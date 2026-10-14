import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { type Document, isAlias, isMap, isPair, isScalar, isSeq, parseDocument, visit } from 'yaml'
import type { KindDescriptor } from '../engine/contract.ts'
import { FORMAT_KINDS } from '../kinds/catalog.ts'
import {
  type Checked,
  FILE_MAX_BYTES,
  type GraphFile,
  NAME_PATTERN,
  type Problem,
  isRecord,
  problem,
} from './model.ts'
import { validateGraph } from './validate.ts'

export interface LoadedGraph {
  name: string
  path: string
  graph: GraphFile
  fingerprint: string
  raw: Record<string, unknown>
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isRecord(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function fingerprintOf(raw: Record<string, unknown>): string {
  const { ui: _ui, ...rest } = raw
  return createHash('sha256').update(canonical(rest)).digest('hex')
}

function yamlProblems(doc: Document): Problem[] {
  const found: Problem[] = []
  for (const error of doc.errors) {
    found.push(
      error.code === 'DUPLICATE_KEY'
        ? problem('yaml-duplicate-key', `a key appears twice: ${error.message.split('\n')[0]}`)
        : problem('yaml-syntax', error.message.split('\n')[0]),
    )
  }
  if (found.length > 0) return found
  visit(doc, (_key, node) => {
    if (isAlias(node)) {
      found.push(problem('yaml-alias', 'anchors and aliases are not allowed'))
      return visit.BREAK
    }
    if (isScalar(node) || isMap(node) || isSeq(node)) {
      if (node.anchor) {
        found.push(problem('yaml-alias', 'anchors and aliases are not allowed'))
        return visit.BREAK
      }
      if (node.tag) {
        found.push(problem('yaml-tag', `tags such as ${node.tag} are not allowed`))
        return visit.BREAK
      }
    }
    if (isPair(node) && isScalar(node.key) && node.key.value === '<<') {
      found.push(problem('yaml-merge-key', 'the << merge key is not allowed'))
      return visit.BREAK
    }
    return undefined
  })
  return found
}

export function parseGraphText(text: string): Checked<Record<string, unknown>> {
  const doc = parseDocument(text, {
    version: '1.2',
    schema: 'core',
    merge: false,
    uniqueKeys: true,
    prettyErrors: false,
  })
  const problems = yamlProblems(doc)
  if (problems.length > 0) return { ok: false, problems }
  const value = doc.toJS({ maxAliasCount: 0 })
  if (!isRecord(value))
    return { ok: false, problems: [problem('bad-graph', 'a graph file is a YAML mapping')] }
  return { ok: true, value }
}

export function graphNameOf(path: string): string {
  return basename(path, extname(path))
}

function symlinkUnder(path: string, workDir: string): boolean {
  const rel = relative(workDir, dirname(path))
  if (rel.startsWith('..') || isAbsolute(rel)) return false
  let at = workDir
  for (const part of rel.split(sep).filter(Boolean)) {
    at = resolve(at, part)
    try {
      if (lstatSync(at).isSymbolicLink()) return true
    } catch {
      return false
    }
  }
  return false
}

export function readGraphText(path: string, workDir: string): Checked<string> {
  const name = graphNameOf(path)
  if (!NAME_PATTERN.test(name) || !['.yaml', '.yml'].includes(extname(path))) {
    return {
      ok: false,
      problems: [
        problem(
          'bad-name',
          `${basename(path)}: a graph's name matches ${NAME_PATTERN} and ends in .yaml`,
        ),
      ],
    }
  }
  if (symlinkUnder(path, workDir)) {
    return {
      ok: false,
      problems: [problem('not-a-regular-file', `${path} is under a symbolic link`)],
    }
  }
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return {
      ok: false,
      problems: [
        problem(
          code === 'ENOENT' ? 'not-found' : 'not-a-regular-file',
          `${path} cannot be read as a regular file`,
        ),
      ],
    }
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile())
      return {
        ok: false,
        problems: [problem('not-a-regular-file', `${path} is not a regular file`)],
      }
    if (stat.size > FILE_MAX_BYTES)
      return { ok: false, problems: [problem('too-large', `${path} is over 64 KiB`)] }
    const buffer = Buffer.alloc(FILE_MAX_BYTES + 1)
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    if (read > FILE_MAX_BYTES)
      return { ok: false, problems: [problem('too-large', `${path} is over 64 KiB`)] }
    return { ok: true, value: buffer.subarray(0, read).toString('utf8') }
  } finally {
    closeSync(fd)
  }
}

export function loadGraphText(
  text: string,
  path: string,
  kinds: readonly KindDescriptor[] = FORMAT_KINDS,
): Checked<LoadedGraph> {
  const parsed = parseGraphText(text)
  if (!parsed.ok) return parsed
  const checked = validateGraph(parsed.value, kinds)
  if (!checked.graph) return { ok: false, problems: checked.problems }
  return {
    ok: true,
    value: {
      name: graphNameOf(path),
      path,
      graph: checked.graph,
      fingerprint: fingerprintOf(parsed.value),
      raw: parsed.value,
    },
  }
}

export function readGraphFile(
  path: string,
  workDir: string,
  kinds?: readonly KindDescriptor[],
): Checked<LoadedGraph> {
  const text = readGraphText(path, workDir)
  return text.ok ? loadGraphText(text.value, path, kinds) : text
}

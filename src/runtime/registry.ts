import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { type LoadedGraph, readGraphFile } from '../format/graphFile.ts'
import { NAME_PATTERN, type Problem, isRecord, problem } from '../format/model.ts'
import { RpcError } from './server.ts'

export const SCOPES_FILE = 'scopes.json'
export const ENABLED_FILE = 'enabled.json'
export const GRAPHS_PER_SCOPE = 64

export interface Scope {
  key: string
  id: string
  folder: string
  sandboxed: boolean
  graphs: Record<string, string>
}

interface EnabledRecord {
  scope: string
  realPath: string
  fingerprint: string
  at: number
}

interface EnabledFile {
  enabled: EnabledRecord[]
  changed: { scope: string; realPath: string }[]
}

export type GraphState = 'enabled' | 'changed' | 'not-enabled' | 'invalid'

export interface Listing {
  scope: string
  name: string
  path: string
  realPath: string
  state: GraphState
  loaded: LoadedGraph | null
  problems: Problem[]
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(path: string, value: unknown): void {
  const staged = `${path}.${process.pid}`
  writeFileSync(staged, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(staged, path)
}

function realOf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export function insideFolder(path: string, folder: string): boolean {
  if (!isAbsolute(path)) return false
  const under = (p: string) => {
    const rel = relative(folder, p)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  }
  return under(resolve(path)) && under(realOf(path))
}

export function scopeKey(id: string): string {
  return `dir-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`
}

export function scopeId(folder: string): string {
  return `dir:${folder}`
}

export class Registry {
  private scopes = new Map<string, Scope>()

  constructor(
    private readonly data: string,
    private readonly now: () => number = Date.now,
  ) {
    const stored = readJson(join(data, SCOPES_FILE))
    if (isRecord(stored)) {
      for (const [key, raw] of Object.entries(stored)) {
        if (!isRecord(raw) || typeof raw.folder !== 'string') continue
        const id = scopeId(raw.folder)
        if (scopeKey(id) !== key) continue
        const graphs: Record<string, string> = {}
        if (isRecord(raw.graphs))
          for (const [name, path] of Object.entries(raw.graphs))
            if (NAME_PATTERN.test(name) && typeof path === 'string') graphs[name] = path
        this.scopes.set(key, {
          key,
          id,
          folder: raw.folder,
          sandboxed: raw.sandboxed === true,
          graphs,
        })
      }
    }
  }

  private saveScopes(): void {
    const out: Record<string, unknown> = {}
    for (const scope of this.scopes.values())
      out[scope.key] = { folder: scope.folder, sandboxed: scope.sandboxed, graphs: scope.graphs }
    writeJson(join(this.data, SCOPES_FILE), out)
  }

  register(folder: unknown, flags: { scratch?: unknown; sandboxed?: unknown } | null): Scope {
    if (flags?.scratch === true) throw new RpcError('scratch')
    if (typeof folder !== 'string' || !folder.startsWith('/')) throw new RpcError('bad-folder')
    let real: string
    try {
      real = realpathSync(folder)
      if (!statSync(real).isDirectory()) throw new Error('not a folder')
    } catch {
      throw new RpcError('bad-folder')
    }
    const id = scopeId(real)
    const key = scopeKey(id)
    const scope = this.scopes.get(key) ?? { key, id, folder: real, sandboxed: false, graphs: {} }
    if (flags && typeof flags.sandboxed === 'boolean') scope.sandboxed = flags.sandboxed
    this.scopes.set(key, scope)
    this.saveScopes()
    return scope
  }

  scope(id: unknown): Scope {
    const scope = typeof id === 'string' ? this.scopes.get(scopeKey(id)) : undefined
    if (!scope) throw new RpcError('unknown-scope')
    return scope
  }

  byKey(key: string): Scope | undefined {
    return this.scopes.get(key)
  }

  all(): Scope[] {
    return [...this.scopes.values()]
  }

  load(scope: Scope, path: unknown): Listing {
    if (typeof path !== 'string') throw new RpcError('bad-path')
    if (!insideFolder(path, scope.folder))
      throw new RpcError('outside-folder: a graph file is read only inside its folder')
    const read = readGraphFile(path, scope.folder)
    if (!read.ok)
      throw new RpcError(`invalid: ${read.problems[0]?.message ?? 'the file does not load'}`)
    const known = Object.keys(scope.graphs)
    if (!known.includes(read.value.name) && known.length >= GRAPHS_PER_SCOPE)
      throw new RpcError(`over-limit: at most ${GRAPHS_PER_SCOPE} graphs in a folder`)
    scope.graphs[read.value.name] = path
    this.saveScopes()
    return this.listing(scope, read.value.name)
  }

  unload(scope: Scope, name: unknown): void {
    if (typeof name !== 'string' || !(name in scope.graphs)) throw new RpcError('unknown-graph')
    delete scope.graphs[name]
    this.saveScopes()
  }

  listing(scope: Scope, name: string): Listing {
    const path = scope.graphs[name]
    if (!path) throw new RpcError('unknown-graph')
    const realPath = resolve(path)
    const read = insideFolder(path, scope.folder)
      ? readGraphFile(path, scope.folder)
      : {
          ok: false as const,
          problems: [problem('outside-folder', `${path} is outside ${scope.folder}`)],
        }
    if (!read.ok || read.value.name !== name) {
      this.disable(scope.id, realPath, true)
      return {
        scope: scope.id,
        name,
        path,
        realPath,
        state: 'invalid',
        loaded: null,
        problems: read.ok
          ? [{ code: 'renamed', message: `the file is now ${read.value.name}` }]
          : read.problems,
      }
    }
    return {
      scope: scope.id,
      name,
      path,
      realPath,
      state: this.checked(scope.id, realPath, read.value.fingerprint),
      loaded: read.value,
      problems: [],
    }
  }

  listings(scope: Scope): Listing[] {
    return Object.keys(scope.graphs)
      .sort()
      .map((name) => this.listing(scope, name))
  }

  private enabledFile(): EnabledFile {
    const raw = readJson(join(this.data, ENABLED_FILE))
    if (!isRecord(raw)) return { enabled: [], changed: [] }
    const enabled = Array.isArray(raw.enabled)
      ? raw.enabled.filter(
          (r): r is EnabledRecord =>
            isRecord(r) &&
            typeof r.scope === 'string' &&
            typeof r.realPath === 'string' &&
            typeof r.fingerprint === 'string' &&
            typeof r.at === 'number',
        )
      : []
    const changed = Array.isArray(raw.changed)
      ? raw.changed.filter(
          (r): r is EnabledFile['changed'][number] =>
            isRecord(r) && typeof r.scope === 'string' && typeof r.realPath === 'string',
        )
      : []
    return { enabled, changed }
  }

  private saveEnabled(file: EnabledFile): void {
    writeJson(join(this.data, ENABLED_FILE), file)
  }

  enable(listing: Listing, fingerprint: unknown): void {
    if (!listing.loaded) throw new RpcError('invalid')
    if (listing.loaded.fingerprint !== fingerprint) throw new RpcError('changed')
    const file = this.enabledFile()
    const same = (r: { scope: string; realPath: string }) =>
      r.scope === listing.scope && r.realPath === listing.realPath
    this.saveEnabled({
      enabled: [
        ...file.enabled.filter((r) => !same(r)),
        { scope: listing.scope, realPath: listing.realPath, fingerprint, at: this.now() },
      ],
      changed: file.changed.filter((r) => !same(r)),
    })
  }

  disable(scope: string, realPath: string, changed = false): void {
    const file = this.enabledFile()
    const same = (r: { scope: string; realPath: string }) =>
      r.scope === scope && r.realPath === realPath
    const wasEnabled = file.enabled.some(same)
    if (!wasEnabled && !changed) return
    if (!wasEnabled && changed && !file.changed.some(same) && !this.everEnabled(scope, realPath))
      return
    this.saveEnabled({
      enabled: file.enabled.filter((r) => !same(r)),
      changed: changed
        ? [...file.changed.filter((r) => !same(r)), { scope, realPath }]
        : file.changed.filter((r) => !same(r)),
    })
  }

  private everEnabled(scope: string, realPath: string): boolean {
    return this.enabledFile().changed.some((r) => r.scope === scope && r.realPath === realPath)
  }

  private checked(scope: string, realPath: string, fingerprint: string): GraphState {
    const file = this.enabledFile()
    const record = file.enabled.find((r) => r.scope === scope && r.realPath === realPath)
    if (record?.fingerprint === fingerprint) return 'enabled'
    if (record) {
      this.disable(scope, realPath, true)
      return 'changed'
    }
    return file.changed.some((r) => r.scope === scope && r.realPath === realPath)
      ? 'changed'
      : 'not-enabled'
  }

  enabled(): { scope: Scope; listing: Listing }[] {
    return this.all().flatMap((scope) =>
      this.listings(scope)
        .filter((l) => l.state === 'enabled')
        .map((listing) => ({ scope, listing })),
    )
  }
}

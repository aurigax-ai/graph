import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { DAY_MS } from '../format/duration'
import { NAME_PATTERN } from '../format/model'
import {
  JOURNAL_LINE_MAX,
  JOURNAL_MAX_BYTES,
  JournalError,
  type JournalStore,
  type Line,
  type RunKey,
  type StoredRun,
} from './journal'

export const RUNS_KEPT = 50
export const RUN_MAX_AGE_MS = 30 * DAY_MS
export const GRAPH_FILE = 'graph.json'
export const JOURNAL_FILE = 'journal.jsonl'

const SCOPE_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{4}$/

function folders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

export function parseJournal(text: string): Line[] {
  const lines: Line[] = []
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    try {
      lines.push(JSON.parse(raw) as Line)
    } catch {
      break
    }
  }
  return lines
}

export class FileJournalStore implements JournalStore {
  private readonly sizes = new Map<string, number>()

  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  private dir(key: RunKey): string {
    if (
      !SCOPE_PATTERN.test(key.scope) ||
      !NAME_PATTERN.test(key.graph) ||
      !RUN_ID_PATTERN.test(key.runId)
    ) {
      throw new JournalError('journal-failed', 'bad run key')
    }
    return join(this.root, key.scope, key.graph, key.runId)
  }

  private ensureDir(path: string): void {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    chmodSync(path, 0o700)
  }

  create(key: RunKey, definition: unknown): void {
    this.ensureDir(this.root)
    this.ensureDir(join(this.root, key.scope))
    this.ensureDir(join(this.root, key.scope, key.graph))
    const dir = this.dir(key)
    this.ensureDir(dir)
    writeFileSync(join(dir, GRAPH_FILE), `${JSON.stringify(definition)}\n`, {
      mode: 0o600,
      flag: 'wx',
    })
    writeFileSync(join(dir, JOURNAL_FILE), '', { mode: 0o600, flag: 'wx' })
    this.sizes.set(dir, 0)
  }

  append(key: RunKey, line: Line): void {
    const dir = this.dir(key)
    const text = `${JSON.stringify(line)}\n`
    const bytes = Buffer.byteLength(text)
    if (bytes > JOURNAL_LINE_MAX)
      throw new JournalError('journal-full', 'a journal line is over 512 KiB')
    const size = this.sizes.get(dir) ?? this.sizeOf(dir)
    if (size + bytes > JOURNAL_MAX_BYTES)
      throw new JournalError('journal-full', 'the journal is over 32 MiB')
    let fd: number
    try {
      fd = openSync(join(dir, JOURNAL_FILE), 'a', 0o600)
    } catch (err) {
      throw new JournalError('journal-failed', err instanceof Error ? err.message : String(err))
    }
    try {
      writeSync(fd, text)
      fsyncSync(fd)
    } catch (err) {
      throw new JournalError('journal-failed', err instanceof Error ? err.message : String(err))
    } finally {
      closeSync(fd)
    }
    this.sizes.set(dir, size + bytes)
    if (line.type === 'run-end') this.prune(key)
  }

  private sizeOf(dir: string): number {
    try {
      return statSync(join(dir, JOURNAL_FILE)).size
    } catch {
      return 0
    }
  }

  read(key: RunKey): StoredRun | null {
    const dir = this.dir(key)
    try {
      const definition = JSON.parse(readFileSync(join(dir, GRAPH_FILE), 'utf8')) as unknown
      const lines = parseJournal(readFileSync(join(dir, JOURNAL_FILE), 'utf8'))
      return { ...key, definition, lines }
    } catch {
      return null
    }
  }

  list(scope?: string): RunKey[] {
    const keys: RunKey[] = []
    for (const s of scope === undefined ? folders(this.root) : [scope]) {
      if (!SCOPE_PATTERN.test(s)) continue
      for (const graph of folders(join(this.root, s))) {
        for (const runId of folders(join(this.root, s, graph))) {
          if (RUN_ID_PATTERN.test(runId)) keys.push({ scope: s, graph, runId })
        }
      }
    }
    return keys.sort((a, b) => a.runId.localeCompare(b.runId))
  }

  remove(key: RunKey): void {
    rmSync(this.dir(key), { recursive: true, force: true })
  }

  private ended(key: RunKey): boolean {
    const stored = this.read(key)
    return stored?.lines.some((line) => line.type === 'run-end') ?? false
  }

  prune(key: Pick<RunKey, 'scope' | 'graph'>): void {
    const runs = this.list(key.scope).filter((k) => k.graph === key.graph)
    const finished = runs.filter((k) => this.ended(k))
    const cutoff = this.now() - RUN_MAX_AGE_MS
    const tooOld = finished.filter((k) => {
      const stored = this.read(k)
      const last = stored?.lines[stored.lines.length - 1]
      return last !== undefined && last.t < cutoff
    })
    const extra = finished.length - RUNS_KEPT
    const oldest = extra > 0 ? finished.slice(0, extra) : []
    for (const k of new Set([...tooOld, ...oldest])) this.remove(k)
  }

  exists(key: RunKey): boolean {
    return existsSync(this.dir(key))
  }
}

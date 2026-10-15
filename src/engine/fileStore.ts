import {
  chmodSync,
  closeSync,
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
import { DAY_MS } from '../format/duration.ts'
import { NAME_PATTERN } from '../format/model.ts'
import {
  JOURNAL_LINE_MAX,
  JOURNAL_MAX_BYTES,
  JournalError,
  type JournalStore,
  type Line,
  type RunKey,
  type StoredRun,
} from './journal.ts'

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

function failure(err: unknown): JournalError {
  return err instanceof JournalError
    ? err
    : new JournalError('journal-failed', err instanceof Error ? err.message : String(err))
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

  async create(key: RunKey, definition: unknown): Promise<void> {
    const dir = this.dir(key)
    try {
      this.ensureDir(this.root)
      this.ensureDir(join(this.root, key.scope))
      this.ensureDir(join(this.root, key.scope, key.graph))
      this.ensureDir(dir)
      writeFileSync(join(dir, GRAPH_FILE), `${JSON.stringify(definition)}\n`, {
        mode: 0o600,
        flag: 'wx',
      })
      writeFileSync(join(dir, JOURNAL_FILE), '', { mode: 0o600, flag: 'wx' })
    } catch (err) {
      throw failure(err)
    }
    this.sizes.set(dir, 0)
  }

  async append(key: RunKey, line: Line): Promise<void> {
    const dir = this.dir(key)
    const text = `${JSON.stringify(line)}\n`
    const bytes = Buffer.byteLength(text)
    if (bytes > JOURNAL_LINE_MAX)
      throw new JournalError('journal-full', 'a journal line is over 512 KiB')
    const size = this.sizes.get(dir) ?? this.sizeOf(dir)
    if (size + bytes > JOURNAL_MAX_BYTES)
      throw new JournalError('journal-full', 'the journal is over 32 MiB')
    try {
      const fd = openSync(join(dir, JOURNAL_FILE), 'a', 0o600)
      try {
        writeSync(fd, text)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } catch (err) {
      throw failure(err)
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

  async read(key: RunKey): Promise<StoredRun | null> {
    return this.readNow(key)
  }

  private readNow(key: RunKey): StoredRun | null {
    const dir = this.dir(key)
    try {
      const definition = JSON.parse(readFileSync(join(dir, GRAPH_FILE), 'utf8')) as unknown
      const lines = parseJournal(readFileSync(join(dir, JOURNAL_FILE), 'utf8'))
      return { ...key, definition, lines }
    } catch {
      return null
    }
  }

  async list(scope?: string): Promise<RunKey[]> {
    return this.listNow(scope)
  }

  private listNow(scope?: string): RunKey[] {
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

  async remove(key: RunKey): Promise<void> {
    this.removeNow(key)
  }

  private removeNow(key: RunKey): void {
    const dir = this.dir(key)
    rmSync(dir, { recursive: true, force: true })
    this.sizes.delete(dir)
  }

  private prune(key: Pick<RunKey, 'scope' | 'graph'>): void {
    const runs = this.listNow(key.scope).filter((k) => k.graph === key.graph)
    const finished: { key: RunKey; last: number }[] = []
    for (const k of runs) {
      const lines = this.readNow(k)?.lines ?? []
      if (lines.some((l) => l.type === 'run-end'))
        finished.push({ key: k, last: lines[lines.length - 1]?.t ?? 0 })
    }
    const cutoff = this.now() - RUN_MAX_AGE_MS
    const tooOld = finished.filter((f) => f.last < cutoff).map((f) => f.key)
    const extra = finished.length - RUNS_KEPT
    const oldest = extra > 0 ? finished.slice(0, extra).map((f) => f.key) : []
    for (const k of new Set([...tooOld, ...oldest])) this.removeNow(k)
  }
}

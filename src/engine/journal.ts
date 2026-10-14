import { JOURNAL_VERSION } from '../format/model'
import type { NodeWait, Output } from './contract'

export type RunStatus =
  | 'running'
  | 'waiting'
  | 'paused'
  | 'interrupted'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'step-limit'
  | 'time-limit'
  | 'agent-limit'
  | 'journal-failed'
  | 'journal-full'
  | 'state-too-large'

export const ENDED_STATUSES: readonly RunStatus[] = [
  'done',
  'failed',
  'cancelled',
  'step-limit',
  'time-limit',
  'agent-limit',
  'journal-failed',
  'journal-full',
  'state-too-large',
]

export interface Write {
  key: string
  op: 'set' | 'append'
  value: unknown
}

export interface NodeFailure {
  node: string
  name: string
  message: string
}

export type NodeEndStatus = 'done' | 'caught' | 'failed' | 'skipped' | 'cancelled'

export type LineBody =
  | {
      type: 'run-start'
      graph: string
      fingerprint: string
      scope: string
      trigger: Output
      input: Output
      state: Output
    }
  | {
      type: 'node-start'
      node: string
      visit: number
      attempt: number
      input: Output
      agent?: true
    }
  | { type: 'node-wait'; node: string; wait: NodeWait; started?: Output }
  | {
      type: 'node-end'
      node: string
      status: NodeEndStatus
      output?: Output
      writes?: Write[]
      error?: { name: string; message: string }
      ms: number
    }
  | {
      type: 'edge'
      from: string
      to: string
      outcome: 'taken' | 'skipped'
      when?: string
      value?: boolean
    }
  | { type: 'node-report'; node: string; valid: boolean }
  | { type: 'reattach'; node: string; verdict: 'running' | 'done' | 'lost' }
  | { type: 'retry'; node: string; attempt: number; delayMs: number; error: string; rule: number }
  | { type: 'state'; state: Output }
  | { type: 'run-pause' }
  | {
      type: 'run-resume'
      choice?: 'resume' | 'retry' | 'rerun' | 'skip' | 'continue'
      node?: string
    }
  | { type: 'run-interrupted'; node: string }
  | { type: 'run-end'; status: RunStatus; error?: NodeFailure }

export type Line = LineBody & { v: number; seq: number; t: number }

export const JOURNAL_LINE_MAX = 512 * 1024
export const JOURNAL_MAX_BYTES = 32 * 1024 * 1024

export class JournalError extends Error {
  constructor(
    readonly code: 'journal-failed' | 'journal-full' | 'journal-version',
    message: string,
  ) {
    super(message)
  }
}

export interface RunKey {
  scope: string
  graph: string
  runId: string
}

export interface StoredRun extends RunKey {
  definition: unknown
  lines: Line[]
}

export interface JournalStore {
  create: (key: RunKey, definition: unknown) => void
  append: (key: RunKey, line: Line) => void
  read: (key: RunKey) => StoredRun | null
  list: (scope?: string) => RunKey[]
  remove: (key: RunKey) => void
}

export function stampLine(body: LineBody, seq: number, t: number): Line {
  return { v: JOURNAL_VERSION, seq, t, ...body } as Line
}

export class MemoryJournalStore implements JournalStore {
  private readonly runs = new Map<string, StoredRun>()

  private id(key: RunKey): string {
    return `${key.scope}/${key.graph}/${key.runId}`
  }

  create(key: RunKey, definition: unknown): void {
    this.runs.set(this.id(key), { ...key, definition, lines: [] })
  }

  append(key: RunKey, line: Line): void {
    const run = this.runs.get(this.id(key))
    if (!run) throw new JournalError('journal-failed', 'no such run')
    run.lines.push(line)
  }

  read(key: RunKey): StoredRun | null {
    const run = this.runs.get(this.id(key))
    return run ? { ...run, lines: [...run.lines] } : null
  }

  list(scope?: string): RunKey[] {
    return [...this.runs.values()]
      .filter((r) => scope === undefined || r.scope === scope)
      .map(({ scope: s, graph, runId }) => ({ scope: s, graph, runId }))
  }

  remove(key: RunKey): void {
    this.runs.delete(this.id(key))
  }
}

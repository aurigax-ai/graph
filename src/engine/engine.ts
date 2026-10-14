import { randomBytes } from 'node:crypto'
import { HOUR_MS, parseDuration } from '../format/duration'
import {
  CONTRACT_VERSION,
  type GraphFile,
  JOURNAL_VERSION,
  type Problem,
  problem,
  triggerKind,
} from '../format/model'
import { FORMAT_KINDS, descriptorOf } from '../kinds/catalog'
import type { Host, Output } from './contract'
import { type BoundKind, GraphRun, NOTIFIED_ENDS, type RunLimits } from './interpreter'
import type { JournalStore, RunKey, RunStatus } from './journal'
import { type RunState, isEnded, newRunState, replay } from './runState'
import { type RunSummary, summarize } from './summary'

export const DEFAULT_LIMITS = {
  steps: 50,
  runsPerHour: 6,
  parallel: 4,
  agents: 6,
  timeMs: 24 * HOUR_MS,
}
export const ACTIVE_PER_SCOPE = 4

export interface Ceilings {
  steps: number
  runsPerHour: number
  parallel: number
  agents: number
  timeMs: number
}

export interface GraphDefinition {
  name: string
  graph: GraphFile
  fingerprint: string
}

export type StartResult =
  | { ok: true; runId: string }
  | { ok: true; queued: true }
  | { ok: false; error: string; message: string }

export function runIdAt(now: number): string {
  const iso = new Date(now)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
  return `${iso}-${randomBytes(2).toString('hex')}`
}

export function missingKinds(
  graph: GraphFile,
  host: Pick<Host, 'kinds' | 'triggers' | 'name'>,
): Problem[] {
  const have = new Set(host.kinds.map((k) => k.kind))
  const problems: Problem[] = []
  for (const kind of new Set(graph.nodes.map((n) => n.kind))) {
    if (!have.has(kind))
      problems.push(problem('unsupported-kind', `unsupported-kind: ${kind} (host: ${host.name})`))
  }
  for (const trigger of new Set(graph.on.map(triggerKind))) {
    if (!host.triggers.includes(trigger)) {
      problems.push(
        problem('unsupported-trigger', `unsupported-trigger: ${trigger} (host: ${host.name})`),
      )
    }
  }
  return problems
}

export function hostProblem(host: Pick<Host, 'contract'>): Problem | null {
  return host.contract === CONTRACT_VERSION
    ? null
    : problem(
        'unsupported-contract',
        `unsupported-contract: the host declares node-kind contract ${host.contract}; this engine runs ${CONTRACT_VERSION}`,
      )
}

function initialState(graph: GraphFile, input: Output): Output {
  const state: Output = {}
  for (const [key, spec] of Object.entries(graph.state)) {
    if (spec.default !== undefined) state[key] = structuredClone(spec.default)
  }
  for (const [key, value] of Object.entries(input)) state[key] = value
  return state
}

interface GraphRecord {
  starts: number[]
  skipped: number
  queued: { definition: GraphDefinition; trigger: Output; input: Output } | null
  lastNotice: number
}

export interface EngineOptions {
  host: Host
  store: JournalStore
  ceilings?: Partial<Ceilings>
  changed?: (runId: string) => void
  dryRun?: boolean
}

export class Engine {
  private readonly runs = new Map<string, GraphRun>()
  private readonly records = new Map<string, GraphRecord>()
  private readonly kinds: Map<string, BoundKind>
  ceilings: Ceilings

  constructor(private readonly opts: EngineOptions) {
    const contract = hostProblem(opts.host)
    if (contract) throw new Error(contract.message)
    this.kinds = new Map()
    for (const impl of opts.host.kinds) {
      const descriptor = descriptorOf(impl.kind)
      if (descriptor) this.kinds.set(impl.kind, { descriptor, impl })
    }
    this.ceilings = { ...DEFAULT_LIMITS, ...opts.ceilings }
  }

  get host(): Host {
    return this.opts.host
  }

  private record(scope: string, graph: string): GraphRecord {
    const id = `${scope}/${graph}`
    const found = this.records.get(id) ?? {
      starts: [],
      skipped: 0,
      queued: null,
      lastNotice: Number.NEGATIVE_INFINITY,
    }
    this.records.set(id, found)
    return found
  }

  skippedCount(scope: string, graph: string): number {
    return this.record(scope, graph).skipped
  }

  private limitsOf(graph: GraphFile): RunLimits & { runsPerHour: number } {
    const file = graph.limits ?? {}
    const time = parseDuration(file.time) ?? DEFAULT_LIMITS.timeMs
    return {
      steps: Math.min(file.steps ?? DEFAULT_LIMITS.steps, this.ceilings.steps),
      parallel: Math.min(file.parallel ?? DEFAULT_LIMITS.parallel, this.ceilings.parallel),
      agents: Math.min(file.agents ?? DEFAULT_LIMITS.agents, this.ceilings.agents),
      runsPerHour: Math.min(
        file.runsPerHour ?? DEFAULT_LIMITS.runsPerHour,
        this.ceilings.runsPerHour,
      ),
      timeMs: Math.min(time, this.ceilings.timeMs),
    }
  }

  private notice(scope: string, graph: string, title: string, body: string, runId?: string): void {
    const record = this.record(scope, graph)
    const now = this.opts.host.clock.now()
    if (now - record.lastNotice < HOUR_MS) return
    record.lastNotice = now
    this.opts.host.notify({ title, body, graph, ...(runId ? { run: runId } : {}) })
  }

  active(scope?: string): GraphRun[] {
    return [...this.runs.values()].filter(
      (run) => !isEnded(run.state.status) && (scope === undefined || run.state.scope === scope),
    )
  }

  private skip(scope: string, definition: GraphDefinition, reason: string): StartResult {
    this.record(scope, definition.name).skipped += 1
    this.notice(scope, definition.name, `Graph ${definition.name} skipped a run`, reason)
    return { ok: false, error: 'skipped', message: reason }
  }

  start(scope: string, definition: GraphDefinition, trigger: Output, input: Output): StartResult {
    const missing = missingKinds(definition.graph, this.opts.host)
    if (missing.length > 0)
      return { ok: false, error: missing[0].code, message: missing[0].message }
    const record = this.record(scope, definition.name)
    const limits = this.limitsOf(definition.graph)
    const now = this.opts.host.clock.now()
    record.starts = record.starts.filter((t) => now - t < HOUR_MS)
    const busy = this.active(scope).some((run) => run.state.graphName === definition.name)
    if (busy) {
      if (definition.graph.concurrency === 'queue' && !record.queued) {
        record.queued = { definition, trigger, input }
        return { ok: true, queued: true }
      }
      return this.skip(scope, definition, 'a run of this graph is still active')
    }
    if (record.starts.length >= limits.runsPerHour) {
      return this.skip(scope, definition, `at most ${limits.runsPerHour} runs an hour`)
    }
    if (this.active(scope).length >= ACTIVE_PER_SCOPE) {
      return this.skip(scope, definition, `at most ${ACTIVE_PER_SCOPE} active runs in a workspace`)
    }
    record.starts.push(now)
    const runId = runIdAt(now)
    const key: RunKey = { scope, graph: definition.name, runId }
    const state = newRunState(runId, definition.name, definition.graph)
    try {
      this.opts.store.create(key, {
        name: definition.name,
        fingerprint: definition.fingerprint,
        graph: definition.graph,
      })
    } catch (err) {
      return {
        ok: false,
        error: 'journal-failed',
        message: err instanceof Error ? err.message : String(err),
      }
    }
    const run = this.bind(key, state, limits)
    void run.open({
      type: 'run-start',
      graph: definition.name,
      fingerprint: definition.fingerprint,
      scope,
      trigger,
      input,
      state: initialState(definition.graph, input),
    })
    return { ok: true, runId }
  }

  private bind(key: RunKey, state: RunState, limits: RunLimits): GraphRun {
    const run = new GraphRun(
      {
        host: this.opts.host,
        kinds: this.kinds,
        store: this.opts.store,
        key,
        limits,
        changed: () => this.opts.changed?.(key.runId),
        ended: (status) => this.ended(key, status),
      },
      state,
    )
    this.runs.set(key.runId, run)
    return run
  }

  private ended(key: RunKey, status: RunStatus): void {
    if (NOTIFIED_ENDS.includes(status)) {
      this.notice(
        key.scope,
        key.graph,
        `Graph ${key.graph} stopped`,
        `The run ended: ${status}`,
        key.runId,
      )
    }
    const record = this.record(key.scope, key.graph)
    const queued = record.queued
    record.queued = null
    if (queued) this.start(key.scope, queued.definition, queued.trigger, queued.input)
  }

  recover(scope?: string): { resumed: string[]; refused: { runId: string; error: string }[] } {
    const resumed: string[] = []
    const refused: { runId: string; error: string }[] = []
    for (const key of this.opts.store.list(scope)) {
      if (this.runs.has(key.runId)) continue
      const stored = this.opts.store.read(key)
      if (!stored) continue
      const definition = stored.definition as { graph?: GraphFile }
      if (!definition?.graph) continue
      if (stored.lines.some((line) => line.v !== JOURNAL_VERSION)) {
        refused.push({ runId: key.runId, error: 'journal-version' })
        continue
      }
      const state = replay(key.runId, key.graph, definition.graph, stored.lines)
      if (isEnded(state.status)) continue
      const run = this.bind(key, state, this.limitsOf(definition.graph))
      void run.recover()
      resumed.push(key.runId)
    }
    return { resumed, refused }
  }

  run(runId: string): GraphRun | undefined {
    return this.runs.get(runId)
  }

  async deliver(event: Output): Promise<number> {
    let matched = 0
    for (const run of this.active()) matched += await run.deliver(event)
    return matched
  }

  waitingOn(event: Output): { run: GraphRun; node: string }[] {
    return this.active().flatMap((run) => run.waitingOn(event).map((node) => ({ run, node })))
  }

  summaries(scope?: string): RunSummary[] {
    return this.opts.store
      .list(scope)
      .map((key) => {
        const live = this.runs.get(key.runId)
        if (live) return summarize(key, live.state)
        const stored = this.opts.store.read(key)
        const graph = (stored?.definition as { graph?: GraphFile } | undefined)?.graph
        if (!stored || !graph) return null
        if (stored.lines.some((line) => line.v !== JOURNAL_VERSION))
          return summarize(key, null, 'journal-version')
        return summarize(key, replay(key.runId, key.graph, graph, stored.lines))
      })
      .filter((s): s is RunSummary => s !== null)
  }

  stopAll(): void {
    this.runs.clear()
  }
}

export const KNOWN_FORMAT_KINDS = FORMAT_KINDS.map((k) => k.kind)

import { evaluateCondition } from '../conditions/evaluate.ts'
import { parseCondition } from '../conditions/parser.ts'
import { parseDuration } from '../format/duration.ts'
import { CONTINUE, END, type GraphNode, isConditional, isJoin } from '../format/model.ts'
import { MissingValue, render } from '../format/templates.ts'
import {
  type Host,
  type KindDescriptor,
  NodeError,
  type NodeKind,
  type NodeResult,
  type NodeWait,
  type Output,
} from './contract.ts'
import {
  JournalError,
  type JournalStore,
  type LineBody,
  type RunKey,
  type RunStatus,
  stampLine,
} from './journal.ts'
import {
  checkOutput,
  computeWrites,
  redactOutput,
  stateTooLarge,
  thrownMessage,
} from './outputs.ts'
import { catchRule, retryDelay, retryRule } from './retry.ts'
import {
  type ActiveNode,
  type RunState,
  applyLine,
  applyWrites,
  isEnded,
  retryKey,
} from './runState.ts'

export const STATE_LINE_EVERY = 25
export const INTERRUPTED_PROMPT = 'You were interrupted. Finish the task and report.'
export const NOTIFIED_ENDS: readonly RunStatus[] = [
  'step-limit',
  'time-limit',
  'agent-limit',
  'journal-failed',
  'journal-full',
  'state-too-large',
]

export interface RunLimits {
  steps: number
  parallel: number
  agents: number
  timeMs: number
}

export interface BoundKind {
  descriptor: KindDescriptor
  impl: NodeKind
}

export interface RunDeps {
  host: Host
  kinds: ReadonlyMap<string, BoundKind>
  store: JournalStore
  key: RunKey
  limits: RunLimits
  changed: () => void
  ended: (status: RunStatus) => void
}

interface Live {
  gen: number
  abort: AbortController
  cancels: (() => void)[]
}

export function reportParagraph(result: Record<string, unknown>, runId: string): string {
  return [
    'When you have finished, report your result as your last action before you stop, with:',
    `ostia graph report --json '<one JSON object>' --run ${runId}`,
    `The object must match this JSON Schema: ${JSON.stringify(result)}`,
    'If the command prints errors, fix the object and run it again. Your closing message is not read as the result.',
  ].join('\n')
}

function errorParts(err: unknown): { name: string; message: string } {
  if (err instanceof NodeError) return { name: err.errorName, message: thrownMessage(err) }
  return { name: 'BadOutput', message: thrownMessage(err) }
}

function waitMatches(wait: NodeWait, event: Output): boolean {
  if (wait.on === 'timer') return false
  const match = wait.on === 'event' ? wait.match : { type: 'answer', key: wait.ask.key }
  return Object.entries(match).every(([k, v]) => event[k] === v)
}

export class GraphRun {
  private readonly live = new Map<string, Live>()
  private readonly runTimers: (() => void)[] = []
  private gen = 0
  private lock: Promise<void> = Promise.resolve()

  constructor(
    private readonly deps: RunDeps,
    readonly state: RunState,
  ) {}

  get id(): string {
    return this.state.id
  }

  serial(fn: () => void | Promise<void>): Promise<void> {
    const next = this.lock.then(fn).catch((err) => this.crash(err))
    this.lock = next
    return next
  }

  private crash(err: unknown): void {
    if (err instanceof JournalError)
      this.endWithoutJournal(err.code === 'journal-full' ? 'journal-full' : 'journal-failed')
    else throw err
  }

  private async record(body: LineBody): Promise<string | null> {
    const line = stampLine(body, this.state.seq + 1, this.deps.host.clock.now())
    try {
      await this.deps.store.append(this.deps.key, line)
    } catch (err) {
      if (err instanceof JournalError) throw err
      throw new JournalError('journal-failed', thrownMessage(err))
    }
    const effect = applyLine(this.state, line)
    this.deps.changed()
    return effect
  }

  private node(id: string): GraphNode {
    return this.state.graph.nodes.find((n) => n.id === id) as GraphNode
  }

  private kind(id: string): BoundKind {
    return this.deps.kinds.get(this.node(id).kind) as BoundKind
  }

  private scope(attempt = 1) {
    return {
      state: this.state.state,
      trigger: this.state.trigger,
      run: {
        id: this.state.id,
        graph: this.state.graphName,
        steps: this.state.steps,
        remaining: Math.max(0, this.deps.limits.steps - this.state.steps),
        visits: { ...this.state.visits },
        attempt,
      },
    }
  }

  private timeoutOf(id: string): number | null {
    const node = this.node(id)
    const kind = this.kind(id).descriptor
    return parseDuration(node.timeout) ?? kind.timeout?.defaultMs ?? null
  }

  private context(id: string, active: ActiveNode, signal: AbortSignal) {
    return {
      run: {
        id: this.state.id,
        graph: this.state.graphName,
        node: id,
        visit: active.visit,
        attempt: active.attempt,
        attemptKey: `${this.state.id}:${id}:${active.visit}`,
      },
      host: this.deps.host.name,
      scope: this.state.scope,
      signal,
      timeoutMs: this.timeoutOf(id),
      trigger: this.state.trigger,
      started: (nodeId: string) => this.state.history.get(nodeId) ?? null,
      node: this.node(id),
    }
  }

  private liveOf(id: string): Live {
    const existing = this.live.get(id)
    if (existing) return existing
    const live: Live = { gen: ++this.gen, abort: new AbortController(), cancels: [] }
    this.live.set(id, live)
    return live
  }

  private freshLive(id: string): Live {
    this.dropLive(id, false)
    return this.liveOf(id)
  }

  private dropLive(id: string, abort: boolean): void {
    const live = this.live.get(id)
    if (!live) return
    for (const cancel of live.cancels) cancel()
    if (abort) live.abort.abort()
    this.live.delete(id)
  }

  private current(id: string, gen: number): boolean {
    return this.live.get(id)?.gen === gen && this.state.active.has(id)
  }

  private timer(id: string, gen: number, at: number, fn: () => void | Promise<void>): void {
    const live = this.live.get(id)
    if (!live) return
    live.cancels.push(
      this.deps.host.clock.setTimer(at, () => {
        void this.serial(() => (this.current(id, gen) ? fn() : undefined))
      }),
    )
  }

  private armTimeout(id: string, active: ActiveNode): void {
    const ms = this.timeoutOf(id)
    if (ms === null) return
    const live = this.liveOf(id)
    this.timer(id, live.gen, active.startedAt + ms, () =>
      this.nodeError(
        id,
        live.gen,
        new NodeError('Timeout', `${id} ran past its timeout of ${ms} ms`),
      ),
    )
  }

  private running(): number {
    return this.state.active.size
  }

  open(definition: unknown, start: Extract<LineBody, { type: 'run-start' }>): Promise<void> {
    return this.serial(async () => {
      await this.deps.store.create(this.deps.key, definition)
      await this.record(start)
      this.armTimeLimit()
      await this.pump()
    })
  }

  private armTimeLimit(): void {
    this.runTimers.push(
      this.deps.host.clock.setTimer(this.state.startedAt + this.deps.limits.timeMs, () => {
        void this.serial(() => this.end('time-limit'))
      }),
    )
  }

  private async pump(): Promise<void> {
    if (isEnded(this.state.status)) return
    const launches: (() => void)[] = []
    while (!this.state.paused && !this.state.failure && this.state.ready.length > 0) {
      if (this.running() >= this.deps.limits.parallel) break
      const id = this.state.ready[0] as string
      const started = await this.startNode(
        id,
        { attempt: 1, visit: (this.state.visits[id] ?? 0) + 1 },
        undefined,
        launches,
      )
      if (!started) return
    }
    for (const launch of launches.splice(0)) launch()
    await this.maybeFinish()
  }

  private async maybeFinish(): Promise<void> {
    if (isEnded(this.state.status) || this.state.active.size > 0) return
    if (this.state.failure) await this.end('failed', this.state.failure)
    else if (this.state.ready.length === 0) await this.end('done')
  }

  private renderInput(id: string, override?: Output): Output | NodeError {
    const node = this.node(id)
    const kind = this.kind(id).descriptor
    let input: Output
    try {
      input = (override ?? render(node.with ?? {}, this.scope())) as Output
    } catch (err) {
      if (err instanceof MissingValue)
        return new NodeError('MissingInput', `${id} reads a value that is not set yet`)
      throw err
    }
    if (kind.takesResult && node.result && typeof input.prompt === 'string') {
      input = {
        ...input,
        prompt: `${input.prompt.trimEnd()}\n\n${reportParagraph(node.result, this.state.id)}`,
      }
    }
    if (
      kind.maxPrompt &&
      typeof input.prompt === 'string' &&
      input.prompt.length > kind.maxPrompt
    ) {
      return new NodeError(
        'PromptTooLong',
        `the prompt is ${input.prompt.length} characters, over ${kind.maxPrompt}`,
      )
    }
    return input
  }

  private async startNode(
    id: string,
    at: { attempt: number; visit: number },
    override?: Output,
    launches?: (() => void)[],
  ): Promise<boolean> {
    if (this.state.steps >= this.deps.limits.steps) {
      await this.end('step-limit')
      return false
    }
    const bound = this.kind(id)
    const input = this.renderInput(id, override)
    const opens = !(input instanceof NodeError) && bound.descriptor.opensAgent?.(input) === true
    if (opens && this.state.agents >= this.deps.limits.agents) {
      await this.end('agent-limit')
      return false
    }
    await this.record({
      type: 'node-start',
      node: id,
      visit: at.visit,
      attempt: at.attempt,
      input: input instanceof NodeError ? (this.node(id).with ?? {}) : input,
      ...(opens ? { agent: true as const } : {}),
    })
    const live = this.freshLive(id)
    const active = this.state.active.get(id) as ActiveNode
    if (input instanceof NodeError) {
      void this.serial(() => this.nodeError(id, live.gen, input))
      return true
    }
    const launch = () => {
      this.armTimeout(id, active)
      this.call(id, live, () =>
        bound.impl.start(input, this.context(id, active, live.abort.signal)),
      )
    }
    if (launches) launches.push(launch)
    else launch()
    return true
  }

  private call(id: string, live: Live, fn: () => Promise<NodeResult>): void {
    let promise: Promise<NodeResult>
    try {
      promise = fn()
    } catch (err) {
      promise = Promise.reject(err)
    }
    promise.then(
      (res) =>
        this.serial(() =>
          this.current(id, live.gen) ? this.onResult(id, live.gen, res) : undefined,
        ),
      (err) =>
        this.serial(() =>
          this.current(id, live.gen) ? this.nodeError(id, live.gen, err) : undefined,
        ),
    )
  }

  private async onResult(id: string, gen: number, res: NodeResult): Promise<void> {
    if ('done' in res) return this.finish(id, gen, res.done, 'done')
    await this.record({
      type: 'node-wait',
      node: id,
      wait: res.waiting,
      ...(res.started ? { started: res.started } : {}),
    })
    this.armWait(id, gen, res.waiting)
  }

  private armWait(id: string, gen: number, wait: NodeWait): void {
    if (wait.on !== 'timer') return
    this.timer(id, gen, wait.at, () => {
      const live = this.live.get(id) as Live
      const active = this.state.active.get(id) as ActiveNode
      const resume = this.kind(id).impl.resume
      if (!resume) return this.finish(id, gen, {}, 'done')
      this.call(id, live, () => resume(wait, {}, this.context(id, active, live.abort.signal)))
    })
  }

  deliver(event: Output): Promise<number> {
    let matched = 0
    return this.serial(() => {
      for (const [id, active] of this.state.active) {
        if (active.phase !== 'waiting' || !active.wait || !waitMatches(active.wait, event)) continue
        const live = this.liveOf(id)
        const resume = this.kind(id).impl.resume
        if (!resume) continue
        matched += 1
        const wait = active.wait
        this.call(id, live, () => resume(wait, event, this.context(id, active, live.abort.signal)))
      }
    }).then(() => matched)
  }

  waitingOn(event: Output): string[] {
    return [...this.state.active.values()]
      .filter((a) => a.phase === 'waiting' && a.wait && waitMatches(a.wait, event))
      .map((a) => a.node)
  }

  private async finish(
    id: string,
    gen: number,
    raw: Output,
    status: 'done' | 'caught',
  ): Promise<void> {
    const node = this.node(id)
    const kind = this.kind(id).descriptor
    let output: Output
    let writes: ReturnType<typeof computeWrites>
    try {
      if (status === 'done') checkOutput(kind, node, raw)
      output = status === 'done' ? await redactOutput(raw, this.deps.host.redact) : raw
      writes = computeWrites(node, this.state.graph.state, this.state.state, output)
    } catch (err) {
      if (status === 'caught') throw err
      return this.nodeError(id, gen, err)
    }
    if (!this.current(id, gen)) return
    if (stateTooLarge(applyWrites(this.state.state, writes))) {
      await this.end('state-too-large')
      return
    }
    const active = this.state.active.get(id) as ActiveNode
    this.dropLive(id, false)
    await this.record({
      type: 'node-end',
      node: id,
      status,
      output,
      writes,
      ms: this.deps.host.clock.now() - active.startedAt,
    })
    await this.stateLine()
    if (!this.state.failure && !isEnded(this.state.status)) await this.route(id)
    await this.pump()
  }

  private async stateLine(): Promise<void> {
    if (this.state.endsSinceState >= STATE_LINE_EVERY)
      await this.record({ type: 'state', state: this.state.state })
  }

  private async route(id: string): Promise<void> {
    for (const edge of this.state.graph.edges) {
      if (isJoin(edge) && edge.from.includes(id))
        await this.record({ type: 'edge', from: id, to: edge.to, outcome: 'taken' })
    }
    const edge = this.state.graph.edges.find((e) => !Array.isArray(e.from) && e.from === id)
    if (!edge) return
    if (!isConditional(edge)) {
      for (const to of Array.isArray(edge.to) ? edge.to : [edge.to]) await this.take(id, to)
      return
    }
    const scope = this.scope()
    let chosen = edge.else
    let chosenIf: string | undefined
    const falses = new Map<string, string>()
    for (const branch of edge.when) {
      const parsed = parseCondition(branch.if)
      const value = parsed.ok
        ? evaluateCondition(parsed.expr, scope)
        : { ok: false as const, error: parsed.problem.message }
      if (!value.ok) {
        await this.conditionError(id, `"${branch.if}": ${value.error}`)
        return
      }
      if (value.value) {
        chosen = branch.to
        chosenIf = branch.if
        break
      }
      if (!falses.has(branch.to)) falses.set(branch.to, branch.if)
    }
    await this.take(id, chosen, chosenIf)
    const others = new Set([...edge.when.map((w) => w.to), edge.else])
    others.delete(chosen)
    for (const to of others) await this.skip(id, to, new Set(), falses.get(to))
  }

  private async take(from: string, to: string, when?: string): Promise<void> {
    if (to === END) return
    await this.record({
      type: 'edge',
      from,
      to,
      outcome: 'taken',
      ...(when ? { when, value: true } : {}),
    })
  }

  private async skip(from: string, to: string, seen: Set<string>, when?: string): Promise<void> {
    if (to === END || seen.has(`${from}>${to}`)) return
    seen.add(`${from}>${to}`)
    const completedSkipped = await this.record({
      type: 'edge',
      from,
      to,
      outcome: 'skipped',
      ...(when ? { when, value: false } : {}),
    })
    const target = completedSkipped ?? to
    if (this.state.active.has(target) || this.state.ready.includes(target)) return
    if (!completedSkipped && this.isJoinTarget(to)) return
    for (const edge of this.state.graph.edges) {
      if (isJoin(edge) && edge.from.includes(target)) await this.skip(target, edge.to, seen)
      else if (!Array.isArray(edge.from) && edge.from === target) {
        const targets = isConditional(edge)
          ? [...edge.when.map((w) => w.to), edge.else]
          : Array.isArray(edge.to)
            ? edge.to
            : [edge.to]
        for (const next of new Set(targets))
          if (this.reachesJoin(next)) await this.skip(target, next, seen)
      }
    }
  }

  private isJoinTarget(id: string): boolean {
    return this.state.graph.edges.some((e) => isJoin(e) && e.to === id)
  }

  private reachesJoin(id: string): boolean {
    const seen = new Set<string>()
    const queue = [id]
    while (queue.length > 0) {
      const at = queue.shift() as string
      if (at === END || seen.has(at)) continue
      seen.add(at)
      for (const edge of this.state.graph.edges) {
        if (isJoin(edge) && edge.from.includes(at)) return true
        if (!Array.isArray(edge.from) && edge.from === at) {
          queue.push(
            ...(isConditional(edge)
              ? [...edge.when.map((w) => w.to), edge.else]
              : Array.isArray(edge.to)
                ? edge.to
                : [edge.to]),
          )
        }
      }
    }
    return false
  }

  private async conditionError(id: string, message: string): Promise<void> {
    const rule = catchRule(this.node(id), 'ConditionError')
    if (rule && rule.then !== CONTINUE) {
      await this.take(id, rule.then)
      return
    }
    if (rule) return
    await this.failRun({ node: id, name: 'ConditionError', message })
  }

  private async nodeError(id: string, gen: number, err: unknown): Promise<void> {
    if (!this.current(id, gen)) return
    const { name, message } = errorParts(err)
    const node = this.node(id)
    const active = this.state.active.get(id) as ActiveNode
    const live = this.live.get(id)
    this.dropLive(id, true)
    if (active.wait)
      await this.kind(id)
        .impl.cancel?.(
          active.wait,
          active.started,
          this.context(id, active, live?.abort.signal ?? new AbortController().signal),
        )
        .catch(() => {})
    const retry = retryRule(node, name)
    if (retry) {
      const key = retryKey(id, active.visit, retry.index)
      const used = this.state.retries.get(key) ?? 0
      if (used < (retry.rule.maxAttempts ?? 1)) {
        const delayMs = retryDelay(retry.rule, used, this.deps.host.random ?? Math.random)
        await this.record({
          type: 'retry',
          node: id,
          attempt: active.attempt,
          delayMs,
          error: name,
          rule: retry.index,
        })
        const next = this.liveOf(id)
        this.timer(id, next.gen, this.deps.host.clock.now() + delayMs, async () => {
          await this.startNode(id, { attempt: active.attempt + 1, visit: active.visit })
          await this.pump()
        })
        return
      }
    }
    const rule = catchRule(node, name)
    if (rule) {
      const caught = this.liveOf(id)
      if (rule.then === CONTINUE)
        return this.finish(id, caught.gen, { error: { name, message } }, 'caught')
      const writes = computeWrites(node, this.state.graph.state, this.state.state, {
        error: { name, message },
      })
      this.dropLive(id, false)
      await this.record({
        type: 'node-end',
        node: id,
        status: 'caught',
        output: { error: { name, message } },
        writes,
        ms: this.deps.host.clock.now() - active.startedAt,
      })
      await this.take(id, rule.then)
      await this.pump()
      return
    }
    await this.record({
      type: 'node-end',
      node: id,
      status: 'failed',
      error: { name, message },
      ms: this.deps.host.clock.now() - active.startedAt,
    })
    await this.failRun({ node: id, name, message })
  }

  private async failRun(failure: { node: string; name: string; message: string }): Promise<void> {
    if (!this.state.failure) this.state.failure = failure
    for (const [other, active] of [...this.state.active]) {
      if (active.phase === 'running' || (active.phase === 'waiting' && active.wait?.on === 'event'))
        continue
      this.releaseWait(other, active)
      await this.record({
        type: 'node-end',
        node: other,
        status: 'cancelled',
        ms: this.deps.host.clock.now() - active.startedAt,
      })
    }
    await this.maybeFinish()
  }

  private releaseWait(id: string, active: ActiveNode): void {
    const live = this.live.get(id)
    this.dropLive(id, true)
    if (active.wait || active.started) {
      void this.kind(id)
        .impl.cancel?.(
          active.wait,
          active.started,
          this.context(id, active, live?.abort.signal ?? new AbortController().signal),
        )
        .catch(() => {})
    }
  }

  private async end(
    status: RunStatus,
    error?: { node: string; name: string; message: string },
  ): Promise<void> {
    if (isEnded(this.state.status)) return
    for (const cancel of this.runTimers.splice(0)) cancel()
    for (const [id, active] of [...this.state.active]) this.releaseWait(id, active)
    await this.record({ type: 'state', state: this.state.state })
    await this.record({ type: 'run-end', status, ...(error ? { error } : {}) })
    this.deps.ended(status)
  }

  private endWithoutJournal(status: RunStatus): void {
    if (isEnded(this.state.status)) return
    for (const cancel of this.runTimers.splice(0)) cancel()
    for (const [id, active] of [...this.state.active]) this.releaseWait(id, active)
    this.state.status = status
    this.deps.changed()
    this.deps.ended(status)
  }

  recordReport(node: string, valid: boolean): Promise<void> {
    return this.serial(async () => {
      if (this.state.active.has(node)) await this.record({ type: 'node-report', node, valid })
    })
  }

  pause(): Promise<void> {
    return this.serial(async () => {
      if (!isEnded(this.state.status) && !this.state.paused)
        await this.record({ type: 'run-pause' })
    })
  }

  resume(): Promise<void> {
    return this.serial(async () => {
      if (!this.state.paused) return
      await this.record({ type: 'run-resume', choice: 'resume' })
      await this.pump()
    })
  }

  cancel(): Promise<void> {
    return this.serial(() => this.end('cancelled'))
  }

  retry(): Promise<boolean> {
    let retried = false
    return this.serial(async () => {
      const failure = this.state.failure
      if (this.state.status !== 'failed' || !failure) return
      const node = failure.node
      await this.record({ type: 'run-resume', choice: 'retry', node })
      this.armTimeLimit()
      retried = await this.startNode(node, {
        attempt: 1,
        visit: Math.max(1, this.state.visits[node] ?? 1),
      })
      await this.pump()
    }).then(() => retried)
  }

  resolve(node: string, choice: 'rerun' | 'skip' | 'continue'): Promise<boolean> {
    let done = false
    return this.serial(async () => {
      const active = this.state.active.get(node)
      if (active?.phase !== 'interrupted') return
      done = true
      if (choice === 'skip') {
        await this.record({ type: 'run-resume', choice, node })
        await this.record({
          type: 'node-end',
          node,
          status: 'skipped',
          output: {},
          writes: [],
          ms: 0,
        })
        await this.route(node)
        await this.pump()
        return
      }
      await this.record({ type: 'run-resume', choice, node })
      const override =
        choice === 'continue'
          ? {
              mode: 'continue',
              from: node,
              prompt: INTERRUPTED_PROMPT,
              ...(active.input.wait ? { wait: active.input.wait } : {}),
            }
          : undefined
      await this.startNode(node, { attempt: active.attempt + 1, visit: active.visit }, override)
      await this.pump()
    }).then(() => done)
  }

  recover(): Promise<void> {
    return this.serial(async () => {
      if (isEnded(this.state.status)) return
      this.armTimeLimit()
      for (const [id, active] of [...this.state.active]) await this.recoverNode(id, active)
      await this.pump()
    })
  }

  private async recoverNode(id: string, active: ActiveNode): Promise<void> {
    const bound = this.kind(id)
    const live = this.freshLive(id)
    if (active.phase === 'interrupted') return
    if (active.phase === 'retrying') {
      this.timer(id, live.gen, active.retryAt ?? this.deps.host.clock.now(), async () => {
        await this.startNode(id, { attempt: active.attempt + 1, visit: active.visit })
        await this.pump()
      })
      return
    }
    const ctx = this.context(id, active, live.abort.signal)
    let verdict: Awaited<ReturnType<NonNullable<NodeKind['reattach']>>>
    if (bound.impl.reattach)
      verdict = await bound.impl
        .reattach(active.started, active.wait, ctx)
        .catch(() => 'lost' as const)
    else verdict = active.phase === 'waiting' ? 'running' : 'lost'
    await this.record({
      type: 'reattach',
      node: id,
      verdict: typeof verdict === 'string' ? verdict : 'done',
    })
    if (verdict === 'running') {
      this.armTimeout(id, active)
      if (active.wait) {
        this.armWait(id, live.gen, active.wait)
        await bound.impl.rearm?.(active.wait, active.started, ctx).catch(() => {})
      }
      return
    }
    if (verdict !== 'lost') return this.finish(id, live.gen, verdict.done, 'done')
    const once = this.node(id).once ?? bound.descriptor.once
    if (once) {
      await this.record({ type: 'run-interrupted', node: id })
      return
    }
    await this.startNode(id, { attempt: active.attempt + 1, visit: active.visit })
  }
}

import { loadGraphText } from '../format/graphFile.ts'
import { type ProcessReply, type ProcessRequest, commandNode } from '../kinds/command.ts'
import { notifyNode, routerNode, waitNode } from '../kinds/smallKinds.ts'
import type { Clock, Host, NodeKind, Notice, Output } from './contract.ts'
import { NodeError } from './contract.ts'
import { Engine } from './engine.ts'
import { type JournalStore, MemoryJournalStore } from './journal.ts'

export class FakeClock implements Clock {
  private timers: { at: number; fn: () => void; id: number }[] = []
  private next = 0

  constructor(private time = Date.UTC(2026, 9, 14, 12, 0, 0)) {}

  now(): number {
    return this.time
  }

  setTimer(at: number, fn: () => void): () => void {
    const id = ++this.next
    this.timers.push({ at, fn, id })
    return () => {
      this.timers = this.timers.filter((t) => t.id !== id)
    }
  }

  pending(): number {
    return this.timers.length
  }

  async advance(ms: number): Promise<void> {
    const end = this.time + ms
    for (;;) {
      await settle()
      const due = this.timers
        .filter((t) => t.at <= end)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!due) break
      this.timers = this.timers.filter((t) => t.id !== due.id)
      this.time = Math.max(this.time, due.at)
      due.fn()
    }
    this.time = end
    await settle()
  }
}

export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r))
}

export interface StartedAgent {
  node: string
  pane: string
  input: Output
}

export interface FakeHostState {
  clock: FakeClock
  notices: Notice[]
  agents: StartedAgent[]
  asks: { key: string; input: Output }[]
  commands: ProcessRequest[]
  cancelled: string[]
  commandReply: (req: ProcessRequest) => ProcessReply | Promise<ProcessReply>
  redact?: (texts: string[]) => Promise<string[] | null>
  reattach: Map<string, 'running' | 'lost' | { done: Output }>
}

export function fakeAgentKind(state: FakeHostState): NodeKind {
  return {
    kind: 'agent',
    version: 1,
    start: async (input, ctx) => {
      if (input.mode === 'message') {
        const target =
          input.to === 'trigger'
            ? (ctx.trigger.pane as string | undefined)
            : ctx.started(String(input.to))?.started?.pane
        if (!target) return { done: { outcome: 'closed' } }
        return { done: { delivered: 'waiting', pane: target } }
      }
      if (input.mode === 'continue' && !ctx.started(String(input.from))?.started?.session) {
        throw new NodeError('AgentGone', `${String(input.from)} recorded no session`)
      }
      const pane = `pane-${state.agents.length + 1}`
      state.agents.push({ node: ctx.run.node, pane, input })
      return {
        waiting: { on: 'event', match: { type: 'agent-stop', pane } },
        started: { pane, session: `s-${pane}` },
      }
    },
    resume: async (_wait, event) => {
      if (event.backgroundWork === true) return { waiting: _wait }
      return {
        done: {
          outcome: 'stopped',
          pane: event.pane,
          ...(event.message !== undefined ? { message: event.message } : {}),
          ...(event.result !== undefined ? { result: event.result } : {}),
        },
      }
    },
    reattach: async (started) => state.reattach.get(String(started?.pane)) ?? 'lost',
    cancel: async (_wait, started) => {
      state.cancelled.push(String(started?.pane ?? 'unknown'))
    },
  }
}

export function fakeApprovalKind(state: FakeHostState): NodeKind {
  return {
    kind: 'approval',
    version: 1,
    start: async (input, ctx) => {
      state.asks.push({ key: ctx.run.attemptKey, input })
      return { waiting: { on: 'human', ask: { key: ctx.run.attemptKey } } }
    },
    rearm: async (wait) => {
      state.asks.push({ key: String(wait.on === 'human' ? wait.ask.key : ''), input: {} })
    },
    resume: async (_wait, event) => {
      if (event.outcome === 'dismissed')
        throw new NodeError('Dismissed', 'the human dismissed the question')
      return { done: { answer: event.answer, values: {}, outcome: 'answered' } }
    },
    cancel: async (wait) => {
      state.cancelled.push(`ask:${wait?.on === 'human' ? String(wait.ask.key) : ''}`)
    },
  }
}

export interface TestEnv extends FakeHostState {
  host: Host
  engine: Engine
  store: JournalStore
  start: (text: string, input?: Output, trigger?: Output) => string
  run: (runId: string) => NonNullable<ReturnType<Engine['run']>>
  stop: (pane: string, extra?: Output) => Promise<void>
  answer: (answer: string, outcome?: string) => Promise<void>
}

export function testEnv(
  opts: { store?: JournalStore; clock?: FakeClock; kinds?: (s: FakeHostState) => NodeKind[] } = {},
): TestEnv {
  const state: FakeHostState = {
    clock: opts.clock ?? new FakeClock(),
    notices: [],
    agents: [],
    asks: [],
    commands: [],
    cancelled: [],
    commandReply: () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      truncated: false,
    }),
    reattach: new Map(),
  }
  const kinds = [
    fakeAgentKind(state),
    fakeApprovalKind(state),
    commandNode(async (req) => {
      state.commands.push(req)
      return state.commandReply(req)
    }),
    routerNode,
    waitNode(() => state.clock.now()),
    notifyNode((n) => {
      state.notices.push(n)
    }),
    ...(opts.kinds?.(state) ?? []),
  ]
  const host: Host = {
    name: 'test',
    contract: 1,
    kinds,
    triggers: ['manual'],
    clock: state.clock,
    notify: (n) => state.notices.push(n),
    redact: (texts) => (state.redact ? state.redact(texts) : Promise.resolve(texts)),
    random: () => 0.5,
  }
  const store = opts.store ?? new MemoryJournalStore()
  const engine = new Engine({ host, store })
  const env: TestEnv = Object.assign(state, {
    host,
    engine,
    store,
    start: (text: string, input: Output = {}, trigger: Output = {}) => {
      const loaded = loadGraphText(text, '/w/.ostia/graphs/g.yaml')
      if (!loaded.ok)
        throw new Error(loaded.problems.map((p) => `${p.code}: ${p.message}`).join('\n'))
      const res = engine.start(
        'w1',
        { name: 'g', graph: loaded.value.graph, fingerprint: loaded.value.fingerprint },
        trigger,
        input,
      )
      if (!res.ok || !('runId' in res)) throw new Error(`not started: ${JSON.stringify(res)}`)
      return res.runId
    },
    run: (runId: string) => engine.run(runId) as NonNullable<ReturnType<Engine['run']>>,
    stop: async (pane: string, extra: Output = {}) => {
      await engine.deliver({ type: 'agent-stop', pane, ...extra })
      await settle()
    },
    answer: async (answer: string, outcome = 'answered') => {
      const last = state.asks[state.asks.length - 1]
      await engine.deliver({ type: 'answer', key: last?.key, answer, outcome })
      await settle()
    },
  })
  return env
}

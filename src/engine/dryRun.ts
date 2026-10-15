import type { LoadedGraph } from '../format/graphFile.ts'
import { type Problem, problem } from '../format/model.ts'
import { FORMAT_KINDS } from '../kinds/catalog.ts'
import type { Clock, Host, NodeKind, Output } from './contract.ts'
import { Engine } from './engine.ts'
import { MemoryJournalStore } from './journal.ts'
import { isEnded } from './runState.ts'
import { runView } from './summary.ts'

export interface DryStep {
  node: string
  status: string
  output?: Output
  error?: { name: string; message: string }
  conditions: { if: string; value: boolean; to: string }[]
  state: Output
}

export type DryRun =
  | { ok: true; status: string; steps: DryStep[] }
  | { ok: false; problems: Problem[] }

class InstantClock implements Clock {
  private timers: { at: number; fn: () => void; id: number }[] = []
  private next = 0

  constructor(private time: number) {}

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

  fireNext(before: number): boolean {
    const due = this.timers
      .filter((t) => t.at <= before)
      .sort((a, b) => a.at - b.at || a.id - b.id)[0]
    if (!due) return false
    this.timers = this.timers.filter((t) => t.id !== due.id)
    this.time = Math.max(this.time, due.at)
    due.fn()
    return true
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
}

export function parseMocks(
  graph: LoadedGraph['graph'],
  pairs: string[],
): Map<string, Output[]> | Problem {
  const mocks = new Map<string, Output[]>()
  for (const pair of pairs) {
    const at = pair.indexOf('=')
    const node = at > 0 ? pair.slice(0, at) : pair
    if (!graph.nodes.some((n) => n.id === node))
      return problem('unknown-node', `unknown-node: ${node}`, { node })
    let value: unknown
    try {
      value = JSON.parse(pair.slice(at + 1))
    } catch {
      return problem('bad-mock', `--mock ${node}= is a JSON object`, { node })
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return problem('bad-mock', `--mock ${node}= is a JSON object`, { node })
    }
    mocks.set(node, [...(mocks.get(node) ?? []), value as Output])
  }
  return mocks
}

function mockKinds(mocks: Map<string, Output[]>): NodeKind[] {
  return FORMAT_KINDS.map((descriptor) => ({
    kind: descriptor.kind,
    version: descriptor.version,
    start: async (input: Output, ctx) => {
      const queued = mocks.get(ctx.run.node)
      const given = queued && queued.length > 1 ? queued.shift() : queued?.[0]
      return { done: given ?? descriptor.mock(input) }
    },
  }))
}

export async function dryRun(
  loaded: LoadedGraph,
  input: Output,
  mocks: Map<string, Output[]>,
  now = Date.now(),
): Promise<DryRun> {
  const clock = new InstantClock(now)
  const host: Host = {
    name: 'dry-run',
    contract: 1,
    kinds: mockKinds(mocks),
    triggers: ['manual', 'schedule', 'files', 'command', 'agent'],
    clock,
    notify: () => {},
  }
  const store = new MemoryJournalStore()
  const engine = new Engine({ host, store })
  const started = await engine.start(
    'dry-run',
    { name: loaded.name, graph: loaded.graph, fingerprint: loaded.fingerprint },
    { dryRun: true },
    input,
  )
  if (!started.ok || !('runId' in started)) {
    return {
      ok: false,
      problems: [
        problem(started.ok ? 'queued' : started.error, started.ok ? 'queued' : started.message),
      ],
    }
  }
  const run = engine.run(started.runId)
  for (let guard = 0; guard < 100_000; guard++) {
    await settle()
    if (!run || isEnded(run.state.status)) break
    if (!clock.fireNext(Number.POSITIVE_INFINITY)) break
  }
  const key = { scope: 'dry-run', graph: loaded.name, runId: started.runId }
  const lines = (await store.read(key))?.lines ?? []
  const view = runView(key, loaded.graph, lines)
  const queue = new Map<string, typeof view.nodes>()
  for (const n of view.nodes) {
    if (n.endedAt === undefined) continue
    queue.set(n.node, [...(queue.get(n.node) ?? []), n])
  }
  const steps: DryStep[] = []
  for (const line of lines) {
    if (line.type === 'node-end') {
      const n = queue.get(line.node)?.shift()
      if (!n) continue
      steps.push({
        node: n.node,
        status: n.status,
        ...(n.output ? { output: n.output } : {}),
        ...(n.error ? { error: n.error } : {}),
        conditions: [],
        state: n.stateAfter ?? {},
      })
    } else if (line.type === 'edge' && line.when !== undefined) {
      steps.at(-1)?.conditions.push({ if: line.when, value: line.value === true, to: line.to })
    }
  }
  return { ok: true, status: run?.state.status ?? 'failed', steps }
}

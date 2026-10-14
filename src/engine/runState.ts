import { type GraphFile, isJoin, startNodes } from '../format/model'
import type { NodeWait, Output, StartedRecord } from './contract'
import { ENDED_STATUSES, type Line, type NodeFailure, type RunStatus, type Write } from './journal'

export type NodePhase = 'running' | 'waiting' | 'retrying' | 'interrupted'

export interface ActiveNode {
  node: string
  visit: number
  attempt: number
  phase: NodePhase
  input: Output
  startedAt: number
  wait?: NodeWait
  started?: Output
  retryAt?: number
}

export interface RunState {
  id: string
  graphName: string
  scope: string
  graph: GraphFile
  fingerprint: string
  trigger: Output
  input: Output
  startedAt: number
  status: RunStatus
  state: Output
  steps: number
  agents: number
  visits: Record<string, number>
  active: Map<string, ActiveNode>
  ready: string[]
  joins: Map<string, Map<string, 'ended' | 'skipped'>>
  history: Map<string, StartedRecord>
  endsSinceState: number
  retries: Map<string, number>
  paused: boolean
  failure: NodeFailure | null
  seq: number
  bytes: number
}

export function newRunState(id: string, graphName: string, graph: GraphFile): RunState {
  return {
    id,
    graphName,
    scope: '',
    graph,
    fingerprint: '',
    trigger: {},
    input: {},
    startedAt: 0,
    status: 'running',
    state: {},
    steps: 0,
    agents: 0,
    visits: Object.fromEntries(graph.nodes.map((n) => [n.id, 0])),
    active: new Map(),
    ready: [],
    joins: new Map(),
    history: new Map(),
    endsSinceState: 0,
    retries: new Map(),
    paused: false,
    failure: null,
    seq: 0,
    bytes: 0,
  }
}

export function applyWrites(state: Output, writes: Write[]): Output {
  const next = { ...state }
  for (const write of writes) {
    next[write.key] =
      write.op === 'append'
        ? [
            ...(Array.isArray(next[write.key]) ? (next[write.key] as unknown[]) : []),
            ...(write.value as unknown[]),
          ]
        : write.value
  }
  return next
}

export function joinOf(graph: GraphFile, from: string, to: string): string[] | null {
  for (const edge of graph.edges) {
    if (isJoin(edge) && edge.to === to && edge.from.includes(from)) return edge.from
  }
  return null
}

export type JoinOutcome = 'pending' | 'ready' | 'skipped'

export function markJoin(
  run: RunState,
  target: string,
  sources: string[],
  from: string,
  how: 'ended' | 'skipped',
): JoinOutcome {
  const marks = run.joins.get(target) ?? new Map<string, 'ended' | 'skipped'>()
  marks.set(from, how)
  run.joins.set(target, marks)
  if (!sources.every((s) => marks.has(s))) return 'pending'
  run.joins.delete(target)
  return [...marks.values()].includes('ended') ? 'ready' : 'skipped'
}

function enqueue(run: RunState, node: string): void {
  if (!run.ready.includes(node)) run.ready.push(node)
}

export function retryKey(node: string, visit: number, rule: number): string {
  return `${node}:${visit}:${rule}`
}

export function applyLine(run: RunState, line: Line): string | null {
  run.seq = line.seq
  run.bytes += Buffer.byteLength(JSON.stringify(line)) + 1
  switch (line.type) {
    case 'run-start':
      run.scope = line.scope
      run.fingerprint = line.fingerprint
      run.trigger = line.trigger
      run.input = line.input
      run.state = line.state
      run.startedAt = line.t
      run.status = 'running'
      run.ready = startNodes(run.graph)
      return null
    case 'node-start':
      run.steps += 1
      if (line.agent) run.agents += 1
      run.visits[line.node] = line.visit
      run.ready = run.ready.filter((n) => n !== line.node)
      run.active.set(line.node, {
        node: line.node,
        visit: line.visit,
        attempt: line.attempt,
        phase: 'running',
        input: line.input,
        startedAt: line.t,
      })
      return null
    case 'node-wait': {
      const active = run.active.get(line.node)
      if (!active) return null
      active.phase = 'waiting'
      active.wait = line.wait
      if (line.started) active.started = line.started
      run.history.set(line.node, {
        node: line.node,
        ...(line.started ? { started: line.started } : {}),
      })
      return null
    }
    case 'node-end': {
      const active = run.active.get(line.node)
      run.active.delete(line.node)
      if (line.writes) run.state = applyWrites(run.state, line.writes)
      run.history.set(line.node, {
        node: line.node,
        ...(active?.started ? { started: active.started } : {}),
        ...(line.output ? { output: line.output } : {}),
      })
      run.endsSinceState += 1
      if (line.status === 'failed' && line.error) {
        run.failure = { node: line.node, name: line.error.name, message: line.error.message }
      }
      return null
    }
    case 'edge': {
      const sources = joinOf(run.graph, line.from, line.to)
      if (line.outcome === 'skipped') {
        if (!sources) return null
        return markJoin(run, line.to, sources, line.from, 'skipped') === 'skipped' ? line.to : null
      }
      if (!sources) {
        enqueue(run, line.to)
        return null
      }
      if (markJoin(run, line.to, sources, line.from, 'ended') === 'ready') enqueue(run, line.to)
      return null
    }
    case 'retry': {
      const key = retryKey(line.node, run.visits[line.node] ?? 0, line.rule)
      run.retries.set(key, (run.retries.get(key) ?? 0) + 1)
      const active = run.active.get(line.node)
      if (!active) return null
      active.phase = 'retrying'
      active.retryAt = line.t + line.delayMs
      return null
    }
    case 'state':
      run.state = line.state
      run.endsSinceState = 0
      return null
    case 'run-pause':
      run.paused = true
      run.status = 'paused'
      return null
    case 'run-resume':
      run.paused = false
      run.status = 'running'
      if (line.choice === 'retry') {
        run.failure = null
        for (const key of [...run.retries.keys()]) {
          if (key.startsWith(`${line.node}:`)) run.retries.delete(key)
        }
      }
      return null
    case 'run-interrupted': {
      const active = run.active.get(line.node)
      if (active) active.phase = 'interrupted'
      run.status = 'interrupted'
      return null
    }
    case 'run-end':
      run.status = line.status
      if (line.error) run.failure = line.error
      return null
    case 'node-report':
    case 'reattach':
      return null
  }
}

export function isEnded(status: RunStatus): boolean {
  return ENDED_STATUSES.includes(status)
}

export function replay(id: string, graphName: string, graph: GraphFile, lines: Line[]): RunState {
  const run = newRunState(id, graphName, graph)
  for (const line of lines) applyLine(run, line)
  return run
}

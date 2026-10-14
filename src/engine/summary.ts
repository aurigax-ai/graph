import type { GraphFile } from '../format/model.ts'
import type { NodeWait, Output } from './contract.ts'
import type { Line, NodeFailure, RunKey, RunStatus } from './journal.ts'
import { type RunState, applyLine, newRunState } from './runState.ts'

export interface RunSummary extends RunKey {
  status: RunStatus | 'journal-version'
  startedAt: number
  steps: number
  failure?: NodeFailure
  waitingOn: string[]
  interrupted: string[]
}

export function summarize(
  key: RunKey,
  state: RunState | null,
  error?: 'journal-version',
): RunSummary {
  if (!state)
    return {
      ...key,
      status: error ?? 'failed',
      startedAt: 0,
      steps: 0,
      waitingOn: [],
      interrupted: [],
    }
  const active = [...state.active.values()]
  return {
    ...key,
    status:
      state.status === 'running' && active.length > 0 && active.every((a) => a.phase === 'waiting')
        ? 'waiting'
        : state.status,
    startedAt: state.startedAt,
    steps: state.steps,
    ...(state.failure ? { failure: state.failure } : {}),
    waitingOn: active.filter((a) => a.phase === 'waiting').map((a) => a.node),
    interrupted: active.filter((a) => a.phase === 'interrupted').map((a) => a.node),
  }
}

export interface NodeRunView {
  node: string
  visit: number
  attempt: number
  status:
    | 'running'
    | 'waiting'
    | 'retrying'
    | 'interrupted'
    | 'done'
    | 'caught'
    | 'failed'
    | 'skipped'
    | 'cancelled'
  input: Output
  output?: Output
  error?: { name: string; message: string }
  retries: { attempt: number; delayMs: number; error: string }[]
  wait?: NodeWait
  started?: Output
  stateAfter?: Output
  startedAt: number
  endedAt?: number
}

export interface RunView {
  summary: RunSummary
  state: Output
  nodes: NodeRunView[]
  edges: { from: string; to: string; outcome: 'taken' | 'skipped'; when?: string }[]
}

export function runView(key: RunKey, graph: GraphFile, lines: Line[]): RunView {
  const state = newRunState(key.runId, key.graph, graph)
  const nodes: NodeRunView[] = []
  const edges: RunView['edges'] = []
  const open = new Map<string, NodeRunView>()
  for (const line of lines) {
    applyLine(state, line)
    if (line.type === 'node-start') {
      const view: NodeRunView = {
        node: line.node,
        visit: line.visit,
        attempt: line.attempt,
        status: 'running',
        input: line.input,
        retries: [],
        startedAt: line.t,
      }
      nodes.push(view)
      open.set(line.node, view)
    } else if (line.type === 'node-wait') {
      const view = open.get(line.node)
      if (view) {
        view.status = 'waiting'
        view.wait = line.wait
        if (line.started) view.started = line.started
      }
    } else if (line.type === 'retry') {
      const view = open.get(line.node)
      if (view) {
        view.status = 'retrying'
        view.retries.push({ attempt: line.attempt, delayMs: line.delayMs, error: line.error })
      }
    } else if (line.type === 'run-interrupted') {
      const view = open.get(line.node)
      if (view) view.status = 'interrupted'
    } else if (line.type === 'node-end') {
      const view = open.get(line.node)
      if (view) {
        view.status = line.status
        if (line.output) view.output = line.output
        if (line.error) view.error = line.error
        view.stateAfter = { ...state.state }
        view.endedAt = line.t
        open.delete(line.node)
      }
    } else if (line.type === 'edge') {
      edges.push({
        from: line.from,
        to: line.to,
        outcome: line.outcome,
        ...(line.when ? { when: line.when } : {}),
      })
    }
  }
  return { summary: summarize(key, state), state: state.state, nodes, edges }
}

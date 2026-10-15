import {
  type NodeContext,
  NodeError,
  type NodeKind,
  type NodeResult,
  type NodeWait,
  type Output,
  type StartedRecord,
} from '../engine/contract.ts'
import type { GraphNode } from '../format/model.ts'
import type { RuntimeClient } from './client.ts'
import { TASK_METHOD } from './workers.ts'

export interface WorkerTask {
  op: 'start' | 'resume' | 'reattach' | 'cancel' | 'rearm'
  kind: string
  scope: string
  folder: string | null
  run: NodeContext['run']
  node: GraphNode
  trigger: Output
  timeoutMs: number | null
  history: StartedRecord[]
  input?: Output
  wait?: NodeWait
  started?: Output
  event?: Output
}

function contextOf(task: WorkerTask, host: string): NodeContext {
  return {
    run: task.run,
    host,
    scope: task.scope,
    signal: new AbortController().signal,
    timeoutMs: task.timeoutMs,
    trigger: task.trigger,
    started: (id) => task.history.find((h) => h.node === id) ?? null,
    history: () => task.history,
    node: task.node,
  }
}

function reply(res: NodeResult): Record<string, unknown> {
  return res
}

async function answer(kind: NodeKind, task: WorkerTask, host: string): Promise<unknown> {
  const ctx = contextOf(task, host)
  switch (task.op) {
    case 'start':
      return reply(await kind.start(task.input ?? {}, ctx))
    case 'resume': {
      if (!kind.resume || !task.wait) return { done: {} }
      return reply(await kind.resume(task.wait, task.event ?? {}, ctx))
    }
    case 'reattach': {
      const verdict = kind.reattach
        ? await kind.reattach(task.started, task.wait, ctx)
        : task.wait
          ? 'running'
          : 'lost'
      if (verdict === 'lost') return { lost: true }
      if (verdict === 'running') return task.wait ? { waiting: task.wait } : { lost: true }
      return verdict
    }
    case 'cancel':
      await kind.cancel?.(task.wait, task.started, ctx)
      return { ok: true }
    case 'rearm':
      if (task.wait) await kind.rearm?.(task.wait, task.started, ctx)
      return { ok: true }
  }
}

export function serveKinds(client: RuntimeClient, kinds: readonly NodeKind[], host: string): void {
  client.handle(TASK_METHOD, async (raw) => {
    const task = raw as WorkerTask
    const kind = kinds.find((k) => k.kind === task.kind)
    if (!kind) return { error: { name: 'BadOutput', message: `no ${task.kind} here` } }
    try {
      return await answer(kind, task, host)
    } catch (err) {
      return {
        error: {
          name: err instanceof NodeError ? err.errorName : 'BadOutput',
          message: err instanceof Error ? err.message : String(err),
        },
      }
    }
  })
}

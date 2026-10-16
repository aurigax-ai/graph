import {
  type KindDescriptor,
  type NodeContext,
  NodeError,
  type NodeKind,
  type NodeResult,
  type NodeWait,
  type Output,
  type Reattached,
  type WorkerWait,
} from '../engine/contract.ts'
import { ERROR_NAMES, type ErrorName, isRecord } from '../format/model.ts'
import type { Registry } from './registry.ts'
import { RpcError, type Session } from './server.ts'

export const WORKER_KINDS = ['agent', 'approval', 'notify', 'connector', 'command'] as const
export const WORKERS_PER_SCOPE = 8
export const TASK_METHOD = 'worker.task'

type Op = 'start' | 'resume' | 'reattach' | 'cancel' | 'rearm'

interface Worker {
  session: Session
  kinds: Set<string>
  scopes: Set<string>
}

export class WorkerGone extends Error {}

type Reply =
  | { done: Output }
  | { waiting: NodeWait; started?: Output }
  | { lost: true }
  | { error: { name: string; message: string } }
  | { ok: true }

export class WorkerPool {
  private readonly workers = new Map<number, Worker>()

  constructor(
    private readonly registry: Registry,
    private readonly changed: (scopes: string[], kinds: string[]) => void,
  ) {}

  register(session: Session, kinds: unknown, scopeKeys: string[]): { kinds: string[] } {
    if (!Array.isArray(kinds) || kinds.some((k) => typeof k !== 'string'))
      throw new RpcError('bad-kinds')
    const served = (kinds as string[]).filter((k) =>
      (WORKER_KINDS as readonly string[]).includes(k),
    )
    for (const key of scopeKeys) {
      const others = [...this.workers.values()].filter(
        (w) => w.session.id !== session.id && w.scopes.has(key),
      )
      if (others.length >= WORKERS_PER_SCOPE)
        throw new RpcError(`too-many-workers: at most ${WORKERS_PER_SCOPE} workers in a folder`)
    }
    this.workers.set(session.id, {
      session,
      kinds: new Set(served),
      scopes: new Set(scopeKeys),
    })
    this.changed(scopeKeys, served)
    return { kinds: served }
  }

  drop(session: Session): void {
    const worker = this.workers.get(session.id)
    if (!worker) return
    this.workers.delete(session.id)
    this.changed([...worker.scopes], [])
  }

  serves(kind: string, scopeKey: string): boolean {
    return this.pick(kind, scopeKey) !== null
  }

  private pick(kind: string, scopeKey: string): Worker | null {
    for (const worker of this.workers.values())
      if (worker.kinds.has(kind) && worker.scopes.has(scopeKey)) return worker
    return null
  }

  list(): { client: string; kinds: string[]; scopes: string[] }[] {
    return [...this.workers.values()].map((w) => ({
      client: w.session.client,
      kinds: [...w.kinds],
      scopes: [...w.scopes].map((key) => this.registry.byKey(key)?.id ?? key),
    }))
  }

  async task(
    kind: string,
    op: Op,
    ctx: NodeContext,
    extra: Record<string, unknown>,
  ): Promise<Reply> {
    const worker = this.pick(kind, ctx.scope)
    if (!worker) throw new WorkerGone('no worker')
    const scope = this.registry.byKey(ctx.scope)
    let reply: unknown
    try {
      reply = await worker.session.request(TASK_METHOD, {
        op,
        kind,
        scope: scope?.id ?? ctx.scope,
        folder: scope?.folder ?? null,
        run: ctx.run,
        node: ctx.node,
        trigger: ctx.trigger,
        timeoutMs: ctx.timeoutMs,
        history: ctx.history(),
        input: ctx.input,
        ...extra,
      })
    } catch {
      throw new WorkerGone('the worker went away')
    }
    if (!isRecord(reply)) throw new NodeError('BadOutput', 'the worker answered nothing')
    return reply as Reply
  }
}

function pending(
  kind: string,
  ctx: NodeContext,
  what: Pick<WorkerWait, 'pending' | 'input' | 'started' | 'wait' | 'event'>,
): NodeResult {
  return { waiting: { on: 'worker', kind, scope: ctx.scope, ...what } }
}

function result(reply: Reply): NodeResult {
  if ('done' in reply) return { done: reply.done }
  if ('waiting' in reply)
    return { waiting: reply.waiting, ...(reply.started ? { started: reply.started } : {}) }
  if ('error' in reply) {
    const name = (ERROR_NAMES as readonly string[]).includes(reply.error.name)
      ? (reply.error.name as ErrorName)
      : 'BadOutput'
    throw new NodeError(name, String(reply.error.message))
  }
  throw new NodeError('BadOutput', 'the worker gave no result')
}

export interface WorkerKindOptions {
  descriptor: KindDescriptor
  pool: WorkerPool
  headless?: NodeKind
  sandboxed: (scopeKey: string) => boolean
}

export function workerKind(opts: WorkerKindOptions): NodeKind {
  const { descriptor, pool, headless } = opts
  const kind = descriptor.kind
  const local = (ctx: NodeContext) =>
    headless !== undefined && !opts.sandboxed(ctx.scope) && !pool.serves(kind, ctx.scope)
  const refuse = (ctx: NodeContext) => {
    if (kind === 'connector' && opts.sandboxed(ctx.scope))
      throw new NodeError('ConnectorFailed', 'connectors do not run in a sandboxed workspace')
  }

  const start = async (input: Output, ctx: NodeContext): Promise<NodeResult> => {
    refuse(ctx)
    if (local(ctx)) return (headless as NodeKind).start(input, ctx)
    try {
      return result(await pool.task(kind, 'start', ctx, { input }))
    } catch (err) {
      if (!(err instanceof WorkerGone)) throw err
      return pending(kind, ctx, {
        pending: err.message === 'no worker' ? 'start' : 'reattach',
        input,
      })
    }
  }

  const startedOf = (ctx: NodeContext) => ctx.started(ctx.run.node)?.started
  const gone = (ctx: NodeContext, what: Pick<WorkerWait, 'pending' | 'wait' | 'event'>) => {
    const started = startedOf(ctx)
    return pending(kind, ctx, { ...what, input: ctx.input, ...(started ? { started } : {}) })
  }

  const reattachThrough = async (wait: WorkerWait, ctx: NodeContext): Promise<NodeResult> => {
    try {
      const reply = await pool.task(kind, 'reattach', ctx, {
        ...(wait.wait ? { wait: wait.wait } : {}),
        ...(wait.started ? { started: wait.started } : {}),
      })
      if ('lost' in reply) {
        if (wait.started && (ctx.node.once ?? descriptor.once))
          throw new NodeError('AgentGone', `${ctx.run.node} was lost while its worker was away`)
        return start(wait.input ?? ctx.input, ctx)
      }
      return result(reply)
    } catch (err) {
      if (!(err instanceof WorkerGone)) throw err
      return pending(kind, ctx, wait)
    }
  }

  const resume = async (wait: NodeWait, event: Output, ctx: NodeContext): Promise<NodeResult> => {
    if (wait.on === 'worker') {
      if (wait.pending === 'start') return start(wait.input ?? ctx.input, ctx)
      if (wait.pending === 'reattach') return reattachThrough(wait, ctx)
      return resume(wait.wait as NodeWait, wait.event ?? {}, ctx)
    }
    refuse(ctx)
    if (local(ctx) && headless?.resume) return headless.resume(wait, event, ctx)
    try {
      return result(await pool.task(kind, 'resume', ctx, { wait, event }))
    } catch (err) {
      if (!(err instanceof WorkerGone)) throw err
      return gone(ctx, {
        pending: err.message === 'no worker' ? 'resume' : 'reattach',
        wait,
        event,
      })
    }
  }

  const reattach = async (
    started: Output | undefined,
    wait: NodeWait | undefined,
    ctx: NodeContext,
  ): Promise<Reattached> => {
    if (wait?.on === 'worker') return 'running'
    if (local(ctx)) return headless?.reattach ? headless.reattach(started, wait, ctx) : 'lost'
    try {
      const reply = await pool.task(kind, 'reattach', ctx, {
        ...(wait ? { wait } : {}),
        ...(started ? { started } : {}),
      })
      if ('lost' in reply) return 'lost'
      if ('done' in reply) return { done: reply.done }
      if ('waiting' in reply)
        return { waiting: reply.waiting, ...(reply.started ? { started: reply.started } : {}) }
      return 'lost'
    } catch (err) {
      if (!(err instanceof WorkerGone)) return 'lost'
      if (wait) return 'running'
      return gone(ctx, { pending: 'reattach' }) as { waiting: NodeWait }
    }
  }

  const quiet =
    (op: 'cancel' | 'rearm') =>
    async (wait: NodeWait | undefined, started: Output | undefined, ctx: NodeContext) => {
      if (wait?.on === 'worker') return
      if (local(ctx)) {
        await (op === 'cancel' ? headless?.cancel : headless?.rearm)?.(
          wait as NodeWait,
          started,
          ctx,
        )
        return
      }
      await pool
        .task(kind, op, ctx, { ...(wait ? { wait } : {}), ...(started ? { started } : {}) })
        .catch(() => {})
    }

  return {
    kind,
    version: descriptor.version,
    start,
    resume,
    reattach,
    cancel: quiet('cancel'),
    rearm: quiet('rearm'),
  }
}

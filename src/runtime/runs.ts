import { join } from 'node:path'
import { realClock, runProcess } from '../cli/headlessHost.ts'
import type { Clock, Host, Notice, Output } from '../engine/contract.ts'
import { Engine, missingKinds } from '../engine/engine.ts'
import { FileJournalStore } from '../engine/fileStore.ts'
import { manualInputKeys, parseInputs } from '../engine/inputs.ts'
import type { Line, RunKey } from '../engine/journal.ts'
import { isEnded } from '../engine/runState.ts'
import { type RunSummary, runView } from '../engine/summary.ts'
import { type GraphFile, isRecord, triggerKind } from '../format/model.ts'
import { commandNode } from '../kinds/command.ts'
import { routerNode, waitNode } from '../kinds/smallKinds.ts'
import { type Listing, Registry, type Scope } from './registry.ts'
import type { Part, Runtime } from './runtime.ts'
import { RpcError, type Session } from './server.ts'

export const RUNS_FOLDER = 'runs'
export const RUNTIME_TRIGGERS = ['manual']
const HEADLESS_KINDS = new Set(['command'])
const CONTROL_ACTIONS = ['pause', 'resume', 'cancel', 'retry', 'rerun', 'skip', 'continue'] as const
type ControlAction = (typeof CONTROL_ACTIONS)[number]

function params(raw: unknown): Record<string, unknown> {
  return isRecord(raw) ? raw : {}
}

function manualOf(graph: GraphFile): { agents?: boolean; input?: string[] } | null {
  const trigger = graph.on.find((t) => triggerKind(t) === 'manual') as
    | { manual: { agents?: boolean; input?: string[] } }
    | undefined
  return trigger ? trigger.manual : null
}

export function listingView(listing: Listing): Record<string, unknown> {
  const manual = listing.loaded ? manualOf(listing.loaded.graph) : null
  return {
    scope: listing.scope,
    name: listing.name,
    path: listing.path,
    state: listing.state,
    ...(listing.loaded ? { fingerprint: listing.loaded.fingerprint } : {}),
    ...(manual
      ? {
          manual: {
            agents: manual.agents === true,
            input: listing.loaded ? manualInputKeys(listing.loaded.graph) : [],
          },
        }
      : {}),
    problems: listing.problems,
  }
}

export class RuntimeRuns implements Part {
  readonly registry: Registry
  readonly engine: Engine
  private readonly owned = new Map<number, Set<string>>()
  private readonly groups = new Set<number>()

  constructor(
    private readonly runtime: Runtime,
    clock: Clock = realClock,
  ) {
    this.registry = new Registry(runtime.paths.data, () => clock.now())
    const host: Host = {
      name: 'wire-runtime',
      contract: 1,
      kinds: [
        commandNode((req) => {
          const scope = this.registry.byKey(req.scope)
          if (!scope || scope.sandboxed)
            return Promise.resolve({
              exitCode: -1,
              stdout: '',
              stderr: 'no folder for this command',
              timedOut: false,
              truncated: false,
            })
          return runProcess(scope.folder, process.env, this.groups)(req)
        }),
        routerNode,
        waitNode(() => clock.now()),
      ],
      triggers: RUNTIME_TRIGGERS,
      clock,
      notify: (notice) => this.notice(notice),
    }
    this.engine = new Engine({
      host,
      store: new FileJournalStore(join(runtime.paths.data, RUNS_FOLDER), () => clock.now()),
      changed: (runId, line) => this.changed(runId, line),
    })
    this.register()
  }

  busy(): boolean {
    return this.engine.active().length > 0
  }

  async drain(deadline: number): Promise<void> {
    this.engine.hold()
    while (this.engine.running() && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50))
    for (const pid of this.groups) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {}
    }
  }

  async recover(): Promise<void> {
    for (const scope of this.registry.all()) await this.engine.recover(scope.key)
  }

  private scopeOfKey(key: string): string {
    return this.registry.byKey(key)?.id ?? key
  }

  private notice(notice: Notice): void {
    if (!notice.graph) return
    this.runtime.server.broadcast('graph.changed', {
      scope: notice.scope ? this.scopeOfKey(notice.scope) : null,
      name: notice.graph,
      notice: { title: notice.title, ...(notice.body ? { body: notice.body } : {}) },
      ...(notice.run ? { runId: notice.run } : {}),
    })
  }

  private changed(runId: string, line?: Line): void {
    const run = this.engine.run(runId)
    if (run) {
      const scope = this.scopeOfKey(run.state.scope)
      if (line && 'node' in line && line.type.startsWith('node-'))
        this.runtime.server.broadcast('node.changed', {
          scope,
          runId,
          node: line.node,
          type: line.type,
        })
      this.runtime.server.broadcast('run.changed', {
        scope,
        runId,
        graph: run.state.graphName,
        status: run.state.status,
      })
    }
    if (!run || isEnded(run.state.status)) this.runtime.touch()
  }

  private graphChanged(listing: Listing): void {
    this.runtime.server.broadcast('graph.changed', {
      scope: listing.scope,
      name: listing.name,
      state: listing.state,
    })
  }

  private ownedBy(session: Session): Set<string> {
    const found = this.owned.get(session.id) ?? new Set<string>()
    if (!this.owned.has(session.id)) {
      this.owned.set(session.id, found)
      this.runtime.server.onClose(session, () => this.owned.delete(session.id))
    }
    return found
  }

  private ownScope(session: Session, id: unknown): Scope {
    const scope = this.registry.scope(id)
    if (!this.ownedBy(session).has(scope.key)) throw new RpcError('unknown-scope')
    return scope
  }

  private summary(s: RunSummary): Record<string, unknown> {
    return { ...s, scope: this.scopeOfKey(s.scope) }
  }

  private register(): void {
    const { server } = this.runtime
    server.method('scopes.register', 'observe', (raw, session) => {
      const p = params(raw)
      const scope = this.registry.register(p.folder, {
        scratch: p.scratch,
        ...(session.rights.has('worker') ? { sandboxed: p.sandboxed } : {}),
      })
      this.ownedBy(session).add(scope.key)
      void this.engine.recover(scope.key)
      return { scope: scope.id, folder: scope.folder, sandboxed: scope.sandboxed }
    })
    server.method('graphs.load', 'observe', (raw, session) => {
      const p = params(raw)
      const listing = this.registry.load(this.ownScope(session, p.scope), p.path)
      this.graphChanged(listing)
      return listingView(listing)
    })
    server.method('graphs.unload', 'observe', (raw, session) => {
      const p = params(raw)
      const scope = this.ownScope(session, p.scope)
      this.registry.unload(scope, p.name)
      this.runtime.server.broadcast('graph.changed', { scope: scope.id, name: p.name, state: null })
      return { ok: true }
    })
    server.method('graphs.list', 'observe', (raw) => {
      const scope = this.registry.scope(params(raw).scope)
      return this.registry.listings(scope).map(listingView)
    })
    server.method('graphs.enable', 'enable', (raw) => {
      const p = params(raw)
      const scope = this.registry.scope(p.scope)
      const listing = this.registry.listing(scope, String(p.name))
      const problem = this.problem(scope, listing)
      if (problem) throw new RpcError(problem)
      this.registry.enable(listing, p.fingerprint)
      const now = this.registry.listing(scope, listing.name)
      this.graphChanged(now)
      return listingView(now)
    })
    server.method('graphs.disable', 'enable', (raw) => {
      const p = params(raw)
      const scope = this.registry.scope(p.scope)
      const listing = this.registry.listing(scope, String(p.name))
      this.registry.disable(listing.scope, listing.realPath)
      const now = this.registry.listing(scope, listing.name)
      this.graphChanged(now)
      return listingView(now)
    })
    server.method('runs.list', 'observe', async (raw) => {
      const scope = this.registry.scope(params(raw).scope)
      return (await this.engine.summaries(scope.key)).map((s) => this.summary(s))
    })
    server.method('runs.show', 'observe', async (raw) => {
      const p = params(raw)
      const scope = this.registry.scope(p.scope)
      const key = (await this.engine.summaries(scope.key)).find((s) => s.runId === p.runId)
      if (!key) throw new RpcError('unknown-run')
      return this.view(scope, key, typeof p.node === 'string' ? p.node : undefined)
    })
    server.method('runs.start', 'start', (raw, session) => this.start(params(raw), session))
    server.method('runs.control', 'control', (raw) => this.control(params(raw)))
  }

  private problem(scope: Scope, listing: Listing): string | null {
    if (!listing.loaded)
      return `invalid: ${listing.problems[0]?.message ?? 'the file does not load'}`
    const missing = missingKinds(listing.loaded.graph, this.engine.host)
    if (missing[0]) return `${missing[0].code}: ${missing[0].message}`
    if (scope.sandboxed && listing.loaded.graph.nodes.some((n) => HEADLESS_KINDS.has(n.kind)))
      return 'sandboxed: a command in a sandboxed folder runs only through its host'
    return null
  }

  private async view(scope: Scope, key: RunKey, node?: string): Promise<Record<string, unknown>> {
    const stored = await this.engine.storeOf().read({ ...key, scope: scope.key })
    const graph = (stored?.definition as { graph?: GraphFile } | undefined)?.graph
    if (!stored || !graph) throw new RpcError('unknown-run')
    const view = runView({ ...key, scope: scope.key }, graph, stored.lines)
    const nodes = node ? view.nodes.filter((n) => n.node === node) : view.nodes
    return { ...view, scope: scope.id, nodes }
  }

  private async start(p: Record<string, unknown>, session: Session): Promise<unknown> {
    const scope = this.ownScope(session, p.scope)
    const listing = this.registry.listing(scope, String(p.name))
    if (!listing.loaded)
      throw new RpcError(`invalid: ${listing.problems[0]?.message ?? 'the file does not load'}`)
    if (listing.state !== 'enabled')
      throw new RpcError(`not-enabled: ${listing.name} is enabled only by the human, in Ostia`)
    const manual = manualOf(listing.loaded.graph)
    if (!manual) throw new RpcError(`no-manual-trigger: ${listing.name} has no manual trigger`)
    const byHuman = session.rights.has('control') && p.by === 'human'
    if (!byHuman && manual.agents !== true)
      throw new RpcError(
        `not-for-agents: ${listing.name} does not let agents start it (its manual trigger has no agents: true)`,
      )
    const problem = this.problem(scope, listing)
    if (problem) throw new RpcError(problem)
    const pairs = Array.isArray(p.inputs) ? p.inputs.filter((x) => typeof x === 'string') : []
    const input = parseInputs(
      listing.loaded.graph,
      pairs,
      isRecord(p.input) ? JSON.stringify(p.input) : undefined,
    )
    if (!input.ok) throw new RpcError(`${input.problem.code}: ${input.problem.message}`)
    const trigger: Output = { kind: 'manual', by: byHuman ? 'human' : 'agent' }
    const res = await this.engine.start(
      scope.key,
      {
        name: listing.name,
        graph: listing.loaded.graph,
        fingerprint: listing.loaded.fingerprint,
      },
      trigger,
      input.input,
    )
    if (!res.ok) throw new RpcError(`${res.error}: ${res.message}`)
    return 'runId' in res ? { runId: res.runId } : { queued: true }
  }

  private async control(p: Record<string, unknown>): Promise<unknown> {
    const scope = this.registry.scope(p.scope)
    const action = p.action as ControlAction
    if (!CONTROL_ACTIONS.includes(action)) throw new RpcError('bad-action')
    const run = typeof p.runId === 'string' ? this.engine.run(p.runId) : undefined
    if (!run || run.state.scope !== scope.key) throw new RpcError('unknown-run')
    switch (action) {
      case 'pause':
        await run.pause()
        return { ok: true }
      case 'resume':
        await run.resume()
        return { ok: true }
      case 'cancel':
        await run.cancel()
        return { ok: true }
      case 'retry':
        return { ok: await run.retry() }
      default:
        if (typeof p.node !== 'string') throw new RpcError('bad-node')
        return { ok: await run.resolve(p.node, action) }
    }
  }
}

import { type ChildProcess, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NodeKind } from '../engine/contract.ts'
import {
  FakeClock,
  type FakeHostState,
  fakeAgentKind,
  fakeApprovalKind,
  testEnv,
} from '../engine/fakeHost.ts'
import { RuntimeClient } from './client.ts'
import { PAIRING_MS } from './pairing.ts'
import type { RuntimePaths } from './paths.ts'
import { scopeKey } from './registry.ts'
import type { Runtime, RuntimeOptions } from './runtime.ts'
import { cliClient, pairedClient, runtimePlace, testRuntime } from './testRuntime.ts'
import { RIGHTS, type Right, Tokens } from './tokens.ts'
import { type WorkerTask, serveKinds } from './workerClient.ts'

const BIN = join(import.meta.dirname, '..', '..', 'dist', 'cli', 'bin.js')
const children: ChildProcess[] = []
const runtimes: Runtime[] = []
const clients: RuntimeClient[] = []

afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
  for (const runtime of runtimes.splice(0)) await runtime.stop()
})

const graph = (nodes: string, edges = 'edges: []') => `version: 1
on: [{ manual: { agents: true } }]
start: a
state: { n: { type: integer, default: 0 } }
nodes:
${nodes}
${edges}
`

const AGENT = '  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: p } }'
const AGENT_THEN_ASK = graph(
  `${AGENT}\n  - { id: ok, kind: approval, with: { question: "ok?" } }`,
  'edges:\n  - { from: a, to: ok }',
)
const ASK = graph('  - { id: a, kind: approval, with: { question: "ok?" } }')
const TIMED_AGENT = graph(
  '  - { id: a, kind: agent, timeout: 1s, with: { mode: start, agent: claude, prompt: p } }',
)
const WAIT_THEN_AGENT = graph(
  '  - { id: a, kind: wait, with: { for: 1s } }\n  - { id: b, kind: agent, with: { mode: start, agent: claude, prompt: p } }',
  'edges:\n  - { from: a, to: b }',
)

function folderWith(graphs: Record<string, string>): string {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'wrt-folder-')))
  mkdirSync(join(folder, 'graphs'))
  for (const [name, text] of Object.entries(graphs))
    writeFileSync(join(folder, 'graphs', `${name}.yaml`), text)
  return folder
}

async function track<T extends RuntimeClient>(client: Promise<T>): Promise<T> {
  const c = await client
  clients.push(c)
  return c
}

async function started(paths: RuntimePaths, opts: RuntimeOptions = {}): Promise<Runtime> {
  const runtime = await testRuntime(paths, opts)
  runtimes.push(runtime)
  return runtime
}

async function enabled(c: RuntimeClient, folder: string, names: string[]): Promise<string> {
  const { scope } = await c.call<{ scope: string }>('scopes.register', { folder })
  for (const name of names) {
    const g = await c.call<{ fingerprint: string }>('graphs.load', {
      scope,
      path: join(folder, 'graphs', `${name}.yaml`),
    })
    await c.call('graphs.enable', { scope, name, fingerprint: g.fingerprint })
  }
  return scope
}

function hostState(): FakeHostState {
  return testEnv()
}

async function worker(
  connect: () => Promise<RuntimeClient>,
  folder: string,
  kinds: NodeKind[],
  opts: { sandboxed?: boolean; tasks?: WorkerTask[] } = {},
): Promise<{ c: RuntimeClient; tasks: WorkerTask[] }> {
  const c = await track(connect())
  const tasks = opts.tasks ?? []
  const served: NodeKind[] = kinds.map((k) => ({
    ...k,
    start: (input, ctx) => {
      tasks.push({ op: 'start', kind: k.kind, run: ctx.run } as WorkerTask)
      return k.start(input, ctx)
    },
    reattach: async (startedAt, wait, ctx) => {
      tasks.push({ op: 'reattach', kind: k.kind, run: ctx.run } as WorkerTask)
      return k.reattach ? k.reattach(startedAt, wait, ctx) : wait ? 'running' : 'lost'
    },
  }))
  serveKinds(c, served, 'ostia')
  const { scope } = await c.call<{ scope: string }>('scopes.register', {
    folder,
    ...(opts.sandboxed !== undefined ? { sandboxed: opts.sandboxed } : {}),
  })
  await c.call('worker.register', { kinds: kinds.map((k) => k.kind), scopes: [scope] })
  return { c, tasks }
}

async function until(check: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 25))
  }
}

function journal(paths: RuntimePaths, scope: string, name: string, runId: string) {
  const path = join(paths.data, 'runs', scopeKey(scope), name, runId, 'journal.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as { type: string; node?: string; status?: string; wait?: { on: string } },
    )
}

async function status(c: RuntimeClient, scope: string, runId: string): Promise<string | undefined> {
  const runs = await c.call<{ runId: string; status: string }[]>('runs.list', { scope })
  return runs.find((r) => r.runId === runId)?.status
}

async function nodeStatus(c: RuntimeClient, scope: string, runId: string, node: string) {
  const run = await c.call<{ nodes: { node: string; status: string }[] }>('runs.show', {
    scope,
    runId,
  })
  return run.nodes.filter((n) => n.node === node).at(-1)?.status
}

function wire(env: NodeJS.ProcessEnv, args: string[], cwd?: string): ChildProcess {
  const child = spawn(process.execPath, [BIN, ...args], {
    env,
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  return child
}

function output(child: ChildProcess): Promise<{ code: number | null; stdout: string }> {
  let stdout = ''
  child.stdout?.on('data', (chunk) => {
    stdout += chunk
  })
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, stdout })))
}

const WORKER_RIGHTS: Right[] = ['observe', 'worker', 'ingest']

describe('workers and pairing', () => {
  it('GRF-C203 agent and approval steps go to the registered worker, its answers advance the run, and the journal holds the same lines as with an in-process host', async () => {
    const { paths } = runtimePlace()
    const runtime = await started(paths)
    const folder = folderWith({ g: AGENT_THEN_ASK })
    const panel = await track(pairedClient(runtime, 'panel', RIGHTS))
    const scope = await enabled(panel, folder, ['g'])
    const state = hostState()
    const ostia = await worker(() => pairedClient(runtime, 'ostia', WORKER_RIGHTS), folder, [
      fakeAgentKind(state),
      fakeApprovalKind(state),
    ])
    const { runId } = await panel.call<{ runId: string }>('runs.start', { scope, name: 'g' })
    await until(() => state.agents.length === 1)
    await ostia.c.call('events.push', {
      scope,
      event: { type: 'agent-stop', pane: state.agents[0]?.pane },
    })
    await until(() => state.asks.length === 1)
    await ostia.c.call('events.push', {
      scope,
      event: { type: 'answer', key: state.asks[0]?.key, answer: 'yes', outcome: 'answered' },
    })
    await until(async () => (await status(panel, scope, runId)) === 'done')
    expect(ostia.tasks.map((t) => `${t.op}:${t.kind}`)).toEqual(['start:agent', 'start:approval'])

    const env = testEnv()
    const local = await env.start(AGENT_THEN_ASK)
    await new Promise((r) => setTimeout(r, 20))
    await env.stop(env.agents[0]?.pane as string)
    await env.answer('yes')
    const shape = (lines: { type: string; node?: string }[]) =>
      lines.map((l) => `${l.type}${l.node ? `:${l.node}` : ''}`)
    const there = (await env.store.read({ scope: 'w1', graph: 'g', runId: local }))?.lines ?? []
    expect(shape(journal(paths, scope, 'g', runId))).toEqual(shape(there))
  })

  it('GRF-C204 with no worker an agent step is pending and its timeout does not run; a worker registering starts it once; a worker gone mid-step is reattached through the next, not started twice', async () => {
    const { paths } = runtimePlace()
    const runtime = await started(paths)
    const folder = folderWith({ timed: TIMED_AGENT, g: graph(AGENT) })
    const panel = await track(pairedClient(runtime, 'panel', RIGHTS))
    const scope = await enabled(panel, folder, ['timed', 'g'])
    const first = await panel.call<{ runId: string }>('runs.start', { scope, name: 'timed' })
    await until(async () => (await nodeStatus(panel, scope, first.runId, 'a')) === 'pending')
    await new Promise((r) => setTimeout(r, 1_500))
    expect(await nodeStatus(panel, scope, first.runId, 'a')).toBe('pending')
    const state = hostState()
    const ostia = await worker(() => pairedClient(runtime, 'ostia', WORKER_RIGHTS), folder, [
      fakeAgentKind(state),
    ])
    await until(() => state.agents.length === 1)
    await new Promise((r) => setTimeout(r, 200))
    expect(state.agents).toHaveLength(1)
    await ostia.c.call('events.push', {
      scope,
      event: { type: 'agent-stop', pane: state.agents[0]?.pane },
    })
    await until(async () => (await status(panel, scope, first.runId)) === 'done')
    ostia.c.close()

    const hanging = await track(pairedClient(runtime, 'hang', WORKER_RIGHTS))
    let asked = 0
    hanging.handle('worker.task', () => {
      asked += 1
      return new Promise(() => {})
    })
    await hanging.call('scopes.register', { folder })
    await hanging.call('worker.register', { kinds: ['agent'], scopes: [scope] })
    const second = await panel.call<{ runId: string }>('runs.start', { scope, name: 'g' })
    await until(() => asked === 1)
    hanging.close()
    await until(async () => (await nodeStatus(panel, scope, second.runId, 'a')) === 'pending')
    const tasks: WorkerTask[] = []
    const later = hostState()
    const back = await worker(
      () => pairedClient(runtime, 'ostia', WORKER_RIGHTS),
      folder,
      [
        {
          ...fakeAgentKind(later),
          reattach: async () => ({
            waiting: { on: 'event', match: { type: 'agent-stop', pane: 'pane-1' } },
            started: { pane: 'pane-1' },
          }),
        },
      ],
      { tasks },
    )
    await until(() => tasks.length === 1)
    expect(tasks.map((t) => t.op)).toEqual(['reattach'])
    await back.c.call('events.push', { scope, event: { type: 'agent-stop', pane: 'pane-1' } })
    await until(async () => (await status(panel, scope, second.runId)) === 'done')
    expect(later.agents).toEqual([])
  })

  it('GRF-C205 in a sandboxed folder a command goes only to the worker and a connector fails ConnectorFailed', async () => {
    const { paths } = runtimePlace()
    const runtime = await started(paths)
    const folder = folderWith({})
    const mark = join(folder, 'ran')
    writeFileSync(
      join(folder, 'graphs', 'g.yaml'),
      graph(
        `  - { id: a, kind: command, with: { run: [touch, ${JSON.stringify(mark)}] } }\n  - { id: b, kind: connector, with: { use: "mcp:fake/echo" } }`,
        'edges:\n  - { from: a, to: b }',
      ),
    )
    const panel = await track(pairedClient(runtime, 'panel', RIGHTS))
    const scope = await enabled(panel, folder, ['g'])
    const commands: WorkerTask[] = []
    const ostia = await track(pairedClient(runtime, 'ostia', WORKER_RIGHTS))
    ostia.handle('worker.task', (raw) => {
      const task = raw as WorkerTask
      commands.push(task)
      return { done: { exit: 0, stdout: '', stderr: '', timedOut: false, truncated: false } }
    })
    await ostia.call('scopes.register', { folder, sandboxed: true })
    await ostia.call('worker.register', { kinds: ['command', 'connector'], scopes: [scope] })
    const { runId } = await panel.call<{ runId: string }>('runs.start', { scope, name: 'g' })
    await until(async () => (await status(panel, scope, runId)) === 'failed')
    expect(commands.map((t) => `${t.op}:${t.kind}`)).toEqual(['start:command'])
    expect(existsSync(mark)).toBe(false)
    const run = await panel.call<{ summary: { failure?: { name: string; message: string } } }>(
      'runs.show',
      {
        scope,
        runId,
      },
    )
    expect(run.summary.failure).toMatchObject({
      name: 'ConnectorFailed',
      message: 'connectors do not run in a sandboxed workspace',
    })
  })

  it('GRF-C213 a pairing the client confirms returns its token once, and the token works on the next connection', async () => {
    const { paths } = runtimePlace()
    await started(paths)
    const cli = await track(cliClient(paths))
    const { id } = await cli.call<{ id: string }>('pair.request', {
      client: 'ostia',
      rights: ['enable', 'control', 'observe'],
    })
    const paired = await cli.call<{ token: string; rights: string[] }>('pair.confirm', { id })
    expect(paired.rights).toEqual(['enable', 'control', 'observe'])
    await expect(cli.call('pair.confirm', { id })).rejects.toThrow('unknown-pairing')
    const next = await track(RuntimeClient.connect({ socket: paths.socket, token: paired.token }))
    expect(next.hello).toMatchObject({ client: 'ostia', rights: ['enable', 'control', 'observe'] })
    expect(readFileSync(join(paths.data, 'tokens.json'), 'utf8')).not.toContain(paired.token)
  })

  it('GRF-C214 a pairing confirmed from another connection, after 2 minutes or twice issues no token', async () => {
    const { paths } = runtimePlace()
    const clock = new FakeClock(Date.UTC(2026, 9, 15, 12, 0, 0))
    await started(paths, { clock })
    const one = await track(cliClient(paths))
    const two = await track(cliClient(paths))
    const ask = () =>
      one.call<{ id: string }>('pair.request', { client: 'ostia', rights: ['enable'] })
    const elsewhere = await ask()
    await expect(two.call('pair.confirm', { id: elsewhere.id })).rejects.toThrow('unknown-pairing')
    const late = await ask()
    await clock.advance(PAIRING_MS + 1)
    await expect(one.call('pair.confirm', { id: late.id })).rejects.toThrow('pairing-expired')
    const twice = await ask()
    await one.call('pair.confirm', { id: twice.id })
    await expect(one.call('pair.confirm', { id: twice.id })).rejects.toThrow('unknown-pairing')
    const records = JSON.parse(readFileSync(join(paths.data, 'tokens.json'), 'utf8')) as {
      client: string
    }[]
    expect(records.filter((r) => r.client === 'ostia')).toHaveLength(1)
  })

  it('GRF-C221 with the daemon running and Ostia closed, an agent starts a graph whose wait ends and whose agent step waits pending until Ostia connects and starts it once', async () => {
    const { env, paths } = runtimePlace()
    const runtime = await started(paths, { daemon: true })
    const folder = folderWith({ g: WAIT_THEN_AGENT })
    const panel = await track(pairedClient(runtime, 'panel', RIGHTS))
    const scope = await enabled(panel, folder, ['g'])
    panel.close()
    const start = await output(wire(env, ['start', 'g'], folder))
    const { runId } = JSON.parse(start.stdout) as { runId: string }
    const lines = () => journal(paths, scope, 'g', runId)
    await until(() =>
      lines().some((l) => l.type === 'node-wait' && l.node === 'b' && l.wait?.on === 'worker'),
    )
    expect(lines().find((l) => l.type === 'node-end' && l.node === 'a')?.status).toBe('done')
    const state = hostState()
    await worker(() => pairedClient(runtime, 'ostia', WORKER_RIGHTS), folder, [
      fakeAgentKind(state),
    ])
    await until(() => state.agents.length === 1)
    await new Promise((r) => setTimeout(r, 200))
    expect(state.agents).toHaveLength(1)
    expect(state.agents[0]?.node).toBe('b')
  })

  it('GRF-C194 a runtime killed while a run waits on an approval asks it again once the worker is back', async () => {
    const { env, paths } = runtimePlace()
    const folder = folderWith({ ask: ASK })
    const daemon = wire(env, ['runtime', 'start', '--foreground', '--daemon'])
    const token = await (async () => {
      await until(async () => {
        try {
          ;(await cliClient(paths)).close()
          return true
        } catch {
          return false
        }
      })
      const issued = new Tokens(paths.data).issue('ostia', RIGHTS)
      daemon.kill('SIGHUP')
      return issued
    })()
    const connect = async () => {
      const deadline = Date.now() + 5_000
      for (;;) {
        try {
          return await RuntimeClient.connect({ socket: paths.socket, token })
        } catch (err) {
          if (Date.now() > deadline) throw err
          await new Promise((r) => setTimeout(r, 25))
        }
      }
    }
    const state = hostState()
    const ostia = await worker(connect, folder, [fakeApprovalKind(state)])
    const scope = await enabled(ostia.c, folder, ['ask'])
    const { runId } = await ostia.c.call<{ runId: string }>('runs.start', { scope, name: 'ask' })
    await until(() => state.asks.length === 1)
    daemon.kill('SIGKILL')
    await until(() => daemon.exitCode !== null || daemon.signalCode !== null)
    ostia.c.close()
    const later = await started(paths)
    void later
    const back = await worker(connect, folder, [fakeApprovalKind(state)])
    await until(() => state.asks.length === 2)
    expect(state.asks[1]?.key).toBe(state.asks[0]?.key)
    await back.c.call('events.push', {
      scope,
      event: { type: 'answer', key: state.asks[0]?.key, answer: 'yes', outcome: 'answered' },
    })
    await until(async () => (await status(back.c, scope, runId)) === 'done')
  })

  it('GRF-C200 the CLI token cannot register as a worker, pause a run or enable a graph', async () => {
    const { paths } = runtimePlace()
    const runtime = await started(paths)
    const folder = folderWith({ g: ASK })
    const panel = await track(pairedClient(runtime, 'panel', RIGHTS))
    const scope = await enabled(panel, folder, ['g'])
    const cli = await track(cliClient(paths))
    await cli.call('scopes.register', { folder })
    await expect(
      cli.call('worker.register', { kinds: ['agent'], scopes: [scope] }),
    ).rejects.toThrow('needs-right: worker')
    const { runId } = await cli.call<{ runId: string }>('runs.start', { scope, name: 'g' })
    await expect(cli.call('runs.control', { scope, runId, action: 'pause' })).rejects.toThrow(
      'needs-right: control',
    )
    await expect(cli.call('graphs.disable', { scope, name: 'g' })).rejects.toThrow(
      'needs-right: enable',
    )
    await expect(
      cli.call('events.push', { scope, event: { type: 'worker-ready', kind: 'agent', scope } }),
    ).rejects.toThrow('reserved-event')
  })
})

import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeClient } from './client.ts'
import { lockHeld } from './lock.ts'
import type { RuntimePaths } from './paths.ts'
import { scopeKey } from './registry.ts'
import type { Runtime } from './runtime.ts'
import { cliClient, pairedClient, runtimePlace, testRuntime } from './testRuntime.ts'
import { RIGHTS, Tokens, readCliToken } from './tokens.ts'

const BIN = join(import.meta.dirname, '..', '..', 'dist', 'cli', 'bin.js')
const children: ChildProcess[] = []
const runtimes: Runtime[] = []
const clients: RuntimeClient[] = []

afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
  for (const runtime of runtimes.splice(0)) await runtime.stop()
})

const graph = (nodes: string, edges = 'edges: []', extra = '') => `version: 1
on: [{ manual: { agents: true } }]
start: a
state: { n: { type: integer, default: 0 } }
nodes:
${nodes}
${edges}
${extra}`

const ROUTER = graph('  - { id: a, kind: router }')
const HUMAN_ONLY = ROUTER.replace('{ manual: { agents: true } }', '{ manual: {} }')
const WAIT = graph('  - { id: a, kind: wait, with: { for: 1s } }')
const SLOW = graph(
  '  - { id: a, kind: command, with: { run: [sleep, "1"] } }\n  - { id: b, kind: router }',
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

async function started(paths: RuntimePaths, opts = {}): Promise<Runtime> {
  const runtime = await testRuntime(paths, opts)
  runtimes.push(runtime)
  return runtime
}

async function host(runtime: Runtime): Promise<RuntimeClient> {
  return track(pairedClient(runtime, 'host', RIGHTS))
}

async function loaded(c: RuntimeClient, folder: string, names: string[]) {
  const { scope } = await c.call<{ scope: string }>('scopes.register', { folder })
  const graphs: Record<string, { fingerprint: string; state: string }> = {}
  for (const name of names)
    graphs[name] = await c.call('graphs.load', {
      scope,
      path: join(folder, 'graphs', `${name}.yaml`),
    })
  return { scope, graphs }
}

async function enabled(c: RuntimeClient, folder: string, names: string[]) {
  const at = await loaded(c, folder, names)
  for (const name of names)
    await c.call('graphs.enable', {
      scope: at.scope,
      name,
      fingerprint: at.graphs[name]?.fingerprint,
    })
  return at.scope
}

async function until(check: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 25))
  }
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

describe('the runtime registry and runs', () => {
  it('GRF-C193 wire list with no runtime starts one and answers; stop during a command step lets the step end, starts nothing after it and exits 0', async () => {
    const { env, paths } = runtimePlace()
    const folder = folderWith({ slow: SLOW })
    const list = await output(wire(env, ['list'], folder))
    expect(list.code).toBe(0)
    expect(JSON.parse(list.stdout)).toEqual([])
    expect(await lockHeld(paths.data)).toBe(true)

    const status = await cliClient(paths)
    const { pid } = await status.call<{ pid: number }>('runtime.status')
    status.close()
    const token = new Tokens(paths.data).issue('host', RIGHTS)
    process.kill(pid, 'SIGHUP')
    const c = await track(RuntimeClient.connect({ socket: paths.socket, token }))
    const scope = await enabled(c, folder, ['slow'])
    const start = await output(wire(env, ['start', 'slow'], folder))
    expect(start.code).toBe(0)
    const { runId } = JSON.parse(start.stdout) as { runId: string }
    await until(async () => {
      const run = await c.call<{ nodes: { node: string }[] }>('runs.show', { scope, runId })
      return run.nodes.some((n) => n.node === 'a')
    })
    const at = Date.now()
    const stop = await output(wire(env, ['runtime', 'stop']))
    expect(JSON.parse(stop.stdout)).toEqual({ ok: true, stopped: pid })
    expect(Date.now() - at).toBeLessThan(10_000)
    expect(await lockHeld(paths.data)).toBe(false)

    const journal = readFileSync(
      join(paths.data, 'runs', scopeKey(scope), 'slow', runId, 'journal.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; node?: string; status?: string })
    expect(journal.find((l) => l.type === 'node-end' && l.node === 'a')?.status).toBe('done')
    expect(journal.some((l) => l.type === 'node-start' && l.node === 'b')).toBe(false)
  })

  it('GRF-C195 a graph enabled with the fingerprint it showed is enabled; a change outside ui disables it and a change of ui does not', async () => {
    const { paths } = runtimePlace()
    const runtime = await started(paths)
    const folder = folderWith({ g: ROUTER })
    const c = await host(runtime)
    const scope = await enabled(c, folder, ['g'])
    const state = async () =>
      (await c.call<{ name: string; state: string }[]>('graphs.list', { scope })).find(
        (g) => g.name === 'g',
      )?.state
    expect(await state()).toBe('enabled')
    writeFileSync(join(folder, 'graphs', 'g.yaml'), `${ROUTER}ui: { x: 1 }\n`)
    expect(await state()).toBe('enabled')
    writeFileSync(join(folder, 'graphs', 'g.yaml'), ROUTER.replace('default: 0', 'default: 1'))
    expect(await state()).toBe('changed')
    writeFileSync(join(folder, 'graphs', 'g.yaml'), ROUTER)
    expect(await state()).toBe('changed')
  })

  it('GRF-C196 enable without the right, with a fingerprint that is not the file, and a scratch folder are refused and nothing is enabled', async () => {
    const { paths } = runtimePlace()
    const runtime = await started(paths)
    const folder = folderWith({ g: ROUTER })
    const cli = await track(cliClient(paths))
    const at = await loaded(cli, folder, ['g'])
    await expect(
      cli.call('graphs.enable', {
        scope: at.scope,
        name: 'g',
        fingerprint: at.graphs.g?.fingerprint,
      }),
    ).rejects.toThrow('needs-right: enable')
    const c = await host(runtime)
    await c.call('scopes.register', { folder })
    await expect(
      c.call('graphs.enable', { scope: at.scope, name: 'g', fingerprint: 'f'.repeat(64) }),
    ).rejects.toThrow('changed')
    await expect(c.call('scopes.register', { folder, scratch: true })).rejects.toThrow('scratch')
    const list = await c.call<{ state: string }[]>('graphs.list', { scope: at.scope })
    expect(list.map((g) => g.state)).toEqual(['not-enabled'])
    expect(readFileSync(join(paths.data, 'scopes.json'), 'utf8')).toContain(folder)
  })

  it('GRF-C199 the CLI token lists, shows and starts an agents graph of its own folder; a paired token also pauses, resumes, cancels and enables', async () => {
    const { paths } = runtimePlace()
    const runtime = await started(paths)
    const folder = folderWith({ g: ROUTER, w: WAIT })
    const c = await host(runtime)
    const scope = await enabled(c, folder, ['g', 'w'])
    const cli = await track(cliClient(paths))
    await cli.call('scopes.register', { folder })
    expect(
      (await cli.call<{ name: string }[]>('graphs.list', { scope })).map((g) => g.name),
    ).toEqual(['g', 'w'])
    const { runId } = await cli.call<{ runId: string }>('runs.start', { scope, name: 'g' })
    await until(async () =>
      (await cli.call<{ runId: string; status: string }[]>('runs.list', { scope })).some(
        (r) => r.runId === runId && r.status === 'done',
      ),
    )
    expect(await cli.call('runs.show', { scope, runId })).toMatchObject({
      summary: { runId, status: 'done' },
    })

    const waiting = await c.call<{ runId: string }>('runs.start', { scope, name: 'w', by: 'human' })
    expect(await c.call('runs.control', { scope, runId: waiting.runId, action: 'pause' })).toEqual({
      ok: true,
    })
    expect(await c.call('runs.control', { scope, runId: waiting.runId, action: 'resume' })).toEqual(
      { ok: true },
    )
    expect(await c.call('runs.control', { scope, runId: waiting.runId, action: 'cancel' })).toEqual(
      { ok: true },
    )
    const list = await c.call<{ runId: string; status: string }[]>('runs.list', { scope })
    expect(list.find((r) => r.runId === waiting.runId)?.status).toBe('cancelled')
    expect(await c.call('graphs.disable', { scope, name: 'g' })).toMatchObject({
      state: 'not-enabled',
    })
  })

  it('GRF-C217 a run waiting on a wait timer keeps the runtime past its idle time until the run ends', async () => {
    const { paths } = runtimePlace()
    const runtime = await started(paths, { idleMs: 150 })
    const folder = folderWith({ w: WAIT })
    const c = await host(runtime)
    const scope = await enabled(c, folder, ['w'])
    await c.call('runs.start', { scope, name: 'w' })
    c.close()
    await new Promise((r) => setTimeout(r, 500))
    expect(await lockHeld(paths.data)).toBe(true)
    await runtime.stopped
    const later = await started(paths)
    const again = await track(pairedClient(later, 'host', RIGHTS))
    await again.call('scopes.register', { folder })
    expect(
      (await again.call<{ status: string }[]>('runs.list', { scope })).map((r) => r.status),
    ).toEqual(['done'])
  })

  it('GRF-C228 a graph enabled by the host in a folder is started by an agent in that folder with the CLI, in that folder scope', async () => {
    const { env, paths } = runtimePlace()
    const runtime = await started(paths)
    const folder = folderWith({ g: ROUTER, human: HUMAN_ONLY })
    const c = await host(runtime)
    const scope = await enabled(c, folder, ['g', 'human'])
    expect(scope).toBe(`dir:${folder}`)
    const start = await output(wire(env, ['start', 'g'], folder))
    expect(start.code).toBe(0)
    const { runId } = JSON.parse(start.stdout) as { runId: string }
    const runs = await c.call<{ runId: string; scope: string }[]>('runs.list', { scope })
    expect(runs).toEqual([expect.objectContaining({ runId, scope })])
    const refused = await output(wire(env, ['start', 'human'], folder))
    expect(refused.code).toBe(1)
    expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, error: 'not-for-agents' })
    expect(readCliToken(paths.data)).not.toBeNull()
  })
})

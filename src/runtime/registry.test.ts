import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeClient, START_WAIT_MS } from './client.ts'
import { lockHeld } from './lock.ts'
import type { RuntimePaths } from './paths.ts'
import { scopeKey } from './registry.ts'
import { DRAIN_MS, type Runtime } from './runtime.ts'
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

async function answers(paths: RuntimePaths): Promise<boolean> {
  try {
    const c = await cliClient(paths)
    c.close()
    return true
  } catch {
    return false
  }
}

async function connectWhenAccepted(paths: RuntimePaths, token: string): Promise<RuntimeClient> {
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

const STEP_MARGIN_MS = 5_000
const START_AND_STOP_BUDGET_MS = START_WAIT_MS + DRAIN_MS + STEP_MARGIN_MS

function runtimeLog(paths: RuntimePaths): string {
  const path = join(paths.data, 'runtime.log')
  return existsSync(path) ? readFileSync(path, 'utf8') : '(no runtime.log)'
}

function stepped(paths: RuntimePaths, budgetMs: number) {
  const began = Date.now()
  let current = 'setup'
  const step = <T>(name: string, act: () => Promise<T>): Promise<T> => {
    current = name
    return act()
  }
  const report = (what: string) =>
    `${what} in step "${current}" after ${Date.now() - began} ms\n--- runtime.log\n${runtimeLog(paths)}`
  const within = async (body: () => Promise<void>): Promise<void> => {
    let timer: NodeJS.Timeout | undefined
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(report('stalled'))), budgetMs)
    })
    try {
      await Promise.race([body(), stalled])
    } catch (err) {
      if (err instanceof Error && !err.message.includes('--- runtime.log'))
        err.message = `${err.message}\n${report('failed')}`
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
  return { step, within }
}

describe('the runtime registry and runs', () => {
  it(
    'GRF-C193 wire list with no runtime starts one and answers; stop during a command step lets the step end, starts nothing after it and exits 0',
    async () => {
      const { env, paths } = runtimePlace()
      const { step, within } = stepped(paths, START_AND_STOP_BUDGET_MS)
      await within(async () => {
        const folder = folderWith({ slow: SLOW })
        const list = await step('wire list', () => output(wire(env, ['list'], folder)))
        expect(list.code).toBe(0)
        expect(JSON.parse(list.stdout)).toEqual([])
        expect(await step('lock held', () => lockHeld(paths.data))).toBe(true)

        const { pid } = await step('runtime.status', async () => {
          const status = await cliClient(paths)
          try {
            return await status.call<{ pid: number }>('runtime.status')
          } finally {
            status.close()
          }
        })
        const token = new Tokens(paths.data).issue('host', RIGHTS)
        process.kill(pid, 'SIGHUP')
        const c = await step('host connect', () =>
          track(RuntimeClient.connect({ socket: paths.socket, token })),
        )
        const scope = await step('enable', () => enabled(c, folder, ['slow']))
        const start = await step('wire start', () => output(wire(env, ['start', 'slow'], folder)))
        expect(start.code).toBe(0)
        const { runId } = JSON.parse(start.stdout) as { runId: string }
        await step('step a started', () =>
          until(async () => {
            const run = await c.call<{ nodes: { node: string }[] }>('runs.show', { scope, runId })
            return run.nodes.some((n) => n.node === 'a')
          }),
        )
        const at = Date.now()
        const stop = await step('wire runtime stop', () => output(wire(env, ['runtime', 'stop'])))
        expect(JSON.parse(stop.stdout)).toEqual({ ok: true, stopped: pid })
        expect(Date.now() - at).toBeLessThan(10_000)
        expect(await step('lock released', () => lockHeld(paths.data))).toBe(false)

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
    },
    START_AND_STOP_BUDGET_MS + STEP_MARGIN_MS,
  )

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

  it('GRF-C87 a ui key with any text stays out of the run: its journal and stored definition hold none of it', async () => {
    const { paths } = runtimePlace()
    const runtime = await started(paths)
    const marker = 'ui-only-note-7f3a'
    const folder = folderWith({ g: `${ROUTER}ui: { note: ${marker}, positions: { a: [1, 2] } }\n` })
    const c = await host(runtime)
    const scope = await enabled(c, folder, ['g'])
    const { runId } = await c.call<{ runId: string }>('runs.start', {
      scope,
      name: 'g',
      by: 'human',
    })
    await until(async () => {
      const runs = await c.call<{ runId: string; status: string }[]>('runs.list', { scope })
      return runs.find((r) => r.runId === runId)?.status === 'done'
    })
    const runFolder = join(paths.data, 'runs', scopeKey(scope), 'g', runId)
    for (const name of readdirSync(runFolder))
      expect(readFileSync(join(runFolder, name), 'utf8')).not.toContain(marker)
  })

  it('GRF-C86 a copy of an enabled graph under another name is not enabled, and the original stays enabled', async () => {
    const { paths } = runtimePlace()
    const runtime = await started(paths)
    const folder = folderWith({ g: ROUTER })
    const c = await host(runtime)
    const scope = await enabled(c, folder, ['g'])
    copyFileSync(join(folder, 'graphs', 'g.yaml'), join(folder, 'graphs', 'other.yaml'))
    expect(
      await c.call('graphs.load', { scope, path: join(folder, 'graphs', 'other.yaml') }),
    ).toMatchObject({ name: 'other', state: 'not-enabled' })
    const states = (await c.call<{ name: string; state: string }[]>('graphs.list', { scope }))
      .map((g) => `${g.name}:${g.state}`)
      .sort()
    expect(states).toEqual(['g:enabled', 'other:not-enabled'])
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
  it('GRF-C196 a graph path outside the folder, through .. or a link, a FIFO and a file over 64 KiB are refused', async () => {
    const { paths } = runtimePlace()
    const runtime = await started(paths)
    const folder = folderWith({ g: ROUTER })
    const outside = folderWith({ x: ROUTER })
    symlinkSync(join(outside, 'graphs', 'x.yaml'), join(folder, 'graphs', 'linked.yaml'))
    symlinkSync(join(outside, 'graphs'), join(folder, 'elsewhere'))
    execFileSync('mkfifo', [join(folder, 'graphs', 'fifo.yaml')])
    writeFileSync(join(folder, 'graphs', 'big.yaml'), `${ROUTER}# ${'x'.repeat(70_000)}\n`)
    const c = await host(runtime)
    const { scope } = await c.call<{ scope: string }>('scopes.register', { folder })
    const load = (path: string) =>
      c.call('graphs.load', { scope, path }).catch((err: Error) => err.message)
    expect(await load(join(outside, 'graphs', 'x.yaml'))).toMatch(/^outside-folder/)
    expect(
      await load(
        join(folder, 'graphs', '..', '..', outside.split('/').pop() ?? '', 'graphs', 'x.yaml'),
      ),
    ).toMatch(/^outside-folder/)
    expect(await load(join(folder, 'elsewhere', 'x.yaml'))).toMatch(/^outside-folder/)
    expect(await load(join(folder, 'graphs', 'linked.yaml'))).toMatch(/^outside-folder/)
    expect(await load(join(folder, 'graphs', 'fifo.yaml'))).toMatch(
      /^invalid: .*not a regular file|cannot be read/,
    )
    expect(await load(join(folder, 'graphs', 'big.yaml'))).toMatch(/^invalid: .*over 64 KiB/)
    expect(await c.call('graphs.list', { scope })).toEqual([])
  })

  it('GRF-C195 an enabled graph whose file is renamed, or swapped for a link and back, is no longer enabled', async () => {
    const { paths } = runtimePlace()
    const runtime = await started(paths)
    const folder = folderWith({ g: ROUTER })
    const c = await host(runtime)
    const scope = await enabled(c, folder, ['g'])
    const file = join(folder, 'graphs', 'g.yaml')
    const renamed = join(folder, 'graphs', 'renamed.yaml')
    renameSync(file, renamed)
    expect(await c.call('graphs.load', { scope, path: renamed })).toMatchObject({
      name: 'renamed',
      state: 'not-enabled',
    })
    const states = async () =>
      (await c.call<{ name: string; state: string }[]>('graphs.list', { scope })).map(
        (g) => `${g.name}:${g.state}`,
      )
    expect(await states()).toEqual(['g:invalid', 'renamed:not-enabled'])
    renameSync(renamed, file)
    expect(await states()).toEqual(['g:changed', 'renamed:invalid'])
    const fingerprint = (
      await c.call<{ fingerprint: string }>('graphs.load', { scope, path: file })
    ).fingerprint
    await c.call('graphs.enable', { scope, name: 'g', fingerprint })
    expect((await states())[0]).toBe('g:enabled')
    const outside = folderWith({ g: ROUTER })
    rmSync(file)
    symlinkSync(join(outside, 'graphs', 'g.yaml'), file)
    expect((await states())[0]).toBe('g:invalid')
    rmSync(file)
    writeFileSync(file, ROUTER)
    expect((await states())[0]).toBe('g:changed')
  })

  it('GRF-C229 only a worker sets or clears the sandboxed flag, it survives a restart, and a command in a sandboxed folder waits pending instead of running headless', async () => {
    const { env, paths } = runtimePlace()
    const runtime = await started(paths)
    const folder = folderWith({ g: ROUTER })
    const mark = join(folder, 'ran')
    writeFileSync(
      join(folder, 'graphs', 'touch.yaml'),
      graph(`  - { id: a, kind: command, with: { run: [touch, ${JSON.stringify(mark)}] } }`),
    )
    const c = await host(runtime)
    const scope = await enabled(c, folder, ['touch', 'g'])
    const cli = await track(cliClient(paths))
    expect(await cli.call('scopes.register', { folder, sandboxed: true })).toMatchObject({
      sandboxed: false,
    })
    expect(await c.call('scopes.register', { folder, sandboxed: true })).toMatchObject({
      sandboxed: true,
    })
    expect(await cli.call('scopes.register', { folder, sandboxed: false })).toMatchObject({
      sandboxed: true,
    })
    await runtime.stop()
    runtimes.splice(runtimes.indexOf(runtime), 1)
    const later = await started(paths)
    const again = await track(pairedClient(later, 'host', RIGHTS))
    expect(await again.call('scopes.register', { folder })).toMatchObject({ sandboxed: true })
    const start = await output(wire(env, ['start', 'touch'], folder))
    const { runId } = JSON.parse(start.stdout) as { runId: string }
    await until(async () => {
      const run = await again.call<{ nodes: { node: string; status: string }[] }>('runs.show', {
        scope,
        runId,
      })
      return run.nodes.some((n) => n.node === 'a' && n.status === 'pending')
    })
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(mark)).toBe(false)
    expect(await again.call('scopes.register', { folder, sandboxed: false })).toMatchObject({
      sandboxed: false,
    })
  })

  it('GRF-C200 a CLI start that says by human still needs agents: true, and a client starts only in folders it registered', async () => {
    const { paths } = runtimePlace()
    const runtime = await started(paths)
    const folder = folderWith({ human: HUMAN_ONLY, g: ROUTER })
    const c = await host(runtime)
    const scope = await enabled(c, folder, ['human', 'g'])
    const cli = await track(cliClient(paths))
    await expect(cli.call('runs.start', { scope, name: 'g' })).rejects.toThrow('unknown-scope')
    await cli.call('scopes.register', { folder })
    await expect(cli.call('runs.start', { scope, name: 'human', by: 'human' })).rejects.toThrow(
      'not-for-agents',
    )
    expect(await c.call('runs.start', { scope, name: 'human', by: 'human' })).toHaveProperty(
      'runId',
    )
    const other = await track(pairedClient(runtime, 'other', RIGHTS))
    await expect(other.call('runs.start', { scope, name: 'g', by: 'human' })).rejects.toThrow(
      'unknown-scope',
    )
    await expect(
      other.call('graphs.load', { scope, path: join(folder, 'graphs', 'g.yaml') }),
    ).rejects.toThrow('unknown-scope')
  })

  it('GRF-C194 a runtime killed during a command recovers the run at its next start and runs the command again as attempt 2', async () => {
    const { env, paths } = runtimePlace()
    const folder = folderWith({ slow: SLOW })
    const runtime = wire(env, ['runtime', 'start', '--foreground', '--daemon'])
    await until(() => answers(paths))
    const token = new Tokens(paths.data).issue('host', RIGHTS)
    runtime.kill('SIGHUP')
    const c = await track(connectWhenAccepted(paths, token))
    const scope = await enabled(c, folder, ['slow'])
    const { runId } = await c.call<{ runId: string }>('runs.start', { scope, name: 'slow' })
    const journal = () =>
      readFileSync(
        join(paths.data, 'runs', scopeKey(scope), 'slow', runId, 'journal.jsonl'),
        'utf8',
      )
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as { type: string; node?: string; attempt?: number; status?: string },
        )
    await until(() => journal().some((l) => l.type === 'node-start' && l.node === 'a'))
    runtime.kill('SIGKILL')
    await until(() => runtime.exitCode !== null || runtime.signalCode !== null)
    const later = await started(paths)
    const again = await track(pairedClient(later, 'host', RIGHTS))
    await again.call('scopes.register', { folder })
    await until(() => journal().some((l) => l.type === 'run-end'))
    const lines = journal()
    expect(
      lines.filter((l) => l.type === 'node-start' && l.node === 'a').map((l) => l.attempt),
    ).toEqual([1, 2])
    expect(lines.find((l) => l.type === 'run-end')?.status).toBe('done')
  })

  it('GRF-C220 stopping a daemon during a command lets the step end and starts nothing after it', async () => {
    const { env, paths } = runtimePlace()
    const folder = folderWith({ slow: SLOW })
    const runtime = wire(env, ['runtime', 'start', '--foreground', '--daemon'])
    const ended = output(runtime)
    await until(() => answers(paths))
    const token = new Tokens(paths.data).issue('host', RIGHTS)
    runtime.kill('SIGHUP')
    const c = await track(connectWhenAccepted(paths, token))
    const scope = await enabled(c, folder, ['slow'])
    const { runId } = await c.call<{ runId: string }>('runs.start', { scope, name: 'slow' })
    const path = join(paths.data, 'runs', scopeKey(scope), 'slow', runId, 'journal.jsonl')
    const journal = () =>
      readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { type: string; node?: string; status?: string })
    await until(() => journal().some((l) => l.type === 'node-start' && l.node === 'a'))
    const stop = await output(wire(env, ['runtime', 'stop']))
    expect(JSON.parse(stop.stdout)).toEqual({ ok: true, stopped: runtime.pid })
    expect((await ended).code).toBe(0)
    expect(journal().find((l) => l.type === 'node-end' && l.node === 'a')?.status).toBe('done')
    expect(journal().some((l) => l.type === 'node-start' && l.node === 'b')).toBe(false)
  })
  it('GRF-C228 a start that names its pane puts the pane in the run trigger', async () => {
    const { paths } = runtimePlace()
    const runtime = await started(paths)
    const folder = folderWith({ g: ROUTER })
    const c = await host(runtime)
    const scope = await enabled(c, folder, ['g'])
    const { runId } = await c.call<{ runId: string }>('runs.start', {
      scope,
      name: 'g',
      pane: 'pane-7',
    })
    const first = readFileSync(
      join(paths.data, 'runs', scopeKey(scope), 'g', runId, 'journal.jsonl'),
      'utf8',
    ).split('\n')[0] as string
    expect((JSON.parse(first) as { trigger: unknown }).trigger).toEqual({
      kind: 'manual',
      by: 'agent',
      pane: 'pane-7',
    })
  })
})

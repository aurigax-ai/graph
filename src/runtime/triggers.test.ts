import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock, fakeAgentKind, testEnv } from '../engine/fakeHost.ts'
import { loadGraphText } from '../format/graphFile.ts'
import { RuntimeCallError, RuntimeClient } from './client.ts'
import type { RuntimePaths } from './paths.ts'
import { scopeKey } from './registry.ts'
import { PACKAGE_VERSION, type Runtime, type RuntimeOptions } from './runtime.ts'
import { pairedClient, runtimePlace, testRuntime } from './testRuntime.ts'
import { RIGHTS, readCliToken } from './tokens.ts'
import { RuntimeTriggers } from './triggers.ts'
import { serveKinds } from './workerClient.ts'

const runtimes: Runtime[] = []
const clients: RuntimeClient[] = []

afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const runtime of runtimes.splice(0)) await runtime.stop()
})

const START = Date.UTC(2026, 9, 16, 12, 0, 0)

const graph = (
  on: string,
  nodes = '  - { id: a, kind: router }',
  edges = 'edges: []',
) => `version: 1
on:
${on}
start: a
state: { n: { type: integer, default: 0 } }
nodes:
${nodes}
${edges}
`

function folderWith(graphs: Record<string, string>): string {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'wrt-folder-')))
  mkdirSync(join(folder, 'graphs'))
  mkdirSync(join(folder, 'src'))
  for (const [name, text] of Object.entries(graphs))
    writeFileSync(join(folder, 'graphs', `${name}.yaml`), text)
  return folder
}

async function started(paths: RuntimePaths, opts: RuntimeOptions = {}): Promise<Runtime> {
  const runtime = await testRuntime(paths, opts)
  runtimes.push(runtime)
  return runtime
}

async function track(client: Promise<RuntimeClient>): Promise<RuntimeClient> {
  const c = await client
  clients.push(c)
  return c
}

async function enabled(c: RuntimeClient, folder: string, names: string[]): Promise<string> {
  const { scope } = await c.call<{ scope: string }>('scopes.register', { folder })
  for (const name of names) {
    const g = await c.call<{ fingerprint: string; problems: unknown[] }>('graphs.load', {
      scope,
      path: join(folder, 'graphs', `${name}.yaml`),
    })
    await c.call('graphs.enable', { scope, name, fingerprint: g.fingerprint })
  }
  return scope
}

function triggersOf(paths: RuntimePaths, scope: string, name: string): string[] {
  const dir = join(paths.data, 'runs', scopeKey(scope), name)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((runId) => {
      const first = readFileSync(join(dir, runId, 'journal.jsonl'), 'utf8').split('\n')[0] ?? '{}'
      const trigger = (JSON.parse(first) as { trigger?: { kind?: string; caughtUp?: boolean } })
        .trigger
      return `${trigger?.kind}${trigger?.caughtUp ? ':caught-up' : ''}`
    })
    .sort()
}

async function until(check: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function minutes(clock: FakeClock, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await clock.advance(60_000)
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('triggers and limits in the runtime', () => {
  it('GRF-C201 a schedule every 5m, a files trigger and an agent trigger fire three, one and one runs, each once with two clients connected', async () => {
    const { paths } = runtimePlace()
    const clock = new FakeClock(START)
    const runtime = await started(paths, { clock })
    const folder = folderWith({
      g: graph(
        "  - { schedule: { every: 5m } }\n  - { files: { glob: 'src/**' } }\n  - { agent: { state: stopped } }",
      ),
    })
    const panel = await track(pairedClient(runtime, 'panel', RIGHTS))
    const other = await track(pairedClient(runtime, 'other', RIGHTS))
    const scope = await enabled(panel, folder, ['g'])
    await other.call('scopes.register', { folder })
    await minutes(clock, 16)
    expect(triggersOf(paths, scope, 'g')).toEqual(['schedule', 'schedule', 'schedule'])

    writeFileSync(join(folder, 'src', 'a.ts'), 'x')
    await new Promise((r) => setTimeout(r, 300))
    await clock.advance(1_500)
    await until(() => triggersOf(paths, scope, 'g').length === 4)
    expect(
      await panel.call('events.push', {
        scope,
        trigger: { kind: 'agent', pane: 'p9', state: 'stopped' },
      }),
    ).toEqual({ matched: 0, fired: 1 })
    await until(() => triggersOf(paths, scope, 'g').length === 5)
    await new Promise((r) => setTimeout(r, 100))
    expect(triggersOf(paths, scope, 'g')).toEqual([
      'agent',
      'files',
      'schedule',
      'schedule',
      'schedule',
    ])
  })

  it('GRF-C202 a stop from a pane one of the graph own runs opened starts no run, and a stop from another pane does', async () => {
    const { paths } = runtimePlace()
    const runtime = await started(paths)
    const folder = folderWith({
      own: graph(
        '  - { manual: {} }\n  - { agent: { state: stopped } }',
        '  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: p } }',
      ),
    })
    const panel = await track(pairedClient(runtime, 'panel', RIGHTS))
    const scope = await enabled(panel, folder, ['own'])
    const state = testEnv()
    const ostia = await track(pairedClient(runtime, 'ostia', ['observe', 'worker', 'ingest']))
    serveKinds(ostia, [fakeAgentKind(state)], 'ostia')
    await ostia.call('scopes.register', { folder })
    await ostia.call('worker.register', { kinds: ['agent'], scopes: [scope] })
    await panel.call('runs.start', { scope, name: 'own', by: 'human' })
    await until(() => state.agents.length === 1)
    const pane = state.agents[0]?.pane
    await until(async () => {
      const runs = await panel.call<{ status: string }[]>('runs.list', { scope })
      return runs[0]?.status === 'waiting'
    })
    expect(
      await ostia.call('events.push', {
        scope,
        event: { type: 'agent-stop', pane },
        trigger: { kind: 'agent', pane, state: 'stopped' },
      }),
    ).toEqual({ matched: 1, fired: 0 })
    expect(
      await ostia.call('events.push', {
        scope,
        trigger: { kind: 'agent', pane: 'elsewhere', state: 'stopped' },
      }),
    ).toEqual({ matched: 0, fired: 1 })
    await until(() => triggersOf(paths, scope, 'own').length === 2)
    expect(triggersOf(paths, scope, 'own')).toEqual(['agent', 'manual'])
  })

  it('GRF-C212 the 17th run at once is skipped naming the global limit and counted, and 50 of 150 events in a second are rate-limited and counted', async () => {
    const { paths } = runtimePlace()
    const clock = new FakeClock(START)
    const runtime = await started(paths, { clock })
    const panel = await track(pairedClient(runtime, 'panel', RIGHTS))
    const long = graph('  - { manual: {} }', '  - { id: a, kind: wait, with: { for: 1h } }')
    const names = Array.from({ length: 4 }, (_, i) => `g${i}`)
    const scopes: string[] = []
    for (let f = 0; f < 5; f++) {
      const folder = folderWith(Object.fromEntries(names.map((n) => [n, long])))
      scopes.push(await enabled(panel, folder, names))
    }
    const answers: string[] = []
    for (const scope of scopes)
      for (const name of names) {
        if (answers.length === 17) break
        answers.push(
          await panel
            .call<{ runId: string }>('runs.start', { scope, name, by: 'human' })
            .then(() => 'started')
            .catch((err: Error) => err.message),
        )
      }
    expect(answers.filter((a) => a === 'started')).toHaveLength(16)
    expect(answers[16]).toBe('skipped: at most 16 active runs in the runtime')
    const listed = await panel.call<{ name: string; skipped: number }[]>('graphs.list', {
      scope: scopes[4],
    })
    expect(listed.find((g) => g.name === 'g0')?.skipped).toBe(1)

    const results = await Promise.all(
      Array.from({ length: 150 }, (_, i) =>
        panel
          .call('events.push', {
            scope: scopes[0],
            trigger: { kind: 'agent', pane: `p${i}`, state: 'waiting' },
          })
          .then(() => 'ok')
          .catch((err: Error) => err.message),
      ),
    )
    expect(results.filter((r) => r === 'ok')).toHaveLength(100)
    expect(results.filter((r) => r.startsWith('rate-limited'))).toHaveLength(50)
    expect(await panel.call('runtime.status')).toMatchObject({ skipped: 1, rateLimited: 50 })
  })

  it('GRF-C218 after the last client leaves the runtime exits, the schedule does not fire while it is away, and the catch-up rule applies when a client comes back', async () => {
    const { paths } = runtimePlace()
    const clock = new FakeClock(START)
    const folder = folderWith({
      caught: graph('  - { schedule: { every: 5m, catchUp: true } }'),
      plain: graph('  - { schedule: { every: 5m } }'),
    })
    const first = await started(paths, { clock, idleMs: 100 })
    const panel = await track(pairedClient(first, 'panel', RIGHTS))
    const scope = await enabled(panel, folder, ['caught', 'plain'])
    panel.close()
    await first.stopped
    await minutes(clock, 16)
    expect(triggersOf(paths, scope, 'caught')).toEqual([])
    expect(triggersOf(paths, scope, 'plain')).toEqual([])
    const again = await started(paths, { clock })
    const back = await track(pairedClient(again, 'panel', RIGHTS))
    await back.call('scopes.register', { folder })
    await until(() => triggersOf(paths, scope, 'caught').length === 1)
    await new Promise((r) => setTimeout(r, 100))
    expect(triggersOf(paths, scope, 'caught')).toEqual(['schedule:caught-up'])
    expect(triggersOf(paths, scope, 'plain')).toEqual([])
  })

  it('GRF-C220 a daemon fires a schedule on time with no client connected', async () => {
    const { paths } = runtimePlace()
    const clock = new FakeClock(START)
    const runtime = await started(paths, { clock, idleMs: 100, daemon: true })
    const folder = folderWith({ g: graph('  - { schedule: { every: 5m } }') })
    const panel = await track(pairedClient(runtime, 'panel', RIGHTS))
    const scope = await enabled(panel, folder, ['g'])
    panel.close()
    await new Promise((r) => setTimeout(r, 300))
    await minutes(clock, 5)
    await until(() => triggersOf(paths, scope, 'g').length === 1)
    expect(triggersOf(paths, scope, 'g')).toEqual(['schedule'])
  })
  it('GRF-C202 a trigger pushed without the ingest right is refused and starts nothing', async () => {
    const { paths } = runtimePlace()
    const runtime = await started(paths)
    const folder = folderWith({ g: graph('  - { agent: { state: stopped } }') })
    const panel = await track(pairedClient(runtime, 'panel', RIGHTS))
    const scope = await enabled(panel, folder, ['g'])
    const watcher = await track(pairedClient(runtime, 'watcher', ['observe']))
    await watcher.call('scopes.register', { folder })
    await expect(
      watcher.call('events.push', {
        scope,
        trigger: { kind: 'agent', pane: 'p1', state: 'stopped' },
      }),
    ).rejects.toThrow('needs-right: ingest')
    expect(triggersOf(paths, scope, 'g')).toEqual([])
  })

  it('GRF-C212 a control client sets ceilings that cap every graph, kept across a restart', async () => {
    const { paths } = runtimePlace()
    const runtime = await started(paths)
    const panel = await track(pairedClient(runtime, 'panel', RIGHTS))
    expect(
      await panel.call('runtime.ceilings', {
        steps: 2,
        runsPerHour: 99,
        parallel: 8,
        agents: 0,
        timeMs: 3_600_000,
      }),
    ).toEqual({ steps: 2, runsPerHour: 60, parallel: 8, agents: 0, timeMs: 3_600_000 })
    await expect(panel.call('runtime.ceilings', { steps: 0 })).rejects.toThrow(
      'bad-ceilings: steps',
    )
    const observer = await track(pairedClient(runtime, 'observer', ['observe']))
    await expect(observer.call('runtime.ceilings', { steps: 9 })).rejects.toThrow(
      'needs-right: control',
    )
    const folder = folderWith({
      long: graph(
        '  - { manual: {} }',
        '  - { id: a, kind: router }\n  - { id: b, kind: router }\n  - { id: c, kind: router }',
        'edges:\n  - { from: a, to: b }\n  - { from: b, to: c }',
      ),
    })
    const scope = await enabled(panel, folder, ['long'])
    const { runId } = await panel.call<{ runId: string }>('runs.start', {
      scope,
      name: 'long',
      by: 'human',
    })
    await until(async () => {
      const runs = await panel.call<{ runId: string; status: string }[]>('runs.list', { scope })
      return runs.some((r) => r.runId === runId && r.status === 'step-limit')
    })
    panel.close()
    await runtime.stop()
    runtimes.splice(runtimes.indexOf(runtime), 1)
    const again = await started(paths)
    const back = await track(pairedClient(again, 'panel', RIGHTS))
    await back.call('scopes.register', { folder })
    const second = await back.call<{ runId: string }>('runs.start', {
      scope,
      name: 'long',
      by: 'human',
    })
    await until(async () => {
      const runs = await back.call<{ runId: string; status: string }[]>('runs.list', { scope })
      return runs.some((r) => r.runId === second.runId && r.status === 'step-limit')
    })
  })

  it('GRF-C227 a client of another contract is refused with the runtime own version and contract', async () => {
    const { paths } = runtimePlace()
    await started(paths)
    const refused = await RuntimeClient.connect({
      socket: paths.socket,
      token: readCliToken(paths.data) ?? '',
      contract: 2,
    }).catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(RuntimeCallError)
    expect((refused as RuntimeCallError).message).toBe('unsupported-contract')
    expect((refused as RuntimeCallError).data).toEqual({ contract: 1, version: PACKAGE_VERSION })
  })
  it('GRF-C218 a trigger host stopped for a stop is not armed again by a later refresh', async () => {
    const clock = new FakeClock(START)
    const loaded = loadGraphText(graph('  - { schedule: { every: 5m } }'), '/x/graphs/g.yaml')
    if (!loaded.ok) throw new Error('graph')
    const scope = { key: 'dir-x', id: 'dir:/x', folder: '/x', sandboxed: false, graphs: {} }
    const listing = {
      scope: scope.id,
      name: 'g',
      path: '/x/graphs/g.yaml',
      realPath: '/x/graphs/g.yaml',
      state: 'enabled' as const,
      loaded: loaded.value,
      problems: [],
    }
    const host = (fired: unknown[]) =>
      new RuntimeTriggers({
        clock,
        data: mkdtempSync(join(tmpdir(), 'wrt-triggers-')),
        enabled: () => [{ scope, listing }],
        fire: (_graph, payload) => fired.push(payload),
        changed: () => {},
      })
    const stoppedFires: unknown[] = []
    const stopped = host(stoppedFires)
    stopped.stop()
    stopped.refresh()
    const liveFires: unknown[] = []
    const live = host(liveFires)
    live.refresh()
    await minutes(clock, 6)
    live.stop()
    expect(stoppedFires).toEqual([])
    expect(liveFires).toHaveLength(1)
  })
  it('GRF-C212 ceilings refuse fractions, NaN and strings, and a ceiling left out keeps its value', async () => {
    const { paths } = runtimePlace()
    const runtime = await started(paths)
    const panel = await track(pairedClient(runtime, 'panel', RIGHTS))
    for (const steps of [1.5, Number.NaN, '3', -1])
      await expect(panel.call('runtime.ceilings', { steps })).rejects.toThrow('bad-ceilings: steps')
    await panel.call('runtime.ceilings', { steps: 2 })
    expect(await panel.call('runtime.ceilings', { agents: 3 })).toMatchObject({
      steps: 2,
      agents: 3,
    })
  })
})

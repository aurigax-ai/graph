import { describe, expect, it } from 'vitest'
import { loadGraphText } from '../format/graphFile.ts'
import { Engine, type GraphDefinition } from './engine.ts'
import { settle, testEnv } from './fakeHost.ts'

const reply = (exitCode = 0) => ({
  exitCode,
  stdout: '',
  stderr: '',
  timedOut: false,
  truncated: false,
})

function definition(text: string, name = 'g'): GraphDefinition {
  const loaded = loadGraphText(text, `/w/.ostia/graphs/${name}.yaml`)
  if (!loaded.ok) throw new Error(loaded.problems.map((p) => p.message).join('\n'))
  return { name, graph: loaded.value.graph, fingerprint: loaded.value.fingerprint }
}

async function nodeRuns(
  env: ReturnType<typeof testEnv>,
  runId: string,
  node?: string,
): Promise<number[]> {
  return ((await await env.store.read({ scope: 'w1', graph: 'g', runId }))?.lines ?? [])
    .filter((l) => l.type === 'node-start' && (node === undefined || l.node === node))
    .map((l) => l.t)
}

const LOOP = `version: 1
on: [{ manual: {} }]
start: a
state: { n: { type: integer, default: 0 } }
limits: { steps: 6 }
nodes:
  - { id: a, kind: command, with: { run: [x] } }
  - { id: b, kind: router }
edges:
  - { from: a, to: b }
  - from: b
    when: [{ if: "state.n == 1", to: end }]
    else: a
`

const WAITING = `version: 1
on: [{ manual: {} }]
start: a
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: a, kind: approval, with: { question: "ok?" } }
edges: []
`

describe('limits, retries and triggers', () => {
  it('GRF-C42 a loop that never ends stops at its step limit with one notification', async () => {
    const env = testEnv()
    const id = env.start(LOOP)
    await settle()
    expect(await nodeRuns(env, id)).toHaveLength(6)
    expect(env.run(id).state.status).toBe('step-limit')
    expect(env.notices).toHaveLength(1)
  })

  it('GRF-C49 with concurrency skip a second trigger during a waiting run is skipped and counted', async () => {
    const env = testEnv()
    env.start(WAITING)
    await settle()
    const second = env.engine.start('w1', definition(WAITING), {}, {})
    expect(second).toMatchObject({ ok: false, error: 'skipped' })
    expect(env.engine.active('w1')).toHaveLength(1)
    expect(env.engine.skippedCount('w1', 'g')).toBe(1)
  })

  it('GRF-C175 with concurrency queue one run waits for the first and the third is skipped', async () => {
    const env = testEnv()
    const text = WAITING.replace('start: a', 'concurrency: queue\nstart: a')
    env.start(text)
    await settle()
    expect(env.engine.start('w1', definition(text), {}, {})).toEqual({ ok: true, queued: true })
    expect(env.engine.start('w1', definition(text), {}, {})).toMatchObject({ error: 'skipped' })
    await env.answer('Approve')
    await settle()
    expect(env.engine.active('w1')).toHaveLength(1)
    expect(env.asks).toHaveLength(2)
  })

  it('GRF-C54 a timeout raises Timeout to its catch, leaves the agent and ignores its later stop', async () => {
    const env = testEnv()
    const id = env.start(`version: 1
on: [{ manual: {} }]
start: a
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: a, kind: agent, timeout: 2m, with: { mode: start, agent: claude, prompt: p }, catch: [{ errors: [Timeout], then: tell }] }
  - { id: tell, kind: notify, with: { title: too slow } }
edges: []
`)
    await settle()
    await env.clock.advance(2 * 60_000)
    expect(env.notices.map((n) => n.title)).toEqual(['too slow'])
    expect(env.run(id).state.status).toBe('done')
    const before = (await env.store.read({ scope: 'w1', graph: 'g', runId: id }))?.lines.length
    await env.stop(env.agents[0].pane)
    expect((await env.store.read({ scope: 'w1', graph: 'g', runId: id }))?.lines.length).toBe(
      before,
    )
  })

  it('GRF-C169 a command retried on ExitCode runs three times 10 s and 20 s apart with two retry lines', async () => {
    const env = testEnv()
    let calls = 0
    env.commandReply = () => reply(++calls < 3 ? 1 : 0)
    const id = env.start(`version: 1
on: [{ manual: {} }]
start: a
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: a, kind: command, with: { run: [x], exitIsError: true }, retry: [{ errors: [ExitCode], maxAttempts: 2, interval: 10s, backoff: 2 }] }
  - { id: b, kind: router }
edges:
  - { from: a, to: b }
`)
    await settle()
    await env.clock.advance(60_000)
    const starts = await nodeRuns(env, id, 'a')
    expect(starts).toHaveLength(3)
    expect([starts[1] - starts[0], starts[2] - starts[1]]).toEqual([10_000, 20_000])
    const lines = (await env.store.read({ scope: 'w1', graph: 'g', runId: id }))?.lines ?? []
    expect(lines.filter((l) => l.type === 'retry')).toHaveLength(2)
    expect(env.run(id).state.status).toBe('done')
  })

  it('GRF-C170 All catches a node’s Timeout but never the step limit reached inside its retries', async () => {
    const env = testEnv()
    const caught = env.start(`version: 1
on: [{ manual: {} }]
start: a
state: { err: { type: object, default: {} } }
nodes:
  - { id: a, kind: agent, timeout: 1m, with: { mode: start, agent: claude, prompt: p }, out: { error: err }, catch: [{ errors: [All], then: continue }] }
  - { id: b, kind: router }
edges:
  - { from: a, to: b }
`)
    await settle()
    await env.clock.advance(60_000)
    expect(env.run(caught).state.status).toBe('done')
    expect(env.run(caught).state.state.err).toMatchObject({ name: 'Timeout' })

    const limited = testEnv()
    limited.commandReply = () => reply(1)
    const id = limited.start(`version: 1
on: [{ manual: {} }]
start: a
state: { n: { type: integer, default: 0 } }
limits: { steps: 2 }
nodes:
  - { id: a, kind: command, with: { run: [x], exitIsError: true }, retry: [{ errors: [ExitCode], maxAttempts: 5, interval: 1s }], catch: [{ errors: [All], then: continue }] }
edges: []
`)
    await settle()
    await limited.clock.advance(60_000)
    expect(limited.run(id).state.status).toBe('step-limit')
  })

  it('GRF-C171 an agent without retry is not run again on NoResult; with retry it runs once more and then hits agent-limit', async () => {
    const result = 'result: { type: object, properties: { v: { type: string } }, required: [v] }'
    const plain = testEnv()
    const one = plain.start(`version: 1
on: [{ manual: {} }]
start: a
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: p }, ${result} }
edges: []
`)
    await settle()
    await plain.stop(plain.agents[0].pane)
    expect(plain.agents).toHaveLength(1)
    expect(plain.run(one).state.failure).toMatchObject({ name: 'NoResult' })

    const retried = testEnv()
    const two = retried.start(`version: 1
on: [{ manual: {} }]
start: a
state: { n: { type: integer, default: 0 } }
limits: { agents: 2 }
nodes:
  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: p }, ${result}, retry: [{ errors: [NoResult], maxAttempts: 4, interval: 1s }] }
edges: []
`)
    await settle()
    await retried.stop(retried.agents[0].pane)
    await retried.clock.advance(5000)
    await retried.stop(retried.agents[1].pane)
    await retried.clock.advance(5000)
    expect(retried.agents).toHaveLength(2)
    expect(retried.run(two).state.status).toBe('agent-limit')
  })

  it('GRF-C98 a loop that starts an agent each round ends agent-limit before the third', async () => {
    const env = testEnv()
    const id = env.start(`version: 1
on: [{ manual: {} }]
start: a
state: { n: { type: integer, default: 0 } }
limits: { agents: 2 }
nodes:
  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: p } }
  - { id: b, kind: router }
edges:
  - { from: a, to: b }
  - from: b
    when: [{ if: "state.n == 1", to: end }]
    else: a
`)
    await settle()
    await env.stop(env.agents[0].pane)
    await env.stop(env.agents[1].pane)
    expect(env.agents).toHaveLength(2)
    expect(env.run(id).state.status).toBe('agent-limit')
  })

  it('GRF-C172 the time limit ends a run waiting at an approval, withdraws it and notifies once', async () => {
    const env = testEnv()
    const id = env.start(WAITING.replace('nodes:', 'limits: { time: 1h }\nnodes:'))
    await settle()
    await env.clock.advance(60 * 60_000)
    expect(env.run(id).state.status).toBe('time-limit')
    expect(env.cancelled.some((c) => c.startsWith('ask:'))).toBe(true)
    expect(env.notices).toHaveLength(1)
  })

  it('GRF-C97 two runs an hour: of six triggers four are skipped, with one notification', async () => {
    const env = testEnv()
    env.engine.ceilings.runsPerHour = 2
    const text = `version: 1
on: [{ manual: {} }]
start: a
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: a, kind: command, with: { run: [x] } }
edges: []
`
    const results = []
    for (let i = 0; i < 6; i++) {
      results.push(env.engine.start('w1', definition(text), {}, {}))
      await settle()
      await env.clock.advance(10 * 60_000 - 1)
    }
    expect(results.filter((r) => r.ok)).toHaveLength(2)
    expect(results.filter((r) => !r.ok && r.error === 'skipped')).toHaveLength(4)
    expect(env.notices.filter((n) => n.title.includes('skipped'))).toHaveLength(1)
  })

  it('GRF-C99 a fifth active run in one workspace is skipped', async () => {
    const env = testEnv()
    for (let i = 1; i <= 4; i++) {
      expect(env.engine.start('w1', definition(WAITING, `g${i}`), {}, {}).ok).toBe(true)
    }
    await settle()
    expect(env.engine.start('w1', definition(WAITING, 'g5'), {}, {})).toMatchObject({
      error: 'skipped',
    })
  })

  it('GRF-C161 a host without the agent kind refuses the run', async () => {
    const env = testEnv()
    const headless = new Engine({
      host: {
        ...env.host,
        name: 'headless',
        kinds: env.host.kinds.filter((k) => k.kind !== 'agent'),
      },
      store: env.store,
    })
    const res = headless.start(
      'w1',
      definition(`version: 1
on: [{ manual: {} }]
start: a
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: p } }
edges: []
`),
      {},
      {},
    )
    expect(res).toEqual({
      ok: false,
      error: 'unsupported-kind',
      message: 'unsupported-kind: agent (host: headless)',
    })
    expect(await env.store.list()).toEqual([])
  })
})

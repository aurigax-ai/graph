import { describe, expect, it } from 'vitest'
import { NodeError, type NodeKind } from './contract.ts'
import { settle, testEnv } from './fakeHost.ts'
import { MemoryJournalStore } from './journal.ts'

const head = (state: string, start = 'a') => `version: 1
on: [{ manual: {} }]
start: ${start}
state:
${state}
`

async function ends(env: ReturnType<typeof testEnv>, runId: string): Promise<string[]> {
  const stored = await await env.store.read({ scope: 'w1', graph: 'g', runId })
  return (stored?.lines ?? []).flatMap((l) => (l.type === 'node-end' ? [l.node] : []))
}

async function lines(env: ReturnType<typeof testEnv>, runId: string) {
  return (await await env.store.read({ scope: 'w1', graph: 'g', runId }))?.lines ?? []
}

const reply = (stdout: string, exitCode = 0) => ({
  exitCode,
  stdout,
  stderr: '',
  timedOut: false,
  truncated: false,
})

describe('running a graph', () => {
  it('GRF-C15 a default fills a key and a long string keeps its last max characters', async () => {
    const env = testEnv()
    env.commandReply = () => reply('0123456789abcdefghijKLMNOPQRST')
    const id =
      env.start(`${head('  count: { type: integer, default: 0 }\n  log: { type: string, max: 10 }')}nodes:
  - { id: a, kind: command, with: { run: [x] }, out: { stdout: log } }
edges: []
`)
    await settle()
    expect(env.run(id).state.state).toEqual({ count: 0, log: 'KLMNOPQRST' })
    expect(env.run(id).state.status).toBe('done')
  })

  it('GRF-C16 an output of the wrong type for its key fails the node with BadOutput and writes nothing', async () => {
    const env = testEnv()
    const id = env.start(`${head('  n: { type: integer, default: 1 }')}nodes:
  - { id: a, kind: command, with: { run: [x] }, out: { stdout: n } }
edges: []
`)
    await settle()
    const run = env.run(id).state
    expect(run.status).toBe('failed')
    expect(run.failure).toMatchObject({ node: 'a', name: 'BadOutput' })
    expect(run.state.n).toBe(1)
  })

  it('GRF-C18 writes past 256 KiB end the run state-too-large and keep the last state', async () => {
    const env = testEnv()
    const big = 'x'.repeat(60 * 1024)
    env.commandReply = () => reply(big)
    const keys = ['a1', 'a2', 'a3', 'a4', 'a5']
      .map((k) => `  ${k}: { type: string, default: "" }`)
      .join('\n')
    const nodes = ['a', 'b', 'c', 'd', 'e']
      .map(
        (n, i) => `  - { id: ${n}, kind: command, with: { run: [x] }, out: { stdout: a${i + 1} } }`,
      )
      .join('\n')
    const id = env.start(`${head(keys)}nodes:
${nodes}
edges:
  - { from: a, to: b }
  - { from: b, to: c }
  - { from: c, to: d }
  - { from: d, to: e }
`)
    await settle()
    const run = env.run(id).state
    expect(run.status).toBe('state-too-large')
    expect(run.state.a4).toBe(big)
    expect(run.state.a5).toBe('')
  })

  it('GRF-C19 appends from a fan-out land in the order the nodes end, and the journal records it', async () => {
    const env = testEnv()
    const id =
      env.start(`${head('  notes: { type: array, items: { type: string }, merge: append, default: [] }', '[a, b]')}nodes:
  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: one }, out: { message: notes } }
  - { id: b, kind: agent, with: { mode: start, agent: claude, prompt: two }, out: { message: notes } }
edges: []
`)
    await settle()
    const [a, b] = env.agents
    await env.stop(b.pane, { message: 'from b' })
    await env.stop(a.pane, { message: 'from a' })
    expect(env.run(id).state.state.notes).toEqual(['from b', 'from a'])
    expect(await ends(env, id)).toEqual(['b', 'a'])
  })

  it('GRF-C21 and GRF-C40 a node reads the state from when it started; the join sees both writes', async () => {
    const env = testEnv()
    const id =
      env.start(`${head('  x: { type: string, default: before }\n  seen: { type: string, default: "" }', 'f')}nodes:
  - { id: f, kind: router }
  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: "x is {{state.x}}" }, out: { message: seen } }
  - { id: b, kind: command, with: { run: [x] }, out: { stdout: x } }
  - { id: later, kind: command, with: { run: [echo, "{{state.x}}"] } }
  - { id: join, kind: router }
edges:
  - { from: f, to: [a, b] }
  - { from: [a, b], to: join }
  - { from: join, to: later }
`)
    env.commandReply = () => reply('after')
    await settle()
    expect(env.agents[0].input.prompt).toBe('x is before')
    expect(env.run(id).state.state.x).toBe('after')
    await env.stop(env.agents[0].pane, { message: 'done' })
    expect(env.run(id).state.state).toMatchObject({ x: 'after', seen: 'done' })
    expect(env.commands.at(-1)?.argv).toEqual(['echo', 'after'])
  })

  it('GRF-C22 a mapped output that is absent leaves its key untouched', async () => {
    const env = testEnv()
    const id = env.start(`${head('  m: { type: string, default: kept }')}nodes:
  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: p }, out: { message: m } }
edges: []
`)
    await settle()
    await env.stop(env.agents[0].pane)
    expect(env.run(id).state.state.m).toBe('kept')
  })

  it('GRF-C23 an argv element is templated alone and never split', async () => {
    const env = testEnv()
    env.start(
      `${head('  pr: { type: string }')}nodes:
  - { id: a, kind: command, with: { run: [gh, pr, checks, "{{state.pr}}"] } }
edges: []
`,
      { pr: '12; rm -rf ~ $(id)' },
    )
    await settle()
    expect(env.commands[0].argv).toEqual(['gh', 'pr', 'checks', '12; rm -rf ~ $(id)'])
  })

  it('GRF-C24 an exact template keeps its type and an embedded one becomes text', async () => {
    const seen: unknown[] = []
    const probe: NodeKind = {
      kind: 'approval',
      version: 1,
      start: async (input) => {
        seen.push(input)
        return { done: { answer: 'ok', outcome: 'answered' } }
      },
    }
    const env = testEnv({ kinds: () => [probe] })
    env.host.kinds.splice(
      env.host.kinds.findIndex((k) => k.kind === 'approval'),
      1,
    )
    const fresh = new (env.engine.constructor as typeof import('./engine.ts').Engine)({
      host: env.host,
      store: new MemoryJournalStore(),
    })
    const res = fresh.start(
      'w1',
      {
        name: 'g',
        fingerprint: 'f',
        graph: {
          version: 1,
          on: [{ manual: {} }],
          start: 'a',
          state: {
            labels: { type: 'array', default: ['bug', 'ui'] },
            count: { type: 'integer', default: 3 },
          },
          nodes: [
            {
              id: 'a',
              kind: 'approval',
              with: { question: 'q', context: 'n={{state.count}}', choices: '{{state.labels}}' },
            },
          ],
          edges: [],
        },
      },
      {},
      {},
    )
    expect(res.ok).toBe(true)
    await settle()
    expect(seen[0]).toMatchObject({ choices: ['bug', 'ui'], context: 'n=3' })
  })

  it('GRF-C26 a node that reads a key nobody wrote fails with MissingInput and starts nothing', async () => {
    const env = testEnv()
    const id = env.start(`${head('  task: { type: string }')}nodes:
  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: "do {{state.task}}" } }
edges: []
`)
    await settle()
    expect(env.agents).toEqual([])
    expect(env.run(id).state.failure).toMatchObject({ node: 'a', name: 'MissingInput' })
  })

  it('GRF-C29 a type error or missing value in a condition raises ConditionError on the node it leaves', async () => {
    const graph = (
      catchPart: string,
    ) => `${head('  count: { type: integer, default: 1 }\n  missing: { type: integer }', 'test')}nodes:
  - { id: test, kind: command, with: { run: [x] }${catchPart} }
  - { id: next, kind: router }
  - { id: handler, kind: router }
edges:
  - from: test
    when: [{ if: "state.count > 'abc'", to: next }]
    else: handler
`
    const plain = testEnv()
    const failed = plain.start(graph(''))
    await settle()
    expect(plain.run(failed).state.failure).toMatchObject({ node: 'test', name: 'ConditionError' })
    expect(await ends(plain, failed)).toEqual(['test'])
    const caught = testEnv()
    const handled = caught.start(graph(', catch: [{ errors: [ConditionError], then: handler }]'))
    await settle()
    expect(caught.run(handled).state.status).toBe('done')
    expect(await ends(caught, handled)).toEqual(['test', 'handler'])
    const missing = testEnv()
    const m = missing.start(graph('').replace("state.count > 'abc'", 'state.missing == 1'))
    await settle()
    expect(missing.run(m).state.failure).toMatchObject({ name: 'ConditionError' })
  })

  it('GRF-C30 a start fan-out runs together and its join once after both', async () => {
    const env = testEnv()
    const id = env.start(`${head('  n: { type: integer, default: 0 }', '[lint, test]')}nodes:
  - { id: lint, kind: agent, with: { mode: start, agent: claude, prompt: l } }
  - { id: test, kind: agent, with: { mode: start, agent: claude, prompt: t } }
  - { id: review, kind: agent, with: { mode: start, agent: claude, prompt: r } }
edges:
  - { from: [lint, test], to: review }
`)
    await settle()
    expect(env.agents.map((a) => a.node)).toEqual(['lint', 'test'])
    await env.stop(env.agents[0].pane)
    expect(env.agents).toHaveLength(2)
    await env.stop(env.agents[1].pane)
    expect(env.agents.map((a) => a.node)).toEqual(['lint', 'test', 'review'])
    await env.stop(env.agents[2].pane)
    expect(env.run(id).state.status).toBe('done')
  })

  it('GRF-C31 a conditional edge picks by the exit code', async () => {
    for (const [exit, next] of [
      [1, 'implement'],
      [0, 'review'],
    ] as const) {
      const env = testEnv()
      env.commandReply = () => reply('', exit)
      const id = env.start(`${head('  exit: { type: integer, default: -1 }', 'test')}nodes:
  - { id: test, kind: command, with: { run: [x] }, out: { exit: exit } }
  - { id: review, kind: router }
  - { id: implement, kind: router }
edges:
  - from: test
    when: [{ if: "state.exit == 0", to: review }]
    else: implement
`)
      await settle()
      expect(await ends(env, id)).toEqual(['test', next])
    }
  })

  it('GRF-C33 a join after a branch that was not taken runs once with the other writes, or is skipped too', async () => {
    const graph = (
      exit: number,
    ) => `${head(`  route: { type: integer, default: ${exit} }\n  out: { type: string, default: "" }`, 'f')}nodes:
  - { id: f, kind: router }
  - { id: a, kind: command, with: { run: [x] }, out: { stdout: out } }
  - { id: pick, kind: router }
  - { id: b, kind: router }
  - { id: c, kind: router }
edges:
  - { from: f, to: [a, pick] }
  - from: pick
    when: [{ if: "state.route == 1", to: b }]
    else: end
  - { from: [a, b], to: c }
`
    const env = testEnv()
    env.commandReply = () => reply('from a')
    const id = env.start(graph(0))
    await settle()
    expect(await ends(env, id)).toEqual(['f', 'pick', 'a', 'c'])
    expect(
      (await lines(env, id)).some(
        (l) => l.type === 'edge' && l.to === 'b' && l.outcome === 'skipped',
      ),
    ).toBe(true)
    expect(env.run(id).state.state.out).toBe('from a')

    const both = testEnv()
    const twice = both.start(`${head('  route: { type: integer, default: 0 }', 'f')}nodes:
  - { id: f, kind: router }
  - { id: p1, kind: router }
  - { id: p2, kind: router }
  - { id: a, kind: router }
  - { id: b, kind: router }
  - { id: c, kind: router }
edges:
  - { from: f, to: [p1, p2] }
  - from: p1
    when: [{ if: "state.route == 1", to: a }]
    else: end
  - from: p2
    when: [{ if: "state.route == 1", to: b }]
    else: end
  - { from: [a, b], to: c }
`)
    await settle()
    expect(await ends(both, twice)).toEqual(['f', 'p1', 'p2'])
    expect(both.run(twice).state.status).toBe('done')
  })


  it('GRF-C43 an uncaught error in one branch fails the run, starts nothing new and keeps the running node’s output', async () => {
    const env = testEnv()
    env.commandReply = (req) =>
      req.argv[0] === 'boom' ? Promise.reject(new NodeError('ExitCode', 'boom')) : reply('ok')
    const id = env.start(`${head('  o: { type: string, default: "" }', '[slow, boom]')}nodes:
  - { id: slow, kind: agent, with: { mode: start, agent: claude, prompt: s }, out: { message: o } }
  - { id: boom, kind: command, with: { run: [boom] } }
  - { id: after, kind: router }
edges:
  - { from: slow, to: after }
`)
    await settle()
    expect(env.run(id).state.failure).toMatchObject({ node: 'boom', name: 'ExitCode' })
    expect(env.run(id).state.status).toBe('running')
    await env.stop(env.agents[0].pane, { message: 'finished' })
    const run = env.run(id).state
    expect(run.status).toBe('failed')
    expect(await ends(env, id)).toEqual(['boom', 'slow'])
    expect(run.state.o).toBe('finished')
  })

  it('GRF-C44 a waiting node is completed by its event 30 minutes later; start ran once', async () => {
    let starts = 0
    const waiter: NodeKind = {
      kind: 'approval',
      version: 1,
      start: async () => {
        starts += 1
        return { waiting: { on: 'event', match: { type: 'ping' } } }
      },
      resume: async () => ({ done: { answer: 'pong', outcome: 'answered' } }),
    }
    const env = testEnv({ kinds: () => [] })
    env.host.kinds.splice(
      env.host.kinds.findIndex((k) => k.kind === 'approval'),
      1,
      waiter,
    )
    const engine = new (env.engine.constructor as typeof import('./engine.ts').Engine)({
      host: env.host,
      store: env.store,
    })
    const res = engine.start(
      'w1',
      {
        name: 'g',
        fingerprint: 'f',
        graph: {
          version: 1,
          on: [{ manual: {} }],
          start: 'a',
          state: { a: { type: 'string', default: '' } },
          nodes: [{ id: 'a', kind: 'approval', with: { question: 'q' }, out: { answer: 'a' } }],
          edges: [],
        },
      },
      {},
      {},
    )
    await settle()
    await env.clock.advance(30 * 60_000)
    await engine.deliver({ type: 'ping' })
    await settle()
    const run = engine.run((res as { runId: string }).runId)
    expect(run?.state.state.a).toBe('pong')
    expect(starts).toBe(1)
  })

  it('GRF-C46 a bad output is BadOutput and a throw keeps its message cut to 240 characters', async () => {
    const env = testEnv()
    env.commandReply = (req) => {
      if (req.argv[0] === 'throw') throw new Error('x'.repeat(500))
      return {
        exitCode: 'zero',
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
      } as never
    }
    const bad = env.start(`${head('  n: { type: integer, default: 0 }')}nodes:
  - { id: a, kind: command, with: { run: [x] } }
edges: []
`)
    await settle()
    expect(env.run(bad).state.failure).toMatchObject({ name: 'BadOutput' })
    const thrown = testEnv()
    thrown.commandReply = () => {
      throw new Error('x'.repeat(500))
    }
    const t = thrown.start(`${head('  n: { type: integer, default: 0 }')}nodes:
  - { id: a, kind: command, with: { run: [throw] } }
edges: []
`)
    await settle()
    expect(thrown.run(t).state.failure?.message).toHaveLength(240)
  })

  it('GRF-C55 a Stop with background work does not end the node; a prompt over 16000 characters is PromptTooLong', async () => {
    const env = testEnv()
    const id = env.start(`${head('  n: { type: integer, default: 0 }')}nodes:
  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: p } }
edges: []
`)
    await settle()
    await env.stop(env.agents[0].pane, { backgroundWork: true })
    expect(env.run(id).state.status).toBe('running')
    await env.stop(env.agents[0].pane, { backgroundWork: false })
    expect(env.run(id).state.status).toBe('done')

    const long = testEnv()
    const l = long.start(
      `${head('  p: { type: string }')}nodes:
  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: "{{state.p}}" } }
edges: []
`,
      { p: 'x'.repeat(16_001) },
    )
    await settle()
    expect(long.agents).toEqual([])
    expect(long.run(l).state.failure).toMatchObject({ name: 'PromptTooLong' })
  })

  it('GRF-C60 a dismissed approval fails the run, or with catch continue goes on with error.name Dismissed', async () => {
    const graph = (catchPart: string) => `${head('  err: { type: object, default: {} }')}nodes:
  - { id: a, kind: approval, with: { question: "ok?" }${catchPart}, out: { error: err } }
  - { id: b, kind: router }
edges:
  - { from: a, to: b }
`
    const env = testEnv()
    const failed = env.start(graph(''))
    await settle()
    await env.answer('', 'dismissed')
    expect(env.run(failed).state.failure).toMatchObject({ node: 'a', name: 'Dismissed' })
    const caught = testEnv()
    const ok = caught.start(graph(', catch: [{ errors: [Dismissed], then: continue }]'))
    await settle()
    await caught.answer('', 'dismissed')
    const run = caught.run(ok).state
    expect(run.status).toBe('done')
    expect(run.state.err).toMatchObject({ name: 'Dismissed' })
    expect(await ends(caught, ok)).toEqual(['a', 'b'])
  })

  it('GRF-C63 a wait until a past time ends at once', async () => {
    const env = testEnv()
    const id = env.start(`${head('  n: { type: integer, default: 0 }')}nodes:
  - { id: a, kind: wait, with: { until: "2020-01-01T00:00:00Z" } }
edges: []
`)
    await settle()
    expect(env.run(id).state.status).toBe('done')
  })

  it('GRF-C160 a notify after a command goes out at once while an agent still works', async () => {
    const env = testEnv()
    const id = env.start(`${head('  n: { type: integer, default: 0 }', 'f')}nodes:
  - { id: f, kind: router }
  - { id: slow, kind: agent, with: { mode: start, agent: claude, prompt: p } }
  - { id: cmd, kind: command, with: { run: [x] } }
  - { id: tell, kind: notify, with: { title: built } }
edges:
  - { from: f, to: [slow, cmd] }
  - { from: cmd, to: tell }
`)
    await settle()
    expect(env.notices.map((n) => n.title)).toEqual(['built'])
    expect(env.run(id).state.active.has('slow')).toBe(true)
    await env.clock.advance(30 * 60_000 - 1)
    await env.stop(env.agents[0].pane)
    expect(env.run(id).state.status).toBe('done')
  })
})

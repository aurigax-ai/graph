import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { WORKED_GRAPHS, workedGraph } from '../engine/fixtures.ts'
import { FORMAT_KINDS } from '../kinds/catalog.ts'
import { loadGraphText } from './graphFile.ts'
import { graphJsonSchema } from './schema.ts'

const BASE = {
  version: 1,
  on: [{ manual: {} }],
  start: 'a',
  state: { n: { type: 'integer', default: 0 }, s: { type: 'string', default: '' } },
  nodes: [
    { id: 'a', kind: 'command', with: { run: ['true'] }, out: { exit: 'n' } },
    { id: 'b', kind: 'router' },
  ],
  edges: [{ from: 'a', to: 'b' }],
}

type Graph = Record<string, unknown>

function variant(change: (g: Graph) => void): Graph {
  const graph = structuredClone(BASE) as Graph
  change(graph)
  return graph
}

function problemsOf(graph: unknown) {
  const text = typeof graph === 'string' ? graph : JSON.stringify(graph)
  const result = loadGraphText(text, '/w/.ostia/graphs/g.yaml')
  return result.ok ? [] : result.problems
}

function codes(graph: unknown): string[] {
  return problemsOf(graph).map((p) => p.code)
}

const nodes = (g: Graph) => g.nodes as Graph[]
const edges = (g: Graph) => g.edges as unknown[]

const BAD_TEMPLATES = [
  ['{{ state.x | upper }}', 'bad-template'],
  ['{{ state.a + 1 }}', 'bad-template'],
  ['{{ env.HOME }}', 'bad-template'],
  ['{{ state.missing }}', 'unknown-state-key'],
] as const

describe('validating a graph', () => {
  it('accepts the base graph', () => {
    expect(codes(BASE)).toEqual([])
  })

  it('GRF-C12 an unknown top-level or node key is unknown-key naming it; under ui it is accepted', () => {
    const top = problemsOf(
      variant((g) => {
        g.schedule = '0 9 * * *'
      }),
    )
    expect(top.map((p) => p.code)).toEqual(['unknown-key'])
    expect(top[0].message).toContain('schedule')
    const node = problemsOf(
      variant((g) => {
        nodes(g)[0].needs = ['b']
      }),
    )
    expect(node.map((p) => p.code)).toEqual(['unknown-key'])
    expect(node[0].message).toContain('needs')
    expect(
      codes(
        variant((g) => {
          g.ui = { schedule: 'x', needs: ['b'], positions: { a: [1, 2] } }
        }),
      ),
    ).toEqual([])
  })

  it('GRF-C13 the three worked graphs pass the printed JSON Schema, which lists every built-in kind', () => {
    const schema = graphJsonSchema(FORMAT_KINDS)
    const ajv = new Ajv2020({ strict: false, allErrors: true })
    const check = ajv.compile(schema)
    for (const name of WORKED_GRAPHS) {
      const ok = check(parse(workedGraph(name)))
      expect(check.errors ?? [], name).toEqual([])
      expect(ok).toBe(true)
      expect(codes(workedGraph(name)), name).toEqual([])
    }
    const text = JSON.stringify(schema)
    for (const kind of ['agent', 'command', 'router', 'approval', 'wait', 'notify', 'connector']) {
      expect(text).toContain(`"const":"${kind}"`)
    }
  })

  it('GRF-C14 version 2, a node called end and two nodes with one id', () => {
    expect(
      codes(
        variant((g) => {
          g.version = 2
        }),
      ),
    ).toEqual(['unsupported-version'])
    expect(
      codes(
        variant((g) => {
          nodes(g)[1].id = 'end'
        }),
      ),
    ).toContain('bad-id')
    expect(
      codes(
        variant((g) => {
          nodes(g)[1].id = 'a'
        }),
      ),
    ).toContain('duplicate-id')
  })

  it('GRF-C17 an out naming an undeclared key, and a default not of its type', () => {
    expect(
      codes(
        variant((g) => {
          nodes(g)[0].out = { exit: 'exitCode' }
        }),
      ),
    ).toEqual(['unknown-state-key'])
    expect(
      codes(
        variant((g) => {
          ;(g.state as Graph).n = { type: 'integer', default: 'zero' }
        }),
      ),
    ).toEqual(['bad-default'])
  })

  it('GRF-C20 two branches of a fan-out writing one replace key is merge-conflict naming both and the key', () => {
    const graph = variant((g) => {
      ;(g.state as Graph).result = { type: 'string', default: '' }
      g.nodes = [
        { id: 'a', kind: 'router' },
        { id: 'x', kind: 'command', with: { run: ['true'] }, out: { stdout: 'result' } },
        { id: 'y', kind: 'command', with: { run: ['true'] }, out: { stdout: 'result' } },
        { id: 'j', kind: 'router' },
      ]
      g.edges = [
        { from: 'a', to: ['x', 'y'] },
        { from: ['x', 'y'], to: 'j' },
      ]
    })
    const found = problemsOf(graph)
    expect(found.map((p) => p.code)).toEqual(['merge-conflict'])
    expect(found[0].message).toContain('x')
    expect(found[0].message).toContain('y')
    expect(found[0].key).toBe('result')
  })

  it('GRF-C22 merge: append on a string key is append-needs-array', () => {
    expect(
      codes(
        variant((g) => {
          ;(g.state as Graph).s = { type: 'string', merge: 'append' }
        }),
      ),
    ).toEqual(['append-needs-array'])
  })

  it.each(BAD_TEMPLATES)('GRF-C25 the template %s is %s with the node id', (template, code) => {
    const found = problemsOf(
      variant((g) => {
        nodes(g)[0].with = { run: ['echo', template] }
      }),
    )
    expect(found.map((p) => p.code)).toEqual([code])
    expect(found[0].node).toBe('a')
  })

  it('GRF-C32 the edge errors of a graph', () => {
    expect(
      codes(
        variant((g) => {
          edges(g)[0] = { from: 'a', to: 'nope' }
        }),
      ),
    ).toContain('unknown-node')
    expect(
      codes(
        variant((g) => {
          g.edges = []
        }),
      ),
    ).toEqual(['unreachable'])
    expect(codes(variant((g) => edges(g).push({ from: 'a', to: 'end' })))).toContain('second-edge')
    expect(
      codes(
        variant((g) => {
          edges(g)[0] = { from: 'a', when: [{ if: 'state.n == 0', to: 'b' }] }
        }),
      ),
    ).toEqual(['bad-edge'])
    expect(
      codes(
        variant((g) => {
          g.start = undefined
        }),
      ),
    ).toEqual(['no-start'])
    expect(codes(variant((g) => edges(g).push({ from: 'b', to: 'a' })))).toEqual([
      'unconditional-cycle',
    ])
    expect(
      codes(
        variant((g) =>
          edges(g).push({ from: 'b', when: [{ if: 'state.n == 0', to: 'a' }], else: 'end' }),
        ),
      ),
    ).toEqual([])
  })

  it('GRF-C34 a string edge is string-edge with the field form in the message', () => {
    const found = problemsOf(
      variant((g) => {
        g.edges = ['a -> b when state.n == 0']
      }),
    )
    expect(found.map((p) => p.code)).toEqual(['string-edge'])
    expect(found[0].message).toContain('{from: a, when: [{if: "state.n == 0", to: b}], else: …}')
  })

  it('GRF-C35 result on a command, bad result schemas, All not last, a bad error name and a trigger node', () => {
    const result = { type: 'object', properties: { v: { type: 'string' } } }
    expect(
      codes(
        variant((g) => {
          nodes(g)[0].result = result
        }),
      ),
    ).toEqual(['bad-result'])
    const agent = (r: unknown) =>
      variant((g) => {
        nodes(g)[1] = {
          id: 'b',
          kind: 'agent',
          with: { mode: 'start', agent: 'claude', prompt: 'hi' },
          result: r,
        }
      })
    const many = Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [`p${i}`, { type: 'string' }]),
    )
    expect(codes(agent({ type: 'object', properties: many }))).toEqual(['bad-result'])
    expect(codes(agent({ type: 'object', properties: { o: { type: 'object' } } }))).toEqual([
      'bad-result',
    ])
    expect(
      codes(
        variant((g) => {
          nodes(g)[0].catch = [
            // biome-ignore lint/suspicious/noThenProperty: the format names a catch target then
            { errors: ['All'], then: 'end' },
            // biome-ignore lint/suspicious/noThenProperty: the format names a catch target then
            { errors: ['Timeout'], then: 'b' },
          ]
        }),
      ),
    ).toEqual(['all-not-last'])
    expect(
      codes(
        variant((g) => {
          nodes(g)[0].retry = [{ errors: ['Oops'] }]
        }),
      ),
    ).toEqual(['bad-error-name'])
    expect(
      codes(
        variant((g) => {
          nodes(g)[1] = { id: 'b', kind: 'trigger' }
        }),
      ),
    ).toEqual(['unknown-kind'])
  })

  it('GRF-C36 a loop from inside a parallel region back to its fan-out is cyclic-parallel-region; after the join it is valid', () => {
    const shape = (loop: Graph) =>
      variant((g) => {
        g.nodes = [
          { id: 'f', kind: 'router' },
          { id: 'a', kind: 'router' },
          { id: 'b', kind: 'router' },
          { id: 'c', kind: 'router' },
        ]
        g.start = 'f'
        g.edges = [{ from: 'f', to: ['a', 'b'] }, { from: ['a', 'b'], to: 'c' }, loop]
      })
    expect(
      codes(shape({ from: 'b', when: [{ if: 'state.n == 0', to: 'f' }], else: 'end' })),
    ).toContain('cyclic-parallel-region')
    expect(
      codes(shape({ from: 'c', when: [{ if: 'state.n == 0', to: 'f' }], else: 'end' })),
    ).toEqual([])
  })

  it('GRF-C51 triggers outside the workspace, too often or with six cron fields are bad-with; a webhook is unsupported-trigger', () => {
    const trigger = (t: unknown) =>
      problemsOf(
        variant((g) => {
          g.on = [t]
        }),
      )
    for (const t of [
      { files: { glob: '../other/**' } },
      { files: { glob: '/etc/*' } },
      { schedule: { every: '10s' } },
      { schedule: { cron: '0 0 9 * * 1' } },
    ]) {
      const found = trigger(t)
      expect(found.map((p) => p.code)).toEqual(['bad-with'])
      expect(found[0].message).toMatch(/glob|every|cron/)
    }
    expect(trigger({ webhook: { path: '/x' } }).map((p) => p.code)).toEqual(['unsupported-trigger'])
  })

  it('GRF-C63 a wait of 31d and a router with fields are bad-with', () => {
    expect(
      codes(
        variant((g) => {
          nodes(g)[1] = { id: 'b', kind: 'wait', with: { for: '31d' } }
        }),
      ),
    ).toEqual(['bad-with'])
    expect(
      codes(
        variant((g) => {
          nodes(g)[1].with = { anything: 1 }
        }),
      ),
    ).toEqual(['bad-with'])
  })

  it('GRF-C46 an unknown kind lists the known kinds', () => {
    const found = problemsOf(
      variant((g) => {
        nodes(g)[1].kind = 'nope'
      }),
    )
    expect(found.map((p) => p.code)).toEqual(['unknown-kind'])
    for (const kind of ['agent', 'command', 'router', 'approval', 'wait', 'notify']) {
      expect(found[0].message).toContain(kind)
    }
  })

  it('GRF-C98 limits.steps 9999 in the file is over-limit', () => {
    expect(
      codes(
        variant((g) => {
          g.limits = { steps: 9999 }
        }),
      ),
    ).toEqual(['over-limit'])
  })

  it('GRF-C182 limits.time 200h is over-limit; a continue from a non-agent node or a session id is bad-with', () => {
    expect(
      codes(
        variant((g) => {
          g.limits = { time: '200h' }
        }),
      ),
    ).toEqual(['over-limit'])
    const cont = (w: Graph) =>
      problemsOf(
        variant((g) => {
          nodes(g)[1] = { id: 'b', kind: 'agent', with: { mode: 'continue', prompt: 'go', ...w } }
        }),
      )
    const fromCommand = cont({ from: 'a' })
    expect(fromCommand.map((p) => p.code)).toEqual(['bad-with'])
    expect(fromCommand[0].message).toContain('from must be an agent node of this graph')
    expect(cont({ session: '0f6b2a3c-1111-2222-3333-444455556666' }).map((p) => p.code)).toContain(
      'bad-with',
    )
  })
})

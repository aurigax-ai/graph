import { describe, expect, it } from 'vitest'
import type { Output } from '../engine/contract.ts'
import { settle, testEnv } from '../engine/fakeHost.ts'
import { loadGraphText } from '../format/graphFile.ts'
import { connectorCatalog, connectorProblems, connectorUses } from './check.ts'
import { connectorNode } from './connectorNode.ts'
import type { McpCall } from './contract.ts'
import { httpConnector } from './http.ts'

function text(node: string, extra = ''): string {
  return `version: 1
on: [{ manual: {} }]
start: a
state:
  task: { type: string, default: "hello" }
  answer: { type: string, default: "" }
  err: { type: string, default: "" }
nodes:
  - ${node}${extra}
edges: []
`
}

function harness(mcpCall?: McpCall) {
  return testEnv({
    kinds: (s) => [
      connectorNode({
        clock: s.clock,
        ...(mcpCall ? { mcpCall } : {}),
        native: [httpConnector()],
        connection: async () => null,
      }),
    ],
  })
}

function graphOf(t: string) {
  const loaded = loadGraphText(t, '/w/.ostia/graphs/g.yaml')
  if (!loaded.ok) throw new Error(loaded.problems.map((p) => p.message).join('\n'))
  return loaded.value.graph
}

describe('the connector kind', () => {
  it('calls an MCP tool with its templated input and puts the text in the state', async () => {
    const calls: Output[] = []
    const env = harness(async (server, tool, input) => {
      calls.push({ server, tool, input })
      return { ok: true, text: `echo: ${String(input.text)}` }
    })
    const id = env.start(
      text(
        '{ id: a, kind: connector, with: { use: "mcp:fake/echo", input: { text: "{{state.task}}" } }, out: { data.text: answer } }',
      ),
    )
    await settle()
    expect(calls).toEqual([{ server: 'fake', tool: 'echo', input: { text: 'hello' } }])
    expect(env.run(id).state.state.answer).toBe('echo: hello')
    expect(env.run(id).state.status).toBe('done')
  })

  it('fails with ConnectorFailed and the host message, and a catch keeps the run going', async () => {
    const env = harness(async () => ({ ok: false, error: 'mcp server fake is off' }))
    const failing = env.start(text('{ id: a, kind: connector, with: { use: "mcp:fake/echo" } }'))
    await settle()
    expect(env.run(failing).state.status).toBe('failed')
    const caught = env.start(
      text(
        '{ id: a, kind: connector, with: { use: "mcp:fake/echo" }, out: { error.message: err }, catch: [{ errors: [ConnectorFailed], then: continue }] }',
      ),
    )
    await settle()
    expect(env.run(caught).state.status).toBe('done')
    expect(String(env.run(caught).state.state.err)).toContain('mcp server fake is off')
  })

  it('GRF-C179 a connection that does not exist is unknown-connection', () => {
    const graph = graphOf(
      text(
        '{ id: a, kind: connector, with: { use: "http.request", connection: nope, input: { path: "/x" } } }',
      ),
    )
    const host = {
      mcp: true,
      native: [httpConnector()],
      connections: [{ name: 'api', kind: 'http' }],
    }
    expect(connectorProblems(graph, host).map((p) => p.code)).toEqual(['unknown-connection'])
    expect(
      connectorProblems(graph, { ...host, connections: [{ name: 'nope', kind: 'http' }] }),
    ).toEqual([])
  })

  it('names native connectors, operations and their effect, and never a URL or secret', () => {
    const graph = graphOf(
      `version: 1
on: [{ manual: {} }]
start: a
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: a, kind: connector, with: { use: "http.request", connection: api, input: { method: POST, path: "/items", body: { n: 1 } } } }
  - { id: b, kind: connector, with: { use: "http.request", connection: api, input: { path: "/items" } } }
  - { id: c, kind: connector, with: { use: "mcp:fake/echo" } }
edges: [{ from: a, to: b }, { from: b, to: c }]
`,
    )
    expect(
      connectorUses(graph, { native: [httpConnector()] }).map((u) => [u.node, u.effect]),
    ).toEqual([
      ['a', 'write'],
      ['b', 'read'],
      ['c', 'external'],
    ])
    const catalog = JSON.stringify(connectorCatalog([httpConnector()]))
    expect(catalog).toContain('"request"')
    expect(catalog).not.toContain('secret"')
  })
})

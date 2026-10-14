import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock, settle, testEnv } from '../engine/fakeHost.ts'
import { connectorNode } from './connectorNode.ts'
import type { ResolvedConnection } from './contract.ts'
import {
  HTTP_ERRORS,
  HTTP_RESPONSE_MAX,
  HTTP_TIMEOUT_MS,
  httpConnector,
  pathUnderBase,
  requestUrl,
} from './http.ts'

const SECRET = ['sk', 'live', 'q'.repeat(24)].join('_')
const servers: Server[] = []

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
})

async function serve(handle: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handle)
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function connection(baseUrl: string): ResolvedConnection {
  return {
    name: 'api',
    kind: 'http',
    fields: { baseUrl, auth: 'bearer' },
    secrets: { secret: SECRET },
  }
}

function graph(input: string): string {
  return `version: 1
on: [{ manual: {} }]
start: a
state:
  status: { type: integer, default: 0 }
  err: { type: string, default: "" }
nodes:
  - { id: a, kind: connector, with: { use: "http.request", connection: api, input: ${input} }, out: { data.status: status, error.message: err }, catch: [{ errors: [ConnectorFailed], then: continue }] }
edges: []
`
}

function harness(conn: ResolvedConnection, clock = new FakeClock()) {
  return testEnv({
    clock,
    kinds: (s) => [
      connectorNode({
        clock: s.clock,
        native: [httpConnector()],
        connection: async (name) => (name === conn.name ? conn : null),
      }),
    ],
  })
}

async function finished(env: ReturnType<typeof harness>, id: string): Promise<void> {
  for (let i = 0; i < 200 && env.run(id).state.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 10))
    await settle()
  }
}

describe('the http connector', () => {
  it('GRF-C189 sends to the connection with its auth, and keeps the secret out of the journal', async () => {
    const seen: { url?: string; auth?: string; method?: string; body: string }[] = []
    const base = await serve((req, res) => {
      let body = ''
      req.on('data', (c) => {
        body += c
      })
      req.on('end', () => {
        seen.push({ url: req.url, auth: req.headers.authorization, method: req.method, body })
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ made: true }))
      })
    })
    const env = harness(connection(`${base}/v1`))
    const id = env.start(graph('{ method: POST, path: "/items", query: { q: a }, body: { n: 1 } }'))
    await finished(env, id)
    expect(seen).toEqual([
      { url: '/v1/items?q=a', auth: `Bearer ${SECRET}`, method: 'POST', body: '{"n":1}' },
    ])
    expect(env.run(id).state.state.status).toBe(200)
    const lines = env.store.read({ scope: 'w1', graph: 'g', runId: id })?.lines ?? []
    expect(JSON.stringify(lines)).not.toContain(SECRET)
  })

  it('GRF-C189 refuses a path that leaves the origin, a redirect to another origin and a response over 1 MiB', async () => {
    const other = await serve((_req, res) => res.end('should never be reached'))
    let otherHits = 0
    const elsewhere = await serve((_req, res) => {
      otherHits++
      res.end('x')
    })
    const base = await serve((req, res) => {
      if (req.url === '/away') {
        res.statusCode = 302
        res.setHeader('location', `${elsewhere}/stolen`)
        res.end()
      } else if (req.url === '/here') {
        res.statusCode = 302
        res.setHeader('location', '/fine')
        res.end()
      } else if (req.url === '/big') {
        res.end(Buffer.alloc(HTTP_RESPONSE_MAX + 1, 97))
      } else res.end('ok')
    })
    expect(() => requestUrl(base, '//evil.test/x')).toThrow(HTTP_ERRORS.invalid)
    const env = harness(connection(base))
    const errors: Record<string, string> = {}
    for (const [name, input] of [
      ['double-slash', '{ path: "//other.test/x" }'],
      ['away', '{ path: "/away" }'],
      ['big', '{ path: "/big" }'],
      ['here', '{ path: "/here" }'],
    ] as const) {
      const id = env.start(graph(input))
      await finished(env, id)
      errors[name] = String(env.run(id).state.state.err)
      if (name === 'here') expect(env.run(id).state.state.status).toBe(200)
    }
    expect(errors['double-slash']).toContain(
      "a path under the connection's base URL, starting with one /",
    )
    expect(errors.away).toBe(HTTP_ERRORS.otherOrigin)
    expect(errors.big).toBe(HTTP_ERRORS.tooLarge)
    expect(errors.here).toBe('')
    expect(otherHits).toBe(0)
    expect(other).toBeTruthy()
  })

  it('GRF-C189 stops a request that gets no answer within 30 s', async () => {
    const base = await serve(() => {})
    const clock = new FakeClock()
    const env = harness(connection(base), clock)
    const id = env.start(graph('{ path: "/slow" }'))
    await new Promise((r) => setTimeout(r, 50))
    await clock.advance(HTTP_TIMEOUT_MS)
    await finished(env, id)
    expect(env.run(id).state.state.err).toBe(HTTP_ERRORS.timeout)
  })

  it('GRF-C189 a GET is a read and every other method a write', () => {
    const op = httpConnector().operations[0]
    const effect = op?.effect as (input: Record<string, unknown>) => string
    expect([
      effect({ path: '/' }),
      effect({ method: 'GET' }),
      effect({ method: 'POST' }),
      effect({ method: 'DELETE' }),
    ]).toEqual(['read', 'read', 'write', 'write'])
  })

  it('refuses a path that leaves the base path, raw or percent-encoded, and keeps a nested one', async () => {
    for (const path of [
      '/../x',
      '/a/../../x',
      '/%2e%2e/x',
      '/%2E%2e/x',
      '/.%2e/x',
      '/a%2f..%2fb',
      '/a%5cb',
      '/a\\b',
      '//other.test/x',
      '/%zz',
    ])
      expect(pathUnderBase(path), path).toBe(false)
    expect(pathUnderBase('/items/42/notes')).toBe(true)
    expect(requestUrl('https://api.example.test/v1', '/items/42').href).toBe(
      'https://api.example.test/v1/items/42',
    )
    expect(requestUrl('https://api.example.test/v1/', '/').href).toBe(
      'https://api.example.test/v1/',
    )
    expect(() => requestUrl('https://api.example.test/v1', '/%2e%2e/admin')).toThrow(
      HTTP_ERRORS.invalid,
    )
    let hits = 0
    const base = await serve((_req, res) => {
      hits++
      res.end('ok')
    })
    const env = harness(connection(`${base}/v1`))
    const id = env.start(graph('{ path: "/%2e%2e/admin" }'))
    await finished(env, id)
    expect(String(env.run(id).state.state.err)).toContain("a path under the connection's base URL")
    expect(hits).toBe(0)
  })

  it('refuses a redirect that leaves the base path on the same origin', async () => {
    const base = await serve((req, res) => {
      if (req.url === '/v1/out') {
        res.statusCode = 302
        res.setHeader('location', '/admin')
        res.end()
      } else res.end('ok')
    })
    const env = harness(connection(`${base}/v1`))
    const id = env.start(graph('{ path: "/out" }'))
    await finished(env, id)
    expect(env.run(id).state.state.err).toBe(HTTP_ERRORS.outsideBase)
  })

  it('keeps a secret with a line break and a base URL with a user name and password out of every error, journal line and output', async () => {
    const broken = `${SECRET}\r\nX-Injected: 1`
    const userinfo = `${['u', 'ser'].join('')}:${['p', 'ass', 'word'].join('')}`
    let hits = 0
    const base = await serve((_req, res) => {
      hits++
      res.end('ok')
    })
    const runs: { err: string; journal: string }[] = []
    for (const conn of [
      { ...connection(base), secrets: { secret: broken } },
      { ...connection(base.replace('http://', `http://${userinfo}@`)) },
    ]) {
      const env = harness(conn)
      const id = env.start(graph('{ path: "/x" }'))
      await finished(env, id)
      const journal = JSON.stringify(
        env.store.read({ scope: 'w1', graph: 'g', runId: id })?.lines ?? [],
      )
      runs.push({ err: String(env.run(id).state.state.err), journal })
    }
    expect(runs.map((r) => r.err)).toEqual([HTTP_ERRORS.control, HTTP_ERRORS.badConnection])
    expect(hits).toBe(0)
    for (const run of runs) {
      for (const leaked of [SECRET, userinfo, 'X-Injected']) {
        expect(run.err).not.toContain(leaked)
        expect(run.journal).not.toContain(leaked)
      }
    }
  })

  it('puts a fixed message in place of whatever a failing fetch says', async () => {
    const leaky = (message: string, code?: string) =>
      (async () => {
        throw Object.assign(new TypeError(message), code ? { cause: { code } } : {})
      }) as unknown as typeof fetch
    const cases = [
      [leaky(`connect ECONNREFUSED with ${SECRET}`, 'ECONNREFUSED'), HTTP_ERRORS.refused],
      [leaky(`getaddrinfo ENOTFOUND ${SECRET}`, 'ENOTFOUND'), HTTP_ERRORS.failed],
      [leaky(`Invalid header value ${SECRET}`), HTTP_ERRORS.invalid],
    ] as const
    for (const [fetcher, message] of cases) {
      const env = testEnv({
        kinds: (s) => [
          connectorNode({
            clock: s.clock,
            native: [httpConnector(fetcher)],
            connection: async () => connection('https://api.example.test'),
          }),
        ],
      })
      const id = env.start(graph('{ path: "/x" }'))
      await finished(env, id)
      expect(env.run(id).state.state.err).toBe(message)
      const journal = JSON.stringify(
        env.store.read({ scope: 'w1', graph: 'g', runId: id })?.lines ?? [],
      )
      expect(journal).not.toContain(SECRET)
    }
  })
})

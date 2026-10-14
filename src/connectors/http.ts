import { z } from 'zod'
import type { Clock, Output } from '../engine/contract.ts'
import type { ConnectorCall, NativeConnector, ResolvedConnection } from './contract.ts'

export const HTTP_RESPONSE_MAX = 1024 * 1024
export const HTTP_TIMEOUT_MS = 30_000
const REDIRECTS_MAX = 5
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

const connectionFields = z.strictObject({
  baseUrl: z.url({ protocol: /^https?$/ }),
  auth: z.enum(['none', 'bearer', 'header', 'basic']),
  header: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,64}$/)
    .optional(),
  username: z.string().max(256).optional(),
})

const requestInput = z.strictObject({
  method: z.enum(METHODS).default('GET'),
  path: z
    .string()
    .max(2048)
    .regex(/^\/(?!\/)/, 'a path starting with one /, on the connection'),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  body: z.unknown().optional(),
})

const requestOutput = z.object({
  status: z.number(),
  contentType: z.string(),
  body: z.unknown(),
})

function failed(message: string): never {
  throw new Error(message)
}

function authHeaders(connection: ResolvedConnection): Record<string, string> {
  const fields = connectionFields.parse(connection.fields)
  const secret = connection.secrets.secret ?? ''
  if (fields.auth === 'bearer') return { authorization: `Bearer ${secret}` }
  if (fields.auth === 'header') return { [fields.header ?? 'x-api-key']: secret }
  if (fields.auth === 'basic') {
    return {
      authorization: `Basic ${Buffer.from(`${fields.username ?? ''}:${secret}`).toString('base64')}`,
    }
  }
  return {}
}

export function requestUrl(baseUrl: string, path: string, query?: Record<string, unknown>): URL {
  const base = new URL(baseUrl)
  const url = new URL(base.href)
  url.pathname = `${base.pathname.replace(/\/$/, '')}${path.split('?')[0]}`
  url.search = ''
  url.hash = ''
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v))
  if (url.origin !== base.origin) failed(`the request leaves ${base.origin}`)
  return url
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > HTTP_RESPONSE_MAX) {
      await reader.cancel()
      failed(`the response is over ${HTTP_RESPONSE_MAX} bytes`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function timeoutSignal(
  clock: Clock,
  outer: AbortSignal,
): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController()
  const abort = () => controller.abort(new Error(`no answer within ${HTTP_TIMEOUT_MS / 1000} s`))
  if (outer.aborted) abort()
  outer.addEventListener('abort', abort, { once: true })
  const cancel = clock.setTimer(clock.now() + HTTP_TIMEOUT_MS, abort)
  return {
    signal: controller.signal,
    done: () => {
      cancel()
      outer.removeEventListener('abort', abort)
    },
  }
}

async function request(call: ConnectorCall, fetcher: typeof fetch): Promise<Output> {
  const connection = call.connection ?? failed('http.request needs a connection')
  const input = requestInput.parse(call.input)
  const fields = connectionFields.parse(connection.fields)
  const origin = new URL(fields.baseUrl).origin
  let url = requestUrl(fields.baseUrl, input.path, input.query)
  const headers: Record<string, string> = {
    accept: 'application/json, text/*',
    ...authHeaders(connection),
  }
  const body =
    input.body === undefined || input.method === 'GET' ? undefined : JSON.stringify(input.body)
  if (body !== undefined) headers['content-type'] = 'application/json'
  const timer = timeoutSignal(call.clock, call.signal)
  try {
    for (let hop = 0; ; hop++) {
      const response = await fetcher(url, {
        method: input.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: 'manual',
        signal: timer.signal,
      }).catch((err: unknown) => {
        const reason = timer.signal.aborted ? timer.signal.reason : err
        failed(reason instanceof Error ? reason.message : String(reason))
      })
      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        await response.body?.cancel()
        const next = new URL(response.headers.get('location') as string, url)
        if (next.origin !== origin)
          failed(`a redirect to another origin was refused (${next.origin})`)
        if (hop >= REDIRECTS_MAX) failed('too many redirects')
        url = next
        continue
      }
      const text = await readCapped(response)
      const contentType = response.headers.get('content-type') ?? ''
      let parsed: unknown = text
      if (contentType.includes('json') && text.length > 0) {
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = text
        }
      }
      return {
        ok: response.status >= 200 && response.status < 300,
        data: { status: response.status, contentType, body: parsed },
      }
    }
  } finally {
    timer.done()
  }
}

export function httpConnector(fetcher: typeof fetch = fetch): NativeConnector {
  return {
    id: 'http',
    version: 1,
    title: 'HTTP',
    connections: [
      {
        kind: 'http',
        title: 'HTTP API',
        fields: connectionFields,
        secrets: ['secret'],
      },
    ],
    operations: [
      {
        name: 'request',
        title: 'Send a request',
        effect: (input) =>
          input.method === undefined || input.method === 'GET' ? 'read' : 'write',
        input: requestInput,
        output: requestOutput,
      },
    ],
    call: (call) => request(call, fetcher),
  }
}

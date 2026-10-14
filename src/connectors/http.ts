import { z } from 'zod'
import type { Clock, Output } from '../engine/contract.ts'
import { hasControl } from '../kinds/fields.ts'
import {
  type ConnectorCall,
  ConnectorError,
  type NativeConnector,
  type ResolvedConnection,
} from './contract.ts'

export const HTTP_RESPONSE_MAX = 1024 * 1024
export const HTTP_TIMEOUT_MS = 30_000
const REDIRECTS_MAX = 5
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

export const HTTP_ERRORS = {
  timeout: `http: timeout after ${HTTP_TIMEOUT_MS / 1000} s`,
  refused: 'http: connection refused',
  failed: 'http: request failed',
  invalid: 'http: invalid request',
  cancelled: 'http: request cancelled',
  tooLarge: `http: response over ${HTTP_RESPONSE_MAX} bytes`,
  otherOrigin: 'http: redirect to another origin refused',
  outsideBase: 'http: redirect outside the base URL refused',
  tooManyRedirects: 'http: too many redirects',
  noConnection: 'http: http.request needs a connection',
  badConnection: 'http: the connection is not a valid http connection',
  control: 'http: the connection holds a control character in a field or its secret',
} as const

function withoutUserinfo(value: string): boolean {
  try {
    const url = new URL(value)
    return url.username === '' && url.password === ''
  } catch {
    return false
  }
}

function decoded(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

export function pathUnderBase(path: string): boolean {
  if (!/^\/(?!\/)/.test(path) || path.includes('\\')) return false
  for (const segment of path.split('?')[0]?.split('/') ?? []) {
    const plain = decoded(segment)
    if (plain === null || plain === '..' || plain.includes('/') || plain.includes('\\'))
      return false
  }
  return true
}

const connectionFields = z.strictObject({
  baseUrl: z
    .url({ protocol: /^https?$/ })
    .refine(
      withoutUserinfo,
      "a base URL with no user name or password in it; the secret goes in the connection's secret",
    ),
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
    .refine(pathUnderBase, "a path under the connection's base URL, starting with one /"),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  body: z.unknown().optional(),
})

const requestOutput = z.object({
  status: z.number(),
  contentType: z.string(),
  body: z.unknown(),
})

function failed(message: string): never {
  throw new ConnectorError(message)
}

function fieldsOf(connection: ResolvedConnection): z.infer<typeof connectionFields> {
  const parsed = connectionFields.safeParse(connection.fields)
  if (!parsed.success) failed(HTTP_ERRORS.badConnection)
  const values = [...Object.values(parsed.data), ...Object.values(connection.secrets)]
  if (values.some((v) => typeof v === 'string' && hasControl(v))) failed(HTTP_ERRORS.control)
  return parsed.data
}

function authHeaders(connection: ResolvedConnection): Record<string, string> {
  const fields = fieldsOf(connection)
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

function basePrefix(base: URL): string {
  return base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`
}

function underBase(url: URL, base: URL): boolean {
  const prefix = basePrefix(base)
  return (
    url.origin === base.origin && (url.pathname.startsWith(prefix) || `${url.pathname}/` === prefix)
  )
}

export function requestUrl(baseUrl: string, path: string, query?: Record<string, unknown>): URL {
  if (!pathUnderBase(path)) failed(HTTP_ERRORS.invalid)
  const base = new URL(baseUrl)
  const url = new URL(base.href)
  url.pathname = `${base.pathname.replace(/\/$/, '')}${path.split('?')[0]}`
  url.search = ''
  url.hash = ''
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v))
  if (!underBase(url, base)) failed(HTTP_ERRORS.invalid)
  return url
}

function failureOf(err: unknown, timedOut: boolean, cancelled: boolean): string {
  if (timedOut) return HTTP_ERRORS.timeout
  if (cancelled) return HTTP_ERRORS.cancelled
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause
  const code = typeof cause?.code === 'string' ? cause.code : ''
  if (code === 'ECONNREFUSED') return HTTP_ERRORS.refused
  if (code.startsWith('UND_ERR_INVALID') || code === 'ERR_INVALID_URL') return HTTP_ERRORS.invalid
  if (err instanceof TypeError && !code) return HTTP_ERRORS.invalid
  return HTTP_ERRORS.failed
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
      failed(HTTP_ERRORS.tooLarge)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function timeoutSignal(
  clock: Clock,
  outer: AbortSignal,
): { signal: AbortSignal; timedOut: () => boolean; done: () => void } {
  const controller = new AbortController()
  const state = { timedOut: false }
  const abort = () => controller.abort()
  const expire = () => {
    state.timedOut = true
    controller.abort()
  }
  if (outer.aborted) abort()
  outer.addEventListener('abort', abort, { once: true })
  const cancel = clock.setTimer(clock.now() + HTTP_TIMEOUT_MS, expire)
  return {
    signal: controller.signal,
    timedOut: () => state.timedOut,
    done: () => {
      cancel()
      outer.removeEventListener('abort', abort)
    },
  }
}

async function request(call: ConnectorCall, fetcher: typeof fetch): Promise<Output> {
  const connection = call.connection ?? failed(HTTP_ERRORS.noConnection)
  const parsedInput = requestInput.safeParse(call.input)
  if (!parsedInput.success) failed(HTTP_ERRORS.invalid)
  const input = parsedInput.data
  const fields = fieldsOf(connection)
  const base = new URL(fields.baseUrl)
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
      }).catch((err: unknown) => failed(failureOf(err, timer.timedOut(), timer.signal.aborted)))
      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        await response.body?.cancel().catch(() => {})
        let next: URL
        try {
          next = new URL(response.headers.get('location') as string, url)
        } catch {
          failed(HTTP_ERRORS.invalid)
        }
        if (next.origin !== base.origin) failed(HTTP_ERRORS.otherOrigin)
        if (!underBase(next, base)) failed(HTTP_ERRORS.outsideBase)
        if (hop >= REDIRECTS_MAX) failed(HTTP_ERRORS.tooManyRedirects)
        url = next
        continue
      }
      const text = await readCapped(response).catch((err: unknown) => {
        if (err instanceof ConnectorError) throw err
        failed(failureOf(err, timer.timedOut(), timer.signal.aborted))
      })
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

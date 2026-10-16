import { chmodSync, rmSync } from 'node:fs'
import { type Server, type Socket, createServer } from 'node:net'
import {
  ErrorCodes,
  Message,
  ResponseError,
  SocketMessageReader,
  SocketMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node'
import type { Right, Tokens } from './tokens.ts'

export const RUNTIME_CONTRACT = 1
export const RUNTIME_EVENTS: readonly string[] = [
  'graph.changed',
  'node.changed',
  'run.changed',
  'worker.changed',
]
export const MAX_CLIENTS = 32
export const MAX_UNAUTHENTICATED = 16
export const HELLO_TIMEOUT_MS = 10_000
export const APP_ERROR = -32000

export class RpcError extends Error {}

export interface Session {
  readonly id: number
  readonly client: string
  readonly rights: ReadonlySet<Right>
  notify: (event: string, params: unknown) => void
  request: (method: string, params: unknown) => Promise<unknown>
  close: () => void
}

export type Handler = (params: unknown, session: Session) => unknown | Promise<unknown>

interface Method {
  right: Right | null
  handler: Handler
}

interface Live extends Session {
  token: string
  closed: (() => void)[]
}

export interface ServerOptions {
  tokens: Tokens
  hello: (session: Session) => Record<string, unknown>
  clientsChanged: (count: number) => void
  maxClients?: number
  helloTimeoutMs?: number
  version?: string
}

class ClosingWriter extends SocketMessageWriter {
  closing = false

  constructor(private readonly target: Socket) {
    super(target)
  }

  override async write(msg: Message): Promise<void> {
    await super.write(msg)
    if (this.closing && Message.isResponse(msg)) this.target.end()
  }
}

function fail(message: string): ResponseError<undefined> {
  return new ResponseError(APP_ERROR, message)
}

export class RuntimeServer {
  private readonly table = new Map<string, Method>()
  private readonly sessions = new Map<number, Live>()
  private readonly sockets = new Set<Socket>()
  private readonly waiting = new Set<Socket>()
  private server: Server | null = null
  private nextId = 1

  constructor(private readonly opts: ServerOptions) {}

  method(name: string, right: Right | null, handler: Handler): void {
    this.table.set(name, { right, handler })
  }

  methods(): string[] {
    return ['hello', ...this.table.keys()].sort()
  }

  get clients(): number {
    return this.sessions.size
  }

  listen(path: string): Promise<void> {
    rmSync(path, { force: true })
    const server = createServer((socket) => this.accept(socket))
    this.server = server
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        chmodSync(path, 0o600)
        server.off('error', reject)
        resolve()
      })
    })
  }

  private accept(socket: Socket): void {
    if (this.waiting.size >= MAX_UNAUTHENTICATED) {
      socket.destroy()
      return
    }
    this.sockets.add(socket)
    this.waiting.add(socket)
    const helloTimer = setTimeout(
      () => socket.destroy(),
      this.opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS,
    )
    socket.on('error', () => socket.destroy())
    const writer = new ClosingWriter(socket)
    const connection = createMessageConnection(new SocketMessageReader(socket), writer)
    let session: Live | null = null
    socket.on('close', () => {
      clearTimeout(helloTimer)
      this.waiting.delete(socket)
      this.sockets.delete(socket)
      connection.dispose()
      if (!session) return
      this.sessions.delete(session.id)
      for (const fn of session.closed.splice(0)) fn()
      this.opts.clientsChanged(this.sessions.size)
    })
    connection.onError(() => socket.destroy())
    const refuse = (code: string, data?: Record<string, unknown>) => {
      writer.closing = true
      return data ? new ResponseError(APP_ERROR, code, data) : fail(code)
    }
    connection.onRequest(async (method: string, params: unknown) => {
      if (method === 'hello') {
        if (session) return fail('already-hello')
        const hello = (params ?? {}) as { contract?: unknown; token?: unknown }
        if (hello.contract !== RUNTIME_CONTRACT)
          return refuse('unsupported-contract', {
            contract: RUNTIME_CONTRACT,
            ...(this.opts.version ? { version: this.opts.version } : {}),
          })
        const verified = this.opts.tokens.verify(hello.token)
        if (!verified) return refuse('unauthorized')
        if (this.sessions.size >= (this.opts.maxClients ?? MAX_CLIENTS))
          return refuse('too-many-clients')
        const live: Live = {
          id: this.nextId++,
          client: verified.client,
          rights: new Set(verified.rights),
          token: hello.token as string,
          closed: [],
          notify: (event, eventParams) => {
            void connection.sendNotification(event, eventParams).catch(() => {})
          },
          request: (method, requestParams) => {
            if (socket.destroyed) return Promise.reject(new RpcError('connection-closed'))
            const closed = new Promise<never>((_, reject) =>
              socket.once('close', () => reject(new RpcError('connection-closed'))),
            )
            return Promise.race([connection.sendRequest(method, requestParams), closed])
          },
          close: () => socket.destroy(),
        }
        clearTimeout(helloTimer)
        this.waiting.delete(socket)
        session = live
        this.sessions.set(live.id, live)
        this.opts.clientsChanged(this.sessions.size)
        return this.opts.hello(live)
      }
      const entry = this.table.get(method)
      if (!entry) return new ResponseError(ErrorCodes.MethodNotFound, 'method-not-found')
      if (!session) return fail('hello-first')
      if (entry.right && !session.rights.has(entry.right))
        return fail(`needs-right: ${entry.right}`)
      try {
        return (await entry.handler(params, session)) ?? null
      } catch (err) {
        if (err instanceof RpcError) return fail(err.message)
        return fail(`internal: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
    connection.listen()
  }

  onClose(session: Session, fn: () => void): void {
    this.sessions.get(session.id)?.closed.push(fn)
  }

  broadcast(event: string, params: unknown, right: Right = 'observe'): void {
    if (!RUNTIME_EVENTS.includes(event)) throw new Error(`${event} is not in the contract`)
    for (const session of this.sessions.values())
      if (session.rights.has(right)) session.notify(event, params)
  }

  dropRevoked(): void {
    for (const session of this.sessions.values())
      if (!this.opts.tokens.verify(session.token)) session.close()
  }

  stopAccepting(): void {
    this.server?.close()
  }

  async close(path: string): Promise<void> {
    const server = this.server
    this.server = null
    for (const socket of this.sockets) socket.destroy()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(path, { force: true })
  }
}

import { chmodSync, rmSync } from 'node:fs'
import { type Server, type Socket, createServer } from 'node:net'
import { METHOD_NOT_FOUND, RpcError, RpcPeer } from './rpc.ts'
import type { Right, Tokens } from './tokens.ts'

export const RUNTIME_CONTRACT = 1
export const RUNTIME_EVENTS: readonly string[] = []
export const MAX_CLIENTS = 32

export interface Session {
  readonly id: number
  readonly client: string
  readonly rights: ReadonlySet<Right>
  notify: (event: string, params: unknown) => void
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
}

export class RuntimeServer {
  private readonly table = new Map<string, Method>()
  private readonly sessions = new Map<number, Live>()
  private readonly sockets = new Set<Socket>()
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
    this.sockets.add(socket)
    const peer = new RpcPeer(socket)
    let session: Live | null = null
    void peer.closed.then(() => {
      this.sockets.delete(socket)
      if (!session) return
      this.sessions.delete(session.id)
      for (const fn of session.closed.splice(0)) fn()
      this.opts.clientsChanged(this.sessions.size)
    })
    const refuse = (code: string): never => {
      peer.endAfterReply()
      throw new RpcError(code)
    }
    peer.onRequest(async (method, params) => {
      if (method === 'hello') {
        if (session) throw new RpcError('already-hello')
        const hello = (params ?? {}) as { contract?: unknown; token?: unknown }
        if (hello.contract !== RUNTIME_CONTRACT) refuse('unsupported-contract')
        const verified = this.opts.tokens.verify(hello.token)
        if (!verified) return refuse('unauthorized')
        if (this.sessions.size >= (this.opts.maxClients ?? MAX_CLIENTS)) refuse('too-many-clients')
        const live: Live = {
          id: this.nextId++,
          client: verified.client,
          rights: new Set(verified.rights),
          token: hello.token as string,
          closed: [],
          notify: (event, eventParams) => peer.notify(event, eventParams),
          close: () => peer.close(),
        }
        session = live
        this.sessions.set(live.id, live)
        this.opts.clientsChanged(this.sessions.size)
        return this.opts.hello(live)
      }
      const entry = this.table.get(method)
      if (!entry) throw new RpcError('method-not-found', METHOD_NOT_FOUND)
      if (!session) throw new RpcError('hello-first')
      if (entry.right && !session.rights.has(entry.right))
        throw new RpcError(`needs-right: ${entry.right}`)
      try {
        return await entry.handler(params, session)
      } catch (err) {
        if (err instanceof RpcError) throw err
        throw new RpcError(`internal: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
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

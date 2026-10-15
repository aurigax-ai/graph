import type { Socket } from 'node:net'

export const MESSAGE_MAX_BYTES = 16 * 1024 * 1024
export const METHOD_NOT_FOUND = -32601
export const APP_ERROR = -32000
const SEPARATOR = Buffer.from('\r\n\r\n')

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code = APP_ERROR,
  ) {
    super(message)
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

type Incoming = {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
  result?: unknown
  error?: { code?: unknown; message?: unknown }
}

export type RequestHandler = (method: string, params: unknown) => Promise<unknown>

export class RpcPeer {
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Map<string, ((params: unknown) => void)[]>()
  private requests: RequestHandler = async () => {
    throw new RpcError('method-not-found', METHOD_NOT_FOUND)
  }
  private closeAfterReply = false
  readonly closed: Promise<void>

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => this.read(chunk))
    socket.on('error', () => socket.destroy())
    this.closed = new Promise((resolve) =>
      socket.once('close', () => {
        for (const pending of this.pending.values())
          pending.reject(new RpcError('connection-closed'))
        this.pending.clear()
        resolve()
      }),
    )
  }

  onRequest(handler: RequestHandler): void {
    this.requests = handler
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), handler])
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.socket.destroyed) return Promise.reject(new RpcError('connection-closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    if (!this.socket.destroyed) this.send({ jsonrpc: '2.0', method, params })
  }

  endAfterReply(): void {
    this.closeAfterReply = true
  }

  close(): void {
    this.socket.end()
  }

  private send(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    this.socket.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))
  }

  private refuse(): void {
    this.buffer = Buffer.alloc(0)
    this.socket.destroy()
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const end = this.buffer.indexOf(SEPARATOR)
      if (end < 0) {
        if (this.buffer.length > 4096) this.refuse()
        return
      }
      const headers = this.buffer.subarray(0, end).toString('ascii').split('\r\n')
      let length = -1
      for (const header of headers) {
        const match = /^content-length: *(\d+)$/i.exec(header)
        if (match) length = Number(match[1])
        else if (!/^[A-Za-z-]+: .*$/.test(header)) {
          this.refuse()
          return
        }
      }
      if (length < 0 || length > MESSAGE_MAX_BYTES) {
        this.refuse()
        return
      }
      const start = end + SEPARATOR.length
      if (this.buffer.length < start + length) return
      const body = this.buffer.subarray(start, start + length).toString('utf8')
      this.buffer = this.buffer.subarray(start + length)
      let message: Incoming
      try {
        message = JSON.parse(body) as Incoming
      } catch {
        this.refuse()
        return
      }
      if (typeof message !== 'object' || message === null || message.jsonrpc !== '2.0') {
        this.refuse()
        return
      }
      this.dispatch(message)
    }
  }

  private dispatch(message: Incoming): void {
    if (typeof message.method === 'string') {
      const method = message.method
      if (message.id === undefined) {
        for (const handler of this.listeners.get(method) ?? []) handler(message.params)
        return
      }
      const id = message.id
      void this.requests(method, message.params).then(
        (result) => this.reply({ jsonrpc: '2.0', id, result: result ?? null }),
        (err: unknown) =>
          this.reply({
            jsonrpc: '2.0',
            id,
            error:
              err instanceof RpcError
                ? { code: err.code, message: err.message }
                : { code: APP_ERROR, message: `internal: ${String(err)}` },
          }),
      )
      return
    }
    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error)
      pending.reject(
        new RpcError(
          String(message.error.message ?? 'error'),
          typeof message.error.code === 'number' ? message.error.code : APP_ERROR,
        ),
      )
    else pending.resolve(message.result)
  }

  private reply(message: unknown): void {
    if (this.socket.destroyed) return
    this.send(message)
    if (this.closeAfterReply) this.socket.end()
  }
}

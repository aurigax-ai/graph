import { type Socket, connect } from 'node:net'
import {
  type MessageConnection,
  ResponseError,
  SocketMessageReader,
  SocketMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node'
import { RUNTIME_CONTRACT } from './server.ts'

export const START_WAIT_MS = 5_000

export class RuntimeCallError extends Error {}

export interface Hello {
  contract: number
  version: string
  pid: number
  mode: 'client' | 'daemon'
  client: string
  rights: string[]
}

export interface ClientOptions {
  socket: string
  token: string
  contract?: number
}

function open(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    socket.once('connect', () => {
      socket.off('error', reject)
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

function callError(err: unknown): unknown {
  return err instanceof ResponseError ? new RuntimeCallError(err.message) : err
}

function untilClosed<T>(closed: Promise<void>, request: Promise<T>): Promise<T> {
  return Promise.race([
    request,
    closed.then(() => {
      throw new RuntimeCallError('connection-closed')
    }),
  ])
}

export class RuntimeClient {
  private constructor(
    private readonly socket: Socket,
    private readonly connection: MessageConnection,
    readonly closed: Promise<void>,
    readonly hello: Hello,
  ) {}

  static async connect(opts: ClientOptions): Promise<RuntimeClient> {
    const socket = await open(opts.socket)
    socket.on('error', () => socket.destroy())
    const connection = createMessageConnection(
      new SocketMessageReader(socket),
      new SocketMessageWriter(socket),
    )
    connection.onError(() => socket.destroy())
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    connection.listen()
    try {
      const hello = (await untilClosed(
        closed,
        connection.sendRequest('hello', {
          contract: opts.contract ?? RUNTIME_CONTRACT,
          token: opts.token,
        }),
      )) as Hello
      return new RuntimeClient(socket, connection, closed, hello)
    } catch (err) {
      socket.destroy()
      throw callError(err)
    }
  }

  async call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    try {
      return (await untilClosed(this.closed, this.connection.sendRequest(method, params))) as T
    } catch (err) {
      throw callError(err)
    }
  }

  on(event: string, handler: (params: unknown) => void): void {
    this.connection.onNotification(event, handler)
  }

  close(): void {
    this.connection.dispose()
    this.socket.destroy()
  }
}

function absent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ECONNREFUSED'
}

export async function connectOrStart(
  opts: Omit<ClientOptions, 'token'> & { token: string | (() => string | null) },
  start: () => void,
  waitMs = START_WAIT_MS,
): Promise<RuntimeClient> {
  const token = () => (typeof opts.token === 'string' ? opts.token : opts.token())
  const attempt = () => RuntimeClient.connect({ ...opts, token: token() ?? '' })
  try {
    return await attempt()
  } catch (err) {
    if (!absent(err)) throw err
  }
  start()
  const deadline = Date.now() + waitMs
  for (;;) {
    await new Promise((r) => setTimeout(r, 50))
    try {
      return await attempt()
    } catch (err) {
      if (!absent(err) || Date.now() > deadline) throw err
    }
  }
}

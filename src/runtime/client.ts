import { type Socket, connect } from 'node:net'
import { RpcError, RpcPeer } from './rpc.ts'
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
  return err instanceof RpcError ? new RuntimeCallError(err.message) : err
}

export class RuntimeClient {
  private constructor(
    private readonly peer: RpcPeer,
    readonly hello: Hello,
  ) {}

  static async connect(opts: ClientOptions): Promise<RuntimeClient> {
    const peer = new RpcPeer(await open(opts.socket))
    try {
      const hello = (await peer.request('hello', {
        contract: opts.contract ?? RUNTIME_CONTRACT,
        token: opts.token,
      })) as Hello
      return new RuntimeClient(peer, hello)
    } catch (err) {
      peer.close()
      throw callError(err)
    }
  }

  async call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    try {
      return (await this.peer.request(method, params)) as T
    } catch (err) {
      throw callError(err)
    }
  }

  on(event: string, handler: (params: unknown) => void): void {
    this.peer.onNotification(event, handler)
  }

  get closed(): Promise<void> {
    return this.peer.closed
  }

  close(): void {
    this.peer.close()
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

import { randomBytes } from 'node:crypto'
import { RpcError } from './server.ts'
import { CLI_CLIENT, RIGHTS, type Right, type Tokens, isClientName } from './tokens.ts'

export const PAIRING_MS = 120_000

interface Request {
  session: number
  client: string
  rights: Right[]
  at: number
}

export class Pairing {
  private readonly requests = new Map<string, Request>()

  constructor(
    private readonly tokens: Tokens,
    private readonly now: () => number = Date.now,
  ) {}

  request(session: number, client: unknown, rights: unknown): { id: string; expiresAt: number } {
    if (!isClientName(client) || client === CLI_CLIENT) throw new RpcError('bad-client')
    if (
      !Array.isArray(rights) ||
      rights.length === 0 ||
      rights.some((r) => !(RIGHTS as readonly unknown[]).includes(r))
    )
      throw new RpcError('bad-rights')
    const id = randomBytes(16).toString('hex')
    const at = this.now()
    this.requests.set(id, { session, client, rights: [...new Set(rights as Right[])], at })
    return { id, expiresAt: at + PAIRING_MS }
  }

  confirm(session: number, id: unknown): { token: string; client: string; rights: Right[] } {
    const request = typeof id === 'string' ? this.requests.get(id) : undefined
    if (!request || request.session !== session) throw new RpcError('unknown-pairing')
    this.requests.delete(id as string)
    if (this.now() - request.at > PAIRING_MS) throw new RpcError('pairing-expired')
    return {
      token: this.tokens.issue(request.client, request.rights),
      client: request.client,
      rights: request.rights,
    }
  }

  forget(session: number): void {
    for (const [id, request] of this.requests)
      if (request.session === session) this.requests.delete(id)
  }
}

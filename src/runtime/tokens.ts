import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensurePrivateDir } from './paths.ts'

export const RIGHTS = ['observe', 'start', 'control', 'ingest', 'worker', 'enable'] as const
export type Right = (typeof RIGHTS)[number]

export const CLI_CLIENT = 'cli'
export const CLI_RIGHTS: readonly Right[] = ['observe', 'start', 'ingest']

const CLIENT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

interface TokenRecord {
  client: string
  rights: Right[]
  hash: string
}

function hashOf(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

export function isClientName(name: unknown): name is string {
  return typeof name === 'string' && CLIENT_PATTERN.test(name)
}

export class Tokens {
  private records: TokenRecord[]

  constructor(private readonly data: string) {
    this.records = this.load()
  }

  private get file(): string {
    return join(this.data, 'tokens.json')
  }

  private load(): TokenRecord[] {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (r): r is TokenRecord =>
          typeof r === 'object' &&
          r !== null &&
          isClientName((r as TokenRecord).client) &&
          Array.isArray((r as TokenRecord).rights) &&
          (r as TokenRecord).rights.every((right) => RIGHTS.includes(right)) &&
          typeof (r as TokenRecord).hash === 'string',
      )
    } catch {
      return []
    }
  }

  private save(): void {
    const staged = `${this.file}.${process.pid}`
    writeFileSync(staged, `${JSON.stringify(this.records, null, 2)}\n`, { mode: 0o600 })
    renameSync(staged, this.file)
  }

  issue(client: string, rights: readonly Right[]): string {
    const token = randomBytes(32).toString('base64url')
    this.records = [
      ...this.records.filter((r) => r.client !== client),
      { client, rights: [...rights], hash: hashOf(token).toString('hex') },
    ]
    this.save()
    return token
  }

  ensureCliToken(): void {
    if (this.verify(readCliToken(this.data))?.client === CLI_CLIENT) return
    const token = this.issue(CLI_CLIENT, CLI_RIGHTS)
    ensurePrivateDir(join(this.data, 'tokens'))
    const path = cliTokenPath(this.data)
    writeFileSync(`${path}.${process.pid}`, `${token}\n`, { mode: 0o600 })
    renameSync(`${path}.${process.pid}`, path)
  }

  verify(token: unknown): { client: string; rights: Right[] } | null {
    if (typeof token !== 'string' || token.length === 0) return null
    const presented = hashOf(token)
    let found: TokenRecord | null = null
    for (const record of this.records) {
      const stored = Buffer.from(record.hash, 'hex')
      if (stored.length === presented.length && timingSafeEqual(stored, presented)) found = record
    }
    return found ? { client: found.client, rights: [...found.rights] } : null
  }

  revoke(client: string): boolean {
    const before = this.records.length
    this.records = this.records.filter((r) => r.client !== client)
    if (this.records.length === before) return false
    this.save()
    return true
  }

  reload(): void {
    this.records = this.load()
  }
}

export function cliTokenPath(data: string): string {
  return join(data, 'tokens', CLI_CLIENT)
}

export function readCliToken(data: string): string | null {
  try {
    return readFileSync(cliTokenPath(data), 'utf8').trim() || null
  } catch {
    return null
  }
}

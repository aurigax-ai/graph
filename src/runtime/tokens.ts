import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { ensurePrivateDir } from './paths.ts'

export const RIGHTS = ['observe', 'start', 'control', 'ingest', 'worker', 'enable'] as const
export type Right = (typeof RIGHTS)[number]

export const CLI_CLIENT = 'cli'
export const CLI_RIGHTS: readonly Right[] = ['observe', 'start', 'ingest']

const CLIENT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
const TOKEN_FILE_MAX = 4096
const TOKEN_MIN = 32

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

export function tokensFolder(data: string): string {
  return join(data, 'tokens')
}

function isRights(value: unknown): value is Right[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((r) => (RIGHTS as readonly unknown[]).includes(r))
  )
}

function readOwnFile(path: string, uid: number): string {
  const link = lstatSync(path)
  if (link.isSymbolicLink()) throw new Error('it is a link')
  if (!link.isFile()) throw new Error('it is not a regular file')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error('it is not a regular file')
    if (stat.uid !== uid) throw new Error('it is owned by another user')
    if ((stat.mode & 0o077) !== 0) throw new Error('others can read or write it')
    if (stat.size > TOKEN_FILE_MAX) throw new Error('it is too large')
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

export class Tokens {
  private records: TokenRecord[]
  private provisioned: TokenRecord[] = []

  constructor(
    private readonly data: string,
    private readonly log: (line: string) => void = () => {},
  ) {
    this.records = this.load()
    this.provisioned = this.loadProvisioned()
  }

  private loadProvisioned(): TokenRecord[] {
    let names: string[]
    try {
      names = readdirSync(tokensFolder(this.data))
    } catch {
      return []
    }
    const uid = process.getuid?.() ?? 0
    const found: TokenRecord[] = []
    for (const name of names) {
      if (name === CLI_CLIENT || name.includes('.')) continue
      const path = join(tokensFolder(this.data), name)
      if (!isClientName(name)) {
        this.log(`refused token file ${path}: the name is not a client name`)
        continue
      }
      try {
        const parsed = JSON.parse(readOwnFile(path, uid)) as { token?: unknown; rights?: unknown }
        if (typeof parsed.token !== 'string' || parsed.token.length < TOKEN_MIN)
          throw new Error('it holds no token')
        if (!isRights(parsed.rights)) throw new Error('its rights are not rights')
        found.push({
          client: name,
          rights: [...new Set(parsed.rights)],
          hash: hashOf(parsed.token).toString('hex'),
        })
      } catch (err) {
        this.log(`refused token file ${path}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return found
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
    ensurePrivateDir(tokensFolder(this.data))
    const path = cliTokenPath(this.data)
    writeFileSync(`${path}.${process.pid}`, `${token}\n`, { mode: 0o600 })
    renameSync(`${path}.${process.pid}`, path)
  }

  verify(token: unknown): { client: string; rights: Right[] } | null {
    if (typeof token !== 'string' || token.length === 0) return null
    const presented = hashOf(token)
    let found: TokenRecord | null = null
    for (const record of [...this.records, ...this.provisioned]) {
      const stored = Buffer.from(record.hash, 'hex')
      if (stored.length === presented.length && timingSafeEqual(stored, presented)) found = record
    }
    return found ? { client: found.client, rights: [...found.rights] } : null
  }

  revoke(client: string): boolean {
    const file = client !== CLI_CLIENT && this.provisioned.some((r) => r.client === client)
    if (file) {
      rmSync(join(tokensFolder(this.data), client), { force: true })
      this.provisioned = this.provisioned.filter((r) => r.client !== client)
    }
    const before = this.records.length
    this.records = this.records.filter((r) => r.client !== client)
    if (this.records.length === before) return file
    this.save()
    return true
  }

  reload(): void {
    this.records = this.load()
    this.provisioned = this.loadProvisioned()
  }
}

export function provisionToken(data: string, client: string, rights: readonly Right[]): string {
  if (!isClientName(client) || client === CLI_CLIENT)
    throw new Error(`${client} is not a client name`)
  if (!isRights(rights)) throw new Error('not rights')
  ensurePrivateDir(data)
  ensurePrivateDir(tokensFolder(data))
  const token = randomBytes(32).toString('base64url')
  const path = join(tokensFolder(data), client)
  const staged = `${path}.${process.pid}`
  writeFileSync(staged, `${JSON.stringify({ token, rights: [...rights] })}\n`, { mode: 0o600 })
  renameSync(staged, path)
  return token
}

export function readProvisionedToken(data: string, client: string): string | null {
  try {
    const parsed = JSON.parse(
      readOwnFile(join(tokensFolder(data), client), process.getuid?.() ?? 0),
    ) as {
      token?: unknown
    }
    return typeof parsed.token === 'string' ? parsed.token : null
  } catch {
    return null
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

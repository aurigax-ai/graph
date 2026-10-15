import { readFileSync } from 'node:fs'
import { acquireLock } from './lock.ts'
import { PathRefusal, type RuntimePaths, ensurePrivateDir, runtimePaths } from './paths.ts'
import { RUNTIME_CONTRACT, RuntimeServer } from './server.ts'
import { Tokens } from './tokens.ts'

export const IDLE_MS = 60_000
export const DRAIN_MS = 10_000
export const PROCESS_TITLE = 'wire-runtime'

export type Mode = 'client' | 'daemon'

export const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version

export interface RuntimeOptions {
  paths?: RuntimePaths
  daemon?: boolean
  idleMs?: number
  drainMs?: number
}

export type StartOutcome =
  | { ok: true; runtime: Runtime }
  | { ok: false; error: 'already-running'; pid: number | null }
  | { ok: false; error: 'unsafe-folder'; message: string }

export interface Part {
  busy?: () => boolean
  drain?: (deadline: number) => Promise<void>
}

export class Runtime {
  readonly server: RuntimeServer
  readonly tokens: Tokens
  readonly mode: Mode
  readonly stopped: Promise<void>
  private readonly parts: Part[] = []
  private idleTimer: NodeJS.Timeout | null = null
  private stopping: Promise<void> | null = null
  private finish: () => void = () => {}

  constructor(
    readonly paths: RuntimePaths,
    private readonly release: () => void,
    private readonly opts: RuntimeOptions,
  ) {
    this.mode = opts.daemon ? 'daemon' : 'client'
    this.tokens = new Tokens(paths.data)
    this.tokens.ensureCliToken()
    this.stopped = new Promise((resolve) => {
      this.finish = resolve
    })
    this.server = new RuntimeServer({
      tokens: this.tokens,
      hello: (session) => ({
        contract: RUNTIME_CONTRACT,
        version: PACKAGE_VERSION,
        pid: process.pid,
        mode: this.mode,
        client: session.client,
        rights: [...session.rights],
      }),
      clientsChanged: () => this.touch(),
    })
    this.server.method('runtime.status', 'observe', () => this.status())
  }

  status(): Record<string, unknown> {
    return {
      pid: process.pid,
      version: PACKAGE_VERSION,
      contract: RUNTIME_CONTRACT,
      mode: this.mode,
      clients: this.server.clients,
    }
  }

  add(part: Part): void {
    this.parts.push(part)
  }

  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (this.stopping || this.mode === 'daemon' || this.server.clients > 0) return
    if (this.parts.some((p) => p.busy?.())) return
    this.idleTimer = setTimeout(() => void this.stop(), this.opts.idleMs ?? IDLE_MS)
  }

  reloadTokens(): void {
    this.tokens.reload()
    this.tokens.ensureCliToken()
    this.server.dropRevoked()
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.stopping = (async () => {
      this.server.stopAccepting()
      const drainMs = this.opts.drainMs ?? DRAIN_MS
      const deadline = Date.now() + drainMs
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        Promise.all(this.parts.map((p) => p.drain?.(deadline))),
        new Promise((resolve) => {
          timer = setTimeout(resolve, drainMs)
        }),
      ])
      clearTimeout(timer)
      await this.server.close(this.paths.socket)
      this.release()
      this.finish()
    })()
    return this.stopping
  }
}

export async function startRuntime(opts: RuntimeOptions = {}): Promise<StartOutcome> {
  const paths = opts.paths ?? runtimePaths()
  try {
    ensurePrivateDir(paths.data)
    ensurePrivateDir(paths.socketDir)
  } catch (err) {
    if (err instanceof PathRefusal)
      return { ok: false, error: 'unsafe-folder', message: err.message }
    throw err
  }
  const lock = await acquireLock(paths.data)
  if (!lock.ok) return { ok: false, error: 'already-running', pid: lock.pid }
  let runtime: Runtime
  try {
    runtime = new Runtime(paths, lock.release, opts)
    await runtime.server.listen(paths.socket)
  } catch (err) {
    lock.release()
    throw err
  }
  runtime.touch()
  return { ok: true, runtime }
}

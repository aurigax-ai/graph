import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RuntimeClient, START_WAIT_MS, connectOrStart } from '../runtime/client.ts'
import { lockHeld, recordedPid } from '../runtime/lock.ts'
import { type RuntimePaths, ensurePrivateDir, runtimePaths } from '../runtime/paths.ts'
import { PROCESS_TITLE, startRuntime } from '../runtime/runtime.ts'
import { Tokens, readCliToken } from '../runtime/tokens.ts'
import type { CommandOutput } from './commands.ts'

export const MODE_NOTES = {
  client: 'Runs while a client is open',
  daemon: 'Runs as a daemon, also while Ostia is closed',
} as const

const STOP_WAIT_MS = 15_000

function json(value: unknown, exitCode = 0): CommandOutput {
  return { exitCode, stdout: `${JSON.stringify(value, null, 2)}\n` }
}

export function binPath(): string {
  const here = fileURLToPath(import.meta.url)
  return join(here, '..', `bin${extname(here)}`)
}

export function runtimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('OSTIA_')))
}

export function spawnRuntime(paths: RuntimePaths, daemon: boolean): void {
  ensurePrivateDir(paths.data)
  const log = openSync(join(paths.data, 'runtime.log'), 'a', 0o600)
  try {
    const child = spawn(
      process.execPath,
      [binPath(), 'runtime', 'start', '--foreground', ...(daemon ? ['--daemon'] : [])],
      { detached: true, stdio: ['ignore', log, log], env: runtimeEnv(process.env) },
    )
    child.unref()
  } finally {
    closeSync(log)
  }
}

export function cliConnect(paths: RuntimePaths = runtimePaths()): Promise<RuntimeClient> {
  return connectOrStart(
    { socket: paths.socket, token: () => readCliToken(paths.data) },
    () => spawnRuntime(paths, false),
    START_WAIT_MS,
  )
}

interface Status {
  pid: number
  mode: keyof typeof MODE_NOTES
  [key: string]: unknown
}

async function probe(paths: RuntimePaths): Promise<Status | null> {
  try {
    const client = await RuntimeClient.connect({
      socket: paths.socket,
      token: readCliToken(paths.data) ?? '',
    })
    try {
      return await client.call<Status>('runtime.status')
    } finally {
      client.close()
    }
  } catch {
    return null
  }
}

async function foreground(daemon: boolean): Promise<CommandOutput> {
  const started = await startRuntime({ daemon })
  if (!started.ok) return json(started, 1)
  const { runtime } = started
  process.title = PROCESS_TITLE
  const stop = () => void runtime.stop()
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  process.on('SIGHUP', () => runtime.reloadTokens())
  process.stderr.write(`wire-runtime ${process.pid} listening on ${runtime.paths.socket}\n`)
  await runtime.stopped
  return json({ ok: true, stopped: process.pid })
}

async function start(daemon: boolean): Promise<CommandOutput> {
  const paths = runtimePaths()
  const running = await probe(paths)
  if (running) return json({ ok: false, error: 'already-running', pid: running.pid }, 1)
  if (await lockHeld(paths.data))
    return json({ ok: false, error: 'already-running', pid: recordedPid(paths.data) }, 1)
  spawnRuntime(paths, daemon)
  const deadline = Date.now() + START_WAIT_MS
  for (;;) {
    await new Promise((r) => setTimeout(r, 50))
    const started = await probe(paths)
    if (started) return json({ ok: true, pid: started.pid, mode: started.mode })
    if (Date.now() > deadline) return json({ ok: false, error: 'not-started' }, 1)
  }
}

async function stop(): Promise<CommandOutput> {
  const paths = runtimePaths()
  const running = await probe(paths)
  if (!running) {
    if (await lockHeld(paths.data))
      return json({ ok: false, error: 'not-answering', pid: recordedPid(paths.data) }, 1)
    return json({ ok: true, running: false })
  }
  process.kill(running.pid, 'SIGTERM')
  const deadline = Date.now() + STOP_WAIT_MS
  while (await lockHeld(paths.data)) {
    if (Date.now() > deadline)
      return json({ ok: false, error: 'still-running', pid: running.pid }, 1)
    await new Promise((r) => setTimeout(r, 50))
  }
  return json({ ok: true, stopped: running.pid })
}

async function status(): Promise<CommandOutput> {
  const paths = runtimePaths()
  const running = await probe(paths)
  if (running) return json({ running: true, ...running, note: MODE_NOTES[running.mode] })
  if (await lockHeld(paths.data))
    return json({ running: true, error: 'not-answering', pid: recordedPid(paths.data) }, 1)
  return json({ running: false })
}

async function revoke(client: string | undefined): Promise<CommandOutput> {
  if (!client) return json({ ok: false, error: 'usage' }, 2)
  const paths = runtimePaths()
  const running = await probe(paths)
  const revoked = new Tokens(paths.data).revoke(client)
  if (revoked && running) process.kill(running.pid, 'SIGHUP')
  return json(
    { ok: revoked, ...(revoked ? { revoked: client } : { error: 'unknown-client' }) },
    revoked ? 0 : 1,
  )
}

export async function runtimeCommand(args: string[]): Promise<CommandOutput | null> {
  const [verb, ...rest] = args
  const has = (flag: string) => rest.includes(flag)
  switch (verb) {
    case 'start':
      return has('--foreground') ? foreground(has('--daemon')) : start(has('--daemon'))
    case 'stop':
      return stop()
    case 'status':
      return status()
    case 'tokens':
      return rest[0] === 'revoke' ? revoke(rest[1]) : null
    default:
      return null
  }
}

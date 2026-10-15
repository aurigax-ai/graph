import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeClient } from './client.ts'
import { type RuntimePaths, runtimePaths } from './paths.ts'
import { type Runtime, type RuntimeOptions, startRuntime } from './runtime.ts'
import { type Right, readCliToken } from './tokens.ts'

export interface RuntimePlace {
  env: NodeJS.ProcessEnv
  paths: RuntimePaths
}

export function runtimePlace(): RuntimePlace {
  const dir = mkdtempSync(join(tmpdir(), 'wrt-'))
  const env = {
    PATH: process.env.PATH,
    HOME: join(dir, 'home'),
    XDG_STATE_HOME: join(dir, 'state'),
    XDG_RUNTIME_DIR: join(dir, 'run'),
    TMPDIR: join(dir, 'tmp'),
  }
  mkdirSync(env.HOME, { recursive: true })
  mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 })
  mkdirSync(env.TMPDIR, { recursive: true })
  const paths = runtimePaths({
    env,
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
    home: env.HOME,
    tmp: env.TMPDIR,
  })
  return { env, paths }
}

export async function testRuntime(
  paths: RuntimePaths,
  opts: RuntimeOptions = {},
): Promise<Runtime> {
  const started = await startRuntime({ paths, ...opts })
  if (!started.ok) throw new Error(JSON.stringify(started))
  return started.runtime
}

export function cliClient(paths: RuntimePaths): Promise<RuntimeClient> {
  return RuntimeClient.connect({ socket: paths.socket, token: readCliToken(paths.data) ?? '' })
}

export function pairedClient(
  runtime: Runtime,
  client: string,
  rights: readonly Right[],
): Promise<RuntimeClient> {
  const token = runtime.tokens.issue(client, rights)
  return RuntimeClient.connect({ socket: runtime.paths.socket, token })
}

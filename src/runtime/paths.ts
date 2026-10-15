import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export interface RuntimePaths {
  data: string
  socketDir: string
  socket: string
}

export interface PathEnv {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  uid: number
  home: string
  tmp: string
}

export function hostPathEnv(): PathEnv {
  return {
    env: process.env,
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
    home: homedir(),
    tmp: tmpdir(),
  }
}

export function runtimePaths(at: PathEnv = hostPathEnv()): RuntimePaths {
  const { env, platform, uid, home, tmp } = at
  const data =
    platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'wire')
      : join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'wire')
  const socketDir =
    platform === 'darwin'
      ? join(env.TMPDIR || tmp, 'wire')
      : env.XDG_RUNTIME_DIR
        ? join(env.XDG_RUNTIME_DIR, 'wire')
        : join(env.TMPDIR || tmp, `wire-${uid}`)
  return { data, socketDir, socket: join(socketDir, 'runtime.sock') }
}

export class PathRefusal extends Error {
  readonly code = 'unsafe-folder'
}

export function ensurePrivateDir(path: string, uid = process.getuid?.() ?? 0): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new PathRefusal(`${path} is a link`)
  if (!stat.isDirectory()) throw new PathRefusal(`${path} is not a folder`)
  if (stat.uid !== uid) throw new PathRefusal(`${path} is owned by another user`)
  if ((stat.mode & 0o777) !== 0o700) chmodSync(path, 0o700)
}

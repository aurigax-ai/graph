import { randomBytes } from 'node:crypto'
import {
  constants,
  closeSync,
  existsSync,
  ftruncateSync,
  linkSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { privateTemp, writePrivate } from './privateFile.ts'

export const LOCK_FILE = 'runtime.lock'
export const LOCK_ID_FILE = 'lock-id'
export const SOCKET_LOCK_FILE = 'socket.lock'
export const SOCKET_LOCK_ID_FILE = 'socket-lock-id'
const DARWIN_O_EXLOCK = 0x20

export type LockResult = { ok: true; release: () => void } | { ok: false; pid: number | null }

interface LockFiles {
  lock: string
  id: string
}

const RUNTIME_LOCK: LockFiles = { lock: LOCK_FILE, id: LOCK_ID_FILE }
const SOCKET_LOCK: LockFiles = { lock: SOCKET_LOCK_FILE, id: SOCKET_LOCK_ID_FILE }

function lockId(data: string, idFile: string): string {
  const path = join(data, idFile)
  try {
    const id = readFileSync(path, 'utf8').trim()
    if (/^[0-9a-f]{32}$/.test(id)) return id
  } catch {}
  const staged = privateTemp(path, `${randomBytes(16).toString('hex')}\n`)
  try {
    linkSync(staged, path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  } finally {
    rmSync(staged, { force: true })
  }
  return readFileSync(path, 'utf8').trim()
}

export function recordedPid(data: string, lockFile = LOCK_FILE): number | null {
  try {
    const pid = Number(readFileSync(join(data, lockFile), 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function busy(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'EADDRINUSE' || code === 'EAGAIN' || code === 'EWOULDBLOCK'
}

function lockDarwin(data: string, pid: number, files: LockFiles): LockResult {
  let fd: number
  try {
    fd = openSync(
      join(data, files.lock),
      constants.O_RDWR | constants.O_CREAT | DARWIN_O_EXLOCK | constants.O_NONBLOCK,
      0o600,
    )
  } catch (err) {
    if (busy(err)) return { ok: false, pid: recordedPid(data, files.lock) }
    throw err
  }
  ftruncateSync(fd, 0)
  writeSync(fd, `${pid}\n`, 0)
  return {
    ok: true,
    release: () => {
      ftruncateSync(fd, 0)
      closeSync(fd)
    },
  }
}

function lockAbstract(data: string, pid: number, files: LockFiles): Promise<LockResult> {
  const server = createServer((socket) => socket.destroy())
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (busy(err)) resolve({ ok: false, pid: recordedPid(data, files.lock) })
      else reject(err)
    })
    server.listen(`\0wire-runtime-${lockId(data, files.id)}`, () => {
      server.unref()
      writePrivate(join(data, files.lock), `${pid}\n`)
      resolve({
        ok: true,
        release: () => {
          if (recordedPid(data, files.lock) === pid) rmSync(join(data, files.lock), { force: true })
          server.close()
        },
      })
    })
  })
}

function lockIn(
  dir: string,
  files: LockFiles,
  pid: number,
  platform: NodeJS.Platform,
): Promise<LockResult> {
  return platform === 'darwin'
    ? Promise.resolve(lockDarwin(dir, pid, files))
    : lockAbstract(dir, pid, files)
}

export function acquireLock(
  data: string,
  pid = process.pid,
  platform: NodeJS.Platform = process.platform,
): Promise<LockResult> {
  return lockIn(data, RUNTIME_LOCK, pid, platform)
}

export function acquireSocketLock(
  socketDir: string,
  pid = process.pid,
  platform: NodeJS.Platform = process.platform,
): Promise<LockResult> {
  return lockIn(socketDir, SOCKET_LOCK, pid, platform)
}

export async function lockHeld(data: string): Promise<boolean> {
  if (!existsSync(data)) return false
  const lock = await acquireLock(data, process.pid)
  if (!lock.ok) return true
  lock.release()
  return false
}

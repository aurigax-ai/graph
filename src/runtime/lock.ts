import { linkSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const LOCK_FILE = 'runtime.lock'

export type LockResult = { ok: true; release: () => void } | { ok: false; pid: number }

export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function lockHolder(data: string): number | null {
  try {
    const pid = Number(readFileSync(join(data, LOCK_FILE), 'utf8').trim())
    return alive(pid) ? pid : null
  } catch {
    return null
  }
}

export function acquireLock(data: string, pid = process.pid): LockResult {
  const path = join(data, LOCK_FILE)
  const staged = join(data, `${LOCK_FILE}.${pid}`)
  writeFileSync(staged, `${pid}\n`, { mode: 0o600 })
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        linkSync(staged, path)
        return {
          ok: true,
          release: () => {
            if (lockHolder(data) === pid) rmSync(path, { force: true })
          },
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      }
      const holder = lockHolder(data)
      if (holder !== null) return { ok: false, pid: holder }
      const moved = join(data, `${LOCK_FILE}.stale.${pid}`)
      try {
        renameSync(path, moved)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        continue
      }
      const movedPid = Number(readFileSync(moved, 'utf8').trim())
      if (alive(movedPid)) {
        try {
          linkSync(moved, path)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        }
        rmSync(moved, { force: true })
        return { ok: false, pid: movedPid }
      }
      rmSync(moved, { force: true })
    }
    const holder = lockHolder(data)
    return { ok: false, pid: holder ?? 0 }
  } finally {
    unlinkSync(staged)
  }
}

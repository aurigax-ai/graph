import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'

export function privateTemp(path: string, text: string): string {
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`
  const fd = openSync(temp, 'wx', 0o600)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } catch (err) {
    closeSync(fd)
    rmSync(temp, { force: true })
    throw err
  }
  closeSync(fd)
  return temp
}

export function writePrivate(path: string, text: string): void {
  const temp = privateTemp(path, text)
  try {
    renameSync(temp, path)
  } catch (err) {
    rmSync(temp, { force: true })
    throw err
  }
}

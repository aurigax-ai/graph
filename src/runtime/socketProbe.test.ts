import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { lockHeld } from './lock.ts'
import type { RuntimePaths } from './paths.ts'
import { startRuntime } from './runtime.ts'

const silent = vi.hoisted(() => ({ path: '' }))

vi.mock('node:net', async (original) => {
  const net = await original<typeof import('node:net')>()
  return {
    ...net,
    connect: (...args: Parameters<typeof net.connect>) =>
      args[0] === silent.path ? new net.Socket() : net.connect(...args),
  }
})

afterEach(() => {
  silent.path = ''
})

function place(): RuntimePaths {
  const dir = mkdtempSync(join(tmpdir(), 'wrt-probe-'))
  const socketDir = join(dir, 'run')
  mkdirSync(socketDir, { mode: 0o700 })
  return { data: join(dir, 'state'), socketDir, socket: join(socketDir, 'runtime.sock') }
}

describe('the socket probe before a start', () => {
  it('GRF-C192 a socket that gives no answer in time is left alone and the start is refused', async () => {
    const paths = place()
    writeFileSync(paths.socket, '')
    const inode = statSync(paths.socket).ino
    silent.path = paths.socket
    const refused = await startRuntime({ paths, probeMs: 100 })
    expect(refused).toEqual({
      ok: false,
      error: 'socket-in-use',
      message: `${paths.socket} may belong to a live runtime (no answer within 100 ms); it was left alone`,
    })
    expect(statSync(paths.socket).ino).toBe(inode)
    expect(await lockHeld(paths.data)).toBe(false)
  })
})

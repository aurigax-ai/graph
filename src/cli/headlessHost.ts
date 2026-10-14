import { spawn } from 'node:child_process'
import type { Clock, Host, Notice } from '../engine/contract'
import {
  type ProcessReply,
  type ProcessRequest,
  STDERR_MAX,
  STDOUT_MAX,
  commandNode,
} from '../kinds/command'
import { notifyNode, routerNode, waitNode } from '../kinds/smallKinds'

export const HEADLESS_TRIGGERS = ['manual']

export const realClock: Clock = {
  now: () => Date.now(),
  setTimer: (at, fn) => {
    const timer = setTimeout(fn, Math.max(0, at - Date.now()))
    return () => clearTimeout(timer)
  },
}

export function runProcess(cwd: string, baseEnv: NodeJS.ProcessEnv) {
  return (req: ProcessRequest): Promise<ProcessReply> =>
    new Promise((resolve) => {
      const [file, ...args] = req.argv
      const out: Buffer[] = []
      const err: Buffer[] = []
      let outBytes = 0
      let errBytes = 0
      let truncated = false
      let timedOut = false
      const child = spawn(file as string, args, {
        cwd,
        env: { ...baseEnv, ...req.env },
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const kill = (): void => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL')
        } catch {}
      }
      const timer = setTimeout(() => {
        timedOut = true
        kill()
      }, req.timeoutMs)
      req.signal.addEventListener('abort', kill, { once: true })
      child.stdout.on('data', (chunk: Buffer) => {
        if (outBytes + chunk.length > STDOUT_MAX) truncated = true
        out.push(chunk.subarray(0, Math.max(0, STDOUT_MAX - outBytes)))
        outBytes += chunk.length
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (errBytes + chunk.length > STDERR_MAX) truncated = true
        err.push(chunk.subarray(0, Math.max(0, STDERR_MAX - errBytes)))
        errBytes += chunk.length
      })
      const finish = (exitCode: number): void => {
        clearTimeout(timer)
        req.signal.removeEventListener('abort', kill)
        resolve({
          exitCode: timedOut ? -1 : exitCode,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          timedOut,
          truncated,
        })
      }
      child.on('error', (e) => {
        clearTimeout(timer)
        resolve({ exitCode: -1, stdout: '', stderr: e.message, timedOut: false, truncated: false })
      })
      child.on('close', (code) => finish(code ?? -1))
    })
}

export function headlessHost(opts: {
  cwd: string
  log: (notice: Notice) => void
  clock?: Clock
}): Host {
  const clock = opts.clock ?? realClock
  return {
    name: 'headless',
    contract: 1,
    kinds: [
      commandNode(runProcess(opts.cwd, process.env)),
      routerNode,
      waitNode(() => clock.now()),
      notifyNode(opts.log),
    ],
    triggers: HEADLESS_TRIGGERS,
    clock,
    notify: opts.log,
  }
}

import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeCallError, RuntimeClient } from './client.ts'
import { LOCK_FILE, lockHeld, recordedPid } from './lock.ts'
import { type RuntimePaths, runtimePaths } from './paths.ts'
import { type Runtime, type RuntimeOptions, startRuntime } from './runtime.ts'
import { MAX_CLIENTS, RUNTIME_EVENTS } from './server.ts'
import { readCliToken } from './tokens.ts'

const ROOT = join(import.meta.dirname, '..', '..')
const BIN = join(ROOT, 'dist', 'cli', 'bin.js')

const children: ChildProcess[] = []
const runtimes: Runtime[] = []

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
  for (const runtime of runtimes.splice(0)) await runtime.stop()
})

function place(): { env: NodeJS.ProcessEnv; paths: RuntimePaths } {
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

function wire(env: NodeJS.ProcessEnv, args: string[]): ChildProcess {
  const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  return child
}

function output(child: ChildProcess): Promise<{ code: number | null; stdout: string }> {
  let stdout = ''
  child.stdout?.on('data', (chunk) => {
    stdout += chunk
  })
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, stdout })))
}

async function until(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function client(paths: RuntimePaths, contract?: number, token?: string) {
  return RuntimeClient.connect({
    socket: paths.socket,
    token: token ?? readCliToken(paths.data) ?? '',
    ...(contract ? { contract } : {}),
  })
}

async function answers(paths: RuntimePaths): Promise<boolean> {
  try {
    const c = await client(paths)
    c.close()
    return true
  } catch {
    return false
  }
}

async function inProcess(paths: RuntimePaths, opts: RuntimeOptions = {}): Promise<Runtime> {
  const started = await startRuntime({ paths, ...opts })
  if (!started.ok) throw new Error(JSON.stringify(started))
  runtimes.push(started.runtime)
  return started.runtime
}

const mode = (path: string) => statSync(path).mode & 0o777

describe('the runtime process', () => {
  it('GRF-C191 a started runtime holds runtime.lock, its socket is 0600 in a 0700 folder, and it is titled wire-runtime', async () => {
    const { env, paths } = place()
    const child = wire(env, ['runtime', 'start', '--foreground'])
    await until(() => answers(paths))
    expect(await lockHeld(paths.data)).toBe(true)
    expect(recordedPid(paths.data)).toBe(child.pid)
    expect(paths.socket).toBe(join(env.XDG_RUNTIME_DIR as string, 'wire', 'runtime.sock'))
    expect(paths.data).toBe(join(env.XDG_STATE_HOME as string, 'wire'))
    expect(mode(paths.data)).toBe(0o700)
    expect(mode(paths.socketDir)).toBe(0o700)
    expect(mode(paths.socket)).toBe(0o600)
    expect(
      execFileSync('ps', ['-o', 'command=', '-p', String(child.pid)], { encoding: 'utf8' }).trim(),
    ).toBe('wire-runtime')
  })

  it('GRF-C192 a second runtime on the same data folder exits already-running with the first pid, and a linked or foreign folder is refused', async () => {
    const { env, paths } = place()
    const first = wire(env, ['runtime', 'start', '--foreground'])
    await until(() => answers(paths))
    const second = await output(wire(env, ['runtime', 'start', '--foreground']))
    expect(second.code).toBe(1)
    expect(JSON.parse(second.stdout)).toEqual({
      ok: false,
      error: 'already-running',
      pid: first.pid,
    })
    expect(first.exitCode).toBeNull()

    for (const which of ['socketDir', 'data'] as const) {
      const linked = place()
      mkdirSync(dirname(linked.paths[which]), { recursive: true })
      symlinkSync(mkdtempSync(join(tmpdir(), 'wrt-real-')), linked.paths[which])
      expect(await startRuntime({ paths: linked.paths })).toEqual({
        ok: false,
        error: 'unsafe-folder',
        message: `${linked.paths[which]} is a link`,
      })
    }

    const rootOwned = existsSync('/usr') ? '/usr' : '/'
    for (const which of ['socketDir', 'data'] as const) {
      const foreign = place()
      expect(
        await startRuntime({
          paths: {
            ...foreign.paths,
            [which]: rootOwned,
            ...(which === 'socketDir' ? { socket: join(rootOwned, 'x.sock') } : {}),
          },
        }),
      ).toEqual({
        ok: false,
        error: 'unsafe-folder',
        message: `${rootOwned} is owned by another user`,
      })
    }
  })

  it('GRF-C192 after a runtime is killed, two starts at once leave exactly one runtime, whatever pid the old lock file names', async () => {
    const { env, paths } = place()
    const killed = wire(env, ['runtime', 'start', '--foreground'])
    await until(() => answers(paths))
    killed.kill('SIGKILL')
    await until(() => killed.exitCode !== null || killed.signalCode !== null)
    writeFileSync(join(paths.data, LOCK_FILE), `${process.pid}\n`)
    const a = wire(env, ['runtime', 'start', '--foreground'])
    const b = wire(env, ['runtime', 'start', '--foreground'])
    const loser = await Promise.race([output(a), output(b)])
    expect(loser.code).toBe(1)
    expect(JSON.parse(loser.stdout)).toMatchObject({ ok: false, error: 'already-running' })
    await until(() => answers(paths))
    const winner = [a, b].find((c) => c.exitCode === null)
    expect(winner).toBeDefined()
    const c = await client(paths)
    expect(await c.call('runtime.status')).toMatchObject({ pid: winner?.pid })
    c.close()
  })

  it('GRF-C193 stop with no run removes the socket, releases the lock and exits 0', async () => {
    const { env, paths } = place()
    const runtime = wire(env, ['runtime', 'start', '--foreground'])
    const ended = output(runtime)
    await until(() => answers(paths))
    const stopped = await output(wire(env, ['runtime', 'stop']))
    expect(JSON.parse(stopped.stdout)).toEqual({ ok: true, stopped: runtime.pid })
    expect((await ended).code).toBe(0)
    expect(existsSync(paths.socket)).toBe(false)
    expect(await lockHeld(paths.data)).toBe(false)
  })

  it('GRF-C197 the methods and events the runtime registers are exactly those in CONTRACT.md, and a contract 1 client reaches every method', async () => {
    const contract = readFileSync(join(ROOT, 'CONTRACT.md'), 'utf8')
    expect(contract).toMatch(/^contract: 1$/m)
    const section = (title: string) =>
      (contract.split(`## ${title}\n`)[1] ?? '')
        .split('\n## ')[0]
        .split('\n')
        .map((row) => /^\| `([a-z.]+)` \|/.exec(row)?.[1])
        .filter((name): name is string => name !== undefined)
    const { paths } = place()
    const runtime = await inProcess(paths)
    expect(section('Methods').sort()).toEqual(runtime.server.methods())
    expect(section('Events').sort()).toEqual([...RUNTIME_EVENTS].sort())
    const c = await client(paths)
    expect(c.hello.contract).toBe(1)
    for (const method of section('Methods').filter((m) => m !== 'hello')) {
      const answer = await c.call(method).catch((err: Error) => err.message)
      expect(answer).not.toBe('method-not-found')
    }
    c.close()
  })

  it('GRF-C198 another contract, a message without Content-Length and an unknown method are refused while others are still served', async () => {
    const { paths } = place()
    await inProcess(paths)
    const refused = await client(paths, 2).catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(RuntimeCallError)
    expect((refused as Error).message).toBe('unsupported-contract')

    const raw = connect(paths.socket)
    const closed = new Promise<void>((resolve) => raw.on('close', () => resolve()))
    raw.on('error', () => {})
    raw.write('{"jsonrpc":"2.0","id":1,"method":"hello"}\r\n\r\n')
    await closed

    const c = await client(paths)
    await expect(c.call('graphs.nothing')).rejects.toThrow('method-not-found')
    const other = await client(paths)
    expect(await other.call('runtime.status')).toMatchObject({ contract: 1, clients: 2 })
    c.close()
    other.close()
  })

  it('GRF-C198 a request before hello, a second hello, a client past the limit and a missing right are refused', async () => {
    const { paths } = place()
    const runtime = await inProcess(paths)
    const raw = connect(paths.socket)
    raw.on('error', () => {})
    const reply = await new Promise<string>((resolve) => {
      raw.on('data', (chunk) => resolve(String(chunk)))
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'runtime.status', params: {} })
      raw.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    })
    expect(reply).toContain('hello-first')
    raw.destroy()

    const c = await client(paths)
    await expect(c.call('hello', { contract: 1, token: readCliToken(paths.data) })).rejects.toThrow(
      'already-hello',
    )
    const crowd = [c]
    for (let i = 1; i < MAX_CLIENTS; i++) crowd.push(await client(paths))
    await expect(client(paths)).rejects.toThrow('too-many-clients')
    for (const one of crowd) one.close()

    const bare = runtime.tokens.issue('bare', [])
    await until(() => runtime.server.clients === 0)
    const limited = await client(paths, undefined, bare)
    await expect(limited.call('runtime.status')).rejects.toThrow('needs-right: observe')
    limited.close()
  })

  it('GRF-C200 a wrong token and a revoked one are refused at hello, and revoking closes the connection at once', async () => {
    const { paths } = place()
    const runtime = await inProcess(paths)
    await expect(client(paths, undefined, 'not-a-token')).rejects.toThrow('unauthorized')
    const paired = runtime.tokens.issue('paired', ['observe', 'control'])
    const live = await client(paths, undefined, paired)
    expect(live.hello.rights).toEqual(['observe', 'control'])
    runtime.tokens.revoke('paired')
    runtime.reloadTokens()
    await live.closed
    await expect(live.call('runtime.status')).rejects.toThrow('connection-closed')
    await expect(client(paths, undefined, paired)).rejects.toThrow('unauthorized')

    const old = readCliToken(paths.data)
    runtime.tokens.revoke('cli')
    runtime.reloadTokens()
    expect(readCliToken(paths.data)).not.toBe(old)
    await expect(client(paths, undefined, old ?? '')).rejects.toThrow('unauthorized')
    expect(await answers(paths)).toBe(true)
  })

  it('GRF-C211 the data and socket folders are 0700, every file is 0600, and SECURITY.md names the same-user gap', async () => {
    const { paths } = place()
    await inProcess(paths)
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? [join(dir, e.name), ...walk(join(dir, e.name))] : [join(dir, e.name)],
      )
    for (const path of [paths.data, paths.socketDir, ...walk(paths.data), ...walk(paths.socketDir)])
      expect([path, mode(path)]).toEqual([path, statSync(path).isDirectory() ? 0o700 : 0o600])
    const security = readFileSync(join(ROOT, 'SECURITY.md'), 'utf8')
    expect(security).toMatch(/another process of the same user/)
    expect(security).toMatch(/enabled\.json/)
  })

  it('GRF-C217 with no client and no run the runtime exits after its idle time, removing its socket and lock', async () => {
    const { paths } = place()
    const runtime = await inProcess(paths, { idleMs: 200 })
    const c = await client(paths)
    await new Promise((r) => setTimeout(r, 400))
    expect(await answers(paths)).toBe(true)
    c.close()
    const at = Date.now()
    await runtime.stopped
    expect(Date.now() - at).toBeGreaterThanOrEqual(150)
    expect(existsSync(paths.socket)).toBe(false)
    expect(await lockHeld(paths.data)).toBe(false)
  })

  it('GRF-C220 a daemon keeps running past the idle time with no client and says it runs as a daemon', async () => {
    const { env, paths } = place()
    await inProcess(paths, { idleMs: 100, daemon: true })
    await new Promise((r) => setTimeout(r, 400))
    expect(await answers(paths)).toBe(true)
    const out = JSON.parse((await output(wire(env, ['runtime', 'status']))).stdout)
    expect(out).toMatchObject({
      running: true,
      mode: 'daemon',
      note: 'Runs as a daemon, also while Ostia is closed',
    })
  })

  it('GRF-C222 the documented unit and plist run node and the package script by absolute path with start --daemon --foreground and restart on failure, and their command twice leaves one runtime', async () => {
    const unit = readFileSync(join(ROOT, 'docs', 'systemd', 'wire-runtime.service'), 'utf8')
    const exec = /^ExecStart=(\S+) (\S+) (.*)$/m.exec(unit)
    const script = /^\/[^%$\s]+\/@aurigax-ai\/wire\/dist\/cli\/bin\.js$/
    expect(exec?.[1]).toMatch(/^\/[^%$\s]+\/node$/)
    expect(exec?.[2]).toMatch(script)
    expect(exec?.[3]).toBe('runtime start --daemon --foreground')
    expect(unit).toMatch(/^Restart=on-failure$/m)
    const plist = readFileSync(
      join(ROOT, 'docs', 'launchd', 'com.aurigax.wire-runtime.plist'),
      'utf8',
    )
    const args = [
      ...(
        (plist.split('<key>ProgramArguments</key>')[1] ?? '').split('</array>')[0] ?? ''
      ).matchAll(/<string>([^<]*)<\/string>/g),
    ].map((m) => m[1])
    expect(args[0]).toMatch(/^\/[^%$\s]+\/node$/)
    expect(args[1]).toMatch(script)
    expect(args.slice(2)).toEqual(['runtime', 'start', '--daemon', '--foreground'])
    expect(plist).not.toMatch(/USERNAME/)
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/)

    const verify = (() => {
      try {
        execFileSync('systemd-analyze', ['--version'], { stdio: 'ignore' })
        return true
      } catch {
        return false
      }
    })()
    if (verify) {
      const dir = mkdtempSync(join(tmpdir(), 'wrt-unit-'))
      writeFileSync(
        join(dir, 'wire-runtime.service'),
        unit.replace(`${exec?.[1]} ${exec?.[2]}`, `${process.execPath} ${BIN}`),
      )
      execFileSync('systemd-analyze', ['--user', 'verify', join(dir, 'wire-runtime.service')])
    }

    const { env, paths } = place()
    const command = (exec?.[3] ?? '').split(' ')
    const first = wire(env, [...command])
    await until(() => answers(paths))
    const second = await output(wire(env, [...command]))
    expect(second.code).toBe(1)
    expect(JSON.parse(second.stdout)).toMatchObject({ error: 'already-running', pid: first.pid })
    const c = await client(paths)
    expect(await c.call('runtime.status')).toMatchObject({ pid: first.pid, mode: 'daemon' })
    c.close()
  })
})

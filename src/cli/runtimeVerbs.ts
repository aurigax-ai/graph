import { realpathSync } from 'node:fs'
import { RuntimeCallError } from '../runtime/client.ts'
import type { CommandOutput } from './commands.ts'
import { cliConnect } from './runtimeCommands.ts'

function json(value: unknown, exitCode = 0): CommandOutput {
  return { exitCode, stdout: `${JSON.stringify(value, null, 2)}\n` }
}

function refusal(err: unknown): CommandOutput {
  if (!(err instanceof RuntimeCallError)) throw err
  const at = err.message.indexOf(': ')
  return json(
    at < 0
      ? { ok: false, error: err.message }
      : { ok: false, error: err.message.slice(0, at), message: err.message.slice(at + 2) },
    1,
  )
}

export async function inFolder(
  cwd: string,
  act: (
    call: <T>(method: string, params: Record<string, unknown>) => Promise<T>,
    scope: string,
  ) => Promise<unknown>,
): Promise<CommandOutput> {
  const client = await cliConnect()
  try {
    const call = <T>(method: string, params: Record<string, unknown>) =>
      client.call<T>(method, params)
    const { scope } = await call<{ scope: string }>('scopes.register', {
      folder: realpathSync(cwd),
    })
    return json(await act(call, scope))
  } catch (err) {
    return refusal(err)
  } finally {
    client.close()
  }
}

export function listCommand(cwd: string): Promise<CommandOutput> {
  return inFolder(cwd, (call, scope) => call('graphs.list', { scope }))
}

export function startCommand(cwd: string, name: string, inputs: string[]): Promise<CommandOutput> {
  return inFolder(cwd, (call, scope) => call('runs.start', { scope, name, inputs }))
}

export function runsCommand(cwd: string): Promise<CommandOutput> {
  return inFolder(cwd, (call, scope) => call('runs.list', { scope }))
}

export function showRunCommand(cwd: string, runId: string, node?: string): Promise<CommandOutput> {
  return inFolder(cwd, (call, scope) =>
    call('runs.show', { scope, runId, ...(node ? { node } : {}) }),
  )
}

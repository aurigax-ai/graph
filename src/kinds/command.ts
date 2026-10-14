import { z } from 'zod'
import type { KindDescriptor, NodeContext, NodeKind, Output } from '../engine/contract.ts'
import { NodeError } from '../engine/contract.ts'
import { MINUTE_MS } from '../format/duration.ts'
import { argument } from './fields.ts'

export const ARGV_MAX = 64
export const ARG_MAX = 4096
export const STDOUT_MAX = 64 * 1024
export const STDERR_MAX = 16 * 1024
export const COMMAND_TIMEOUT_MS = 60_000
export const COMMAND_TIMEOUT_MAX_MS = 10 * MINUTE_MS

const commandWith = z.strictObject({
  run: z.array(argument(ARG_MAX)).min(1).max(ARGV_MAX),
  exitIsError: z.boolean().optional(),
})

const outputs = z.object({
  exit: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
})

export const commandKind: KindDescriptor = {
  kind: 'command',
  version: 1,
  title: 'Command',
  with: commandWith,
  outputs,
  effect: 'local',
  sandbox: 'wrapped',
  once: false,
  takesResult: false,
  timeout: { defaultMs: COMMAND_TIMEOUT_MS, maxMs: COMMAND_TIMEOUT_MAX_MS },
  errors: ['Timeout', 'ExitCode', 'SandboxUnavailable'],
  mock: () => ({ exit: 0, stdout: '', stderr: '', timedOut: false, truncated: false }),
}

export interface ProcessRequest {
  scope: string
  argv: string[]
  env: Record<string, string>
  timeoutMs: number
  signal: AbortSignal
}

export interface ProcessReply {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
}

export type ProcessRunner = (req: ProcessRequest) => Promise<ProcessReply>

export function argvText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export function commandEnv(ctx: {
  run: { id: string; node: string; attempt: number; attemptKey: string }
}) {
  return {
    GRAPH_RUN_ID: ctx.run.id,
    GRAPH_NODE: ctx.run.node,
    GRAPH_ATTEMPT_KEY: ctx.run.attemptKey,
    GRAPH_ATTEMPT: String(ctx.run.attempt),
  }
}

export function commandNode(runProcess: ProcessRunner): NodeKind {
  return {
    kind: 'command',
    version: 1,
    start: async (input: Output, ctx: NodeContext) => {
      const argv = (input.run as unknown[]).map(argvText)
      const reply = await runProcess({
        scope: ctx.scope,
        argv,
        env: commandEnv(ctx),
        timeoutMs: ctx.timeoutMs ?? COMMAND_TIMEOUT_MS,
        signal: ctx.signal,
      })
      if (reply.timedOut) throw new NodeError('Timeout', `${argv[0]} ran past its timeout`)
      if (input.exitIsError === true && reply.exitCode !== 0) {
        throw new NodeError('ExitCode', `${argv[0]} exited ${reply.exitCode}`)
      }
      return {
        done: {
          exit: reply.exitCode,
          stdout: reply.stdout.slice(0, STDOUT_MAX),
          stderr: reply.stderr.slice(0, STDERR_MAX),
          timedOut: reply.timedOut,
          truncated: reply.truncated,
        },
      }
    },
  }
}

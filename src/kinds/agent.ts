import { z } from 'zod'
import type { KindCheckContext, KindDescriptor, Output } from '../engine/contract.ts'
import { HOUR_MS, MINUTE_MS } from '../format/duration.ts'
import { type GraphNode, type Problem, problem } from '../format/model.ts'
import { NODE_REF, text } from './fields.ts'

export const PROMPT_MAX = 16_000
export const MESSAGE_MAX = 8000
export const TRIGGER_TARGET = 'trigger'
export const AGENT_OUTCOMES = ['stopped', 'exited', 'closed'] as const

const prompt = text(PROMPT_MAX)
const wait = z.enum(['stop', 'none']).optional()

const agentWith = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('start'),
    agent: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/),
    prompt,
    wait,
  }),
  z.strictObject({ mode: z.literal('continue'), from: NODE_REF, prompt, wait }),
  z.strictObject({
    mode: z.literal('message'),
    to: z.union([NODE_REF, z.literal(TRIGGER_TARGET)]),
    prompt,
    wait,
  }),
])

const outputs = z.object({
  pane: z.string().optional(),
  session: z.string().optional(),
  outcome: z.enum(AGENT_OUTCOMES).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  message: z.string().max(MESSAGE_MAX).optional(),
  delivered: z.enum(['waiting', 'queued']).optional(),
})

function checkAgent(node: GraphNode, ctx: KindCheckContext): Problem[] {
  const w = node.with ?? {}
  const ref = w.mode === 'continue' ? w.from : w.mode === 'message' ? w.to : undefined
  if (typeof ref !== 'string' || ref === TRIGGER_TARGET) return []
  const target = ctx.nodes.get(ref)
  if (target?.kind === 'agent' && ref !== node.id) return []
  const field = w.mode === 'continue' ? 'from' : 'to'
  return [
    problem(
      'bad-with',
      `${field} must be an agent node of this graph${field === 'to' ? ' or trigger' : ''}`,
      {
        node: node.id,
        path: `with.${field}`,
      },
    ),
  ]
}

export const agentKind: KindDescriptor = {
  kind: 'agent',
  version: 1,
  title: 'Agent',
  with: agentWith,
  outputs,
  effect: 'agent',
  sandbox: 'same',
  once: true,
  takesResult: true,
  opensAgent: (input) => input.mode === 'start' || input.mode === 'continue',
  maxPrompt: PROMPT_MAX,
  timeout: { defaultMs: 30 * MINUTE_MS, maxMs: 24 * HOUR_MS },
  errors: ['Timeout', 'NoResult', 'BadResult', 'AgentGone', 'PromptTooLong'],
  mock: (input: Output) =>
    input.mode === 'message'
      ? { delivered: 'waiting' }
      : { outcome: 'stopped', pane: 'mock', session: 'mock' },
  check: checkAgent,
}

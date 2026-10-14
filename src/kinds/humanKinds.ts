import { z } from 'zod'
import type { KindDescriptor } from '../engine/contract'
import { line, text } from './fields'

export const QUESTION_MAX = 500
export const CONTEXT_MAX = 4000
export const CHOICES_MAX = 12
export const FORM_FIELDS_MAX = 8
export const DEFAULT_CHOICES = ['Approve', 'Reject']

const formField = z.union([
  z.strictObject({ type: z.literal('string'), title: z.string().max(80).optional() }),
  z.strictObject({ type: z.literal('integer'), title: z.string().max(80).optional() }),
  z.strictObject({ type: z.literal('boolean'), title: z.string().max(80).optional() }),
  z.strictObject({
    type: z.literal('string'),
    enum: z.array(line(120)).min(1).max(CHOICES_MAX),
    title: z.string().max(80).optional(),
  }),
])

const approvalWith = z.strictObject({
  question: text(QUESTION_MAX),
  context: z.string().max(CONTEXT_MAX).optional(),
  choices: z.array(line(120)).min(1).max(CHOICES_MAX).optional(),
  fields: z
    .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/), formField)
    .refine(
      (fields) => Object.keys(fields).length <= FORM_FIELDS_MAX,
      `at most ${FORM_FIELDS_MAX} fields`,
    )
    .optional(),
})

export const approvalKind: KindDescriptor = {
  kind: 'approval',
  version: 1,
  title: 'Approval',
  with: approvalWith,
  outputs: z.object({
    answer: z.string().optional(),
    values: z.record(z.string(), z.unknown()).optional(),
    outcome: z.literal('answered').optional(),
  }),
  effect: 'human',
  sandbox: 'same',
  once: false,
  takesResult: false,
  errors: ['Dismissed'],
  mock: (input) => {
    const choices = Array.isArray(input.choices) ? input.choices : DEFAULT_CHOICES
    return { answer: String(choices[0]), values: {}, outcome: 'answered' }
  },
}

const USE_PATTERN =
  /^(?:mcp:[A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._-]{1,64}|[a-z][a-z0-9-]{0,39}\.[A-Za-z][A-Za-z0-9_]{0,39})$/

export const connectorKind: KindDescriptor = {
  kind: 'connector',
  version: 1,
  title: 'Connector',
  with: z.strictObject({
    use: z.string().regex(USE_PATTERN, 'mcp:<server>/<tool> or <connector>.<operation>'),
    connection: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,39}$/)
      .optional(),
    input: z.record(z.string(), z.unknown()).optional(),
  }),
  outputs: z.object({ ok: z.boolean(), data: z.unknown().optional() }),
  effect: 'external',
  sandbox: 'refuse',
  once: false,
  takesResult: false,
  timeout: { defaultMs: 120_000, maxMs: 600_000 },
  errors: ['ConnectorFailed', 'Timeout'],
  mock: () => ({ ok: true, data: { text: '' } }),
}

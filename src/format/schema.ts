import { z } from 'zod'
import type { KindDescriptor } from '../engine/contract.ts'
import { line } from '../kinds/fields.ts'
import { cronValid } from '../triggers/schedule.ts'
import { HOUR_MS, MINUTE_MS, parseDuration } from './duration.ts'
import {
  ALL_ERRORS,
  CATCH_MAX,
  EDGES_MAX,
  ERROR_NAMES,
  FAN_MAX,
  NODES_MAX,
  RETRY_MAX,
  STATE_TYPES,
  STRING_MAX,
  TRIGGERS_MAX,
  WHEN_MAX,
} from './model.ts'

export const LIMIT_CEILINGS = {
  steps: 500,
  runsPerHour: 60,
  parallel: 8,
  agents: 24,
  timeMs: 168 * HOUR_MS,
}

const durationString = z
  .string()
  .refine((v) => parseDuration(v) !== null, 'a duration such as 30s, 10m or 2h')
const errorMatch = z.enum([...ERROR_NAMES, ALL_ERRORS])

export const stateKeySchema = z.strictObject({
  type: z.enum(STATE_TYPES),
  default: z.unknown().optional(),
  merge: z.enum(['replace', 'append']).optional(),
  enum: z
    .array(z.union([z.string(), z.number(), z.boolean()]))
    .min(1)
    .max(64)
    .optional(),
  items: z.strictObject({ type: z.enum(STATE_TYPES) }).optional(),
  max: z.number().int().min(1).max(STRING_MAX).optional(),
  keep: z.enum(['head', 'tail']).optional(),
})

export const retrySchema = z.strictObject({
  errors: z.array(errorMatch).min(1),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  interval: durationString.optional(),
  backoff: z.number().min(1).max(10).optional(),
  maxDelay: durationString.optional(),
  jitter: z.enum(['full', 'none']).optional(),
})

export const catchSchema = z.strictObject({
  errors: z.array(errorMatch).min(1),
  // biome-ignore lint/suspicious/noThenProperty: the format names a catch target then
  then: z.string(),
})

export const nodeBaseSchema = z.strictObject({
  id: z.string(),
  kind: z.string(),
  title: line(80).optional(),
  with: z.record(z.string(), z.unknown()).optional(),
  out: z.record(z.string(), z.string()).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  once: z.boolean().optional(),
  timeout: durationString.optional(),
  retry: z.array(retrySchema).min(1).max(RETRY_MAX).optional(),
  catch: z.array(catchSchema).min(1).max(CATCH_MAX).optional(),
})

function relativeGlob(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.split('/').includes('..') &&
    !value.startsWith('~')
  )
}

export const TRIGGER_SCHEMAS = {
  manual: z.strictObject({
    agents: z.boolean().optional(),
    input: z.array(z.string()).max(64).optional(),
  }),
  schedule: z
    .strictObject({
      cron: z
        .string()
        .refine(cronValid, 'five cron fields: minute hour day month weekday')
        .optional(),
      every: z
        .string()
        .refine((v) => (parseDuration(v) ?? 0) >= MINUTE_MS, 'a duration of at least 1m')
        .optional(),
      catchUp: z.boolean().optional(),
    })
    .refine(
      (s) => (s.cron === undefined) !== (s.every === undefined),
      'exactly one of cron and every',
    ),
  files: z.strictObject({
    glob: z.union([
      z.string().refine(relativeGlob, 'a pattern relative to the workspace folder'),
      z
        .array(z.string().refine(relativeGlob, 'a pattern relative to the workspace folder'))
        .min(1)
        .max(8),
    ]),
  }),
  command: z.strictObject({ exit: z.enum(['any', 'zero', 'nonzero']).optional() }),
  agent: z.strictObject({
    state: z.enum(['stopped', 'waiting']),
    agent: z.enum(['claude', 'codex']).optional(),
  }),
} as const

const nodeId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)
const fan = z.array(z.string()).min(1).max(FAN_MAX)

export const EDGE_SCHEMAS = {
  plain: z.strictObject({ from: z.string(), to: z.union([z.string(), fan]) }),
  join: z.strictObject({ from: z.array(z.string()).min(2).max(FAN_MAX), to: z.string() }),
  conditional: z.strictObject({
    from: z.string(),
    when: z
      .array(z.strictObject({ if: z.string(), to: z.string() }))
      .min(1)
      .max(WHEN_MAX),
    else: z.string(),
  }),
}

export const limitsSchema = z.strictObject({
  steps: z.number().int().min(1).optional(),
  runsPerHour: z.number().int().min(1).optional(),
  parallel: z.number().int().min(1).optional(),
  agents: z.number().int().min(0).optional(),
  time: durationString.optional(),
})

export const topSchema = z.strictObject({
  version: z.literal(1),
  description: line(200).optional(),
  on: z.array(z.unknown()).min(1).max(TRIGGERS_MAX),
  concurrency: z.enum(['skip', 'queue']).optional(),
  start: z.union([z.string(), fan]),
  state: z.record(z.string(), z.unknown()),
  limits: z.unknown().optional(),
  nodes: z.array(z.unknown()).min(1).max(NODES_MAX),
  edges: z.array(z.unknown()).max(EDGES_MAX),
  ui: z.unknown().optional(),
})

export function graphJsonSchema(kinds: readonly KindDescriptor[]): Record<string, unknown> {
  const node = z.discriminatedUnion(
    'kind',
    kinds.map((k) =>
      nodeBaseSchema.extend({
        id: nodeId,
        kind: z.literal(k.kind),
        with: k.kind === 'router' ? z.never().optional() : k.with.optional(),
        ...(k.takesResult ? {} : { result: z.never().optional() }),
      }),
    ) as unknown as [z.ZodObject, ...z.ZodObject[]],
  )
  const trigger = z.union(
    Object.entries(TRIGGER_SCHEMAS).map(([name, schema]) =>
      z.strictObject({ [name]: schema }),
    ) as unknown as [z.ZodType, ...z.ZodType[]],
  )
  const schema = topSchema.extend({
    on: z.array(trigger).min(1).max(TRIGGERS_MAX),
    state: z.record(z.string().regex(/^[a-z][A-Za-z0-9_]{0,39}$/), stateKeySchema),
    limits: limitsSchema.optional(),
    nodes: z.array(node).min(1).max(NODES_MAX),
    edges: z
      .array(z.union([EDGE_SCHEMAS.conditional, EDGE_SCHEMAS.join, EDGE_SCHEMAS.plain]))
      .max(EDGES_MAX),
    ui: z.record(z.string(), z.unknown()).optional(),
  })
  return {
    ...z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any', io: 'input' }),
    title: 'Graph file',
  }
}

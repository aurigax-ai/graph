import { z } from 'zod'
import type { KindDescriptor, NodeKind, Notice, Output } from '../engine/contract.ts'
import { DAY_MS, parseDuration } from '../format/duration.ts'
import { RFC3339, duration, line, text } from './fields.ts'

export const WAIT_MAX_MS = 30 * DAY_MS
export const NOTIFY_TITLE_MAX = 80
export const NOTIFY_BODY_MAX = 400

export const routerKind: KindDescriptor = {
  kind: 'router',
  version: 1,
  title: 'Router',
  with: z.undefined({ error: 'a router has no fields' }),
  outputs: z.object({}),
  effect: 'none',
  sandbox: 'same',
  once: false,
  takesResult: false,
  errors: ['ConditionError'],
  mock: () => ({}),
}

const waitWith = z.union([
  z.strictObject({ for: duration(WAIT_MAX_MS) }),
  z.strictObject({
    until: z.string().regex(RFC3339, 'an RFC 3339 time such as 2026-10-14T09:00:00Z'),
  }),
])

export const waitKind: KindDescriptor = {
  kind: 'wait',
  version: 1,
  title: 'Wait',
  with: waitWith,
  outputs: z.object({}),
  effect: 'none',
  sandbox: 'same',
  once: false,
  takesResult: false,
  errors: ['Timeout'],
  mock: () => ({}),
}

export function waitDeadline(input: Output, startedAt: number): number {
  if (typeof input.until === 'string') return Date.parse(input.until)
  return startedAt + (parseDuration(input.for) ?? 0)
}

export function waitNode(now: () => number): NodeKind {
  return {
    kind: 'wait',
    version: 1,
    start: async (input) => {
      const at = waitDeadline(input, now())
      return at <= now() ? { done: {} } : { waiting: { on: 'timer', at } }
    },
    resume: async () => ({ done: {} }),
  }
}

export const notifyKind: KindDescriptor = {
  kind: 'notify',
  version: 1,
  title: 'Notify',
  with: z.strictObject({ title: line(NOTIFY_TITLE_MAX), body: text(NOTIFY_BODY_MAX).optional() }),
  outputs: z.object({}),
  effect: 'human',
  sandbox: 'same',
  once: false,
  takesResult: false,
  errors: [],
  mock: () => ({}),
}

export function notifyNode(send: (notice: Notice) => void | Promise<void>): NodeKind {
  return {
    kind: 'notify',
    version: 1,
    start: async (input, ctx) => {
      const body = typeof input.body === 'string' ? input.body.slice(0, NOTIFY_BODY_MAX) : undefined
      await send({
        title: String(input.title).slice(0, NOTIFY_TITLE_MAX),
        ...(body ? { body } : {}),
        run: ctx.run.id,
        graph: ctx.run.graph,
      })
      return { done: {} }
    },
  }
}

export const routerNode: NodeKind = {
  kind: 'router',
  version: 1,
  start: async () => ({ done: {} }),
}

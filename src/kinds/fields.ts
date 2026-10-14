import { z } from 'zod'
import { parseDuration } from '../format/duration.ts'

export function hasControl(value: string): boolean {
  for (const ch of value) {
    const code = ch.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export function text(max: number) {
  return z.string().min(1).max(max)
}

export function line(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !hasControl(value), 'one line without control characters')
}

export function argument(max: number) {
  return z
    .string()
    .max(max)
    .refine((value) => !hasControl(value), 'no control characters')
}

export function duration(maxMs: number) {
  return z.string().refine(
    (value) => {
      const ms = parseDuration(value)
      return ms !== null && ms <= maxMs
    },
    `a duration such as 30s, 10m or 2h, at most ${Math.round(maxMs / 86_400_000)}d`,
  )
}

export const NODE_REF = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)

export const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

const DURATION_PATTERN = /^(?:\d+(?:ms|s|m|h|d))+$/
const PART_PATTERN = /(\d+)(ms|s|m|h|d)/g

export function parseDuration(text: unknown): number | null {
  if (typeof text !== 'string' || !DURATION_PATTERN.test(text)) return null
  let total = 0
  for (const [, amount, unit] of text.matchAll(PART_PATTERN)) {
    total += Number(amount) * UNIT_MS[unit]
  }
  return total > 0 ? total : null
}

export function formatDuration(ms: number): string {
  for (const unit of ['d', 'h', 'm', 's'] as const) {
    if (ms >= UNIT_MS[unit] && ms % UNIT_MS[unit] === 0) return `${ms / UNIT_MS[unit]}${unit}`
  }
  return `${ms}ms`
}

export const MINUTE_MS = UNIT_MS.m
export const HOUR_MS = UNIT_MS.h
export const DAY_MS = UNIT_MS.d

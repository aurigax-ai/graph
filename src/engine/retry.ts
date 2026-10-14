import { parseDuration } from '../format/duration'
import { ALL_ERRORS, type CatchRule, type GraphNode, type RetryRule } from '../format/model'

export const RETRY_INTERVAL_MS = 1000
export const RETRY_BACKOFF = 2

function matches(errors: readonly string[], name: string): boolean {
  return errors.includes(name) || errors.includes(ALL_ERRORS)
}

export function retryRule(
  node: GraphNode,
  name: string,
): { index: number; rule: RetryRule } | null {
  const rules = node.retry ?? []
  const index = rules.findIndex((rule) => matches(rule.errors, name))
  return index === -1 ? null : { index, rule: rules[index] }
}

export function retryDelay(rule: RetryRule, retryNumber: number, random: () => number): number {
  const interval = parseDuration(rule.interval) ?? RETRY_INTERVAL_MS
  const backoff = rule.backoff ?? RETRY_BACKOFF
  const raw = interval * backoff ** retryNumber
  const capped = rule.maxDelay ? Math.min(raw, parseDuration(rule.maxDelay) ?? raw) : raw
  return rule.jitter === 'full' ? Math.floor(random() * capped) : capped
}

export function catchRule(node: GraphNode, name: string): CatchRule | null {
  return (node.catch ?? []).find((rule) => matches(rule.errors, name)) ?? null
}

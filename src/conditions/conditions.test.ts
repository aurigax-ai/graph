import { evaluate as celEvaluate } from '@marcbachmann/cel-js'
import { describe, expect, it } from 'vitest'
import { checkCondition } from './check'
import { evaluateCondition } from './evaluate'
import { parseCondition } from './parser'

const scope = {
  state: {
    exit: 0,
    review: 'Looks fine.\nVERDICT: pass',
    labels: ['bug', 'ui'],
    notes: ['a', 'b', 'c'],
    done: false,
    result: { verdict: 'skip' },
  },
  trigger: {},
  run: { id: 'r1', graph: 'g', steps: 3, remaining: 47, attempt: 1, visits: { implement: 4 } },
}

const declared = {
  state: new Set(['exit', 'review', 'labels', 'notes', 'done', 'result', 'absent', 'count', 'a']),
  nodes: new Set(['implement']),
}

function value(text: string): boolean {
  const parsed = parseCondition(text)
  if (!parsed.ok) throw new Error(parsed.problem.message)
  const result = evaluateCondition(parsed.expr, scope)
  if (!result.ok) throw new Error(result.error)
  return result.value
}

describe('conditions', () => {
  it.each([
    ['state.exit == 0', true],
    ["state.review.contains('VERDICT: pass')", true],
    ["'bug' in state.labels", true],
    ['size(state.notes) >= 3 && !state.done', true],
    ['run.visits.implement >= 4', true],
    ['!has(state.absent)', true],
    ["state.result.verdict in ['pass', 'skip']", true],
    ["state.result.verdict in ['pass']", false],
    ['state.exit != 0 || size(state.labels) == 2', true],
  ])('GRF-C27 %s gives the listed value, as cel-js does', (text, expected) => {
    expect(value(text)).toBe(expected)
    expect(celEvaluate(text, scope)).toBe(expected)
  })

  it.each([
    'state.a + 1 > 2',
    'state.list.exists(x, x > 1)',
    "state.s.matches('^a')",
    "timestamp('2026-01-01')",
    'state.x.constructor == 1',
    'state.a = 1',
    `state.a == '${'x'.repeat(490)}'`,
    `${'('.repeat(17)}true${')'.repeat(17)}`,
  ])('GRF-C28 %s is bad-condition with a column', (text) => {
    const parsed = parseCondition(text)
    const checked = parsed.ok ? checkCondition(parsed.expr, declared) : parsed.problem
    expect(checked).not.toBeNull()
    expect(checked?.code).toBe('bad-condition')
    expect(typeof checked?.column).toBe('number')
  })

  it('GRF-C28 a 501-character condition is refused at column 501', () => {
    const parsed = parseCondition(`state.a == '${'x'.repeat(487)}'`.padEnd(501, ' '))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.problem.column).toBe(501)
  })

  it('names an undeclared state key and an unknown node in run.visits', () => {
    const one = parseCondition('state.nope == 1')
    const two = parseCondition('run.visits.nope >= 1')
    if (!one.ok || !two.ok) throw new Error('parse')
    expect(checkCondition(one.expr, declared)?.code).toBe('unknown-state-key')
    expect(checkCondition(two.expr, declared)?.code).toBe('bad-condition')
  })

  it('fails closed on unlike types and missing fields instead of choosing false', () => {
    for (const text of ["state.exit > 'abc'", 'state.absent == 1', '!state.exit']) {
      const parsed = parseCondition(text)
      if (!parsed.ok) throw new Error(parsed.problem.message)
      expect(evaluateCondition(parsed.expr, scope).ok).toBe(false)
    }
  })

  it('absorbs an error on the side that does not decide, as CEL does', () => {
    const parsed = parseCondition('state.absent == 1 || state.exit == 0')
    if (!parsed.ok) throw new Error(parsed.problem.message)
    expect(evaluateCondition(parsed.expr, scope)).toEqual({ ok: true, value: true })
  })
})

import { describe, expect, it } from 'vitest'
import { checkCondition } from './check.ts'
import { evaluateCondition } from './evaluate.ts'
import { parseCondition } from './parser.ts'

describe('reading a node id with a dash', () => {
  it('works with brackets, and the error for the dotted form says so', () => {
    const parsed = parseCondition("run.visits['fix-review'] >= 1")
    if (!parsed.ok) throw new Error(parsed.problem.message)
    const declared = { state: new Set<string>(), nodes: new Set(['fix-review']) }
    expect(checkCondition(parsed.expr, declared)).toBeNull()
    const value = evaluateCondition(parsed.expr, {
      state: {},
      trigger: {},
      run: { visits: { 'fix-review': 2 } },
    })
    expect(value).toEqual({ ok: true, value: true })
    const dotted = parseCondition('run.visits.fix-review >= 1')
    expect(dotted.ok).toBe(false)
    if (!dotted.ok) expect(dotted.problem.message).toContain("run.visits['fix-review']")
  })
})

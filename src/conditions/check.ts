import { type Problem, problem } from '../format/model.ts'
import type { Expr } from './parser.ts'

export const RUN_FIELDS = ['id', 'graph', 'steps', 'remaining', 'visits', 'attempt'] as const

export interface Declared {
  state: ReadonlySet<string>
  nodes: ReadonlySet<string>
}

function checkPath(expr: Expr & { t: 'path' }, declared: Declared): Problem | null {
  const [first, second] = expr.steps
  const firstField = first && 'field' in first ? first.field : undefined
  if (expr.root === 'state') {
    if (first && firstField === undefined) {
      return problem('bad-condition', 'a state key is read with .name', { column: first.column })
    }
    if (firstField !== undefined && !declared.state.has(firstField)) {
      return problem('unknown-state-key', `state.${firstField} is not declared under state`, {
        column: first?.column,
        key: firstField,
      })
    }
    return null
  }
  if (expr.root === 'run') {
    if (firstField === undefined || !(RUN_FIELDS as readonly string[]).includes(firstField)) {
      return problem('bad-condition', `run has only ${RUN_FIELDS.join(', ')}`, {
        column: first?.column ?? expr.column,
      })
    }
    if (firstField === 'visits') {
      const node = second ? ('field' in second ? second.field : String(second.index)) : undefined
      if (node === undefined || !declared.nodes.has(node)) {
        return problem('bad-condition', 'run.visits is read with the id of a node of this graph', {
          column: second?.column ?? first?.column,
        })
      }
    }
  }
  return null
}

export function checkCondition(expr: Expr, declared: Declared): Problem | null {
  switch (expr.t) {
    case 'lit':
      return null
    case 'list':
      for (const item of expr.items) {
        const found = checkCondition(item, declared)
        if (found) return found
      }
      return null
    case 'path':
      return checkPath(expr, declared)
    case 'has':
      return checkPath(expr.path, declared)
    case 'size':
      return checkCondition(expr.arg, declared)
    case 'call':
      return checkCondition(expr.target, declared) ?? checkCondition(expr.arg, declared)
    case 'not':
      return checkCondition(expr.expr, declared)
    case 'and':
    case 'or':
    case 'rel':
      return checkCondition(expr.left, declared) ?? checkCondition(expr.right, declared)
  }
}

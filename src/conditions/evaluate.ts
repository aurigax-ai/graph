import { isRecord } from '../format/model.ts'
import type { Expr, Step } from './parser.ts'

export type Evaluated = { ok: true; value: boolean } | { ok: false; error: string }

export interface ConditionScope {
  state: Record<string, unknown>
  trigger: Record<string, unknown>
  run: Record<string, unknown>
}

class ConditionEvalError extends Error {}

type Value = unknown

function typeOf(value: Value): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'list'
  if (typeof value === 'number') return 'number'
  if (isRecord(value)) return 'map'
  return typeof value
}

function readStep(value: Value, step: Step): Value {
  if ('field' in step) {
    if (!isRecord(value) || !Object.hasOwn(value, step.field)) {
      throw new ConditionEvalError(`no such field '${step.field}'`)
    }
    return value[step.field]
  }
  if (Array.isArray(value) && typeof step.index === 'number') {
    if (!Number.isInteger(step.index) || step.index < 0 || step.index >= value.length) {
      throw new ConditionEvalError(`index ${step.index} is out of range`)
    }
    return value[step.index]
  }
  if (isRecord(value) && typeof step.index === 'string' && Object.hasOwn(value, step.index)) {
    return value[step.index]
  }
  throw new ConditionEvalError(`no such index ${JSON.stringify(step.index)}`)
}

function readPath(expr: Expr & { t: 'path' }, scope: ConditionScope): Value {
  let value: Value = scope[expr.root]
  for (const step of expr.steps) value = readStep(value, step)
  return value === undefined ? null : value
}

function equal(left: Value, right: Value): boolean {
  if (left === null || right === null) return left === right
  const lt = typeOf(left)
  const rt = typeOf(right)
  if (lt !== rt) throw new ConditionEvalError(`cannot compare ${lt} with ${rt}`)
  if (lt === 'list') {
    const l = left as Value[]
    const r = right as Value[]
    return l.length === r.length && l.every((item, i) => equal(item, r[i]))
  }
  if (lt === 'map') {
    const l = left as Record<string, Value>
    const r = right as Record<string, Value>
    const keys = Object.keys(l)
    return (
      keys.length === Object.keys(r).length &&
      keys.every((k) => Object.hasOwn(r, k) && equal(l[k], r[k]))
    )
  }
  return left === right
}

function order(left: Value, right: Value): number {
  const lt = typeOf(left)
  const rt = typeOf(right)
  if (lt !== rt || !['number', 'string', 'boolean'].includes(lt)) {
    throw new ConditionEvalError(`cannot order ${lt} and ${rt}`)
  }
  const l = left as number | string | boolean
  const r = right as number | string | boolean
  return l < r ? -1 : l > r ? 1 : 0
}

function bool(value: Value): boolean {
  if (typeof value !== 'boolean')
    throw new ConditionEvalError(`expected a boolean, got ${typeOf(value)}`)
  return value
}

function settle(fn: () => boolean): { value: boolean } | { error: ConditionEvalError } {
  try {
    return { value: fn() }
  } catch (err) {
    if (err instanceof ConditionEvalError) return { error: err }
    throw err
  }
}

function logic(expr: Expr & { t: 'and' | 'or' }, scope: ConditionScope): boolean {
  const decisive = expr.t === 'or'
  const left = settle(() => bool(value(expr.left, scope)))
  if ('value' in left && left.value === decisive) return decisive
  const right = settle(() => bool(value(expr.right, scope)))
  if ('value' in right && right.value === decisive) return decisive
  if ('error' in left) throw left.error
  if ('error' in right) throw right.error
  return !decisive
}

function sizeOf(arg: Value): number {
  if (typeof arg === 'string') return [...arg].length
  if (Array.isArray(arg)) return arg.length
  if (isRecord(arg)) return Object.keys(arg).length
  throw new ConditionEvalError(`size() of ${typeOf(arg)}`)
}

function relation(expr: Expr & { t: 'rel' }, scope: ConditionScope): boolean {
  const left = value(expr.left, scope)
  const right = value(expr.right, scope)
  switch (expr.op) {
    case '==':
      return equal(left, right)
    case '!=':
      return !equal(left, right)
    case '<':
      return order(left, right) < 0
    case '<=':
      return order(left, right) <= 0
    case '>':
      return order(left, right) > 0
    case '>=':
      return order(left, right) >= 0
    case 'in':
      if (Array.isArray(right))
        return right.some((item) => typeOf(item) === typeOf(left) && equal(item, left))
      if (isRecord(right) && typeof left === 'string') return Object.hasOwn(right, left)
      throw new ConditionEvalError(`'in' needs a list, got ${typeOf(right)}`)
  }
}

function value(expr: Expr, scope: ConditionScope): Value {
  switch (expr.t) {
    case 'lit':
      return expr.value
    case 'list':
      return expr.items.map((item) => value(item, scope))
    case 'path':
      return readPath(expr, scope)
    case 'has': {
      const parent = { ...expr.path, steps: expr.path.steps.slice(0, -1) }
      const last = expr.path.steps[expr.path.steps.length - 1]
      const holder = readPath(parent, scope)
      return 'value' in settle(() => readStep(holder, last) !== undefined)
    }
    case 'size':
      return sizeOf(value(expr.arg, scope))
    case 'call': {
      const target = value(expr.target, scope)
      const arg = value(expr.arg, scope)
      if (typeof target !== 'string' || typeof arg !== 'string') {
        throw new ConditionEvalError(`${expr.method}() needs two strings`)
      }
      if (expr.method === 'contains') return target.includes(arg)
      return target[expr.method](arg)
    }
    case 'not':
      return !bool(value(expr.expr, scope))
    case 'and':
    case 'or':
      return logic(expr, scope)
    case 'rel':
      return relation(expr, scope)
  }
}

export function evaluateCondition(expr: Expr, scope: ConditionScope): Evaluated {
  try {
    return { ok: true, value: bool(value(expr, scope)) }
  } catch (err) {
    if (err instanceof ConditionEvalError) return { ok: false, error: err.message }
    throw err
  }
}

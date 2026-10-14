import { type Problem, problem } from '../format/model'
import { CONDITION_DEPTH_MAX, ConditionSyntaxError, type Token, tokenize } from './lexer'

export const ROOTS = ['state', 'trigger', 'run'] as const
export type Root = (typeof ROOTS)[number]
export const METHODS = ['contains', 'startsWith', 'endsWith'] as const
export type Method = (typeof METHODS)[number]
export const RELATIONS = ['==', '!=', '<', '<=', '>', '>=', 'in'] as const
export type Relation = (typeof RELATIONS)[number]
const FORBIDDEN_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

export type Step = { field: string; column: number } | { index: string | number; column: number }

export type Expr =
  | { t: 'lit'; value: string | number | boolean | null }
  | { t: 'list'; items: Expr[] }
  | { t: 'path'; root: Root; steps: Step[]; column: number }
  | { t: 'has'; path: Expr & { t: 'path' } }
  | { t: 'size'; arg: Expr }
  | { t: 'call'; target: Expr; method: Method; arg: Expr }
  | { t: 'not'; expr: Expr }
  | { t: 'and' | 'or'; left: Expr; right: Expr }
  | { t: 'rel'; op: Relation; left: Expr; right: Expr }

export type Parsed = { ok: true; expr: Expr } | { ok: false; problem: Problem }

class Parser {
  private pos = 0
  private depth = 0

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos]
  }

  private next(): Token {
    return this.tokens[this.pos++]
  }

  private isOp(text: string): boolean {
    const token = this.peek()
    return token.type === 'op' && token.text === text
  }

  private expect(text: string): Token {
    const token = this.next()
    if (token.type !== 'op' || token.text !== text) {
      throw new ConditionSyntaxError(`expected '${text}'`, token.column)
    }
    return token
  }

  private enter(column: number): void {
    this.depth++
    if (this.depth > CONDITION_DEPTH_MAX) {
      throw new ConditionSyntaxError(
        `a condition nests at most ${CONDITION_DEPTH_MAX} deep`,
        column,
      )
    }
  }

  parse(): Expr {
    const expr = this.or()
    const rest = this.peek()
    if (rest.type !== 'eof')
      throw new ConditionSyntaxError(`unexpected '${rest.text}'`, rest.column)
    return expr
  }

  private or(): Expr {
    let left = this.and()
    while (this.isOp('||')) {
      this.next()
      left = { t: 'or', left, right: this.and() }
    }
    return left
  }

  private and(): Expr {
    let left = this.rel()
    while (this.isOp('&&')) {
      this.next()
      left = { t: 'and', left, right: this.rel() }
    }
    return left
  }

  private rel(): Expr {
    const left = this.unary()
    const token = this.peek()
    const op =
      token.type === 'op' && (RELATIONS as readonly string[]).includes(token.text)
        ? (token.text as Relation)
        : token.type === 'ident' && token.text === 'in'
          ? 'in'
          : null
    if (!op) return left
    this.next()
    return { t: 'rel', op, left, right: this.unary() }
  }

  private unary(): Expr {
    if (this.isOp('!')) {
      const token = this.next()
      this.enter(token.column)
      const expr: Expr = { t: 'not', expr: this.unary() }
      this.depth--
      return expr
    }
    return this.member()
  }

  private member(): Expr {
    let expr = this.primary()
    for (;;) {
      if (this.isOp('.')) {
        this.next()
        const name = this.next()
        if (name.type !== 'ident')
          throw new ConditionSyntaxError('expected a field name', name.column)
        if (FORBIDDEN_NAMES.has(name.text)) {
          throw new ConditionSyntaxError(`'${name.text}' cannot be read`, name.column)
        }
        if (this.isOp('(')) {
          if (!(METHODS as readonly string[]).includes(name.text)) {
            throw new ConditionSyntaxError(
              `'${name.text}()' is not a function of the language`,
              name.column,
            )
          }
          this.next()
          const arg = this.or()
          this.expect(')')
          expr = { t: 'call', target: expr, method: name.text as Method, arg }
          continue
        }
        expr = this.step(expr, { field: name.text, column: name.column })
        continue
      }
      if (this.isOp('[')) {
        const open = this.next()
        const index = this.next()
        if (index.type !== 'int' && index.type !== 'string') {
          throw new ConditionSyntaxError('an index is an integer or a string', index.column)
        }
        if (typeof index.value === 'string' && FORBIDDEN_NAMES.has(index.value)) {
          throw new ConditionSyntaxError(`'${index.value}' cannot be read`, index.column)
        }
        this.expect(']')
        expr = this.step(expr, { index: index.value as string | number, column: open.column })
        continue
      }
      return expr
    }
  }

  private step(expr: Expr, step: Step): Expr {
    if (expr.t !== 'path')
      throw new ConditionSyntaxError('only a path can be read further', step.column)
    return { ...expr, steps: [...expr.steps, step] }
  }

  private primary(): Expr {
    const token = this.next()
    if (token.type === 'int' || token.type === 'double' || token.type === 'string') {
      return { t: 'lit', value: token.value as string | number }
    }
    if (token.type === 'op' && token.text === '(') {
      this.enter(token.column)
      const expr = this.or()
      this.expect(')')
      this.depth--
      return expr
    }
    if (token.type === 'op' && token.text === '[') {
      const items: Expr[] = []
      if (!this.isOp(']')) {
        items.push(this.or())
        while (this.isOp(',')) {
          this.next()
          items.push(this.or())
        }
      }
      this.expect(']')
      return { t: 'list', items }
    }
    if (token.type === 'ident') {
      if (token.text === 'true' || token.text === 'false')
        return { t: 'lit', value: token.text === 'true' }
      if (token.text === 'null') return { t: 'lit', value: null }
      if ((ROOTS as readonly string[]).includes(token.text)) {
        return { t: 'path', root: token.text as Root, steps: [], column: token.column }
      }
      if (token.text === 'has' || token.text === 'size') {
        this.expect('(')
        const arg = token.text === 'has' ? this.member() : this.or()
        this.expect(')')
        if (token.text === 'size') return { t: 'size', arg }
        if (arg.t !== 'path' || arg.steps.length === 0) {
          throw new ConditionSyntaxError('has() takes a field of a path', token.column)
        }
        return { t: 'has', path: arg }
      }
      throw new ConditionSyntaxError(
        `'${token.text}' is not a path, literal or function of the language`,
        token.column,
      )
    }
    throw new ConditionSyntaxError(
      token.type === 'eof' ? 'the condition ends too early' : `unexpected '${token.text}'`,
      token.column,
    )
  }
}

export function parseCondition(text: string): Parsed {
  try {
    return { ok: true, expr: new Parser(tokenize(text)).parse() }
  } catch (err) {
    if (err instanceof ConditionSyntaxError) {
      return { ok: false, problem: problem('bad-condition', err.message, { column: err.column }) }
    }
    throw err
  }
}

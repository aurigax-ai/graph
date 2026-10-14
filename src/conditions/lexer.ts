export const CONDITION_MAX = 500
export const CONDITION_DEPTH_MAX = 16

export type TokenType = 'ident' | 'int' | 'double' | 'string' | 'op' | 'eof'

export interface Token {
  type: TokenType
  text: string
  value?: string | number
  column: number
}

export class ConditionSyntaxError extends Error {
  constructor(
    message: string,
    readonly column: number,
  ) {
    super(message)
  }
}

const OPERATORS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '!', '(', ')', '[', ']', '.', ',']
const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '\\': '\\',
  "'": "'",
  '"': '"',
}
const IDENT_START = /[A-Za-z_]/
const IDENT_PART = /[A-Za-z0-9_]/
const DIGIT = /[0-9]/

function readString(text: string, start: number): { value: string; end: number } {
  const quote = text[start]
  let value = ''
  let i = start + 1
  while (i < text.length) {
    const ch = text[i]
    if (ch === quote) return { value, end: i + 1 }
    if (ch === '\\') {
      const escaped = ESCAPES[text[i + 1] ?? '']
      if (escaped === undefined) throw new ConditionSyntaxError('unknown escape in a string', i + 1)
      value += escaped
      i += 2
      continue
    }
    if (ch === '\n') break
    value += ch
    i++
  }
  throw new ConditionSyntaxError('a string is not closed', start + 1)
}

function readNumber(text: string, start: number): { token: Token; end: number } {
  let i = start
  if (text[i] === '-') i++
  while (DIGIT.test(text[i] ?? '')) i++
  let type: TokenType = 'int'
  if (text[i] === '.' && DIGIT.test(text[i + 1] ?? '')) {
    type = 'double'
    i++
    while (DIGIT.test(text[i] ?? '')) i++
  }
  const raw = text.slice(start, i)
  return { token: { type, text: raw, value: Number(raw), column: start + 1 }, end: i }
}

function startsNumber(text: string, i: number, previous: Token | undefined): boolean {
  if (DIGIT.test(text[i])) return true
  if (text[i] !== '-' || !DIGIT.test(text[i + 1] ?? '')) return false
  return (
    previous === undefined ||
    (previous.type === 'op' && previous.text !== ')' && previous.text !== ']')
  )
}

export function tokenize(text: string): Token[] {
  if (text.length > CONDITION_MAX) {
    throw new ConditionSyntaxError(
      `a condition is at most ${CONDITION_MAX} characters`,
      CONDITION_MAX + 1,
    )
  }
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }
    if (ch === "'" || ch === '"') {
      const { value, end } = readString(text, i)
      tokens.push({ type: 'string', text: text.slice(i, end), value, column: i + 1 })
      i = end
      continue
    }
    if (startsNumber(text, i, tokens[tokens.length - 1])) {
      const { token, end } = readNumber(text, i)
      tokens.push(token)
      i = end
      continue
    }
    if (IDENT_START.test(ch)) {
      let end = i + 1
      while (IDENT_PART.test(text[end] ?? '')) end++
      tokens.push({ type: 'ident', text: text.slice(i, end), column: i + 1 })
      i = end
      continue
    }
    const op = OPERATORS.find((candidate) => text.startsWith(candidate, i))
    if (!op) throw new ConditionSyntaxError(`'${ch}' is not part of the condition language`, i + 1)
    tokens.push({ type: 'op', text: op, column: i + 1 })
    i += op.length
  }
  tokens.push({ type: 'eof', text: '', column: text.length + 1 })
  return tokens
}

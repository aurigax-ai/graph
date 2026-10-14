import { RUN_FIELDS } from '../conditions/check'
import { type Problem, isRecord, problem } from './model'

const TEMPLATE = /\{\{(.*?)\}\}/gs
const PATH = /^(state|trigger|run)((?:\.[A-Za-z_][A-Za-z0-9_-]*|\[\d+\])*)$/
const STEP = /\.([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+)\]/g
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])

export type TemplatePath = { root: 'state' | 'trigger' | 'run'; steps: (string | number)[] }

export class MissingValue extends Error {}

export interface TemplateScope {
  state: Record<string, unknown>
  trigger: Record<string, unknown>
  run: Record<string, unknown>
}

function parsePath(inner: string): TemplatePath | null {
  const match = PATH.exec(inner.trim())
  if (!match) return null
  const steps: (string | number)[] = []
  for (const [, field, index] of match[2].matchAll(STEP)) {
    if (field !== undefined && FORBIDDEN.has(field)) return null
    steps.push(field ?? Number(index))
  }
  return { root: match[1] as TemplatePath['root'], steps }
}

export function templatesIn(text: string): { inner: string; path: TemplatePath | null }[] {
  return [...text.matchAll(TEMPLATE)].map((m) => ({ inner: m[1], path: parsePath(m[1]) }))
}

function strings(value: unknown, at: string, visit: (text: string, at: string) => void): void {
  if (typeof value === 'string') visit(value, at)
  else if (Array.isArray(value)) value.forEach((item, i) => strings(item, `${at}[${i}]`, visit))
  else if (isRecord(value))
    for (const [k, v] of Object.entries(value)) strings(v, `${at}.${k}`, visit)
}

export interface TemplateDeclared {
  state: ReadonlySet<string>
  nodes: ReadonlySet<string>
}

function checkPath(
  path: TemplatePath,
  declared: TemplateDeclared,
  node: string,
  at: string,
): Problem | null {
  const [first, second] = path.steps
  if (path.root === 'state') {
    if (typeof first !== 'string')
      return problem('bad-template', `${at}: state is read as state.<key>`, { node, path: at })
    if (!declared.state.has(first)) {
      return problem('unknown-state-key', `${at}: state.${first} is not declared`, {
        node,
        key: first,
        path: at,
      })
    }
  }
  if (path.root === 'run') {
    if (typeof first !== 'string' || !(RUN_FIELDS as readonly string[]).includes(first)) {
      return problem('bad-template', `${at}: run has only ${RUN_FIELDS.join(', ')}`, {
        node,
        path: at,
      })
    }
    if (first === 'visits' && (typeof second !== 'string' || !declared.nodes.has(second))) {
      return problem('bad-template', `${at}: run.visits is read with a node id`, { node, path: at })
    }
  }
  return null
}

export function checkTemplates(
  value: unknown,
  declared: TemplateDeclared,
  node: string,
): Problem[] {
  const found: Problem[] = []
  strings(value, 'with', (text, at) => {
    for (const { inner, path } of templatesIn(text)) {
      const bad = path
        ? checkPath(path, declared, node, at)
        : problem('bad-template', `${at}: {{${inner}}} is not a path such as {{state.key}}`, {
            node,
            path: at,
          })
      if (bad) found.push(bad)
    }
    const stray = text.replace(TEMPLATE, '')
    if (stray.includes('{{')) {
      found.push(problem('bad-template', `${at}: a template is not closed`, { node, path: at }))
    }
  })
  return found
}

function resolve(path: TemplatePath, scope: TemplateScope): unknown {
  let value: unknown = scope[path.root]
  for (const step of path.steps) {
    if (typeof step === 'number' ? !Array.isArray(value) : !isRecord(value))
      throw new MissingValue()
    const holder = value as Record<string | number, unknown>
    if (!Object.hasOwn(holder, step)) throw new MissingValue()
    value = holder[step]
  }
  if (value === undefined || value === null) throw new MissingValue()
  return value
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function renderString(text: string, scope: TemplateScope): unknown {
  const found = templatesIn(text)
  if (found.length === 0) return text
  const whole = /^\{\{(.*?)\}\}$/s.exec(text)
  if (whole && found.length === 1 && found[0].path) return resolve(found[0].path, scope)
  return text.replace(TEMPLATE, (_m, inner: string) => {
    const path = parsePath(inner)
    if (!path) throw new MissingValue()
    return asText(resolve(path, scope))
  })
}

export function render(value: unknown, scope: TemplateScope): unknown {
  if (typeof value === 'string') return renderString(value, scope)
  if (Array.isArray(value)) return value.map((item) => render(item, scope))
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v, scope)]))
  }
  return value
}

export function missingNames(value: unknown, scope: TemplateScope): string[] {
  const names: string[] = []
  strings(value, 'with', (text) => {
    for (const { inner, path } of templatesIn(text)) {
      if (!path) continue
      try {
        resolve(path, scope)
      } catch {
        names.push(inner.trim())
      }
    }
  })
  return names
}

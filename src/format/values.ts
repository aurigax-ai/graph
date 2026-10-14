import { STRING_MAX, type StateKeySpec, type StateType, isRecord } from './model'

export function typeMatches(type: StateType, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'integer':
      return Number.isInteger(value)
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isRecord(value)
  }
}

export function matchesType(spec: StateKeySpec, value: unknown): boolean {
  if (!typeMatches(spec.type, value)) return false
  if (spec.enum && !spec.enum.includes(value as never)) return false
  if (spec.type === 'array' && spec.items) {
    const itemType = spec.items.type
    return (value as unknown[]).every((item) => typeMatches(itemType, item))
  }
  return true
}

export function cutString(spec: StateKeySpec, value: string): string {
  const max = Math.min(spec.max ?? STRING_MAX, STRING_MAX)
  const chars = [...value]
  if (chars.length <= max) return value
  return spec.keep === 'head'
    ? chars.slice(0, max).join('')
    : chars.slice(chars.length - max).join('')
}

export type Written = { ok: true; value: unknown } | { ok: false; error: string }

export function writeValue(spec: StateKeySpec, current: unknown, value: unknown): Written {
  if (spec.merge === 'append') {
    const itemType = spec.items?.type
    const items = Array.isArray(value) && (!itemType || itemType !== 'array') ? value : [value]
    if (itemType && !items.every((item) => typeMatches(itemType, item))) {
      return { ok: false, error: `the value is not an item of type ${itemType}` }
    }
    return { ok: true, value: [...(Array.isArray(current) ? current : []), ...items] }
  }
  const cut = typeof value === 'string' && spec.type === 'string' ? cutString(spec, value) : value
  if (!matchesType(spec, cut))
    return {
      ok: false,
      error: `the value is not of type ${spec.type}${spec.enum ? ` in ${spec.enum.join(', ')}` : ''}`,
    }
  return { ok: true, value: cut }
}

export function readField(output: Record<string, unknown>, field: string): unknown {
  let value: unknown = output
  for (const part of field.split('.')) {
    if (!isRecord(value) || !Object.hasOwn(value, part)) return undefined
    value = value[part]
  }
  return value
}

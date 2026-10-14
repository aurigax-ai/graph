import { RESULT_MAX_BYTES, RESULT_PROPERTIES_MAX, isRecord } from './model.ts'

const SCALARS = new Set(['string', 'integer', 'number', 'boolean'])
const RESULT_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'description',
])
const PROPERTY_KEYS = new Set(['type', 'enum', 'items', 'description'])

function propertyProblem(name: string, raw: unknown): string | null {
  if (!isRecord(raw)) return `result.properties.${name} must be an object`
  const extra = Object.keys(raw).find((k) => !PROPERTY_KEYS.has(k))
  if (extra) return `result.properties.${name}: ${extra} is not allowed`
  if (raw.type === 'array') {
    const items = raw.items
    return isRecord(items) && items.type === 'string' && Object.keys(items).length === 1
      ? null
      : `result.properties.${name}: an array holds strings`
  }
  if (typeof raw.type !== 'string' || !SCALARS.has(raw.type)) {
    return `result.properties.${name}: type is string, integer, number, boolean or an array of strings`
  }
  if (raw.items !== undefined) return `result.properties.${name}: items is only for arrays`
  if (raw.enum !== undefined) {
    const ok =
      raw.type === 'string' &&
      Array.isArray(raw.enum) &&
      raw.enum.length > 0 &&
      raw.enum.every((v) => typeof v === 'string')
    if (!ok) return `result.properties.${name}: enum is a list of strings on a string`
  }
  return null
}

export function checkResultSchema(raw: Record<string, unknown>): string[] {
  if (JSON.stringify(raw).length > RESULT_MAX_BYTES) return ['result is at most 4 KiB']
  const extra = Object.keys(raw).find((k) => !RESULT_KEYS.has(k))
  if (extra) return [`result: ${extra} is not allowed`]
  if (raw.type !== 'object' || !isRecord(raw.properties))
    return ['result is {type: object, properties: {...}}']
  const names = Object.keys(raw.properties)
  if (names.length === 0 || names.length > RESULT_PROPERTIES_MAX) {
    return [`result has 1 to ${RESULT_PROPERTIES_MAX} properties`]
  }
  const found = names
    .map((n) => propertyProblem(n, (raw.properties as Record<string, unknown>)[n]))
    .filter((p): p is string => p !== null)
  const required = raw.required
  if (
    required !== undefined &&
    (!Array.isArray(required) || !required.every((r) => typeof r === 'string' && names.includes(r)))
  ) {
    found.push('result.required names its own properties')
  }
  if (raw.additionalProperties !== undefined && raw.additionalProperties !== false) {
    found.push('result.additionalProperties may only be false')
  }
  return found
}

function valueOfType(type: unknown, v: unknown): boolean {
  switch (type) {
    case 'array':
      return Array.isArray(v) && v.every((x) => typeof x === 'string')
    case 'integer':
      return Number.isInteger(v)
    case 'number':
      return typeof v === 'number' && Number.isFinite(v)
    case 'string':
      return typeof v === 'string'
    case 'boolean':
      return typeof v === 'boolean'
    default:
      return false
  }
}

export function resultErrors(schema: Record<string, unknown>, value: unknown): string[] {
  if (!isRecord(value)) return ['the result is a JSON object']
  const props = schema.properties as Record<string, Record<string, unknown>>
  const errors: string[] = []
  for (const name of (schema.required as string[] | undefined) ?? []) {
    if (!(name in value)) errors.push(`${name} is required`)
  }
  for (const [name, v] of Object.entries(value)) {
    const prop = props[name]
    if (!prop) {
      errors.push(`${name} is not in the schema`)
      continue
    }
    const type = prop.type
    const ok = valueOfType(type, v)
    if (!ok)
      errors.push(`${name} must be ${type === 'array' ? 'an array of strings' : `a ${type}`}`)
    else if (Array.isArray(prop.enum) && !prop.enum.includes(v))
      errors.push(`${name} must be one of ${prop.enum.join(', ')}`)
  }
  return errors
}

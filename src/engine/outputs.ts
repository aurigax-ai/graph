import { type GraphNode, STATE_MAX_BYTES, type StateKeySpec, isRecord } from '../format/model'
import { resultErrors } from '../format/resultSchema'
import { readField, writeValue } from '../format/values'
import type { KindDescriptor, Output } from './contract'
import { NodeError } from './contract'
import type { Write } from './journal'
import { applyWrites } from './runState'

export const THROWN_MESSAGE_MAX = 240

export function checkOutput(kind: KindDescriptor, node: GraphNode, output: Output): void {
  if (output.error !== undefined && Object.keys(output).length === 1) return
  const parsed = kind.outputs.safeParse(output)
  if (!parsed.success) {
    throw new NodeError(
      'BadOutput',
      `${node.kind} returned ${parsed.error.issues[0]?.message ?? 'a bad output'}`,
    )
  }
  if (!kind.takesResult || !node.result) return
  if (output.result === undefined) {
    throw new NodeError('NoResult', `${node.id} ended without a valid report`)
  }
  const errors = resultErrors(node.result, output.result)
  if (errors.length > 0) throw new NodeError('BadResult', errors.join('; '))
}

export function computeWrites(
  node: GraphNode,
  keys: Record<string, StateKeySpec>,
  state: Output,
  output: Output,
): Write[] {
  const writes: Write[] = []
  let current = state
  for (const [field, key] of Object.entries(node.out ?? {})) {
    const value = readField(output, field)
    if (value === undefined || value === null) continue
    const spec = keys[key]
    const written = writeValue(spec, current[key], value)
    if (!written.ok) throw new NodeError('BadOutput', `out.${field} -> ${key}: ${written.error}`)
    const write: Write =
      spec.merge === 'append'
        ? {
            key,
            op: 'append',
            value: (written.value as unknown[]).slice(
              Array.isArray(current[key]) ? (current[key] as unknown[]).length : 0,
            ),
          }
        : { key, op: 'set', value: written.value }
    writes.push(write)
    current = applyWrites(current, [write])
  }
  return writes
}

export function stateTooLarge(state: Output): boolean {
  return Buffer.byteLength(JSON.stringify(state)) > STATE_MAX_BYTES
}

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === 'string') into.push(value)
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into)
  else if (isRecord(value)) for (const item of Object.values(value)) collectStrings(item, into)
}

function replaceStrings(value: unknown, next: () => string): unknown {
  if (typeof value === 'string') return next()
  if (Array.isArray(value)) return value.map((item) => replaceStrings(item, next))
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceStrings(v, next)]))
  return value
}

export async function redactOutput(
  output: Output,
  redact: ((texts: string[]) => Promise<string[] | null>) | undefined,
): Promise<Output> {
  if (!redact) return output
  const texts: string[] = []
  collectStrings(output, texts)
  if (texts.length === 0) return output
  const clean = await redact(texts).catch(() => null)
  if (!clean || clean.length !== texts.length)
    throw new NodeError('RedactionFailed', 'the secret scan failed; nothing was written')
  let i = 0
  return replaceStrings(output, () => clean[i++] as string) as Output
}

export function thrownMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.length > THROWN_MESSAGE_MAX ? text.slice(0, THROWN_MESSAGE_MAX) : text
}

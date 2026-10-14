import {
  type GraphFile,
  type Problem,
  type StateKeySpec,
  isRecord,
  problem,
  triggerKind,
} from '../format/model'
import { matchesType } from '../format/values'
import type { Output } from './contract'

function typed(spec: StateKeySpec, raw: string): unknown {
  switch (spec.type) {
    case 'string':
      return raw
    case 'integer':
      return /^-?\d+$/.test(raw) ? Number(raw) : raw
    case 'number':
      return raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw
    case 'boolean':
      return raw === 'true' ? true : raw === 'false' ? false : raw
    default:
      try {
        return JSON.parse(raw)
      } catch {
        return raw
      }
  }
}

export function manualInputKeys(graph: GraphFile): string[] {
  for (const trigger of graph.on) {
    if (triggerKind(trigger) === 'manual')
      return (trigger as { manual: { input?: string[] } }).manual.input ?? []
  }
  return []
}

export function parseInputs(
  graph: GraphFile,
  pairs: string[],
  json?: string,
): { ok: true; input: Output } | { ok: false; problem: Problem } {
  const input: Output = {}
  if (json !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch {
      return { ok: false, problem: problem('bad-input', '--input-json is not JSON') }
    }
    if (!isRecord(parsed))
      return { ok: false, problem: problem('bad-input', '--input-json is an object') }
    Object.assign(input, parsed)
  }
  for (const pair of pairs) {
    const at = pair.indexOf('=')
    if (at <= 0) return { ok: false, problem: problem('bad-input', `--input ${pair} is key=value`) }
    const key = pair.slice(0, at)
    const spec = graph.state[key]
    if (!spec)
      return {
        ok: false,
        problem: problem('bad-input', `${key} is not a state key of this graph`, { key }),
      }
    input[key] = typed(spec, pair.slice(at + 1))
  }
  for (const [key, value] of Object.entries(input)) {
    const spec = graph.state[key]
    if (!spec)
      return {
        ok: false,
        problem: problem('bad-input', `${key} is not a state key of this graph`, { key }),
      }
    if (!matchesType(spec, value)) {
      return {
        ok: false,
        problem: problem('bad-input', `${key} must be of type ${spec.type}`, { key }),
      }
    }
  }
  for (const key of manualInputKeys(graph)) {
    if (input[key] === undefined && graph.state[key]?.default === undefined) {
      return {
        ok: false,
        problem: problem('missing-input', `--input ${key}=… is required`, { key }),
      }
    }
  }
  return { ok: true, input }
}

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Ceilings, DEFAULT_LIMITS } from '../engine/engine.ts'
import { HOUR_MS } from '../format/duration.ts'
import { isRecord } from '../format/model.ts'
import { RpcError } from './server.ts'

export const CEILINGS_FILE = 'ceilings.json'
export const CEILING_MAX: Ceilings = {
  steps: 500,
  runsPerHour: 60,
  parallel: 8,
  agents: 24,
  timeMs: 168 * HOUR_MS,
}

const NAMES = Object.keys(CEILING_MAX) as (keyof Ceilings)[]

export function ceilingsOf(raw: unknown): Ceilings {
  if (!isRecord(raw)) throw new RpcError('bad-ceilings')
  const out = { ...DEFAULT_LIMITS }
  for (const name of NAMES) {
    const value = raw[name]
    if (value === undefined) continue
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < (name === 'agents' ? 0 : 1)
    )
      throw new RpcError(`bad-ceilings: ${name}`)
    out[name] = Math.min(value, CEILING_MAX[name])
  }
  return out
}

export function loadCeilings(data: string): Ceilings | null {
  try {
    return ceilingsOf(JSON.parse(readFileSync(join(data, CEILINGS_FILE), 'utf8')))
  } catch {
    return null
  }
}

export function saveCeilings(data: string, ceilings: Ceilings): void {
  const path = join(data, CEILINGS_FILE)
  const staged = `${path}.${process.pid}`
  writeFileSync(staged, `${JSON.stringify(ceilings)}\n`, { mode: 0o600 })
  renameSync(staged, path)
}

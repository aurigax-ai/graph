import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const WORKED_GRAPHS = ['review-loop', 'watch-pr', 'daily-report'] as const
export type WorkedGraph = (typeof WORKED_GRAPHS)[number]

export const FIXTURES_DIR = fileURLToPath(new URL('../../fixtures', import.meta.url))

export function workedGraph(name: WorkedGraph): string {
  return readFileSync(join(FIXTURES_DIR, `${name}.yaml`), 'utf8')
}

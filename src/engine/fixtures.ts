import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const WORKED_GRAPHS = ['review-loop', 'watch-pr', 'daily-report'] as const
export type WorkedGraph = (typeof WORKED_GRAPHS)[number]

export const FIXTURES_DIR = join(__dirname, '../../fixtures')

export function workedGraph(name: WorkedGraph): string {
  return readFileSync(join(FIXTURES_DIR, `${name}.yaml`), 'utf8')
}

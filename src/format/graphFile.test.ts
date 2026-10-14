import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { workedGraph } from '../engine/fixtures.ts'
import { readGraphFile } from './graphFile.ts'

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'graph-file-'))
  mkdirSync(join(dir, '.ostia/graphs'), { recursive: true })
  return dir
}

function write(dir: string, name: string, text: string): string {
  const path = join(dir, '.ostia/graphs', name)
  writeFileSync(path, text)
  return path
}

const MINIMAL = `version: 1
on: [{ manual: {} }]
start: a
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: a, kind: router }
edges: []
`

function codes(result: ReturnType<typeof readGraphFile>): string[] {
  return result.ok ? [] : result.problems.map((p) => p.code)
}

describe('reading a graph file', () => {
  it('GRF-C10 a valid review-loop file reads with its name', () => {
    const dir = workspace()
    const path = write(dir, 'review-loop.yaml', workedGraph('review-loop'))
    const result = readGraphFile(path, dir)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.name).toBe('review-loop')
  })

  it('GRF-C11 a symlink, a symlinked .ostia, a large file and a bad name are refused', () => {
    const dir = workspace()
    const real = write(dir, 'real.yaml', MINIMAL)
    symlinkSync(real, join(dir, '.ostia/graphs/link.yaml'))
    expect(codes(readGraphFile(join(dir, '.ostia/graphs/link.yaml'), dir))).toEqual([
      'not-a-regular-file',
    ])

    const other = workspace()
    const linked = mkdtempSync(join(tmpdir(), 'graph-linked-'))
    symlinkSync(join(other, '.ostia'), join(linked, '.ostia'))
    write(other, 'g.yaml', MINIMAL)
    expect(codes(readGraphFile(join(linked, '.ostia/graphs/g.yaml'), linked))).toEqual([
      'not-a-regular-file',
    ])

    const big = write(dir, 'big.yaml', `${MINIMAL}# ${'x'.repeat(65 * 1024)}\n`)
    expect(codes(readGraphFile(big, dir))).toEqual(['too-large'])

    const bad = write(dir, 'Bad_Name.yaml', MINIMAL)
    expect(codes(readGraphFile(bad, dir))).toEqual(['bad-name'])
  })

  it.each([
    ['yaml-alias', MINIMAL.replace('state: {', 'base: &b { x: 1 }\nother: *b\nstate: {')],
    ['yaml-tag', MINIMAL.replace('nodes:', 'description: !!js/function "f"\nnodes:')],
    ['yaml-merge-key', MINIMAL.replace('state: {', 'state: { <<: { m: { type: integer } },')],
    ['yaml-duplicate-key', `${MINIMAL}start: b\n`],
  ])('GRF-C11 YAML that could read two ways is refused with %s', (code, text) => {
    const dir = workspace()
    expect(codes(readGraphFile(write(dir, 'g.yaml', text), dir))).toEqual([code])
  })
})

import { describe, expect, it } from 'vitest'
import { FakeClock } from '../engine/fakeHost.ts'
import { loadGraphText } from '../format/graphFile.ts'
import type { GraphFile } from '../format/model.ts'
import { firedBy, liveTriggers } from './match.ts'
import { PathBatch } from './pathBatch.ts'

function graph(on: string): GraphFile {
  const loaded = loadGraphText(
    `version: 1
on: [${on}]
start: a
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: a, kind: router }
edges: []
`,
    '/w/.ostia/graphs/g.yaml',
  )
  if (!loaded.ok) throw new Error(loaded.problems.map((p) => p.message).join('\n'))
  return loaded.value.graph
}

describe('trigger matching', () => {
  it('a files trigger fires for the paths its glob matches, each once and sorted', () => {
    const g = graph("{ files: { glob: 'src/**/*.ts' } }")
    expect(
      firedBy(g, { kind: 'files', paths: ['src/a/b.ts', 'README.md', 'src/a/b.ts', 'src/.x.ts'] }),
    ).toEqual({ kind: 'files', paths: ['src/.x.ts', 'src/a/b.ts'] })
    expect(firedBy(g, { kind: 'files', paths: ['README.md'] })).toBeNull()
  })

  it('a command trigger fires by exit code', () => {
    const zero = graph('{ command: { exit: zero } }')
    expect(firedBy(zero, { kind: 'command', pane: 'p1', exitCode: 0 })).toEqual({
      kind: 'command',
      pane: 'p1',
      exit: 0,
    })
    expect(firedBy(zero, { kind: 'command', pane: 'p1', exitCode: 2 })).toBeNull()
    expect(firedBy(graph('{ command: {} }'), { kind: 'command', pane: 'p', exitCode: 9 })).toEqual({
      kind: 'command',
      pane: 'p',
      exit: 9,
    })
  })

  it('an agent trigger fires for its state and agent only', () => {
    const g = graph('{ agent: { state: waiting, agent: claude } }')
    expect(firedBy(g, { kind: 'agent', pane: 'p', state: 'waiting', agent: 'claude' })).toEqual({
      kind: 'agent',
      pane: 'p',
      state: 'waiting',
      agent: 'claude',
    })
    expect(firedBy(g, { kind: 'agent', pane: 'p', state: 'stopped', agent: 'claude' })).toBeNull()
    expect(firedBy(g, { kind: 'agent', pane: 'p', state: 'waiting', agent: 'codex' })).toBeNull()
  })

  it('lists the triggers that need a live host', () => {
    expect(liveTriggers(graph('{ manual: {} }'))).toEqual([])
    expect(liveTriggers(graph('{ manual: {} }, { command: {} }'))).toEqual([{ command: {} }])
  })

  it('collects the paths written within a second into one batch', async () => {
    const clock = new FakeClock()
    const batches: string[][] = []
    const batch = new PathBatch(clock, (paths) => batches.push(paths))
    batch.add('src/a/b.ts')
    await clock.advance(400)
    batch.add('src/a/b.ts')
    batch.add('README.md')
    await clock.advance(700)
    batch.add('src/c.ts')
    await clock.advance(1000)
    expect(batches).toEqual([['README.md', 'src/a/b.ts'], ['src/c.ts']])
  })
})

import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadGraphText } from '../format/graphFile.ts'
import { Engine } from './engine.ts'
import { FakeClock, settle, testEnv } from './fakeHost.ts'
import { FileJournalStore, GRAPH_FILE, JOURNAL_FILE, RUNS_KEPT } from './fileStore.ts'
import type { Line } from './journal.ts'

const DAY = 86_400_000

function store(root = mkdtempSync(join(tmpdir(), 'graph-runs-'))) {
  return { root, files: new FileJournalStore(root) }
}

function linesOf(root: string, runId: string): Line[] {
  return readFileSync(join(root, 'w1', 'g', runId, JOURNAL_FILE), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Line)
}

const WAIT = `version: 1
on: [{ manual: {} }]
start: w
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: w, kind: wait, with: { for: 10m } }
  - { id: after, kind: notify, with: { title: waited } }
edges:
  - { from: w, to: after }
`

const AGENT = `version: 1
on: [{ manual: {} }]
start: a
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: p } }
  - { id: b, kind: notify, with: { title: next } }
edges:
  - { from: a, to: b }
`

describe('journal and recovery', () => {
  it('GRF-C61 a wait of 10 minutes ends at its stored deadline after a restart', async () => {
    const { files } = store()
    const clock = new FakeClock(Date.UTC(2026, 9, 14, 12, 0, 0))
    const first = testEnv({ store: files, clock })
    const id = await first.start(WAIT)
    await settle()
    await clock.advance(4 * 60_000)
    const later = testEnv({ store: files, clock: new FakeClock(clock.now()) })
    expect((await later.engine.recover('w1')).resumed).toEqual([id])
    await settle()
    await later.clock.advance(6 * 60_000 - 1)
    expect(later.notices).toEqual([])
    await later.clock.advance(1)
    expect(later.notices.map((n) => n.title)).toEqual(['waited'])
    expect(later.clock.now()).toBe(Date.UTC(2026, 9, 14, 12, 10, 0))
  })

  it('GRF-C67 a finished run’s files are 0600 in a 0700 folder and its lines are whole and ordered', async () => {
    const { root, files } = store()
    const env = testEnv({ store: files })
    const id = await env.start(AGENT)
    await settle()
    await env.stop(env.agents[0].pane)
    const dir = join(root, 'w1', 'g', id)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, GRAPH_FILE)).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, JOURNAL_FILE)).mode & 0o777).toBe(0o600)
    const lines = linesOf(root, id)
    expect(lines.map((l) => l.seq)).toEqual(lines.map((_, i) => i + 1))
    for (const node of ['a', 'b']) {
      const start = lines.findIndex((l) => l.type === 'node-start' && l.node === node)
      const end = lines.findIndex((l) => l.type === 'node-end' && l.node === node)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeGreaterThan(start)
    }
    expect(lines.some((l) => l.type === 'edge' && l.from === 'a' && l.to === 'b')).toBe(true)
    expect(lines.at(-1)?.type).toBe('run-end')
  })

  it('GRF-C68 a torn last line is dropped and the state comes from the last state line and the writes after it', async () => {
    const { root, files } = store()
    const env = testEnv({ store: files })
    const id = await env.start(`version: 1
on: [{ manual: {} }]
start: a
state: { log: { type: string, default: "" } }
nodes:
  - { id: a, kind: command, with: { run: [x] }, out: { stdout: log } }
  - { id: b, kind: agent, with: { mode: start, agent: claude, prompt: p } }
edges:
  - { from: a, to: b }
`)
    env.commandReply = () => ({
      exitCode: 0,
      stdout: 'written',
      stderr: '',
      timedOut: false,
      truncated: false,
    })
    await settle()
    const path = join(root, 'w1', 'g', id, JOURNAL_FILE)
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"v":1,"seq":99,"type":"node-e`)
    env.reattach.set(env.agents[0].pane, 'running')
    const later = testEnv({ store: files, clock: new FakeClock(env.clock.now()) })
    later.reattach.set(env.agents[0].pane, 'running')
    expect((await later.engine.recover('w1')).resumed).toEqual([id])
    await settle()
    const run = later.engine.run(id)
    expect(run?.state.state.log).toBe('written')
    expect(run?.state.active.get('b')?.phase).toBe('waiting')
  })

  it('GRF-C68 after a torn last line the recovered run goes on and every later line is kept', async () => {
    const { root, files } = store()
    const env = testEnv({ store: files })
    const id = await env.start(AGENT)
    await settle()
    const path = join(root, 'w1', 'g', id, JOURNAL_FILE)
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"v":1,"seq":99,"type":"node-e`)
    const later = testEnv({
      store: new FileJournalStore(root),
      clock: new FakeClock(env.clock.now()),
    })
    later.reattach.set(env.agents[0].pane, 'running')
    expect((await later.engine.recover('w1')).resumed).toEqual([id])
    await settle()
    await later.stop(env.agents[0].pane)
    expect(later.engine.run(id)?.state.status).toBe('done')
    const reread = testEnv({ store: new FileJournalStore(root) })
    expect((await reread.engine.summaries('w1')).map((s) => s.status)).toEqual(['done'])
    expect(linesOf(root, id).map((l) => l.seq)).toEqual(linesOf(root, id).map((_, i) => i + 1))
  })

  it('GRF-C69 a run end keeps the newest 50 runs, nothing older than 30 days, and never an active run', async () => {
    const clock = new FakeClock(Date.UTC(2026, 9, 14, 12, 0, 0))
    const files = new FileJournalStore(mkdtempSync(join(tmpdir(), 'graph-runs-')), () =>
      clock.now(),
    )
    const env = testEnv({ store: files, clock })
    const quick = `version: 1
on: [{ manual: {} }]
start: a
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: a, kind: router }
edges: []
`
    const loaded = loadGraphText(quick, '/w/.ostia/graphs/g.yaml')
    if (!loaded.ok) throw new Error('graph')
    const def = { name: 'g', graph: loaded.value.graph, fingerprint: loaded.value.fingerprint }
    const ids: string[] = []
    env.engine.ceilings.runsPerHour = 60
    const elsewhere = testEnv({ store: files, clock: new FakeClock(clock.now()) })
    const active = await elsewhere.start(AGENT)
    await settle()
    for (let i = 0; i < RUNS_KEPT + 1; i++) {
      await clock.advance(i === 0 ? 0 : (2 * DAY) / RUNS_KEPT)
      const res = await env.engine.start('w1', def, {}, {})
      if (res.ok && 'runId' in res) ids.push(res.runId)
      await settle()
      await clock.advance(3_600_000)
    }
    const kept = (await files.list('w1')).map((k) => k.runId)
    expect(kept).toContain(active)
    expect(kept).not.toContain(ids[0])
    expect(kept.filter((k) => k !== active)).toHaveLength(RUNS_KEPT)

    await clock.advance(31 * DAY)
    await env.engine.start('w1', def, {}, {})
    await settle()
    const after = (await files.list('w1')).map((k) => k.runId)
    expect(after).toContain(active)
    expect(after.filter((k) => k !== active)).toHaveLength(1)
  })

  it('GRF-C72 and GRF-C73 a lost once node makes the run interrupted until the human picks Run again, Continue or Skip', async () => {
    const { files } = store()
    const env = testEnv({ store: files })
    const id = await env.start(AGENT)
    await settle()
    const later = testEnv({ store: files, clock: new FakeClock(env.clock.now()) })
    await later.engine.recover('w1')
    await settle()
    const run = later.engine.run(id)
    expect(run?.state.status).toBe('interrupted')
    expect(later.agents).toEqual([])
    expect(await run?.resolve('a', 'continue')).toBe(true)
    await settle()
    expect(later.agents[0].input).toMatchObject({
      mode: 'continue',
      from: 'a',
      prompt: 'You were interrupted. Finish the task and report.',
    })
    await later.stop(later.agents[0].pane)
    expect(later.notices.map((n) => n.title)).toEqual(['next'])

    const skip = testEnv({ store: files })
    const second = await skip.start(AGENT.replace('title: next', 'title: skipped on'))
    await settle()
    const third = testEnv({ store: files, clock: new FakeClock(skip.clock.now()) })
    await third.engine.recover('w1')
    await settle()
    await third.engine.run(second)?.resolve('a', 'skip')
    await settle()
    expect(third.agents).toEqual([])
    expect(third.notices.map((n) => n.title)).toEqual(['skipped on'])
  })

  it('GRF-C177 a journal that cannot be written ends the run journal-failed before the next node, with one notification', async () => {
    const { root, files } = store()
    const env = testEnv({ store: files })
    const id = await env.start(AGENT)
    await settle()
    const dir = join(root, 'w1', 'g', id)
    chmodSync(join(dir, JOURNAL_FILE), 0o400)
    await env.stop(env.agents[0].pane)
    expect(env.engine.run(id)?.state.status).toBe('journal-failed')
    expect(env.notices.map((n) => n.title)).toEqual(['Graph g stopped'])
    chmodSync(join(dir, JOURNAL_FILE), 0o600)
  })

  it('GRF-C181 a journal of another version is listed but not resumed, and an unknown host contract is refused', async () => {
    const { root, files } = store()
    const env = testEnv({ store: files })
    const id = await env.start(AGENT)
    await settle()
    const path = join(root, 'w1', 'g', id, JOURNAL_FILE)
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('"v":1', '"v":2'))
    const later = testEnv({ store: files })
    expect(await later.engine.recover('w1')).toEqual({
      resumed: [],
      refused: [{ runId: id, error: 'journal-version' }],
    })
    expect((await later.engine.summaries('w1')).map((s) => s.status)).toEqual(['journal-version'])
    expect(later.agents).toEqual([])
    expect(() => new Engine({ host: { ...env.host, contract: 2 }, store: files })).toThrow(
      'unsupported-contract',
    )
  })
})

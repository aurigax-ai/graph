import { describe, expect, it } from 'vitest'
import type { GraphDefinition } from '../engine/engine.ts'
import { FakeClock, settle, testEnv } from '../engine/fakeHost.ts'
import { MINUTE_MS } from '../format/duration.ts'
import { loadGraphText } from '../format/graphFile.ts'
import { type ScheduleMemory, TriggerScheduler } from './scheduler.ts'

const TRIGGERS = ['manual', 'schedule']

function graph(on: string): GraphDefinition {
  const text = `version: 1
on: [${on}]
start: a
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: a, kind: router }
edges: []
`
  const loaded = loadGraphText(text, '/w/.ostia/graphs/tick.yaml')
  if (!loaded.ok) throw new Error(loaded.problems.map((p) => p.message).join('\n'))
  return { name: 'tick', graph: loaded.value.graph, fingerprint: loaded.value.fingerprint }
}

function memory(): ScheduleMemory & { marks: Map<string, number> } {
  const marks = new Map<string, number>()
  return { marks, last: (k) => marks.get(k), mark: (k, at) => marks.set(k, at) }
}

function harness(definition: GraphDefinition, clock: FakeClock, mem = memory()) {
  const env = testEnv({ clock, triggers: TRIGGERS })
  const started: unknown[] = []
  const scheduler = new TriggerScheduler({
    clock,
    memory: mem,
    fire: (g, payload) => {
      started.push(payload)
      void env.engine.start('w1', g.definition, payload, {})
    },
    timezone: 'UTC',
  })
  scheduler.set([{ key: 'w1/tick', definition }])
  return { env, started, scheduler, mem }
}

describe('the schedule trigger', () => {
  it('GRF-C47 every 5m over 16 minutes, each run ending at once, starts three runs', async () => {
    const clock = new FakeClock()
    const { env, started } = harness(graph('{ schedule: { every: 5m } }'), clock)
    await clock.advance(16 * MINUTE_MS)
    await settle()
    expect(started).toHaveLength(3)
    expect(await env.store.list('w1')).toHaveLength(3)
    expect(env.engine.active('w1')).toEqual([])
  })

  it('GRF-C78 a time missed three times while closed starts one run with catchUp and none without', async () => {
    for (const [catchUp, runs] of [
      ['true', 1],
      ['false', 0],
    ] as const) {
      const clock = new FakeClock()
      const definition = graph(`{ schedule: { every: 10m, catchUp: ${catchUp} } }`)
      const first = harness(definition, clock)
      first.scheduler.stop()
      await clock.advance(35 * MINUTE_MS)
      const again = harness(definition, clock, first.mem)
      await settle()
      expect(again.started).toHaveLength(runs)
      expect(await again.env.store.list('w1')).toHaveLength(runs)
      if (runs === 1) expect(again.started[0]).toMatchObject({ caughtUp: true })
    }
  })

  it('fires a five-field cron at its next time and keeps firing', async () => {
    const clock = new FakeClock(Date.UTC(2026, 9, 14, 8, 59, 0))
    const { started } = harness(graph("{ schedule: { cron: '0 9 * * *' } }"), clock)
    await clock.advance(2 * MINUTE_MS)
    expect(started).toEqual([{ kind: 'schedule', at: '2026-10-14T09:00:00.000Z' }])
    await clock.advance(24 * 60 * MINUTE_MS)
    expect(started).toHaveLength(2)
  })

  it('stops a changed or removed graph and starts nothing for it', async () => {
    const clock = new FakeClock()
    const { started, scheduler } = harness(graph('{ schedule: { every: 5m } }'), clock)
    scheduler.set([])
    await clock.advance(20 * MINUTE_MS)
    expect(started).toEqual([])
    expect(clock.pending()).toBe(0)
  })
})

import type { Clock, Output } from '../engine/contract.ts'
import type { GraphDefinition } from '../engine/engine.ts'
import { DAY_MS } from '../format/duration.ts'
import { type Schedule, nextScheduled } from './schedule.ts'

export interface ScheduledGraph {
  key: string
  definition: GraphDefinition
}

export interface ScheduleMemory {
  last: (key: string) => number | undefined
  mark: (key: string, at: number) => void
}

export interface SchedulerOptions {
  clock: Clock
  memory: ScheduleMemory
  fire: (graph: ScheduledGraph, payload: Output) => void
  timezone?: string
}

interface Armed {
  fingerprint: string
  cancels: (() => void)[]
}

function schedulesOf(definition: GraphDefinition): Schedule[] {
  return definition.graph.on.flatMap((t) => ('schedule' in t ? [t.schedule] : []))
}

export class TriggerScheduler {
  private readonly armed = new Map<string, Armed>()

  constructor(private readonly opts: SchedulerOptions) {}

  set(graphs: ScheduledGraph[]): void {
    const wanted = new Map(graphs.map((g) => [g.key, g]))
    for (const [key, armed] of this.armed) {
      const next = wanted.get(key)
      if (!next || next.definition.fingerprint !== armed.fingerprint) this.disarm(key)
    }
    for (const graph of graphs) {
      if (this.armed.has(graph.key)) continue
      const schedules = schedulesOf(graph.definition)
      if (schedules.length === 0) continue
      const armed: Armed = { fingerprint: graph.definition.fingerprint, cancels: [] }
      this.armed.set(graph.key, armed)
      schedules.forEach((schedule, i) => this.start(graph, schedule, `${graph.key}#${i}`, armed))
    }
  }

  stop(): void {
    for (const key of [...this.armed.keys()]) this.disarm(key)
  }

  private disarm(key: string): void {
    for (const cancel of this.armed.get(key)?.cancels ?? []) cancel()
    this.armed.delete(key)
  }

  private start(graph: ScheduledGraph, schedule: Schedule, key: string, armed: Armed): void {
    const { clock, memory } = this.opts
    const now = clock.now()
    const last = memory.last(key)
    if (last === undefined) {
      memory.mark(key, now)
      this.arm(graph, schedule, key, armed, now)
      return
    }
    const due = nextScheduled(schedule, last, last, this.opts.timezone)
    if (due !== null && due <= now) {
      memory.mark(key, now)
      if (schedule.catchUp) {
        this.opts.fire(graph, { kind: 'schedule', at: new Date(now).toISOString(), caughtUp: true })
      }
    }
    this.arm(graph, schedule, key, armed, schedule.every !== undefined ? last : now)
  }

  private arm(
    graph: ScheduledGraph,
    schedule: Schedule,
    key: string,
    armed: Armed,
    anchor: number,
  ): void {
    const { clock, memory } = this.opts
    const now = clock.now()
    const next = nextScheduled(schedule, now, anchor, this.opts.timezone)
    if (next === null) return
    const wake = Math.min(next, now + DAY_MS)
    const cancel = clock.setTimer(wake, () => {
      armed.cancels = armed.cancels.filter((c) => c !== cancel)
      if (this.armed.get(graph.key) !== armed) return
      if (wake === next) {
        memory.mark(key, next)
        this.opts.fire(graph, { kind: 'schedule', at: new Date(next).toISOString() })
      }
      this.arm(graph, schedule, key, armed, anchor)
    })
    armed.cancels.push(cancel)
  }
}

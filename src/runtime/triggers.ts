import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Clock, Output } from '../engine/contract.ts'
import { isRecord } from '../format/model.ts'
import { FolderWatcher, type WatchStart } from '../triggers/folderWatch.ts'
import { type TriggerEvent, firedBy } from '../triggers/match.ts'
import { PathBatch } from '../triggers/pathBatch.ts'
import { type ScheduleMemory, TriggerScheduler } from '../triggers/scheduler.ts'
import { writePrivate } from './privateFile.ts'
import type { Listing, Scope } from './registry.ts'

export const SCHEDULES_FILE = 'schedules.json'

export interface EnabledGraph {
  scope: Scope
  listing: Listing
}

export interface TriggerDeps {
  clock: Clock
  data: string
  enabled: () => EnabledGraph[]
  fire: (graph: EnabledGraph, payload: Output) => void
  changed: (scope: Scope) => void
  watcher?: (
    root: string,
    onPath: (rel: string) => void,
    onRefused: () => void,
  ) => { start: () => WatchStart; stop: () => void }
}

interface Watched {
  root: string
  watcher: { start: () => WatchStart; stop: () => void }
  batch: PathBatch
}

function scheduleMemory(path: string): ScheduleMemory {
  let marks: Record<string, number> = {}
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (isRecord(raw))
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'number') marks[k] = v
  } catch {}
  return {
    last: (key) => marks[key],
    mark: (key, at) => {
      marks = { ...marks, [key]: at }
      writePrivate(path, `${JSON.stringify(marks)}\n`)
    },
  }
}

function keyOf(graph: EnabledGraph): string {
  return `${graph.scope.key}/${graph.listing.name}/${graph.listing.loaded?.fingerprint ?? ''}`
}

export class RuntimeTriggers {
  private readonly scheduler: TriggerScheduler
  private readonly watched = new Map<string, Watched>()
  private readonly refused = new Set<string>()
  private readonly panes = new Map<string, Set<string>>()
  private graphs: EnabledGraph[] = []
  private stopped = false

  constructor(private readonly deps: TriggerDeps) {
    this.scheduler = new TriggerScheduler({
      clock: deps.clock,
      memory: scheduleMemory(join(deps.data, SCHEDULES_FILE)),
      fire: (scheduled, payload) => {
        const graph = this.graphs.find((g) => keyOf(g) === scheduled.key)
        if (graph) deps.fire(graph, payload)
      },
    })
  }

  refresh(): void {
    if (this.stopped) return
    this.graphs = this.deps.enabled()
    this.scheduler.set(
      this.graphs.flatMap((g) =>
        g.listing.loaded
          ? [
              {
                key: keyOf(g),
                definition: {
                  name: g.listing.name,
                  graph: g.listing.loaded.graph,
                  fingerprint: g.listing.loaded.fingerprint,
                },
              },
            ]
          : [],
      ),
    )
    const wanted = new Map<string, Scope>()
    for (const g of this.graphs)
      if (g.listing.loaded?.graph.on.some((t) => 'files' in t)) wanted.set(g.scope.key, g.scope)
    for (const [key, watched] of this.watched)
      if (wanted.get(key)?.folder !== watched.root) this.unwatch(key)
    for (const key of [...this.refused]) if (!wanted.has(key)) this.refused.delete(key)
    for (const [key, scope] of wanted)
      if (!this.watched.has(key) && !this.refused.has(key)) this.watch(scope)
  }

  filesRefused(scope: Scope): boolean {
    return this.refused.has(scope.key)
  }

  notePane(scopeKey: string, graph: string, pane: string): void {
    const key = `${scopeKey}/${graph}`
    const known = this.panes.get(key) ?? new Set<string>()
    known.add(pane)
    this.panes.set(key, known)
  }

  ownPane(scopeKey: string, graph: string, pane: string): boolean {
    return this.panes.get(`${scopeKey}/${graph}`)?.has(pane) === true
  }

  push(scope: Scope, event: TriggerEvent): number {
    let fired = 0
    for (const graph of this.graphs) {
      if (graph.scope.key !== scope.key || !graph.listing.loaded) continue
      if ('pane' in event && this.ownPane(scope.key, graph.listing.name, event.pane)) continue
      const payload = firedBy(graph.listing.loaded.graph, event)
      if (!payload) continue
      this.deps.fire(graph, payload)
      fired += 1
    }
    return fired
  }

  stop(): void {
    this.stopped = true
    this.scheduler.stop()
    for (const key of [...this.watched.keys()]) this.unwatch(key)
  }

  private watch(scope: Scope): void {
    const batch = new PathBatch(this.deps.clock, (paths) => {
      this.push(scope, { kind: 'files', paths })
    })
    const make =
      this.deps.watcher ?? ((r, onPath, onRefused) => new FolderWatcher(r, onPath, onRefused))
    const watcher = make(
      scope.folder,
      (rel) => batch.add(rel),
      () => {
        this.unwatch(scope.key)
        this.refused.add(scope.key)
        this.deps.changed(scope)
      },
    )
    const started = watcher.start()
    if (!started.ok) {
      batch.stop()
      this.refused.add(scope.key)
      this.deps.changed(scope)
      return
    }
    this.watched.set(scope.key, { root: scope.folder, watcher, batch })
  }

  private unwatch(key: string): void {
    const watched = this.watched.get(key)
    watched?.watcher.stop()
    watched?.batch.stop()
    this.watched.delete(key)
  }
}

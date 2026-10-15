import type { z } from 'zod'
import type { ErrorName, GraphNode, Problem } from '../format/model.ts'

export type NodeEffect = 'none' | 'local' | 'agent' | 'external' | 'human'
export type NodeSandbox = 'wrapped' | 'same' | 'refuse'
export type Output = Record<string, unknown>

export type NodeWait =
  | { on: 'event'; match: Record<string, unknown> }
  | { on: 'timer'; at: number }
  | { on: 'human'; ask: Record<string, unknown> }

export type NodeResult = { done: Output } | { waiting: NodeWait; started?: Output }

export type Reattached = 'running' | 'lost' | { done: Output }

export class NodeError extends Error {
  constructor(
    readonly errorName: ErrorName,
    message: string,
  ) {
    super(message)
  }
}

export interface RunInfo {
  id: string
  graph: string
  node: string
  visit: number
  attempt: number
  attemptKey: string
}

export interface StartedRecord {
  node: string
  started?: Output
  output?: Output
}

export interface NodeContext {
  run: RunInfo
  host: string
  scope: string
  signal: AbortSignal
  timeoutMs: number | null
  trigger: Output
  started: (nodeId: string) => StartedRecord | null
  node: GraphNode
}

export interface KindCheckContext {
  nodes: ReadonlyMap<string, GraphNode>
}

export interface KindDescriptor {
  kind: string
  version: number
  title: string
  with: z.ZodType
  outputs: z.ZodObject
  effect: NodeEffect
  sandbox: NodeSandbox
  once: boolean
  takesResult: boolean
  opensAgent?: (input: Output) => boolean
  maxPrompt?: number
  timeout?: { defaultMs?: number; maxMs?: number }
  errors: ErrorName[]
  mock: (input: Output) => Output
  check?: (node: GraphNode, ctx: KindCheckContext) => Problem[]
}

export interface NodeKind {
  kind: string
  version: number
  start: (input: Output, ctx: NodeContext) => Promise<NodeResult>
  resume?: (wait: NodeWait, event: Output, ctx: NodeContext) => Promise<NodeResult>
  rearm?: (wait: NodeWait, started: Output | undefined, ctx: NodeContext) => Promise<void>
  reattach?: (
    started: Output | undefined,
    wait: NodeWait | undefined,
    ctx: NodeContext,
  ) => Promise<Reattached>
  cancel?: (
    wait: NodeWait | undefined,
    started: Output | undefined,
    ctx: NodeContext,
  ) => Promise<void>
}

export interface Clock {
  now: () => number
  setTimer: (at: number, fn: () => void) => () => void
}

export interface Notice {
  title: string
  body?: string
  run?: string
  graph?: string
  scope?: string
}

export interface Host {
  name: string
  contract: number
  kinds: NodeKind[]
  triggers: string[]
  clock: Clock
  notify: (notice: Notice) => void
  redact?: (texts: string[]) => Promise<string[] | null>
  random?: () => number
}

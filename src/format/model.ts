export const FORMAT_VERSION = 1
export const JOURNAL_VERSION = 1
export const CONTRACT_VERSION = 1

export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/
export const NODE_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/
export const STATE_KEY_PATTERN = /^[a-z][A-Za-z0-9_]{0,39}$/
export const END = 'end'

export const FILE_MAX_BYTES = 64 * 1024
export const UI_MAX_BYTES = 16 * 1024
export const NODES_MAX = 64
export const EDGES_MAX = 128
export const STATE_KEYS_MAX = 64
export const FAN_MAX = 8
export const TRIGGERS_MAX = 8
export const RETRY_MAX = 4
export const CATCH_MAX = 4
export const WHEN_MAX = 16
export const RESULT_PROPERTIES_MAX = 16
export const RESULT_MAX_BYTES = 4 * 1024
export const STRING_MAX = 64 * 1024
export const STATE_MAX_BYTES = 256 * 1024
export const GRAPHS_LISTED_MAX = 32

export const ERROR_NAMES = [
  'Timeout',
  'ExitCode',
  'NoResult',
  'BadResult',
  'AgentGone',
  'Dismissed',
  'ConnectorFailed',
  'SandboxUnavailable',
  'BadOutput',
  'MissingInput',
  'PromptTooLong',
  'RedactionFailed',
  'ConditionError',
] as const

export type ErrorName = (typeof ERROR_NAMES)[number]
export const ALL_ERRORS = 'All'
export type ErrorMatch = ErrorName | typeof ALL_ERRORS

export const STATE_TYPES = ['string', 'integer', 'number', 'boolean', 'array', 'object'] as const
export type StateType = (typeof STATE_TYPES)[number]

export interface StateKeySpec {
  type: StateType
  default?: unknown
  merge?: 'replace' | 'append'
  enum?: unknown[]
  items?: { type: StateType }
  max?: number
  keep?: 'head' | 'tail'
}

export interface ManualTrigger {
  manual: { agents?: boolean; input?: string[] }
}
export interface ScheduleTrigger {
  schedule: { cron?: string; every?: string; catchUp?: boolean }
}
export interface FilesTrigger {
  files: { glob: string | string[] }
}
export interface CommandTrigger {
  command: { exit?: 'any' | 'zero' | 'nonzero' }
}
export interface AgentTrigger {
  agent: { state: 'stopped' | 'waiting'; agent?: 'claude' | 'codex' }
}
export type Trigger = ManualTrigger | ScheduleTrigger | FilesTrigger | CommandTrigger | AgentTrigger
export const TRIGGER_KINDS = ['manual', 'schedule', 'files', 'command', 'agent'] as const
export type TriggerKind = (typeof TRIGGER_KINDS)[number]

export interface RetryRule {
  errors: ErrorMatch[]
  maxAttempts?: number
  interval?: string
  backoff?: number
  maxDelay?: string
  jitter?: 'full' | 'none'
}

export interface CatchRule {
  errors: ErrorMatch[]
  then: string
}

export const CONTINUE = 'continue'

export interface GraphNode {
  id: string
  kind: string
  title?: string
  with?: Record<string, unknown>
  out?: Record<string, string>
  result?: Record<string, unknown>
  once?: boolean
  timeout?: string
  retry?: RetryRule[]
  catch?: CatchRule[]
}

export interface PlainEdge {
  from: string
  to: string | string[]
}
export interface JoinEdge {
  from: string[]
  to: string
}
export interface ConditionalEdge {
  from: string
  when: { if: string; to: string }[]
  else: string
}
export type Edge = PlainEdge | JoinEdge | ConditionalEdge

export interface GraphLimits {
  steps?: number
  runsPerHour?: number
  parallel?: number
  agents?: number
  time?: string
}

export interface GraphFile {
  version: 1
  description?: string
  on: Trigger[]
  concurrency?: 'skip' | 'queue'
  start: string | string[]
  state: Record<string, StateKeySpec>
  limits?: GraphLimits
  nodes: GraphNode[]
  edges: Edge[]
  ui?: unknown
}

export interface Problem {
  code: string
  message: string
  node?: string
  key?: string
  edge?: number
  column?: number
  path?: string
}

export type Checked<T> = { ok: true; value: T } | { ok: false; problems: Problem[] }

export function problem(
  code: string,
  message: string,
  at: Omit<Problem, 'code' | 'message'> = {},
): Problem {
  return { code, message, ...at }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isConditional(edge: Edge): edge is ConditionalEdge {
  return 'when' in edge
}

export function isJoin(edge: Edge): edge is JoinEdge {
  return Array.isArray(edge.from)
}

export function startNodes(graph: Pick<GraphFile, 'start'>): string[] {
  return Array.isArray(graph.start) ? graph.start : [graph.start]
}

export function triggerKind(trigger: Trigger): TriggerKind {
  return Object.keys(trigger)[0] as TriggerKind
}

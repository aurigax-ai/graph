import type { z } from 'zod'
import type { Clock, Output } from '../engine/contract.ts'

export type OperationEffect = 'read' | 'write'

export interface ConnectionKind {
  kind: string
  title: string
  fields: z.ZodObject
  secrets: string[]
}

export interface ConnectorOperation {
  name: string
  title: string
  effect: OperationEffect | ((input: Output) => OperationEffect)
  input: z.ZodType
  output: z.ZodType
}

export interface ResolvedConnection {
  name: string
  kind: string
  fields: Record<string, unknown>
  secrets: Record<string, string>
}

export interface ConnectorCall {
  operation: string
  input: Output
  connection: ResolvedConnection | null
  signal: AbortSignal
  clock: Clock
}

export interface NativeConnector {
  id: string
  version: number
  title: string
  connections: ConnectionKind[]
  operations: ConnectorOperation[]
  call: (call: ConnectorCall) => Promise<Output>
}

export interface McpReply {
  ok: boolean
  text?: string
  structured?: unknown
  error?: string
}

export type McpCall = (
  server: string,
  tool: string,
  input: Output,
  signal: AbortSignal,
) => Promise<McpReply>

export type ParsedUse =
  | { family: 'mcp'; server: string; tool: string }
  | { family: 'native'; connector: string; operation: string }

export function parseUse(use: string): ParsedUse | null {
  const mcp = /^mcp:([A-Za-z0-9._-]{1,64})\/([A-Za-z0-9._-]{1,64})$/.exec(use)
  if (mcp) return { family: 'mcp', server: mcp[1] as string, tool: mcp[2] as string }
  const native = /^([a-z][a-z0-9-]{0,39})\.([A-Za-z][A-Za-z0-9_]{0,39})$/.exec(use)
  if (native)
    return { family: 'native', connector: native[1] as string, operation: native[2] as string }
  return null
}

export function operationEffect(op: ConnectorOperation, input: Output): OperationEffect {
  return typeof op.effect === 'function' ? op.effect(input) : op.effect
}

export class ConnectorError extends Error {}

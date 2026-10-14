import { NodeError, type NodeKind, type Output } from '../engine/contract.ts'
import type { Clock } from '../engine/contract.ts'
import {
  ConnectorError,
  type McpCall,
  type NativeConnector,
  type ResolvedConnection,
  parseUse,
} from './contract.ts'

export interface ConnectorHost {
  clock: Clock
  mcpCall?: McpCall
  native: readonly NativeConnector[]
  connection: (name: string) => Promise<ResolvedConnection | null>
}

function failed(message: string): never {
  throw new NodeError('ConnectorFailed', message)
}

function issues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((i) => `${i.path.map(String).join('.') || 'input'}: ${i.message}`)
    .join('; ')
}

async function callMcp(
  host: ConnectorHost,
  server: string,
  tool: string,
  input: Output,
  signal: AbortSignal,
): Promise<Output> {
  if (!host.mcpCall) failed(`this host runs no MCP servers (mcp:${server}/${tool})`)
  const reply = await host.mcpCall(server, tool, input, signal)
  if (!reply.ok) failed(reply.error ?? `mcp:${server}/${tool} failed`)
  return {
    ok: true,
    data: {
      text: reply.text ?? '',
      ...(reply.structured !== undefined ? { structured: reply.structured } : {}),
    },
  }
}

async function callNative(
  host: ConnectorHost,
  id: string,
  operation: string,
  connectionName: string | undefined,
  input: Output,
  signal: AbortSignal,
): Promise<Output> {
  const connector = host.native.find((c) => c.id === id)
  if (!connector) failed(`unknown-connector: ${id}`)
  const op = connector.operations.find((o) => o.name === operation)
  if (!op) failed(`unknown-operation: ${id}.${operation}`)
  const parsed = op.input.safeParse(input)
  if (!parsed.success) failed(`bad-input: ${issues(parsed.error)}`)
  let connection: ResolvedConnection | null = null
  if (connector.connections.length > 0) {
    if (!connectionName) failed(`${id}.${operation} needs a connection`)
    connection = await host.connection(connectionName)
    if (!connection) failed(`unknown-connection: ${connectionName}`)
    if (!connector.connections.some((k) => k.kind === connection?.kind)) {
      failed(`connection ${connectionName} is not a ${id} connection`)
    }
  }
  const out = await connector
    .call({ operation, input: parsed.data as Output, connection, signal, clock: host.clock })
    .catch((err: unknown) =>
      failed(err instanceof ConnectorError ? err.message : `${id}.${operation} failed`),
    )
  const checked = op.output.safeParse(out.data)
  if (!checked.success) failed(`${id}.${operation} returned bad data: ${issues(checked.error)}`)
  return { ok: out.ok !== false, data: checked.data }
}

export function connectorNode(host: ConnectorHost): NodeKind {
  return {
    kind: 'connector',
    version: 1,
    start: async (input, ctx) => {
      const use = String(input.use ?? '')
      const parsed = parseUse(use)
      if (!parsed) failed(`bad use: ${use}`)
      const args = (input.input ?? {}) as Output
      const done =
        parsed.family === 'mcp'
          ? await callMcp(host, parsed.server, parsed.tool, args, ctx.signal)
          : await callNative(
              host,
              parsed.connector,
              parsed.operation,
              typeof input.connection === 'string' ? input.connection : undefined,
              args,
              ctx.signal,
            )
      return { done }
    },
  }
}

import { z } from 'zod'
import type { Output } from '../engine/contract.ts'
import { type GraphFile, type Problem, problem } from '../format/model.ts'
import {
  type NativeConnector,
  type OperationEffect,
  operationEffect,
  parseUse,
} from './contract.ts'

export interface ConnectorHostInfo {
  mcp: boolean
  native: readonly NativeConnector[]
  connections: readonly { name: string; kind: string }[]
}

export interface ConnectorUse {
  node: string
  use: string
  family: 'mcp' | 'native'
  connection?: string
  effect: OperationEffect | 'external'
}

function hasTemplate(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('{{')
  if (Array.isArray(value)) return value.some(hasTemplate)
  if (value && typeof value === 'object') return Object.values(value).some(hasTemplate)
  return false
}

export function connectorUses(
  graph: GraphFile,
  host: Pick<ConnectorHostInfo, 'native'>,
): ConnectorUse[] {
  return graph.nodes.flatMap((node): ConnectorUse[] => {
    if (node.kind !== 'connector') return []
    const use = String(node.with?.use ?? '')
    const parsed = parseUse(use)
    if (!parsed) return []
    const connection = typeof node.with?.connection === 'string' ? node.with.connection : undefined
    if (parsed.family === 'mcp') return [{ node: node.id, use, family: 'mcp', effect: 'external' }]
    const op = host.native
      .find((c) => c.id === parsed.connector)
      ?.operations.find((o) => o.name === parsed.operation)
    const input = (node.with?.input ?? {}) as Output
    return [
      {
        node: node.id,
        use,
        family: 'native' as const,
        ...(connection ? { connection } : {}),
        effect: op ? operationEffect(op, input) : ('external' as const),
      },
    ]
  })
}

export function connectorProblems(graph: GraphFile, host: ConnectorHostInfo): Problem[] {
  const problems: Problem[] = []
  for (const node of graph.nodes) {
    if (node.kind !== 'connector') continue
    const use = String(node.with?.use ?? '')
    const parsed = parseUse(use)
    if (!parsed) continue
    const connection = typeof node.with?.connection === 'string' ? node.with.connection : undefined
    if (parsed.family === 'mcp') {
      if (!host.mcp)
        problems.push(
          problem('unsupported-connector', `this host runs no MCP servers (${use})`, {
            node: node.id,
          }),
        )
      continue
    }
    const connector = host.native.find((c) => c.id === parsed.connector)
    if (!connector) {
      problems.push(
        problem('unknown-connector', `unknown-connector: ${parsed.connector}`, { node: node.id }),
      )
      continue
    }
    const op = connector.operations.find((o) => o.name === parsed.operation)
    if (!op) {
      problems.push(problem('unknown-operation', `unknown-operation: ${use}`, { node: node.id }))
      continue
    }
    const input = (node.with?.input ?? {}) as Output
    if (!hasTemplate(input)) {
      const checked = op.input.safeParse(input)
      if (!checked.success) {
        const first = checked.error.issues[0]
        problems.push(
          problem(
            'bad-with',
            `bad-with: input.${first?.path.map(String).join('.') ?? ''} ${first?.message ?? ''}`.trim(),
            { node: node.id },
          ),
        )
      }
    }
    if (connector.connections.length === 0) continue
    if (!connection) {
      problems.push(problem('no-connection', `${use} needs a connection`, { node: node.id }))
      continue
    }
    const made = host.connections.find((c) => c.name === connection)
    if (!made) {
      problems.push(
        problem('unknown-connection', `unknown-connection: ${connection}`, { node: node.id }),
      )
    } else if (!connector.connections.some((k) => k.kind === made.kind)) {
      problems.push(
        problem(
          'unknown-connection',
          `connection ${connection} is not a ${connector.id} connection`,
          { node: node.id },
        ),
      )
    }
  }
  return problems
}

export interface ConnectorCatalogEntry {
  id: string
  title: string
  connectionKinds: { kind: string; title: string; fields: Record<string, unknown> }[]
  operations: {
    name: string
    title: string
    effect: OperationEffect | 'by-input'
    input: Record<string, unknown>
  }[]
}

export function connectorCatalog(native: readonly NativeConnector[]): ConnectorCatalogEntry[] {
  return native.map((c) => ({
    id: c.id,
    title: c.title,
    connectionKinds: c.connections.map((k) => ({
      kind: k.kind,
      title: k.title,
      fields: z.toJSONSchema(k.fields, { unrepresentable: 'any' }) as Record<string, unknown>,
    })),
    operations: c.operations.map((o) => ({
      name: o.name,
      title: o.title,
      effect: typeof o.effect === 'function' ? 'by-input' : o.effect,
      input: z.toJSONSchema(o.input, { unrepresentable: 'any', io: 'input' }) as Record<
        string,
        unknown
      >,
    })),
  }))
}

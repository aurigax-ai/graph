import { formatDuration, parseDuration } from '../format/duration'
import {
  END,
  type GraphFile,
  type GraphNode,
  isConditional,
  isJoin,
  startNodes,
  triggerKind,
} from '../format/model'
import { descriptorOf } from '../kinds/catalog'
import { DEFAULT_LIMITS } from './engine'

function triggerLine(trigger: GraphFile['on'][number]): string {
  const kind = triggerKind(trigger)
  const body = (trigger as unknown as Record<string, Record<string, unknown>>)[kind] ?? {}
  if (kind === 'manual') {
    const parts = [body.agents === true ? 'agents may start this' : 'only the human starts it']
    const input = Array.isArray(body.input) ? body.input : []
    if (input.length > 0) parts.push(`input: ${input.join(', ')}`)
    return `manual (${parts.join('; ')})`
  }
  return `${kind} ${JSON.stringify(body)}`
}

function nodeDetail(node: GraphNode): string {
  const w = node.with ?? {}
  switch (node.kind) {
    case 'agent':
      return w.mode === 'start'
        ? `start ${String(w.agent)}`
        : w.mode === 'continue'
          ? `continue the session of ${String(w.from)}`
          : `message ${String(w.to)}`
    case 'command':
      return `runs ${JSON.stringify(w.run)}${w.exitIsError === true ? ', a non-zero exit is an error' : ''}`
    case 'approval':
      return `asks "${String(w.question)}"`
    case 'wait':
      return w.for !== undefined ? `waits ${String(w.for)}` : `waits until ${String(w.until)}`
    case 'notify':
      return `notifies "${String(w.title)}"`
    case 'connector':
      return `calls ${String(w.use)}`
    default:
      return ''
  }
}

function nodeLine(node: GraphNode): string {
  const descriptor = descriptorOf(node.kind)
  const effect = descriptor?.effect ?? 'unknown'
  const extras: string[] = []
  const detail = nodeDetail(node)
  if (detail) extras.push(detail)
  if (node.result)
    extras.push(`result: ${Object.keys((node.result.properties as object) ?? {}).join(', ')}`)
  if (node.timeout) extras.push(`timeout ${node.timeout}`)
  if (node.once ?? descriptor?.once) extras.push('once')
  if (node.retry) extras.push(`retry on ${node.retry.map((r) => r.errors.join('/')).join(', ')}`)
  if (node.catch)
    extras.push(`catch ${node.catch.map((c) => `${c.errors.join('/')} -> ${c.then}`).join(', ')}`)
  return `  ${node.id}  ${node.kind} (${effect})${extras.length > 0 ? `  ${extras.join('; ')}` : ''}`
}

function edgeLines(graph: GraphFile): string[] {
  const lines: string[] = []
  for (const edge of graph.edges) {
    if (isJoin(edge)) lines.push(`  [${edge.from.join(', ')}] -> ${edge.to}  (join)`)
    else if (isConditional(edge)) {
      for (const branch of edge.when)
        lines.push(`  ${edge.from} -> ${branch.to}  when ${branch.if}`)
      lines.push(`  ${edge.from} -> ${edge.else}  otherwise`)
    } else if (Array.isArray(edge.to))
      lines.push(`  ${edge.from} -> [${edge.to.join(', ')}]  (fan-out)`)
    else lines.push(`  ${edge.from} -> ${edge.to === END ? 'end' : edge.to}`)
  }
  return lines
}

export function neededKinds(graph: GraphFile): string[] {
  return [...new Set(graph.nodes.map((n) => n.kind))]
}

export function neededConnectors(graph: GraphFile): string[] {
  return [
    ...new Set(
      graph.nodes.filter((n) => n.kind === 'connector').map((n) => String(n.with?.use ?? '')),
    ),
  ]
}

export function explain(name: string, graph: GraphFile): string {
  const limits = graph.limits ?? {}
  const time = parseDuration(limits.time) ?? DEFAULT_LIMITS.timeMs
  const connectors = neededConnectors(graph)
  return [
    `graph ${name}${graph.description ? `: ${graph.description}` : ''}`,
    'triggers:',
    ...graph.on.map((t) => `  ${triggerLine(t)}`),
    `start: ${startNodes(graph).join(', ')}${startNodes(graph).length > 1 ? ' (fan-out)' : ''}`,
    'nodes:',
    ...graph.nodes.map(nodeLine),
    'edges:',
    ...edgeLines(graph),
    `kinds needed: ${neededKinds(graph).join(', ')}`,
    `connectors needed: ${connectors.length > 0 ? connectors.join(', ') : 'none'}`,
    `limits: steps ${limits.steps ?? DEFAULT_LIMITS.steps}, agents ${limits.agents ?? DEFAULT_LIMITS.agents}, parallel ${limits.parallel ?? DEFAULT_LIMITS.parallel}, runs an hour ${limits.runsPerHour ?? DEFAULT_LIMITS.runsPerHour}, time ${formatDuration(time)}`,
    'runs only while its host runs',
  ].join('\n')
}

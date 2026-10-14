import type { z } from 'zod'
import { checkCondition } from '../conditions/check'
import { parseCondition } from '../conditions/parser'
import type { KindDescriptor } from '../engine/contract'
import { parseDuration } from './duration'
import { arcs, cycles, parallelRegions, reachable, sourcesOf, targetsOf } from './graphShape'
import {
  ALL_ERRORS,
  CONTINUE,
  END,
  type Edge,
  FORMAT_VERSION,
  type GraphFile,
  type GraphNode,
  NODE_ID_PATTERN,
  type Problem,
  STATE_KEYS_MAX,
  STATE_KEY_PATTERN,
  type StateKeySpec,
  UI_MAX_BYTES,
  isConditional,
  isJoin,
  isRecord,
  problem,
  startNodes,
} from './model'
import { checkResultSchema } from './resultSchema'
import {
  EDGE_SCHEMAS,
  LIMIT_CEILINGS,
  TRIGGER_SCHEMAS,
  catchSchema,
  limitsSchema,
  nodeBaseSchema,
  retrySchema,
  stateKeySchema,
  topSchema,
} from './schema'
import { checkTemplates } from './templates'
import { matchesType } from './values'

type Issues = z.core.$ZodIssue[]

function pathText(path: PropertyKey[]): string {
  return path
    .map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`))
    .join('')
    .replace(/^\./, '')
}

function fromIssues(
  issues: Issues,
  code: string,
  prefix: string,
  at: Omit<Problem, 'code' | 'message'> = {},
): Problem[] {
  return issues.map((issue) => {
    if (issue.code === 'unrecognized_keys') {
      const keys = issue.keys.join(', ')
      const where = pathText([...(prefix ? [prefix] : []), ...issue.path])
      return problem('unknown-key', `unknown key ${keys}${where ? ` in ${where}` : ''}`, {
        ...at,
        key: issue.keys[0],
      })
    }
    const where = pathText([...(prefix ? [prefix] : []), ...issue.path])
    return problem(code, `${where || 'graph'}: ${issue.message}`, { ...at, path: where })
  })
}

function stringEdgeHint(text: string): string {
  const match = /^\s*([a-z][a-z0-9-]*)\s*->\s*([a-z][a-z0-9-]*)(?:\s+when\s+(.+))?$/.exec(text)
  if (!match) return 'write an edge as fields, such as {from: a, to: b}'
  const [, from, to, condition] = match
  return condition
    ? `write it as {from: ${from}, when: [{if: "${condition.trim()}", to: ${to}}], else: …}`
    : `write it as {from: ${from}, to: ${to}}`
}

function parseEdge(raw: unknown, index: number): { edge?: Edge; problems: Problem[] } {
  if (typeof raw === 'string') {
    return {
      problems: [
        problem('string-edge', `edges[${index}] is a string; ${stringEdgeHint(raw)}`, {
          edge: index,
        }),
      ],
    }
  }
  const schema =
    isRecord(raw) && 'when' in raw
      ? EDGE_SCHEMAS.conditional
      : isRecord(raw) && Array.isArray(raw.from)
        ? EDGE_SCHEMAS.join
        : EDGE_SCHEMAS.plain
  const parsed = schema.safeParse(raw)
  if (parsed.success) return { edge: parsed.data as Edge, problems: [] }
  if (isRecord(raw) && 'when' in raw && !('else' in raw)) {
    return {
      problems: [
        problem('bad-edge', `edges[${index}]: a conditional edge needs else`, { edge: index }),
      ],
    }
  }
  return {
    problems: fromIssues(parsed.error.issues, 'bad-edge', `edges[${index}]`, { edge: index }),
  }
}

function checkState(state: Record<string, unknown>): {
  keys: Record<string, StateKeySpec>
  problems: Problem[]
} {
  const problems: Problem[] = []
  const keys: Record<string, StateKeySpec> = {}
  const entries = Object.entries(state)
  if (entries.length === 0 || entries.length > STATE_KEYS_MAX) {
    problems.push(problem('over-limit', `state declares 1 to ${STATE_KEYS_MAX} keys`))
  }
  for (const [name, raw] of entries) {
    if (!STATE_KEY_PATTERN.test(name)) {
      problems.push(
        problem('bad-id', `state key ${name} must match ${STATE_KEY_PATTERN}`, { key: name }),
      )
      continue
    }
    const parsed = stateKeySchema.safeParse(raw)
    if (!parsed.success) {
      problems.push(...fromIssues(parsed.error.issues, 'bad-state', `state.${name}`, { key: name }))
      continue
    }
    const spec = parsed.data as StateKeySpec
    keys[name] = spec
    if (spec.merge === 'append' && spec.type !== 'array') {
      problems.push(
        problem('append-needs-array', `state.${name}: merge: append needs type: array`, {
          key: name,
        }),
      )
    }
    if (spec.default !== undefined && !matchesType(spec, spec.default)) {
      problems.push(
        problem('bad-default', `state.${name}: default is not of type ${spec.type}`, { key: name }),
      )
    }
  }
  return { keys, problems }
}

function checkTriggers(on: unknown[], keys: Record<string, StateKeySpec>): Problem[] {
  const problems: Problem[] = []
  on.forEach((raw, i) => {
    const names = isRecord(raw) ? Object.keys(raw) : []
    const name = names[0]
    if (names.length !== 1 || !(name in TRIGGER_SCHEMAS)) {
      problems.push(
        problem(
          'unsupported-trigger',
          `on[${i}]: ${name ?? 'a trigger'} is not a trigger this host runs`,
          { path: `on[${i}]` },
        ),
      )
      return
    }
    const schema = TRIGGER_SCHEMAS[name as keyof typeof TRIGGER_SCHEMAS]
    const parsed = schema.safeParse((raw as Record<string, unknown>)[name] ?? {})
    if (!parsed.success) {
      problems.push(...fromIssues(parsed.error.issues, 'bad-with', `on[${i}].${name}`))
      return
    }
    if (name === 'manual') {
      for (const key of (parsed.data as { input?: string[] }).input ?? []) {
        if (!(key in keys))
          problems.push(
            problem('unknown-state-key', `on[${i}].manual.input: ${key} is not declared`, { key }),
          )
      }
    }
  })
  return problems
}

function checkErrorLists(node: GraphNode): Problem[] {
  const problems: Problem[] = []
  for (const [field, rules] of [
    ['retry', node.retry ?? []],
    ['catch', node.catch ?? []],
  ] as const) {
    rules.forEach((rule, i) => {
      if (rule.errors.includes(ALL_ERRORS) && (i !== rules.length - 1 || rule.errors.length > 1)) {
        problems.push(
          problem('all-not-last', `${field}[${i}]: All may only be named alone in the last entry`, {
            node: node.id,
          }),
        )
      }
    })
  }
  return problems
}

function rawErrorNames(raw: Record<string, unknown>, id: string): Problem[] {
  const problems: Problem[] = []
  for (const field of ['retry', 'catch']) {
    const list = raw[field]
    if (!Array.isArray(list)) continue
    const schema = field === 'retry' ? retrySchema : catchSchema
    list.forEach((rule, i) => {
      const parsed = schema.safeParse(rule)
      if (parsed.success) return
      for (const issue of parsed.error.issues) {
        const isName = issue.path[0] === 'errors' && issue.path.length === 2
        problems.push(
          isName
            ? problem(
                'bad-error-name',
                `${field}[${i}]: unknown error name; use one of the error names or All`,
                { node: id },
              )
            : (fromIssues([issue], 'bad-node', `${field}[${i}]`, { node: id })[0] as Problem),
        )
      }
    })
  }
  return problems
}

interface NodeCheck {
  nodes: GraphNode[]
  problems: Problem[]
}

function checkNodes(rawNodes: unknown[], kinds: readonly KindDescriptor[]): NodeCheck {
  const problems: Problem[] = []
  const nodes: GraphNode[] = []
  const seen = new Set<string>()
  rawNodes.forEach((raw, i) => {
    const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id : `nodes[${i}]`
    if (!isRecord(raw)) {
      problems.push(problem('bad-node', `nodes[${i}] must be an object`))
      return
    }
    if (typeof raw.id !== 'string' || !NODE_ID_PATTERN.test(raw.id) || raw.id === END) {
      problems.push(
        problem('bad-id', `nodes[${i}].id must match ${NODE_ID_PATTERN} and not be end`, {
          node: id,
        }),
      )
    } else if (seen.has(raw.id)) {
      problems.push(problem('duplicate-id', `two nodes have the id ${raw.id}`, { node: id }))
    }
    if (typeof raw.id === 'string') seen.add(raw.id)
    const errorNames = rawErrorNames(raw, id)
    const parsed = nodeBaseSchema.safeParse(raw)
    if (!parsed.success) {
      const rest = parsed.error.issues.filter(
        (issue) => issue.path[0] !== 'retry' && issue.path[0] !== 'catch' && issue.path[0] !== 'id',
      )
      problems.push(...errorNames, ...fromIssues(rest, 'bad-node', `nodes[${i}]`, { node: id }))
      return
    }
    const node = parsed.data as GraphNode
    const kind = kinds.find((k) => k.kind === node.kind)
    if (!kind) {
      problems.push(
        problem(
          'unknown-kind',
          `${node.kind} is not a node kind; known kinds: ${kinds.map((k) => k.kind).join(', ')}`,
          { node: id },
        ),
      )
      return
    }
    const withParsed = kind.with.safeParse(node.with)
    if (!withParsed.success)
      problems.push(...fromIssues(withParsed.error.issues, 'bad-with', 'with', { node: id }))
    if (node.result !== undefined) {
      if (!kind.takesResult)
        problems.push(problem('bad-result', `${node.kind} nodes have no result`, { node: id }))
      else
        problems.push(
          ...checkResultSchema(node.result).map((message) =>
            problem('bad-result', message, { node: id }),
          ),
        )
    }
    if (node.timeout !== undefined) {
      const ms = parseDuration(node.timeout) ?? 0
      if (!kind.timeout?.maxMs || ms > kind.timeout.maxMs) {
        problems.push(
          problem(
            kind.timeout?.maxMs ? 'over-limit' : 'bad-node',
            `timeout is past what ${node.kind} allows`,
            { node: id },
          ),
        )
      }
    }
    problems.push(...checkErrorLists(node))
    nodes.push(node)
  })
  return { nodes, problems }
}

function outputFieldOk(node: GraphNode, kind: KindDescriptor, field: string): boolean {
  const [top, sub] = field.split('.')
  if (top === 'error') return true
  if (!(top in kind.outputs.shape)) return false
  if (top !== 'result') return true
  if (!node.result) return false
  const props = node.result.properties
  return sub === undefined || (isRecord(props) && sub in props)
}

function checkOuts(
  nodes: GraphNode[],
  keys: Record<string, StateKeySpec>,
  kinds: readonly KindDescriptor[],
): Problem[] {
  const problems: Problem[] = []
  for (const node of nodes) {
    const kind = kinds.find((k) => k.kind === node.kind) as KindDescriptor
    for (const [field, key] of Object.entries(node.out ?? {})) {
      if (!(key in keys))
        problems.push(
          problem('unknown-state-key', `out.${field}: ${key} is not declared under state`, {
            node: node.id,
            key,
          }),
        )
      if (!outputFieldOk(node, kind, field))
        problems.push(
          problem('bad-out', `out.${field}: ${node.kind} has no output ${field}`, {
            node: node.id,
          }),
        )
    }
  }
  return problems
}

function checkEdges(graph: GraphFile, ids: Set<string>): Problem[] {
  const problems: Problem[] = []
  const known = (id: string): boolean => ids.has(id)
  const outgoing = new Map<string, number>()
  graph.edges.forEach((edge, i) => {
    for (const from of sourcesOf(edge)) {
      if (!known(from))
        problems.push(
          problem('unknown-node', `edges[${i}]: ${from} is not a node`, { edge: i, node: from }),
        )
      if (Array.isArray(edge.from)) continue
      if (outgoing.has(from))
        problems.push(
          problem(
            'second-edge',
            `${from} leaves by two edges (edges[${outgoing.get(from)}] and edges[${i}])`,
            { edge: i, node: from },
          ),
        )
      outgoing.set(from, i)
    }
    for (const to of targetsOf(edge)) {
      if (to !== END && !known(to))
        problems.push(
          problem('unknown-node', `edges[${i}]: ${to} is not a node`, { edge: i, node: to }),
        )
    }
    if (isJoin(edge) && edge.to === END)
      problems.push(problem('bad-edge', `edges[${i}]: a join leads to a node`, { edge: i }))
  })
  for (const node of graph.nodes) {
    for (const rule of node.catch ?? []) {
      if (rule.then !== CONTINUE && rule.then !== END && !known(rule.then)) {
        problems.push(
          problem('unknown-node', `catch: ${rule.then} is not a node`, { node: node.id }),
        )
      }
    }
  }
  return problems
}

function checkConditions(
  graph: GraphFile,
  keys: Record<string, StateKeySpec>,
  ids: Set<string>,
): Problem[] {
  const problems: Problem[] = []
  const declared = { state: new Set(Object.keys(keys)), nodes: ids }
  graph.edges.forEach((edge, i) => {
    if (!isConditional(edge)) return
    for (const branch of edge.when) {
      const parsed = parseCondition(branch.if)
      const found = parsed.ok ? checkCondition(parsed.expr, declared) : parsed.problem
      if (found)
        problems.push({
          ...found,
          edge: i,
          node: edge.from,
          message: `edges[${i}] "${branch.if}": ${found.message}`,
        })
    }
  })
  return problems
}

function checkShape(
  graph: GraphFile,
  ids: Set<string>,
  keys: Record<string, StateKeySpec>,
): Problem[] {
  const problems: Problem[] = []
  const graphArcs = arcs(graph)
  const starts = startNodes(graph)
  for (const s of starts)
    if (!ids.has(s))
      problems.push(problem('unknown-node', `start: ${s} is not a node`, { node: s }))
  const seen = reachable(
    starts.filter((s) => ids.has(s)),
    graphArcs,
  )
  for (const id of ids)
    if (!seen.has(id))
      problems.push(problem('unreachable', `${id} cannot be reached from start`, { node: id }))
  const unconditional = (id: string): string[] =>
    (graphArcs.get(id) ?? []).filter((a) => !a.conditional).map((a) => a.to)
  for (const group of cycles([...ids], unconditional)) {
    problems.push(
      problem('unconditional-cycle', `the cycle ${group.join(' -> ')} passes no conditional edge`, {
        node: group[0],
      }),
    )
  }
  for (const region of parallelRegions(graph)) {
    const next = (id: string): string[] =>
      (graphArcs.get(id) ?? []).map((a) => a.to).filter((to) => region.members.has(to))
    const looped =
      (region.source !== null && region.members.has(region.source)) ||
      cycles([...region.members], next).length > 0
    if (looped) {
      problems.push(
        problem(
          'cyclic-parallel-region',
          `a cycle leaves and re-enters the parallel region after ${region.source ?? 'start'}`,
          { node: region.source ?? starts[0] },
        ),
      )
    }
    const writers = new Map<string, Map<string, number>>()
    region.branches.forEach((branch, b) => {
      for (const id of branch) {
        const node = graph.nodes.find((n) => n.id === id)
        for (const key of Object.values(node?.out ?? {})) {
          if (keys[key]?.merge === 'append') continue
          const byNode = writers.get(key) ?? new Map<string, number>()
          if (!byNode.has(id)) byNode.set(id, b)
          writers.set(key, byNode)
        }
      }
    })
    for (const [key, byNode] of writers) {
      const branches = new Set(byNode.values())
      if (branches.size > 1) {
        const names = [...byNode.keys()]
        problems.push(
          problem(
            'merge-conflict',
            `${names.join(' and ')} both write the replace key ${key} in one parallel region`,
            { node: names[0], key },
          ),
        )
      }
    }
  }
  return problems
}

function checkLimits(raw: unknown): Problem[] {
  if (raw === undefined) return []
  const parsed = limitsSchema.safeParse(raw)
  if (!parsed.success) return fromIssues(parsed.error.issues, 'bad-limits', 'limits')
  const problems: Problem[] = []
  const limits = parsed.data
  for (const key of ['steps', 'runsPerHour', 'parallel', 'agents'] as const) {
    const value = limits[key]
    if (value !== undefined && value > LIMIT_CEILINGS[key]) {
      problems.push(
        problem('over-limit', `limits.${key} is at most ${LIMIT_CEILINGS[key]}`, {
          path: `limits.${key}`,
        }),
      )
    }
  }
  if (limits.time !== undefined && (parseDuration(limits.time) ?? 0) > LIMIT_CEILINGS.timeMs) {
    problems.push(problem('over-limit', 'limits.time is at most 168h', { path: 'limits.time' }))
  }
  return problems
}

export function validateGraph(
  raw: unknown,
  kinds: readonly KindDescriptor[],
): { graph?: GraphFile; problems: Problem[] } {
  if (!isRecord(raw)) return { problems: [problem('bad-graph', 'a graph file is a YAML mapping')] }
  if (raw.version !== FORMAT_VERSION) {
    return {
      problems: [
        problem(
          'unsupported-version',
          `version must be ${FORMAT_VERSION}, not ${JSON.stringify(raw.version)}`,
        ),
      ],
    }
  }
  if (raw.start === undefined) return { problems: [problem('no-start', 'the graph has no start')] }
  const top = topSchema.safeParse(raw)
  const problems: Problem[] = top.success ? [] : fromIssues(top.error.issues, 'bad-graph', '')
  if (raw.ui !== undefined && JSON.stringify(raw.ui).length > UI_MAX_BYTES) {
    problems.push(problem('over-limit', 'ui is at most 16 KiB'))
  }
  if (!top.success) return { problems }
  const state = checkState(top.data.state)
  const nodeCheck = checkNodes(top.data.nodes, kinds)
  const edges: Edge[] = []
  top.data.edges.forEach((rawEdge, i) => {
    const parsed = parseEdge(rawEdge, i)
    if (parsed.edge) edges.push(parsed.edge)
    problems.push(...parsed.problems)
  })
  problems.push(
    ...state.problems,
    ...checkTriggers(top.data.on, state.keys),
    ...nodeCheck.problems,
    ...checkLimits(top.data.limits),
  )
  if (problems.length > 0) return { problems }
  const graph = { ...top.data, state: state.keys, nodes: nodeCheck.nodes, edges } as GraphFile
  const ids = new Set(graph.nodes.map((n) => n.id))
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const declared = { state: new Set(Object.keys(state.keys)), nodes: ids }
  for (const node of graph.nodes) {
    const kind = kinds.find((k) => k.kind === node.kind) as KindDescriptor
    problems.push(
      ...checkTemplates(node.with, declared, node.id),
      ...(kind.check?.(node, { nodes: byId }) ?? []),
    )
  }
  problems.push(
    ...checkOuts(graph.nodes, state.keys, kinds),
    ...checkEdges(graph, ids),
    ...checkConditions(graph, state.keys, ids),
  )
  if (problems.length === 0) problems.push(...checkShape(graph, ids, state.keys))
  return problems.length > 0 ? { problems } : { graph, problems }
}

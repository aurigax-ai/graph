import {
  CONTINUE,
  END,
  type Edge,
  type GraphFile,
  isConditional,
  isJoin,
  startNodes,
} from './model'

export interface Arc {
  to: string
  conditional: boolean
}

export function targetsOf(edge: Edge): string[] {
  if (isConditional(edge)) return [...edge.when.map((w) => w.to), edge.else]
  return Array.isArray(edge.to) ? edge.to : [edge.to]
}

export function sourcesOf(edge: Edge): string[] {
  return Array.isArray(edge.from) ? edge.from : [edge.from]
}

export function arcs(graph: Pick<GraphFile, 'nodes' | 'edges'>): Map<string, Arc[]> {
  const out = new Map<string, Arc[]>()
  const add = (from: string, arc: Arc): void => {
    if (arc.to === END) return
    const list = out.get(from) ?? []
    list.push(arc)
    out.set(from, list)
  }
  for (const node of graph.nodes) {
    out.set(node.id, out.get(node.id) ?? [])
    for (const rule of node.catch ?? []) {
      if (rule.then !== CONTINUE) add(node.id, { to: rule.then, conditional: true })
    }
  }
  for (const edge of graph.edges) {
    const conditional = isConditional(edge)
    for (const from of sourcesOf(edge)) {
      for (const to of targetsOf(edge)) add(from, { to, conditional })
    }
  }
  return out
}

export function reachable(
  from: string[],
  graph: Map<string, Arc[]>,
  stop: ReadonlySet<string> = new Set(),
): Set<string> {
  const seen = new Set<string>()
  const queue = [...from]
  while (queue.length > 0) {
    const id = queue.shift() as string
    if (seen.has(id)) continue
    seen.add(id)
    if (stop.has(id)) continue
    for (const arc of graph.get(id) ?? []) queue.push(arc.to)
  }
  return seen
}

export function stronglyConnected(nodes: string[], next: (id: string) => string[]): string[][] {
  let index = 0
  const indices = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const groups: string[][] = []
  const visit = (id: string): void => {
    indices.set(id, index)
    low.set(id, index)
    index++
    stack.push(id)
    onStack.add(id)
    for (const to of next(id)) {
      if (!indices.has(to)) {
        visit(to)
        low.set(id, Math.min(low.get(id) as number, low.get(to) as number))
      } else if (onStack.has(to)) {
        low.set(id, Math.min(low.get(id) as number, indices.get(to) as number))
      }
    }
    if (low.get(id) === indices.get(id)) {
      const group: string[] = []
      for (;;) {
        const top = stack.pop() as string
        onStack.delete(top)
        group.push(top)
        if (top === id) break
      }
      groups.push(group)
    }
  }
  for (const id of nodes) if (!indices.has(id)) visit(id)
  return groups
}

export function cycles(nodes: string[], next: (id: string) => string[]): string[][] {
  return stronglyConnected(nodes, next).filter(
    (group) => group.length > 1 || next(group[0]).includes(group[0]),
  )
}

export interface Region {
  source: string | null
  join: string | null
  branches: Set<string>[]
  members: Set<string>
}

export function joinTargets(graph: Pick<GraphFile, 'edges'>): Set<string> {
  return new Set(graph.edges.filter(isJoin).map((e) => e.to))
}

export function parallelRegions(graph: Pick<GraphFile, 'nodes' | 'edges' | 'start'>): Region[] {
  const graphArcs = arcs(graph)
  const joins = joinTargets(graph)
  const fanOuts: { source: string | null; targets: string[] }[] = []
  const starts = startNodes(graph)
  if (starts.length > 1) fanOuts.push({ source: null, targets: starts })
  for (const edge of graph.edges) {
    if (!isConditional(edge) && !isJoin(edge) && Array.isArray(edge.to) && edge.to.length > 1) {
      fanOuts.push({ source: edge.from, targets: edge.to.filter((t) => t !== END) })
    }
  }
  return fanOuts.map(({ source, targets }) => {
    const branches = targets.map((t) => {
      const seen = reachable([t], graphArcs, joins)
      for (const j of joins) if (seen.has(j) && !targets.includes(j)) seen.delete(j)
      return seen
    })
    const members = new Set(branches.flatMap((b) => [...b]))
    const reachedJoins = [...joins].filter((j) =>
      targets.some((t) => reachable([t], graphArcs, joins).has(j)),
    )
    return { source, join: reachedJoins[0] ?? null, branches, members }
  })
}

export interface GraphStepInput {
  id: string
  needs?: readonly string[]
}

export interface GraphNode {
  id: string
  col: number
  row: number
}

export interface GraphEdge {
  from: string
  to: string
}

export interface WorkflowGraphLayout {
  nodes: GraphNode[]
  edges: GraphEdge[]
  flat: boolean
}

function flatLayout(steps: readonly GraphStepInput[]): WorkflowGraphLayout {
  return { nodes: steps.map((s, i) => ({ id: s.id, col: i, row: 0 })), edges: [], flat: true }
}

export function layoutWorkflowGraph(steps: readonly GraphStepInput[]): WorkflowGraphLayout {
  if (steps.length === 0) return { nodes: [], edges: [], flat: false }
  const index = new Map<string, number>()
  for (const [i, step] of steps.entries()) {
    if (index.has(step.id)) return flatLayout(steps)
    index.set(step.id, i)
  }
  const needs = steps.map((step, i) => step.needs ?? (i === 0 ? [] : [steps[i - 1].id]))
  if (needs.some((list) => list.some((id) => !index.has(id)))) return flatLayout(steps)

  const cols: number[] = new Array(steps.length).fill(-1)
  const visiting = new Set<number>()
  let cyclic = false
  const depth = (i: number): number => {
    if (cols[i] >= 0) return cols[i]
    if (visiting.has(i)) {
      cyclic = true
      return 0
    }
    visiting.add(i)
    let col = 0
    for (const id of needs[i]) col = Math.max(col, depth(index.get(id) as number) + 1)
    visiting.delete(i)
    cols[i] = col
    return col
  }
  for (let i = 0; i < steps.length; i++) depth(i)
  if (cyclic) return flatLayout(steps)

  const rowCounts = new Map<number, number>()
  const nodes = steps.map((step, i) => {
    const row = rowCounts.get(cols[i]) ?? 0
    rowCounts.set(cols[i], row + 1)
    return { id: step.id, col: cols[i], row }
  })
  const edges: GraphEdge[] = []
  const seen = new Set<string>()
  steps.forEach((step, i) => {
    for (const from of needs[i]) {
      const key = `${from}\u0000${step.id}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ from, to: step.id })
    }
  })
  return { nodes, edges, flat: false }
}

import { describe, expect, it } from 'vitest'
import { ALL_WORKFLOW_FEATURES, validateWorkflowDefinition } from '../../../../shared/workflow-def'
import { layoutWorkflowGraph } from './layout-workflow-graph'

const pos = (steps: Parameters<typeof layoutWorkflowGraph>[0]) =>
  layoutWorkflowGraph(steps).nodes.map((n) => `${n.id}:${n.col},${n.row}`)

describe('layoutWorkflowGraph', () => {
  it('returns an empty non-flat layout for no steps', () => {
    expect(layoutWorkflowGraph([])).toEqual({ nodes: [], edges: [], flat: false })
  })

  it('lays a linear chain out one column per step', () => {
    const result = layoutWorkflowGraph([
      { id: 'a', needs: [] },
      { id: 'b', needs: ['a'] },
      { id: 'c', needs: ['b'] }
    ])
    expect(result.nodes).toEqual([
      { id: 'a', col: 0, row: 0 },
      { id: 'b', col: 1, row: 0 },
      { id: 'c', col: 2, row: 0 }
    ])
    expect(result.edges).toEqual([
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' }
    ])
    expect(result.flat).toBe(false)
  })

  it('places a diamond with the join after the longest path', () => {
    const result = layoutWorkflowGraph([
      { id: 'a', needs: [] },
      { id: 'b', needs: ['a'] },
      { id: 'c', needs: ['a'] },
      { id: 'd', needs: ['b', 'c'] }
    ])
    expect(pos([{ id: 'a', needs: [] }, { id: 'b', needs: ['a'] }, { id: 'c', needs: ['a'] }, { id: 'd', needs: ['b', 'c'] }])).toEqual([
      'a:0,0',
      'b:1,0',
      'c:1,1',
      'd:2,0'
    ])
    expect(result.edges).toEqual([
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'b', to: 'd' },
      { from: 'c', to: 'd' }
    ])
  })

  it('uses the longest path for a column', () => {
    expect(pos([{ id: 'a' }, { id: 'b' }, { id: 'c', needs: ['a', 'b'] }])).toEqual(['a:0,0', 'b:1,0', 'c:2,0'])
  })

  it('treats omitted needs as the previous step and empty needs as a root', () => {
    const result = layoutWorkflowGraph([{ id: 'a' }, { id: 'b' }, { id: 'c', needs: [] }])
    expect(result.nodes).toEqual([
      { id: 'a', col: 0, row: 0 },
      { id: 'b', col: 1, row: 0 },
      { id: 'c', col: 0, row: 1 }
    ])
    expect(result.edges).toEqual([{ from: 'a', to: 'b' }])
  })

  it('dedupes repeated needs', () => {
    expect(layoutWorkflowGraph([{ id: 'a' }, { id: 'b', needs: ['a', 'a'] }]).edges).toEqual([{ from: 'a', to: 'b' }])
  })

  it.each([
    ['a cycle', [{ id: 'a', needs: ['b'] }, { id: 'b', needs: ['a'] }]],
    ['a self reference', [{ id: 'a', needs: ['a'] }, { id: 'b' }]],
    ['an unknown ref', [{ id: 'a' }, { id: 'b', needs: ['zzz'] }]],
    ['a duplicate id', [{ id: 'a' }, { id: 'a' }]]
  ])('degrades %s to a flat single row', (_name, steps) => {
    const result = layoutWorkflowGraph(steps)
    expect(result.flat).toBe(true)
    expect(result.edges).toEqual([])
    expect(result.nodes).toEqual(steps.map((s, i) => ({ id: s.id, col: i, row: 0 })))
  })

  it('matches the needs the parser resolves', () => {
    const text = `name: graph
steps:
  - id: plan
    agent: claude
    prompt: plan it
  - id: build
    agent: claude
    prompt: build it
    permissions: read-only
  - id: test
    kind: shell
    run: pnpm test
    needs: [plan]
    parallel_safe: true
  - id: review
    agent: claude
    prompt: review it
    needs: [build, test]
`
    const { definition, diagnostics } = validateWorkflowDefinition(text, { supportedFeatures: ALL_WORKFLOW_FEATURES })
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const steps = definition!.steps
    const expected = steps.flatMap((s) => s.needs.map((from) => ({ from, to: s.id })))
    const layout = layoutWorkflowGraph(steps)
    expect(layout.flat).toBe(false)
    expect(layout.edges).toHaveLength(expected.length)
    expect(layout.edges).toEqual(expect.arrayContaining(expected))
  })
})

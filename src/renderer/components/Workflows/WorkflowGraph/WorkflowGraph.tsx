import { useMemo } from 'react'
import type { WorkflowStepStatus } from '../../../../shared/state/workflows'
import { GLYPH_COLORS, STEP_GLYPHS, STEP_STATUS_LABELS } from '../workflow-run-helpers'
import { layoutWorkflowGraph, type GraphStepInput } from './layout-workflow-graph'

const NODE_W = 9
const NODE_H = 2.25
const GAP_X = 2.5
const GAP_Y = 0.75
const PITCH_X = NODE_W + GAP_X
const PITCH_Y = NODE_H + GAP_Y

export interface WorkflowGraphProps {
  steps: readonly GraphStepInput[]
  statusByStep?: Partial<Record<string, WorkflowStepStatus>>
  pausedStepId?: string
}

function nodeLabel(id: string, status: WorkflowStepStatus | undefined, paused: boolean): string {
  const base = status ? `${id}: ${STEP_STATUS_LABELS[status]}` : id
  return paused ? `${base}, needs you` : base
}

export function WorkflowGraph({ steps, statusByStep, pausedStepId }: WorkflowGraphProps): JSX.Element | null {
  const layout = useMemo(() => layoutWorkflowGraph(steps), [steps])
  if (layout.nodes.length === 0) return null

  const cols = Math.max(...layout.nodes.map((n) => n.col)) + 1
  const rows = Math.max(...layout.nodes.map((n) => n.row)) + 1
  const width = cols * PITCH_X - GAP_X
  const height = rows * PITCH_Y - GAP_Y
  const byId = new Map(layout.nodes.map((n) => [n.id, n]))

  return (
    <div role="group" aria-label="Workflow graph" tabIndex={0} className="overflow-x-auto p-2">
      <div className="relative" style={{ width: `${width}rem`, height: `${height}rem` }}>
        <svg
          aria-hidden="true"
          className="absolute inset-0 text-faint"
          style={{ width: `${width}rem`, height: `${height}rem` }}
          viewBox={`0 0 ${width} ${height}`}
        >
          {layout.edges.map((edge) => {
            const from = byId.get(edge.from)
            const to = byId.get(edge.to)
            if (!from || !to) return null
            const x1 = from.col * PITCH_X + NODE_W
            const y1 = from.row * PITCH_Y + NODE_H / 2
            const x2 = to.col * PITCH_X
            const y2 = to.row * PITCH_Y + NODE_H / 2
            const mid = (x1 + x2) / 2
            return (
              <path
                key={`${edge.from}->${edge.to}`}
                data-edge={`${edge.from}->${edge.to}`}
                d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke="currentColor"
                strokeWidth={0.08}
              />
            )
          })}
        </svg>
        <div
          role="list"
          className="absolute inset-0 grid"
          style={{
            gridTemplateColumns: `repeat(${cols}, ${NODE_W}rem)`,
            gridTemplateRows: `repeat(${rows}, ${NODE_H}rem)`,
            columnGap: `${GAP_X}rem`,
            rowGap: `${GAP_Y}rem`
          }}
        >
          {layout.nodes.map((node) => {
            const status = statusByStep?.[node.id]
            const glyph = status ? STEP_GLYPHS[status] : null
            const paused = node.id === pausedStepId
            return (
              <div
                key={node.id}
                role="listitem"
                aria-label={nodeLabel(node.id, status, paused)}
                title={node.id}
                className={`flex items-center gap-2 rounded border bg-surface px-2 text-xs text-fg ${
                  paused ? 'border-warning ring-2 ring-warning' : 'border-border'
                }`}
                style={{ gridColumn: node.col + 1, gridRow: node.row + 1 }}
              >
                <span className="truncate">{node.id}</span>
                {glyph && (
                  <span aria-hidden="true" className={`ml-auto ${GLYPH_COLORS[glyph]}`}>
                    {glyph}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

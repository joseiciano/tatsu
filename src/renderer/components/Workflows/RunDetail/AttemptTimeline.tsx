import { useId } from 'react'
import type { WorkflowAttemptStatus } from '../../../../shared/state/workflows'
import type { RunDetailTimelineRow } from '../run-detail-model'

const STATUS_COLORS: Record<WorkflowAttemptStatus, string> = {
  running: 'text-accent',
  done: 'text-success',
  failed: 'text-danger',
  cancelled: 'text-dim',
  interrupted: 'text-warning'
}

export interface AttemptTimelineProps {
  rows: readonly RunDetailTimelineRow[]
  selectedAttemptId: string | null
  onSelect: (attemptId: string) => void
}

export function rowLabel(row: RunDetailTimelineRow): string {
  const completed = row.completedBy ? `, completed by ${row.completedBy}` : ''
  return `${row.stepId} #${row.n}: ${row.statusLabel}${completed}, ${row.duration}, cost ${row.cost}`
}

export function AttemptTimeline({ rows, selectedAttemptId, onSelect }: AttemptTimelineProps): JSX.Element {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2 min-w-0">
      <h3 id={headingId} className="text-xs font-medium text-dim">
        Attempt timeline
      </h3>
      {rows.length === 0 ? (
        <p className="text-sm text-faint">No attempts yet.</p>
      ) : (
        <ol aria-labelledby={headingId} className="flex flex-col gap-1">
          {rows.map((row) => {
            const selected = row.attemptId === selectedAttemptId
            return (
              <li key={row.attemptId}>
                <button
                  type="button"
                  aria-pressed={selected}
                  aria-label={rowLabel(row)}
                  onClick={() => onSelect(row.attemptId)}
                  className={`w-full grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 rounded border px-2 py-1 text-left text-xs cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                    selected ? 'border-accent bg-panel-raised' : 'border-border bg-surface hover:border-border-strong'
                  }`}
                >
                  <span className="truncate text-fg-bright" title={row.stepId}>
                    {row.stepId} <span className="text-faint">#{row.n}</span>
                  </span>
                  <span className={`text-right ${STATUS_COLORS[row.status]}`}>{row.statusLabel}</span>
                  <span className="truncate text-dim">{row.completedBy ?? '—'}</span>
                  <span className="text-right tabular-nums text-dim">
                    {row.duration} · {row.cost}
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

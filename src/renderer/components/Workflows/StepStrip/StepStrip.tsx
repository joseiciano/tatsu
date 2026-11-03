import { Fragment, useMemo } from 'react'
import { useWorkflowDefinition, useWorkflowRun } from '../../../store'
import {
  STEP_STATUS_LABELS,
  deriveStepStrip,
  stepOrderFor,
  type StepGlyph,
  type StepStripEntry
} from '../workflow-run-helpers'

const GLYPH_COLORS: Record<StepGlyph, string> = {
  '✓': 'text-success',
  '●': 'text-accent',
  '✕': 'text-danger',
  '↷': 'text-dim',
  '○': 'text-faint',
  '!': 'text-warning'
}

function stepLabel(entry: StepStripEntry): string {
  return `${entry.id} ${entry.paused ? 'paused' : STEP_STATUS_LABELS[entry.status]}`
}

export function StepStripLine({ entries }: { entries: StepStripEntry[] }): JSX.Element | null {
  if (entries.length === 0) return null
  return (
    <div
      role="img"
      aria-label={`Workflow steps: ${entries.map(stepLabel).join(', ')}`}
      className="text-xs text-faint truncate"
    >
      {entries.map((entry, i) => (
        <Fragment key={entry.id}>
          {i > 0 && <span aria-hidden="true"> → </span>}
          <span title={entry.id}>
            {entry.id} <span className={GLYPH_COLORS[entry.glyph]}>{entry.glyph}</span>
          </span>
        </Fragment>
      ))}
    </div>
  )
}

export function StepStrip({ runId }: { runId: string }): JSX.Element | null {
  const run = useWorkflowRun(runId)
  const summary = useWorkflowDefinition(run?.defId ?? null)
  const entries = useMemo(() => (run ? deriveStepStrip(run, stepOrderFor(run, summary)) : []), [run, summary])
  return <StepStripLine entries={entries} />
}

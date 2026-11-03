import { useEffect, useId, useState } from 'react'
import { useBackend } from '../../../backend'
import { useWorkflowAttempt, useWorkflowRun } from '../../../store'
import type { TerminalTabWorkflow } from '../../../../shared/state/terminals'
import type {
  WorkflowAttemptRecord,
  WorkflowMarkDonePayload,
  WorkflowRunRecord
} from '../../../../shared/state/workflows'
import { STEP_STATUS_LABELS } from '../workflow-run-helpers'
import { COMPLETED_BY_LABELS, stepTabOverlayMode } from './StepTab'
import { MarkDoneForm } from './MarkDoneForm'

interface StepResultOverlayProps {
  workflow: TerminalTabWorkflow
  title: string
}

interface Records {
  attempt: WorkflowAttemptRecord | null
  run: WorkflowRunRecord | null
}

export function StepResultOverlay({ workflow, title }: StepResultOverlayProps): JSX.Element {
  const backend = useBackend()
  const titleId = useId()
  const { runId, stepId, attemptId } = workflow
  const sliceAttempt = useWorkflowAttempt(attemptId)
  const sliceRun = useWorkflowRun(runId)
  const [records, setRecords] = useState<Records | null>(null)
  const attemptStatus = sliceAttempt?.status
  const attemptEndedAt = sliceAttempt?.endedAt
  const runStatus = sliceRun?.status
  const pausedReason = sliceRun?.pausedReason
  const stepStatus = sliceRun?.steps[stepId]?.status

  useEffect(() => {
    let cancelled = false
    void Promise.all([backend.getWorkflowAttemptResult(attemptId), backend.getWorkflowRun(runId)])
      .then(([attempt, run]) => {
        if (!cancelled) setRecords({ attempt, run })
      })
      .catch(() => {
        if (!cancelled) setRecords({ attempt: null, run: null })
      })
    return () => {
      cancelled = true
    }
  }, [backend, attemptId, runId, attemptStatus, attemptEndedAt, runStatus, pausedReason, stepStatus])

  const attempt = records?.attempt ?? null
  const mode = stepTabOverlayMode({ workflow }, attempt, records?.run ?? null)
  const step = records?.run?.definition.steps.find((s) => s.id === stepId)
  const completedBy = attempt?.metrics.completedBy ?? attempt?.result?.completedBy
  const summary = attempt?.result?.summary ?? sliceAttempt?.summaryPreview ?? ''
  const status = attempt?.status ?? sliceAttempt?.status

  const markDone = (payload: WorkflowMarkDonePayload) => backend.markWorkflowStepDone(runId, stepId, payload)

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-app/80 p-4 overflow-auto">
      <section
        aria-labelledby={titleId}
        className="w-full max-w-lg max-h-full overflow-auto rounded-lg border border-border bg-surface p-4 flex flex-col gap-3"
      >
        <h2 id={titleId} className="text-sm font-semibold text-fg-bright break-words">
          {title}
        </h2>
        {records === null ? (
          <p className="text-xs text-dim">Loading step result…</p>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-dim">Step</dt>
            <dd className="text-fg break-words">{stepId}</dd>
            <dt className="text-dim">Status</dt>
            <dd className="text-fg">{status ? STEP_STATUS_LABELS[status] : 'unknown'}</dd>
            <dt className="text-dim">Completed by</dt>
            <dd className="text-fg">{completedBy ? COMPLETED_BY_LABELS[completedBy] : '—'}</dd>
            <dt className="text-dim">Summary</dt>
            <dd className="text-fg whitespace-pre-wrap break-words max-h-40 overflow-auto">{summary || '—'}</dd>
          </dl>
        )}
        {mode === 'result-with-mark-done' && <MarkDoneForm key={attemptId} step={step} onSubmit={markDone} />}
      </section>
    </div>
  )
}

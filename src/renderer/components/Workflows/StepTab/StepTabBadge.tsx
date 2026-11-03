import { useWorkflowAttempt } from '../../../store'
import { STEP_STATUS_LABELS } from '../workflow-run-helpers'
import type { WorkflowAttemptStatus } from '../../../../shared/state/workflows'

const BADGE_TONE: Record<WorkflowAttemptStatus, string> = {
  running: 'text-success border-success/40',
  done: 'text-dim border-border',
  failed: 'text-danger border-danger/40',
  cancelled: 'text-warning border-warning/40',
  interrupted: 'text-warning border-warning/40'
}

export function StepTabBadge({ attemptId }: { attemptId: string }): JSX.Element {
  const attempt = useWorkflowAttempt(attemptId)
  const label = attempt ? STEP_STATUS_LABELS[attempt.status] : 'step'
  const tone = attempt ? BADGE_TONE[attempt.status] : 'text-dim border-border'
  return (
    <span
      className={`px-1 rounded border text-xs leading-tight ${tone}`}
      aria-label={`Workflow step, ${label}`}
    >
      {label}
    </span>
  )
}

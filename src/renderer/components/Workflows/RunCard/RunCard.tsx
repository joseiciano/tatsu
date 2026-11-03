import type { WorkflowRunStatus } from '../../../../shared/state/workflows'
import { StepStripLine } from '../StepStrip'
import type { RunCardModel } from '../run-card-model'
import type { StepStripEntry } from '../workflow-run-helpers'

const STATUS_COLORS: Record<WorkflowRunStatus, string> = {
  queued: 'text-dim',
  running: 'text-accent',
  paused: 'text-warning',
  done: 'text-success',
  failed: 'text-danger',
  cancelled: 'text-dim'
}

export interface RunCardProps {
  model: RunCardModel
  runStatus: WorkflowRunStatus
  repoName: string | null
  worktreePath: string
  steps: StepStripEntry[]
}

export function RunCard({ model, runStatus, repoName, worktreePath, steps }: RunCardProps): JSX.Element {
  const location = repoName ? `${repoName} / ${model.worktreeName}` : model.worktreeName
  return (
    <article
      aria-label={`${model.name} on ${model.worktreeName}`}
      className="flex flex-col gap-1 rounded-md border border-border bg-surface px-3 py-2 min-w-0"
    >
      <div className="flex items-baseline gap-2 min-w-0">
        <h3 className="text-sm font-medium text-fg-bright truncate" title={model.name}>
          {model.name}
        </h3>
        <span className={`ml-auto shrink-0 text-xs ${STATUS_COLORS[runStatus]}`}>{model.status}</span>
      </div>
      <div className="text-xs text-faint truncate" title={worktreePath}>
        {location}
      </div>
      <StepStripLine entries={steps} />
      <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-dim">
        <div className="flex gap-1 min-w-0">
          <dt className="text-faint">Step</dt>
          <dd className="truncate">{model.stepId ? (model.agent ? `${model.stepId} · ${model.agent}` : model.stepId) : '—'}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-faint">Elapsed</dt>
          <dd className="tabular-nums">{model.elapsed}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-faint">Cost</dt>
          <dd className="tabular-nums">{model.cost}</dd>
        </div>
      </dl>
    </article>
  )
}

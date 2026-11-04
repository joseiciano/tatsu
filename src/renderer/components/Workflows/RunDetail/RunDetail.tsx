import { useEffect, useId, useRef, type ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { WorkflowRunStatus, WorkflowStepStatus } from '../../../../shared/state/workflows'
import type { ResolvedWorkflowStep } from '../../../../shared/workflow-def'
import type { RunCardModel } from '../run-card-model'
import type { RunDetailActionKind, RunDetailModel } from '../run-detail-model'
import { WorkflowGraph } from '../WorkflowGraph'
import { AttemptResult, type AttemptResultState } from './AttemptResult'
import { AttemptTimeline } from './AttemptTimeline'

export const RUN_DETAIL_ACTION_LABELS: Record<RunDetailActionKind, string> = {
  resume: 'Resume',
  retry: 'Retry',
  'retry-from-clean': 'Retry from clean',
  swap: 'Swap harness/model',
  'mark-done': 'Mark done',
  skip: 'Skip',
  'cancel-step': 'Cancel step',
  'cancel-run': 'Cancel run',
  jump: 'Jump to tab'
}

const RUN_LEVEL_ACTIONS: ReadonlySet<RunDetailActionKind> = new Set(['cancel-run', 'jump'])

const DANGER_ACTIONS: ReadonlySet<RunDetailActionKind> = new Set(['cancel-run', 'cancel-step', 'retry-from-clean'])

const STATUS_COLORS: Record<WorkflowRunStatus, string> = {
  queued: 'text-dim',
  running: 'text-accent',
  paused: 'text-warning',
  done: 'text-success',
  failed: 'text-danger',
  cancelled: 'text-dim'
}

export interface RunDetailProps {
  card: RunCardModel
  runStatus: WorkflowRunStatus
  location: string
  worktreePath: string
  steps: readonly ResolvedWorkflowStep[] | null
  statusByStep: Partial<Record<string, WorkflowStepStatus>>
  model: RunDetailModel | null
  loadError: boolean
  selectedAttemptId: string | null
  onSelectAttempt: (attemptId: string) => void
  attemptResult: AttemptResultState
  attemptChanges: ReactNode
  busy: boolean
  actionError: string | null
  markDoneOpen: boolean
  onAction: (kind: RunDetailActionKind) => void
  onBack: () => void
  markDoneForm: ReactNode
}

function actionLabel(kind: RunDetailActionKind, stepId: string | null): string {
  const label = RUN_DETAIL_ACTION_LABELS[kind]
  return RUN_LEVEL_ACTIONS.has(kind) || !stepId ? label : `${label}: ${stepId}`
}

function RunActions({
  model,
  busy,
  actionError,
  markDoneOpen,
  onAction,
  markDoneForm
}: Pick<RunDetailProps, 'busy' | 'actionError' | 'markDoneOpen' | 'onAction' | 'markDoneForm'> & {
  model: RunDetailModel
}): JSX.Element {
  const headingId = useId()
  const stepId = model.actionStepId
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="text-xs font-medium text-dim">
        Actions{stepId ? <span className="text-faint"> · step {stepId}</span> : null}
      </h3>
      {model.actions.length === 0 ? (
        <p className="text-xs text-faint">Nothing to do on this run right now.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {model.actions.map((kind) => (
            <button
              key={kind}
              type="button"
              disabled={busy}
              onClick={() => onAction(kind)}
              aria-label={actionLabel(kind, stepId)}
              aria-expanded={kind === 'mark-done' ? markDoneOpen : undefined}
              aria-haspopup={kind === 'swap' ? 'dialog' : undefined}
              className={`text-xs px-2 py-1 rounded border border-border-strong hover:bg-surface transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                DANGER_ACTIONS.has(kind) ? 'text-danger' : 'text-fg'
              }`}
            >
              {RUN_DETAIL_ACTION_LABELS[kind]}
            </button>
          ))}
        </div>
      )}
      {actionError && (
        <p role="alert" className="text-xs text-danger break-words">
          {actionError}
        </p>
      )}
      {markDoneForm}
    </section>
  )
}

export function RunDetail({
  card,
  runStatus,
  location,
  worktreePath,
  steps,
  statusByStep,
  model,
  loadError,
  selectedAttemptId,
  onSelectAttempt,
  attemptResult,
  attemptChanges,
  busy,
  actionError,
  markDoneOpen,
  onAction,
  onBack,
  markDoneForm
}: RunDetailProps): JSX.Element {
  const titleId = useId()
  const titleRef = useRef<HTMLHeadingElement | null>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-5 min-w-0">
      <div>
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-muted hover:text-fg-bright transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
        >
          <ArrowLeft className="icon-sm" aria-hidden="true" />
          All runs
        </button>
      </div>

      <header className="flex flex-col gap-1 min-w-0">
        <div className="flex items-baseline gap-2 min-w-0">
          <h2 ref={titleRef} id={titleId} tabIndex={-1} className="text-lg font-medium text-fg-bright truncate outline-none" title={card.name}>
            {card.name}
          </h2>
          <span className={`ml-auto shrink-0 text-sm ${STATUS_COLORS[runStatus]}`}>{card.status}</span>
        </div>
        <div className="text-xs text-faint truncate" title={worktreePath}>
          {location}
        </div>
        <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-dim">
          <div className="flex gap-1">
            <dt className="text-faint">Elapsed</dt>
            <dd className="tabular-nums">{card.elapsed}</dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-faint">Cost</dt>
            <dd className="tabular-nums">{card.cost}</dd>
          </div>
        </dl>
      </header>

      {loadError && (
        <p role="alert" className="text-xs text-danger">
          Could not load this run's record.
        </p>
      )}

      {steps && steps.length > 0 && <WorkflowGraph steps={steps} statusByStep={statusByStep} />}

      {model === null ? (
        !loadError && <p className="text-xs text-dim">Loading run…</p>
      ) : (
        <>
          <RunActions
            model={model}
            busy={busy}
            actionError={actionError}
            markDoneOpen={markDoneOpen}
            onAction={onAction}
            markDoneForm={markDoneForm}
          />
          <div className="grid gap-5 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <AttemptTimeline rows={model.timeline} selectedAttemptId={selectedAttemptId} onSelect={onSelectAttempt} />
            <AttemptResult state={attemptResult} />
          </div>
          {attemptChanges}
        </>
      )}
    </section>
  )
}

import type {
  WorkflowAttemptRecord,
  WorkflowAttemptStatus,
  WorkflowRun,
  WorkflowRunRecord
} from '../../../../shared/state/workflows'
import { formatCost, formatElapsed, isTerminalRun } from '../run-card-model'
import { COMPLETED_BY_LABELS, stepTabOverlayMode } from '../StepTab'
import { needsYouActions, recordStepContext, STEP_STATUS_LABELS, type NeedsYouActionKind } from '../workflow-run-helpers'

export type RunDetailActionKind =
  | 'approve'
  | 'request-changes'
  | 'loop-again'
  | 'loop-continue'
  | 'keep-waiting'
  | 'resume'
  | 'retry'
  | 'retry-from-clean'
  | 'swap'
  | 'mark-done'
  | 'skip'
  | 'cancel-step'
  | 'cancel-run'
  | 'jump'

export interface RunDetailTimelineRow {
  attemptId: string
  stepId: string
  n: number
  status: WorkflowAttemptStatus
  statusLabel: string
  completedBy: string | null
  duration: string
  cost: string
}

export interface RunDetailModel {
  timeline: RunDetailTimelineRow[]
  latestAttemptId: string | null
  actionStepId: string | null
  actions: RunDetailActionKind[]
}

export interface RunDetailModelArgs {
  record: WorkflowRunRecord
  run: WorkflowRun
  tabExists: boolean
  now: number
}

export const RUN_DETAIL_ACTION_ORDER: readonly RunDetailActionKind[] = [
  'approve',
  'request-changes',
  'loop-again',
  'loop-continue',
  'keep-waiting',
  'resume',
  'retry',
  'retry-from-clean',
  'swap',
  'mark-done',
  'skip',
  'cancel-step',
  'cancel-run',
  'jump'
]

const NO_VALUE = '—'

const SWAPPABLE_STATUSES: ReadonlySet<WorkflowAttemptStatus> = new Set(['failed', 'cancelled', 'interrupted'])

function fromNeedsYou(kind: Exclude<NeedsYouActionKind, 'jump'>): RunDetailActionKind {
  return kind === 'cancel' ? 'cancel-run' : kind
}

function attemptDuration(attempt: WorkflowAttemptRecord, now: number): string {
  if (attempt.endedAt !== undefined) return formatElapsed(attempt.endedAt - attempt.startedAt)
  return attempt.status === 'running' ? formatElapsed(now - attempt.startedAt) : NO_VALUE
}

function timelineRow(attempt: WorkflowAttemptRecord, now: number): RunDetailTimelineRow {
  const completedBy = attempt.metrics.completedBy ?? attempt.result?.completedBy
  return {
    attemptId: attempt.attemptId,
    stepId: attempt.stepId,
    n: attempt.n,
    status: attempt.status,
    statusLabel: STEP_STATUS_LABELS[attempt.status],
    completedBy: completedBy ? COMPLETED_BY_LABELS[completedBy] : null,
    duration: attemptDuration(attempt, now),
    cost: formatCost(attempt.metrics.costUsd ?? attempt.result?.costUsd)
  }
}

function orderedAttempts(record: WorkflowRunRecord): WorkflowAttemptRecord[] {
  const stepIndex = new Map(record.definition.steps.map((step, i) => [step.id, i]))
  const rank = (a: WorkflowAttemptRecord): number => stepIndex.get(a.stepId) ?? record.definition.steps.length
  return record.attempts
    .map((attempt, i) => ({ attempt, i }))
    .sort((a, b) => rank(a.attempt) - rank(b.attempt) || a.attempt.n - b.attempt.n || a.i - b.i)
    .map(({ attempt }) => attempt)
}

export function latestAttemptId(record: WorkflowRunRecord): string | null {
  let latest: WorkflowAttemptRecord | null = null
  for (const attempt of record.attempts) {
    if (!latest || attempt.startedAt >= latest.startedAt) latest = attempt
  }
  return latest?.attemptId ?? null
}

function runActions(record: WorkflowRunRecord, run: WorkflowRun, tabExists: boolean): Set<RunDetailActionKind> {
  const actions = new Set<RunDetailActionKind>()
  if (tabExists) actions.add('jump')
  if (isTerminalRun(run)) return actions
  actions.add('cancel-run')
  const context = recordStepContext(record)
  if (!context) return actions
  const latest = record.attempts.filter((a) => a.stepId === context.stepId).at(-1) ?? null
  if (latest?.status === 'running') actions.add('cancel-step')
  if (run.status !== 'paused' || !run.pausedReason) return actions
  for (const kind of needsYouActions({ reason: run.pausedReason, step: context.step, attempt: context.attempt, tabExists: false })) {
    if (kind !== 'jump') actions.add(fromNeedsYou(kind))
  }
  if (context.step.kind === 'agent' && latest && SWAPPABLE_STATUSES.has(latest.status)) actions.add('swap')
  const workflow = { runId: record.runId, stepId: context.stepId, attemptId: latest?.attemptId ?? '' }
  if (latest && stepTabOverlayMode({ workflow }, latest, record) === 'result-with-mark-done') actions.add('mark-done')
  return actions
}

export function runDetailModel({ record, run, tabExists, now }: RunDetailModelArgs): RunDetailModel {
  const context = recordStepContext(record)
  const actions = runActions(record, run, tabExists)
  return {
    timeline: orderedAttempts(record).map((attempt) => timelineRow(attempt, now)),
    latestAttemptId: latestAttemptId(record),
    actionStepId: context?.stepId ?? null,
    actions: RUN_DETAIL_ACTION_ORDER.filter((kind) => actions.has(kind))
  }
}

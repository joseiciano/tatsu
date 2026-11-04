import type {
  WorkflowActionResponse,
  WorkflowAttempt,
  WorkflowAttemptStatus,
  WorkflowDefinitionSummary,
  WorkflowPausedReason,
  WorkflowRun,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowStepStatus
} from '../../../../shared/state/workflows'
import { RESUMABLE_AGENTS, WORKFLOW_BUDGET_MAX_USD, isBudgetUsd } from '../../../../shared/state/workflows'
export { PAUSED_REASON_LABELS, pausedReasonLabel } from '../../../../shared/state/workflows'
import type { ElectronAPI } from '../../../types'
import type { AgentKind } from '../../../../shared/state/terminals'

export type StepGlyph = '✓' | '●' | '✕' | '↷' | '○' | '!'

export interface StepStripEntry {
  id: string
  status: WorkflowStepStatus
  glyph: StepGlyph
  paused: boolean
}

export type NeedsYouActionKind =
  | 'jump'
  | 'approve'
  | 'request-changes'
  | 'loop-again'
  | 'loop-continue'
  | 'keep-waiting'
  | 'raise-budget'
  | 'resume'
  | 'retry'
  | 'retry-from-clean'
  | 'skip'
  | 'cancel'

export interface NeedsYouStepInfo {
  kind: 'agent' | 'shell' | 'foreach' | 'orchestrator'
  agent?: AgentKind
}

export interface NeedsYouAttemptInfo {
  status: WorkflowAttemptStatus
  resumable: boolean
  hasBaseSnapshot?: boolean
}

export interface NeedsYouActionsArgs {
  reason: WorkflowPausedReason
  step: NeedsYouStepInfo | null
  attempt: NeedsYouAttemptInfo | null
  tabExists: boolean
}

export interface RecordStepContext {
  stepId: string
  step: NeedsYouStepInfo
  attempt: NeedsYouAttemptInfo | null
}

export type BackendNeedsYouAction = Exclude<NeedsYouActionKind, 'jump' | 'retry-from-clean' | 'request-changes' | 'raise-budget'>

export type NeedsYouActionsApi = Pick<
  ElectronAPI,
  | 'retryWorkflowStep'
  | 'skipWorkflowStep'
  | 'resumeWorkflowStep'
  | 'cancelWorkflowRun'
  | 'retryWorkflowStepFromClean'
  | 'approveWorkflowGate'
  | 'resolveWorkflowLoopCap'
  | 'keepWaitingWorkflowStep'
>

export const STEP_GLYPHS: Record<WorkflowStepStatus, StepGlyph> = {
  done: '✓',
  running: '●',
  failed: '✕',
  skipped: '↷',
  pending: '○',
  queued: '○',
  'awaiting-gate': '!',
  cancelled: '✕',
  interrupted: '!'
}

export const GLYPH_COLORS: Record<StepGlyph, string> = {
  '✓': 'text-success',
  '●': 'text-accent',
  '✕': 'text-danger',
  '↷': 'text-dim',
  '○': 'text-faint',
  '!': 'text-warning'
}

export const STEP_STATUS_LABELS: Record<WorkflowStepStatus, string> = {
  done: 'done',
  running: 'running',
  failed: 'failed',
  skipped: 'skipped',
  pending: 'pending',
  queued: 'queued',
  'awaiting-gate': 'waiting at gate',
  cancelled: 'cancelled',
  interrupted: 'interrupted'
}

const FINISHED_STEP_STATUSES: ReadonlySet<WorkflowStepStatus> = new Set(['done', 'skipped'])

const TERMINAL_RUN_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set(['done', 'failed', 'cancelled'])

export function displayStepStatus(runStatus: WorkflowRunStatus, status: WorkflowStepStatus): WorkflowStepStatus {
  return status === 'awaiting-gate' && TERMINAL_RUN_STATUSES.has(runStatus) ? 'cancelled' : status
}

export function stepOrderFor(run: WorkflowRun, summary: WorkflowDefinitionSummary | null): string[] {
  if (summary && summary.hash === run.defHash) return summary.stepIds
  return Object.keys(run.steps)
}

export function currentStepId(run: WorkflowRun, stepOrder: readonly string[]): string | null {
  for (const id of stepOrder) {
    const step = run.steps[id]
    if (step && !FINISHED_STEP_STATUSES.has(step.status)) return id
  }
  return null
}

export function deriveStepStrip(run: WorkflowRun, stepOrder: readonly string[]): StepStripEntry[] {
  const cursor = run.cursorStepId !== undefined && stepOrder.includes(run.cursorStepId) ? run.cursorStepId : null
  const pausedId = run.status === 'paused' && run.pausedReason !== 'budget' ? cursor ?? currentStepId(run, stepOrder) : null
  const entries: StepStripEntry[] = []
  for (const id of stepOrder) {
    const step = run.steps[id]
    if (!step) continue
    const paused = id === pausedId
    const status = displayStepStatus(run.status, step.status)
    entries.push({ id, status, glyph: paused ? '!' : STEP_GLYPHS[status], paused })
  }
  return entries
}

function canResume(step: NeedsYouStepInfo | null, attempt: NeedsYouAttemptInfo | null): boolean {
  return (
    step?.kind === 'agent' &&
    step.agent !== undefined &&
    RESUMABLE_AGENTS.has(step.agent) &&
    attempt?.status === 'interrupted' &&
    attempt.resumable
  )
}

export function needsYouActions({ reason, step, attempt, tabExists }: NeedsYouActionsArgs): NeedsYouActionKind[] {
  const jump: NeedsYouActionKind[] = tabExists ? ['jump'] : []
  const fromClean: NeedsYouActionKind[] = attempt?.hasBaseSnapshot === true ? ['retry-from-clean'] : []
  switch (reason) {
    case 'step-failed':
      return ['retry', ...fromClean, 'skip', 'cancel', ...jump]
    case 'needs-input':
      return [...jump, 'retry', 'skip', 'cancel']
    case 'needs-approval':
      return [...jump, 'cancel']
    case 'interrupted':
      return canResume(step, attempt) ? ['resume', 'retry', 'cancel'] : ['retry', 'cancel']
    case 'trust':
      return ['retry', 'cancel', ...jump]
    case 'gate':
      return ['approve', ...(step?.kind === 'agent' ? (['request-changes'] as const) : []), 'cancel', ...jump]
    case 'loop-cap':
      return ['loop-again', 'loop-continue', 'cancel', ...jump]
    case 'timeout':
      return ['keep-waiting', 'cancel', ...jump]
    case 'budget':
      return ['raise-budget', 'cancel']
    case 'restack-conflict':
      return ['cancel', ...jump]
    default: {
      const _exhaustive: never = reason
      return _exhaustive
    }
  }
}

export function budgetFloorUsd(totalUsd: number): number {
  return Math.min(WORKFLOW_BUDGET_MAX_USD, (Math.floor(Math.max(0, totalUsd) * 100) + 1) / 100)
}

export function suggestedBudgetUsd(totalUsd: number, budgetUsd: number | undefined): number {
  const doubled = Math.ceil(Math.max(totalUsd, budgetUsd ?? 0) * 200) / 100
  return Math.min(WORKFLOW_BUDGET_MAX_USD, Math.max(budgetFloorUsd(totalUsd), doubled))
}

export function parseBudgetInput(text: string, totalUsd: number): number | null {
  const trimmed = text.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
  const value = Number(trimmed)
  return isBudgetUsd(value) && value > totalUsd ? value : null
}

export function recordStepContext(record: WorkflowRunRecord): RecordStepContext | null {
  const step = record.definition.steps[record.cursor]
  if (!step) return null
  const last = record.attempts.filter((a) => a.stepId === step.id).at(-1)
  return {
    stepId: step.id,
    step: step.kind === 'agent' ? { kind: step.kind, agent: step.agent } : { kind: step.kind },
    attempt: last
      ? { status: last.status, resumable: last.sessionId !== undefined, hasBaseSnapshot: last.baseSnapshot !== undefined }
      : null
  }
}

export function sliceStepContext(run: WorkflowRun, lastAttempt: WorkflowAttempt | null): RecordStepContext | null {
  const stepId = run.cursorStepId
  const step = stepId === undefined ? undefined : run.steps[stepId]
  if (stepId === undefined || step?.kind === undefined) return null
  return {
    stepId,
    step: step.agent === undefined ? { kind: step.kind } : { kind: step.kind, agent: step.agent },
    attempt: lastAttempt ? { status: lastAttempt.status, resumable: lastAttempt.resumable === true } : null
  }
}

export function runNeedsYouAction(
  api: NeedsYouActionsApi,
  kind: BackendNeedsYouAction,
  runId: string,
  stepId: string
): Promise<WorkflowActionResponse> {
  switch (kind) {
    case 'retry':
      return api.retryWorkflowStep(runId, stepId)
    case 'skip':
      return api.skipWorkflowStep(runId, stepId)
    case 'resume':
      return api.resumeWorkflowStep(runId, stepId)
    case 'cancel':
      return api.cancelWorkflowRun(runId)
    case 'approve':
      return api.approveWorkflowGate(runId, stepId)
    case 'loop-again':
      return api.resolveWorkflowLoopCap(runId, stepId, 'again')
    case 'loop-continue':
      return api.resolveWorkflowLoopCap(runId, stepId, 'continue')
    case 'keep-waiting':
      return api.keepWaitingWorkflowStep(runId, stepId)
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

export function confirmRetryFromClean(
  api: NeedsYouActionsApi,
  runId: string,
  stepId: string
): Promise<WorkflowActionResponse> {
  return api.retryWorkflowStepFromClean(runId, stepId, { confirmed: true })
}

import type {
  WorkflowActionResponse,
  WorkflowAttemptStatus,
  WorkflowDefinitionSummary,
  WorkflowPausedReason,
  WorkflowRun,
  WorkflowRunRecord,
  WorkflowStepStatus
} from '../../../../shared/state/workflows'
import type { ElectronAPI } from '../../../types'
import type { WorkflowAgent } from '../../../../shared/workflow-def'

export type StepGlyph = '✓' | '●' | '✕' | '↷' | '○' | '!'

export interface StepStripEntry {
  id: string
  status: WorkflowStepStatus
  glyph: StepGlyph
  paused: boolean
}

export type NeedsYouActionKind = 'jump' | 'resume' | 'retry' | 'retry-from-clean' | 'skip' | 'cancel'

export interface NeedsYouStepInfo {
  kind: 'agent' | 'shell' | 'foreach' | 'orchestrator'
  agent?: WorkflowAgent
}

export interface NeedsYouAttemptInfo {
  status: WorkflowAttemptStatus
  sessionId?: string
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

export type BackendNeedsYouAction = Exclude<NeedsYouActionKind, 'jump' | 'retry-from-clean'>

export type NeedsYouActionsApi = Pick<
  ElectronAPI,
  'retryWorkflowStep' | 'skipWorkflowStep' | 'resumeWorkflowStep' | 'cancelWorkflowRun' | 'retryWorkflowStepFromClean'
>

const STEP_GLYPHS: Record<WorkflowStepStatus, StepGlyph> = {
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

export const PAUSED_REASON_LABELS: Record<WorkflowPausedReason, string> = {
  'step-failed': 'Step failed',
  'needs-input': 'Needs input',
  'needs-approval': 'Needs approval',
  interrupted: 'Interrupted',
  trust: 'Folder not trusted',
  gate: 'Waiting at gate',
  budget: 'Budget reached',
  'loop-cap': 'Loop limit reached',
  timeout: 'Timed out',
  'restack-conflict': 'Restack conflict'
}

const FINISHED_STEP_STATUSES: ReadonlySet<WorkflowStepStatus> = new Set(['done', 'skipped'])

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
  const pausedId = run.status === 'paused' ? currentStepId(run, stepOrder) : null
  const entries: StepStripEntry[] = []
  for (const id of stepOrder) {
    const step = run.steps[id]
    if (!step) continue
    const paused = id === pausedId
    entries.push({ id, status: step.status, glyph: paused ? '!' : STEP_GLYPHS[step.status], paused })
  }
  return entries
}

function canResume(step: NeedsYouStepInfo | null, attempt: NeedsYouAttemptInfo | null): boolean {
  return (
    step?.kind === 'agent' &&
    step.agent === 'claude' &&
    attempt?.status === 'interrupted' &&
    attempt.sessionId !== undefined
  )
}

export function needsYouActions({ reason, step, attempt, tabExists }: NeedsYouActionsArgs): NeedsYouActionKind[] {
  const jump: NeedsYouActionKind[] = tabExists ? ['jump'] : []
  switch (reason) {
    case 'step-failed':
      return ['retry', 'retry-from-clean', 'skip', 'cancel', ...jump]
    case 'needs-input':
      return [...jump, 'retry', 'skip', 'cancel']
    case 'needs-approval':
      return [...jump, 'cancel']
    case 'interrupted':
      return canResume(step, attempt) ? ['resume', 'retry', 'cancel'] : ['retry', 'cancel']
    case 'trust':
      return ['retry', 'cancel', ...jump]
    case 'gate':
    case 'budget':
    case 'loop-cap':
    case 'timeout':
    case 'restack-conflict':
      return ['cancel', ...jump]
    default: {
      const _exhaustive: never = reason
      return _exhaustive
    }
  }
}

export function recordStepContext(record: WorkflowRunRecord): RecordStepContext | null {
  const step = record.definition.steps[record.cursor]
  if (!step) return null
  const last = record.attempts.filter((a) => a.stepId === step.id).at(-1)
  return {
    stepId: step.id,
    step: step.kind === 'agent' ? { kind: step.kind, agent: step.agent } : { kind: step.kind },
    attempt: last ? { status: last.status, ...(last.sessionId === undefined ? {} : { sessionId: last.sessionId }) } : null
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

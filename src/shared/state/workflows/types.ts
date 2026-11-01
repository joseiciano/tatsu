import type { ResolvedDefinition, WorkflowValidationResult } from '../../workflow-def'

export type WorkflowScope = 'personal'

export interface WorkflowDefinitionSummary {
  id: string
  name: string
  scope: WorkflowScope
  path: string
  hash: string
  stepIds: string[]
  issues: string[]
}

export interface WorkflowDefinitionDetail extends WorkflowValidationResult {
  summary: WorkflowDefinitionSummary
  source: string
}

export type WorkflowRunStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'

export type WorkflowPausedReason =
  | 'gate'
  | 'step-failed'
  | 'needs-approval'
  | 'needs-input'
  | 'budget'
  | 'loop-cap'
  | 'timeout'
  | 'interrupted'
  | 'trust'
  | 'restack-conflict'

export type WorkflowStepStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'awaiting-gate'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'interrupted'

export type WorkflowCompletedBy = 'tool' | 'fallback' | 'user' | 'exit'

export type WorkflowAttemptStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'

export interface WorkflowRunStep {
  status: WorkflowStepStatus
  attemptIds: string[]
}

export interface WorkflowRun {
  defId: string
  defHash: string
  chainId?: string
  itemId?: string
  worktreePath: string
  status: WorkflowRunStatus
  pausedReason?: WorkflowPausedReason
  startedAt: number
  finishedAt?: number
  costUsd?: number
  steps: Record<string, WorkflowRunStep>
}

export interface WorkflowAttempt {
  runId: string
  stepId: string
  n: number
  status: WorkflowAttemptStatus
  completedBy?: WorkflowCompletedBy
  summaryPreview: string
  costUsd?: number
  startedAt: number
  endedAt?: number
}

export interface WorkflowsState {
  definitions: Record<string, WorkflowDefinitionSummary>
  runs: Record<string, WorkflowRun>
  attempts: Record<string, WorkflowAttempt>
}

export type WorkflowsEvent =
  | {
      type: 'workflows/definitionsLoaded'
      payload: { scope: WorkflowScope; definitions: WorkflowDefinitionSummary[] }
    }
  | { type: 'workflows/runStarted'; payload: { runId: string; run: WorkflowRun } }
  | { type: 'workflows/runPaused'; payload: { runId: string; reason: WorkflowPausedReason } }
  | { type: 'workflows/runResumed'; payload: { runId: string } }
  | { type: 'workflows/runCancelled'; payload: { runId: string; finishedAt: number } }
  | {
      type: 'workflows/runFinished'
      payload: { runId: string; status: 'done' | 'failed'; finishedAt: number; costUsd?: number }
    }
  | { type: 'workflows/stepQueued'; payload: { runId: string; stepId: string } }
  | { type: 'workflows/stepStarted'; payload: { runId: string; stepId: string } }
  | { type: 'workflows/stepSkipped'; payload: { runId: string; stepId: string } }
  | {
      type: 'workflows/stepStatusChanged'
      payload: { runId: string; stepId: string; status: WorkflowStepStatus }
    }
  | {
      type: 'workflows/attemptStarted'
      payload: { attemptId: string; runId: string; stepId: string; n: number; startedAt: number }
    }
  | {
      type: 'workflows/attemptEnded'
      payload: {
        attemptId: string
        status: Exclude<WorkflowAttemptStatus, 'running'>
        endedAt: number
        summary: string
        completedBy?: WorkflowCompletedBy
        costUsd?: number
      }
    }
  | { type: 'workflows/runsEvicted'; payload: { runIds: string[] } }

export interface StepResult {
  status: 'done' | 'failed' | 'needs-input'
  summary: string
  completedBy: WorkflowCompletedBy
  data?: Record<string, unknown>
  exitCode?: number
  costUsd?: number
}

export interface WorkflowSnapshotRef {
  commit: string
  ref: string
}

export interface WorkflowAttemptPause {
  reason: WorkflowPausedReason
  at: number
}

export interface WorkflowAttemptMetrics {
  completedBy?: WorkflowCompletedBy
  continuations: number
  pauses: WorkflowAttemptPause[]
  wallMs?: number
  costUsd?: number
}

export interface WorkflowAttemptRecord {
  attemptId: string
  stepId: string
  n: number
  status: WorkflowAttemptStatus
  startedAt: number
  endedAt?: number
  executionId?: string
  result?: StepResult
  baseSnapshot?: WorkflowSnapshotRef
  headSnapshot?: WorkflowSnapshotRef
  metrics: WorkflowAttemptMetrics
}

export interface WorkflowRunRecord {
  version: 1
  runId: string
  defId: string
  defHash: string
  definition: ResolvedDefinition
  inputs: Record<string, string>
  worktreePath: string
  contextPath: string
  status: WorkflowRunStatus
  pausedReason?: WorkflowPausedReason
  cursor: number
  steps: Record<string, WorkflowStepStatus>
  startedAt: number
  finishedAt?: number
  timeToFirstDoneMs?: number
  attempts: WorkflowAttemptRecord[]
}

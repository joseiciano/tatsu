import type { Store } from '../store'
import type { WorkflowDefsLoader } from '../workflow-defs-loader'
import type { ResolvedDefinition } from '../../shared/workflow-def'
import type {
  WorkflowAttemptStatus,
  WorkflowCompletedBy,
  WorkflowPausedReason,
  WorkflowRunStatus
} from '../../shared/state/workflows'
import type { StepDriver, StepDriverKind } from './drivers/types'

export interface StepResult {
  status: 'done' | 'failed' | 'needs-input'
  summary: string
  completedBy: WorkflowCompletedBy
  data?: Record<string, unknown>
  exitCode?: number
  costUsd?: number
}

export interface StartRunRequest {
  defId: string
  worktreePath: string
  inputs: Record<string, string>
}

export type StartRefusal =
  | 'labs-off'
  | 'unknown-definition'
  | 'invalid-definition'
  | 'unsupported-step'
  | 'worktree-busy'

export type StartRunResult = { ok: true; runId: string } | { ok: false; reason: StartRefusal }

export interface WorkflowAttemptRecord {
  attemptId: string
  stepId: string
  n: number
  status: WorkflowAttemptStatus
  result?: StepResult
}

export interface WorkflowRunRecord {
  runId: string
  defId: string
  defHash: string
  definition: ResolvedDefinition
  inputs: Record<string, string>
  worktreePath: string
  status: WorkflowRunStatus
  pausedReason?: WorkflowPausedReason
  cursor: number
  attempts: WorkflowAttemptRecord[]
}

export type WorkflowLog = (category: string, message: string, data?: Record<string, string>) => void

export interface WorkflowRunnerDeps {
  store: Pick<Store, 'dispatch' | 'getSnapshot'>
  loader: Pick<WorkflowDefsLoader, 'getDefinition'>
  drivers: Record<StepDriverKind, StepDriver>
  now: () => number
  newId: () => string
  log: WorkflowLog
  persist?: (run: WorkflowRunRecord) => void
}

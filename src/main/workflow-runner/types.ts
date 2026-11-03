import type { Store } from '../store'
import type { WorkflowDefsLoader } from '../workflow-defs-loader'
import type { WorkflowMarkDonePayload, WorkflowRunRecord, WorkflowSnapshotRef } from '../../shared/state/workflows'
import type { StepDriver, StepDriverKind } from './drivers/types'
import type { StepOutputFieldError, WorkflowOutputSchema } from '../../shared/workflow-def'

export type {
  StepResult,
  WorkflowAttemptMetrics,
  WorkflowAttemptPause,
  WorkflowAttemptRecord,
  WorkflowRunRecord,
  WorkflowSnapshotRef
} from '../../shared/state/workflows'

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
  | 'unknown-worktree'
  | 'invalid-inputs'
  | 'missing-input'
  | 'hooks-consent'
  | 'starting'

export type StartRunResult = { ok: true; runId: string } | { ok: false; reason: StartRefusal }

export type WorkflowLog = (category: string, message: string, data?: Record<string, string>) => void

export interface WorkflowRunnerDeps {
  store: Pick<Store, 'dispatch' | 'getSnapshot'>
  loader: Pick<WorkflowDefsLoader, 'getDefinition'>
  drivers: Record<StepDriverKind, StepDriver>
  now: () => number
  newId: () => string
  log: WorkflowLog
  persist?: (run: WorkflowRunRecord) => void
  artifacts?: RunArtifacts
  hasExecution?: (executionId: string) => boolean
}

export interface RunSnapshotRequest {
  worktreePath: string
  runId: string
  stepId: string
  n: number
  parent?: string
}

export interface RunArtifacts {
  prepare(args: { worktreePath: string; runId: string }): Promise<void>
  snapshot(args: RunSnapshotRequest): Promise<WorkflowSnapshotRef>
  appendContext(args: { contextPath: string; section: string }): Promise<void>
  restore(args: { worktreePath: string; commit: string }): Promise<void>
}

export interface WorkflowExecutionStep {
  attemptId: string
  stepId: string
  output?: WorkflowOutputSchema
  ended: boolean
}

export type CompleteExecutionResult = { ok: true } | { ok: false; reason: 'not-a-step' | 'already-completed' }

export type StopCheckDecision = 'block' | 'none'

export type StepActionRefusal =
  | 'unknown-run'
  | 'wrong-step'
  | 'not-paused'
  | 'labs-off'
  | 'busy'
  | 'awaiting-approval'
  | 'live-attempt'
  | 'no-snapshot'
  | 'restore-failed'
  | 'not-claude-step'
  | 'not-interrupted'
  | 'no-session'
  | 'nothing-to-cancel'
  | 'not-completable'
  | 'starting'

export type StepActionResult =
  | { ok: true }
  | { ok: false; reason: StepActionRefusal }
  | { ok: false; reason: 'invalid-output'; errors: StepOutputFieldError[] }

export type MarkDoneRequest = WorkflowMarkDonePayload

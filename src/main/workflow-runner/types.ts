import type { Store } from '../store'
import type { WorkflowDefsLoader } from '../workflow-defs-loader'
import type { WorkflowRunRecord, WorkflowSnapshotRef } from '../../shared/state/workflows'
import type { StepDriver, StepDriverKind } from './drivers/types'

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
}

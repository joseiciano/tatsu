import type { Store } from '../store'
import type { WorkflowDefsLoader } from '../workflow-defs-loader'
import type {
  WorkflowInputTrust,
  WorkflowInputTrustType,
  WorkflowMarkDonePayload,
  WorkflowRunRecord,
  WorkflowSnapshotRef
} from '../../shared/state/workflows'
import type { StepDriver, StepDriverKind } from './drivers/types'
import type { TerminalTabWorkflow } from '../../shared/state/terminals'
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
  allowFull?: boolean
  overrides?: Record<string, StepOverrideRequest>
}

export interface StepOverrideRequest {
  agent?: string
  model?: string
}

export interface SwapStepRequest extends StepOverrideRequest {
  allowFull?: boolean
}

export type StartRefusal =
  | 'labs-off'
  | 'unknown-definition'
  | 'untrusted-definition'
  | 'invalid-definition'
  | 'unsupported-step'
  | 'invalid-overrides'
  | 'unsupported-agent'
  | 'full-permission-unconfirmed'
  | 'worktree-busy'
  | 'unknown-worktree'
  | 'invalid-inputs'
  | 'missing-input'
  | 'hooks-consent'
  | 'codex-hooks-untrusted'
  | 'parallel-writer'
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
  retagStepTab?: (worktreePath: string, tabId: string, workflow: TerminalTabWorkflow) => void
  inputTrust?: InputTrustFetcher
  inputTrustTimeoutMs?: number
}

export type InputTrustFetcher = (
  worktreePath: string,
  type: WorkflowInputTrustType,
  number: string
) => Promise<WorkflowInputTrust>

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
  | 'not-resumable-step'
  | 'not-interrupted'
  | 'no-session'
  | 'nothing-to-cancel'
  | 'not-completable'
  | 'not-agent-step'
  | 'not-swappable'
  | 'unsupported-agent'
  | 'invalid-override'
  | 'hooks-consent'
  | 'codex-hooks-untrusted'
  | 'full-permission-unconfirmed'
  | 'starting'
  | 'not-continuable-step'
  | 'nothing-to-continue'

export interface ContinueStepOptions {
  fresh?: boolean
}

export type StepActionResult =
  | { ok: true }
  | { ok: false; reason: StepActionRefusal }
  | { ok: false; reason: 'invalid-output'; errors: StepOutputFieldError[] }

export type MarkDoneRequest = WorkflowMarkDonePayload

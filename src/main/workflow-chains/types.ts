import type { Store } from '../store'
import type { StartRunRequest, StartRunResult, StepOverrideRequest, WorkflowLog } from '../workflow-runner'
import type { WorkflowChainMode, WorkflowRunChainOrigin } from '../../shared/state/workflows'

export const WORKFLOW_CHAIN_RECORD_VERSION = 1

export interface ChainItemRequest {
  title: string
  value: string
  origin?: WorkflowRunChainOrigin
}

export interface StartChainRequest {
  defId: string
  definitionName: string
  repoRoot: string
  mode: Extract<WorkflowChainMode, 'independent'>
  items: ChainItemRequest[]
  inputs: Record<string, string>
  overrides?: Record<string, StepOverrideRequest>
  autopilot?: boolean
  allowFull?: boolean
  draftPrs: boolean
}

export type ChainItemFailure = 'branch-invalid' | 'worktree-failed' | 'setup-failed' | 'start-refused' | 'start-threw'

export interface WorkflowChainItemRecord extends ChainItemRequest {
  id: string
  branch?: string
  baseBranch?: string
  worktreePath?: string
  runId?: string
  failed?: ChainItemFailure
}

export interface WorkflowChainRecord {
  version: typeof WORKFLOW_CHAIN_RECORD_VERSION
  chainId: string
  defId: string
  definitionName: string
  repoRoot: string
  mode: WorkflowChainMode
  draftPrs: boolean
  inputs: Record<string, string>
  overrides?: Record<string, StepOverrideRequest>
  autopilot?: true
  allowFull?: true
  items: WorkflowChainItemRecord[]
  startedAt: number
  finishedAt?: number
  status?: 'done' | 'failed' | 'cancelled'
}

export type ChainWorktreeResult =
  | { ok: true; worktreePath: string; baseBranch: string }
  | { ok: false; reason: Extract<ChainItemFailure, 'worktree-failed' | 'setup-failed'> }

export interface ChainSchedulerDeps {
  store: Pick<Store, 'dispatch' | 'getSnapshot' | 'subscribe'>
  createWorktree: (request: { repoRoot: string; branchName: string }) => Promise<ChainWorktreeResult>
  startRun: (request: StartRunRequest) => Promise<StartRunResult>
  persist: (record: WorkflowChainRecord) => void
  now: () => number
  newId: () => string
  newShortId: () => string
  log: WorkflowLog
}

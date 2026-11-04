import type { ResolvedDefinition, WorkflowAgent, WorkflowValidationResult } from '../../workflow-def'
import type { AgentKind } from '../terminals'

export type WorkflowScope = 'personal' | 'repo'

export interface WorkflowDefinitionSummary {
  id: string
  name: string
  scope: WorkflowScope
  repoRoot?: string
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
  | 'publish-failed'

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

export type WorkflowRunStepKind = 'agent' | 'shell'

export interface WorkflowRunStep {
  status: WorkflowStepStatus
  attemptIds: string[]
  kind?: WorkflowRunStepKind
  agent?: AgentKind
}

export interface WorkflowRunPr {
  number: number
  url: string
  draft: boolean
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
  budgetUsd?: number
  cursorStepId?: string
  pr?: WorkflowRunPr
  steps: Record<string, WorkflowRunStep>
}

export type WorkflowChainMode = 'independent' | 'stacked'

export interface WorkflowChainItem {
  id: string
  title: string
  branch?: string
  baseBranch?: string
  prNumber?: number
  prevItemId?: string
  skipped?: true
  failed?: true
}

export type WorkflowChainItemPatch = Pick<WorkflowChainItem, 'id'> & Partial<Omit<WorkflowChainItem, 'id'>>

export interface WorkflowChain {
  chainId: string
  defId: string
  repoRoot: string
  mode: WorkflowChainMode
  items: WorkflowChainItem[]
  draftPrs: boolean
  childRunIds: Record<string, string>
  startedAt: number
  finishedAt?: number
  budgetUsd?: number
}

export type WorkflowChainStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'

export type WorkflowChainFinalStatus = Extract<WorkflowChainStatus, 'done' | 'failed' | 'cancelled'>

export type WorkflowChainStatusResult =
  | { status: 'paused'; runId: string }
  | { status: Exclude<WorkflowChainStatus, 'paused'> }

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
  resumable?: true
}

export type WorkflowDefinitionsGroup = { scope: 'personal' } | { scope: 'repo'; repoRoot: string }

export type WorkflowDefinitionsGroupPayload = WorkflowDefinitionsGroup & {
  definitions: WorkflowDefinitionSummary[]
}

export interface WorkflowsState {
  definitions: Record<string, WorkflowDefinitionSummary>
  runs: Record<string, WorkflowRun>
  attempts: Record<string, WorkflowAttempt>
  trust: Record<string, string>
  chains: Record<string, WorkflowChain>
}

export type WorkflowsEvent =
  | {
      type: 'workflows/definitionsLoaded'
      payload: WorkflowDefinitionsGroupPayload
    }
  | { type: 'workflows/definitionSaved'; payload: WorkflowDefinitionSummary }
  | { type: 'workflows/definitionDeleted'; payload: { defId: string } }
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
  | { type: 'workflows/stepAgentChanged'; payload: { runId: string; stepId: string; agent: AgentKind } }
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
  | { type: 'workflows/cursorChanged'; payload: { runId: string; stepId: string } }
  | { type: 'workflows/attemptSessionRecorded'; payload: { attemptId: string } }
  | { type: 'workflows/attemptCostChanged'; payload: { attemptId: string; costUsd: number } }
  | { type: 'workflows/runBudgetChanged'; payload: { runId: string; budgetUsd: number } }
  | { type: 'workflows/trustGranted'; payload: { defId: string; hash: string } }
  | { type: 'workflows/gateResolved'; payload: { runId: string; stepId: string; decision: WorkflowGateDecision } }
  | { type: 'workflows/chainStarted'; payload: { chain: WorkflowChain } }
  | { type: 'workflows/chainItemsChanged'; payload: { chainId: string; items: WorkflowChainItemPatch[] } }
  | { type: 'workflows/chainChildRunLinked'; payload: { chainId: string; itemId: string; runId: string } }
  | {
      type: 'workflows/chainFinished'
      payload: { chainId: string; status: WorkflowChainFinalStatus; finishedAt: number }
    }
  | { type: 'workflows/prRecorded'; payload: { runId: string; pr: WorkflowRunPr } }

export type WorkflowGateDecision = 'approved' | 'autopilot' | 'changes-requested'

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
  sessionId?: string
  agent?: WorkflowAgent
  model?: string
  result?: StepResult
  baseSnapshot?: WorkflowSnapshotRef
  headSnapshot?: WorkflowSnapshotRef
  timeoutAt?: number
  metrics: WorkflowAttemptMetrics
}

export type WorkflowRunChainOriginKind = 'issue' | 'pr'

export interface WorkflowRunChainItem {
  id: string
  title: string
  value: string
  branch: string
  baseBranch: string
  number?: number
  url?: string
}

export interface WorkflowRunChainOrigin {
  kind: WorkflowRunChainOriginKind
  number: number
}

export interface WorkflowRunChain {
  chainId: string
  item: WorkflowRunChainItem
  origin?: WorkflowRunChainOrigin
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
  overriddenFrom?: Record<string, WorkflowStepHarness>
  inputsUntrusted?: boolean
  autopilot?: true
  budgetUsd?: number
  continuations?: Record<string, WorkflowContinuation>
  chain?: WorkflowRunChain
}

export interface WorkflowContinuation {
  prompt: string
  fresh?: true
}

export interface WorkflowStepHarness {
  agent: WorkflowAgent
  model?: string
}

export interface WorkflowStepOverride {
  agent?: WorkflowAgent
  model?: string
}

export interface WorkflowSwapStepPayload extends WorkflowStepOverride {
  allowFull?: boolean
}

export interface WorkflowStartRunPayload {
  defId: string
  worktreePath: string
  inputs: Record<string, string>
  allowFull?: boolean
  overrides?: Record<string, WorkflowStepOverride>
  autopilot?: boolean
  budgetUsd?: number
}

export interface WorkflowStartChainItemPayload {
  title: string
  value: string
  origin?: WorkflowRunChainOrigin
}

export interface WorkflowStartChainPayload {
  defId: string
  repoRoot: string
  mode: WorkflowChainMode
  items: WorkflowStartChainItemPayload[]
  inputs: Record<string, string>
  overrides?: Record<string, WorkflowStepOverride>
  autopilot?: boolean
  allowFull?: boolean
  draftPrs?: boolean
}

export interface WorkflowMarkDonePayload {
  summary: string
  fields: Record<string, unknown>
}

export interface WorkflowRequestChangesPayload {
  feedback: string
  fresh: boolean
}

export type WorkflowLoopCapAction = 'again' | 'continue'

export type WorkflowStartRunResponse = { runId: string } | { error: string }

export type WorkflowStartChainResponse = { chainId: string } | { error: string }

export type WorkflowActionResponse = { ok: true } | { error: string }

export type WorkflowDefinitionSaveResponse = { defId: string } | { error: string }

export type WorkflowSaveDefinitionPayload = ({ scope: 'personal' } | { scope: 'repo'; repoRoot: string }) & {
  defId?: string
  name: string
  source: string
}

export type WorkflowInputTrustType = 'issue' | 'pr'

export type WorkflowInputTrust = 'trusted' | 'untrusted'

export type WorkflowInputTrustResponse = { trusted: boolean } | { error: string }

export interface WorkflowAttemptChangedFile {
  path: string
  status: 'added' | 'modified' | 'deleted'
  additions: number | null
  deletions: number | null
}

export type WorkflowAttemptChangedFilesResponse =
  | { files: WorkflowAttemptChangedFile[]; truncated: boolean }
  | { error: string }

export type WorkflowAttemptFileDiffResponse = { original: string; modified: string } | { error: string }

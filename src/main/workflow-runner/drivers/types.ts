import type { ResolvedAgentStep, ResolvedShellStep, TemplateScope } from '../../../shared/workflow-def'
import type { WorkflowPausedReason } from '../../../shared/state/workflows'

export const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type RunnableStep = ResolvedAgentStep | ResolvedShellStep

export type StepDriverKind = RunnableStep['kind']

export interface StepAttempt {
  runId: string
  stepId: string
  attemptId: string
  n: number
  worktreePath: string
  inputs: Record<string, string>
  step: RunnableStep
  scope: TemplateScope
  resumeSessionId?: string
  bind(execution: StepExecution): boolean
}

export interface StepExecution {
  executionId: string
  sessionId?: string
}

export type StepDriverEvent =
  | { type: 'turnEnded'; executionId: string; lastMessage?: string; continued?: boolean }
  | { type: 'promptSubmitted'; executionId: string }
  | { type: 'exited'; executionId: string; code: number | null; summary?: string }
  | { type: 'needsApproval'; executionId: string }
  | { type: 'sessionDiscovered'; executionId: string; sessionId: string }

export type StepDriverListener = (event: StepDriverEvent) => void

export interface StepDriver {
  start(attempt: StepAttempt): Promise<StepExecution> | StepExecution
  continue(executionId: string, prompt: string): void
  cancel(executionId: string): void
  release?(executionId: string): void
  onEvent(listener: StepDriverListener): () => void
}

export class StepStartError extends Error {
  constructor(readonly summary: string) {
    super(summary)
    this.name = 'StepStartError'
  }
}

export type StepPauseReason = Extract<WorkflowPausedReason, 'needs-input' | 'trust'>

export class StepPauseError extends Error {
  constructor(
    readonly reason: StepPauseReason,
    readonly summary: string
  ) {
    super(summary)
    this.name = 'StepPauseError'
  }
}

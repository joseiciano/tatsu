import type { ResolvedAgentStep, ResolvedShellStep, TemplateScope } from '../../../shared/workflow-def'

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
}

export interface StepExecution {
  executionId: string
}

export type StepDriverEvent =
  | { type: 'turnEnded'; executionId: string; lastMessage?: string }
  | { type: 'exited'; executionId: string; code: number | null }

export type StepDriverListener = (event: StepDriverEvent) => void

export interface StepDriver {
  start(attempt: StepAttempt): Promise<StepExecution> | StepExecution
  continue(executionId: string, prompt: string): void
  cancel(executionId: string): void
  onEvent(listener: StepDriverListener): () => void
}

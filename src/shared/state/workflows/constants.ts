import type { AgentKind } from '../terminals'
import { WORKFLOW_FEATURES, type WorkflowAgent } from '../../workflow-def'

export const SUMMARY_PREVIEW_MAX = 200
export const RECENT_RUNS_MAX = 50
export const WORKFLOW_RUN_RECORD_VERSION = 1
export const RESUMABLE_AGENTS: ReadonlySet<AgentKind> = new Set<AgentKind>(['claude', 'codex', 'opencode'])
export const WORKFLOW_STEP_MODEL_MAX_CHARS = 200
export const STEP_HARNESS_AGENTS: readonly WorkflowAgent[] = [
  'claude',
  ...(WORKFLOW_FEATURES['agent-codex'].supported ? (['codex'] as const) : []),
  ...(WORKFLOW_FEATURES['agent-opencode'].supported ? (['opencode'] as const) : [])
]

export function isStepHarnessAgent(value: unknown): value is WorkflowAgent {
  return typeof value === 'string' && STEP_HARNESS_AGENTS.some((agent) => agent === value)
}

export function isWorkflowStepModel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value.length <= WORKFLOW_STEP_MODEL_MAX_CHARS &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

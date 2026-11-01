import type { StepOutputStatus, WorkflowFeature, WorkflowFeatureInfo } from './types'

export const WORKFLOW_FEATURES: Readonly<Record<WorkflowFeature, WorkflowFeatureInfo>> = {
  'agent-codex': { phase: 3, message: 'Codex steps ("agent: codex") need phase 3', supported: false },
  'agent-opencode': { phase: 3, message: 'opencode steps ("agent: opencode") need phase 3', supported: false },
  gate: { phase: 4, message: 'Gates ("gate") need phase 4', supported: false },
  loop: { phase: 4, message: 'Loops ("loop") need phase 4', supported: false },
  when: { phase: 4, message: 'Conditional steps ("when") need phase 4', supported: false },
  on_loop: { phase: 4, message: 'Loop re-entry prompts ("on_loop") need phase 4', supported: false },
  'nonlinear-needs': { phase: 4, message: 'Non-linear "needs" (parallel branches or skipped predecessors) need phase 4', supported: false },
  parallel_safe: { phase: 4, message: 'Parallel shell steps ("parallel_safe") need phase 4', supported: false },
  timeout: { phase: 4, message: 'Step timeouts ("timeout") need phase 4', supported: false },
  item_input: { phase: 5, message: 'Batch launches ("item_input") need phase 5', supported: false },
  foreach: { phase: 6, message: 'Foreach steps ("kind: foreach") need phase 6', supported: false },
  orchestrator: { phase: 8, message: 'Orchestrator steps ("kind: orchestrator") need phase 8', supported: false }
}

export const ALL_WORKFLOW_FEATURES: readonly WorkflowFeature[] = Object.keys(WORKFLOW_FEATURES).filter(
  (id): id is WorkflowFeature => Object.hasOwn(WORKFLOW_FEATURES, id)
)

export const BASELINE_SUPPORTED_FEATURES: readonly WorkflowFeature[] = ALL_WORKFLOW_FEATURES.filter((id) => WORKFLOW_FEATURES[id].supported)

export const STEP_OUTPUT_STATUSES: readonly StepOutputStatus[] = ['done', 'failed', 'needs-input']

export const STEP_OUTPUT_RESERVED_KEYS: ReadonlySet<string> = new Set(['status', 'summary'])

export const STEP_OUTPUT_FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

export const STEP_SUMMARY_MAX_CHARS = 16384

export const STEP_OUTPUT_STRING_MAX_CHARS = 16384

export const STEP_OUTPUT_ARRAY_MAX_ITEMS = 256

export const STEP_OUTPUT_MAX_ERRORS = 20

export const STEP_OUTPUT_FIELD_NAME_MAX_CHARS = 64

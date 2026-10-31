import type { WorkflowValidationResult } from '../../workflow-def'

export type WorkflowScope = 'personal'

export interface WorkflowDefinitionSummary {
  id: string
  name: string
  scope: WorkflowScope
  path: string
  hash: string
  stepIds: string[]
  issues: string[]
}

export interface WorkflowDefinitionDetail extends WorkflowValidationResult {
  summary: WorkflowDefinitionSummary
  source: string
}

export interface WorkflowsState {
  definitions: Record<string, WorkflowDefinitionSummary>
}

export type WorkflowsEvent = {
  type: 'workflows/definitionsLoaded'
  payload: { scope: WorkflowScope; definitions: WorkflowDefinitionSummary[] }
}

export const initialWorkflows: WorkflowsState = {
  definitions: {}
}

function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i])
}

function sameSummary(a: WorkflowDefinitionSummary, b: WorkflowDefinitionSummary): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.scope === b.scope &&
    a.path === b.path &&
    a.hash === b.hash &&
    sameStrings(a.stepIds, b.stepIds) &&
    sameStrings(a.issues, b.issues)
  )
}

function definitionsLoaded(
  state: WorkflowsState,
  scope: WorkflowScope,
  incoming: WorkflowDefinitionSummary[]
): WorkflowsState {
  const definitions: Record<string, WorkflowDefinitionSummary> = {}
  let changed = false
  for (const [id, existing] of Object.entries(state.definitions)) {
    if (existing.scope !== scope) definitions[id] = existing
  }
  for (const next of incoming) {
    const existing = state.definitions[next.id]
    if (existing && sameSummary(existing, next)) {
      definitions[next.id] = existing
    } else {
      definitions[next.id] = next
      changed = true
    }
  }
  if (!changed && Object.keys(definitions).length === Object.keys(state.definitions).length) {
    return state
  }
  return { definitions }
}

export function workflowsReducer(state: WorkflowsState, event: WorkflowsEvent): WorkflowsState {
  switch (event.type) {
    case 'workflows/definitionsLoaded':
      return definitionsLoaded(state, event.payload.scope, event.payload.definitions)
    default: {
      const _exhaustive: never = event.type
      void _exhaustive
      return state
    }
  }
}

import { SUMMARY_PREVIEW_MAX } from './constants'
import type {
  WorkflowDefinitionSummary,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowRunStep,
  WorkflowScope,
  WorkflowStepStatus,
  WorkflowsEvent,
  WorkflowsState
} from './types'

export const initialWorkflows: WorkflowsState = {
  definitions: {},
  runs: {},
  attempts: {}
}

const TERMINAL_RUN_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set(['done', 'failed', 'cancelled'])

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
  return { ...state, definitions }
}

function withoutPausedReason(run: WorkflowRun): WorkflowRun {
  if (!('pausedReason' in run)) return run
  const next = { ...run }
  delete next.pausedReason
  return next
}

function patchRun(state: WorkflowsState, runId: string, run: WorkflowRun): WorkflowsState {
  return { ...state, runs: { ...state.runs, [runId]: run } }
}

function patchStep(run: WorkflowRun, stepId: string, step: WorkflowRunStep): WorkflowRun {
  return { ...run, steps: { ...run.steps, [stepId]: step } }
}

function isTerminalRun(state: WorkflowsState, runId: string): boolean {
  const run = state.runs[runId]
  return run !== undefined && TERMINAL_RUN_STATUSES.has(run.status)
}

function previewOf(summary: string): string {
  if (summary.length <= SUMMARY_PREVIEW_MAX) return summary
  const last = summary.charCodeAt(SUMMARY_PREVIEW_MAX - 1)
  const end = last >= 0xd800 && last <= 0xdbff ? SUMMARY_PREVIEW_MAX - 1 : SUMMARY_PREVIEW_MAX
  return summary.slice(0, end)
}

function setStepStatus(
  state: WorkflowsState,
  runId: string,
  stepId: string,
  status: WorkflowStepStatus
): WorkflowsState {
  const run = state.runs[runId]
  const step = run?.steps[stepId]
  if (!step || step.status === status || TERMINAL_RUN_STATUSES.has(run.status)) return state
  return patchRun(state, runId, patchStep(run, stepId, { ...step, status }))
}

export function workflowsReducer(state: WorkflowsState, event: WorkflowsEvent): WorkflowsState {
  switch (event.type) {
    case 'workflows/definitionsLoaded':
      return definitionsLoaded(state, event.payload.scope, event.payload.definitions)
    case 'workflows/runStarted': {
      const { runId, run } = event.payload
      if (state.runs[runId]) return state
      return patchRun(state, runId, run)
    }
    case 'workflows/runPaused': {
      const { runId, reason } = event.payload
      const run = state.runs[runId]
      if (
        !run ||
        TERMINAL_RUN_STATUSES.has(run.status) ||
        (run.status === 'paused' && run.pausedReason === reason)
      ) {
        return state
      }
      return patchRun(state, runId, { ...run, status: 'paused', pausedReason: reason })
    }
    case 'workflows/runResumed': {
      const { runId } = event.payload
      const run = state.runs[runId]
      if (!run || run.status !== 'paused') return state
      return patchRun(state, runId, { ...withoutPausedReason(run), status: 'running' })
    }
    case 'workflows/runCancelled': {
      const { runId, finishedAt } = event.payload
      const run = state.runs[runId]
      if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return state
      return patchRun(state, runId, {
        ...withoutPausedReason(run),
        status: 'cancelled',
        finishedAt
      })
    }
    case 'workflows/runFinished': {
      const { runId, status, finishedAt, costUsd } = event.payload
      const run = state.runs[runId]
      if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return state
      return patchRun(state, runId, {
        ...withoutPausedReason(run),
        status,
        finishedAt,
        ...(costUsd === undefined ? {} : { costUsd })
      })
    }
    case 'workflows/stepQueued':
      return setStepStatus(state, event.payload.runId, event.payload.stepId, 'queued')
    case 'workflows/stepStarted':
      return setStepStatus(state, event.payload.runId, event.payload.stepId, 'running')
    case 'workflows/stepSkipped':
      return setStepStatus(state, event.payload.runId, event.payload.stepId, 'skipped')
    case 'workflows/stepStatusChanged':
      return setStepStatus(
        state,
        event.payload.runId,
        event.payload.stepId,
        event.payload.status
      )
    case 'workflows/attemptStarted': {
      const { attemptId, runId, stepId, n, startedAt } = event.payload
      const run = state.runs[runId]
      const step = run?.steps[stepId]
      if (!step || state.attempts[attemptId] || TERMINAL_RUN_STATUSES.has(run.status)) return state
      const nextRun = patchStep(run, stepId, {
        ...step,
        attemptIds: [...step.attemptIds, attemptId]
      })
      return {
        ...state,
        runs: { ...state.runs, [runId]: nextRun },
        attempts: {
          ...state.attempts,
          [attemptId]: { runId, stepId, n, status: 'running', summaryPreview: '', startedAt }
        }
      }
    }
    case 'workflows/attemptEnded': {
      const { attemptId, status, endedAt, summary, completedBy, costUsd } = event.payload
      const attempt = state.attempts[attemptId]
      if (!attempt || attempt.endedAt !== undefined || isTerminalRun(state, attempt.runId)) {
        return state
      }
      return {
        ...state,
        attempts: {
          ...state.attempts,
          [attemptId]: {
            ...attempt,
            status,
            endedAt,
            summaryPreview: previewOf(summary),
            ...(completedBy === undefined ? {} : { completedBy }),
            ...(costUsd === undefined ? {} : { costUsd })
          }
        }
      }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

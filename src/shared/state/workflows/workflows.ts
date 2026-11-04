import type { ResolvedAgentStep, ResolvedDefinition, ResolvedWorkflowStep } from '../../workflow-def'
import { RECENT_RUNS_MAX, SUMMARY_PREVIEW_MAX, isStepHarnessAgent, isWorkflowStepModel } from './constants'
import type {
  WorkflowAttempt,
  WorkflowDefinitionsGroup,
  WorkflowDefinitionsGroupPayload,
  WorkflowDefinitionSummary,
  WorkflowRun,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowRunStep,
  WorkflowStepHarness,
  WorkflowStepStatus,
  WorkflowsEvent,
  WorkflowsState
} from './types'

export const initialWorkflows: WorkflowsState = {
  definitions: {},
  runs: {},
  attempts: {},
  trust: {}
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
    a.repoRoot === b.repoRoot &&
    a.path === b.path &&
    a.hash === b.hash &&
    sameStrings(a.stepIds, b.stepIds) &&
    sameStrings(a.issues, b.issues)
  )
}

function inGroup(summary: WorkflowDefinitionSummary, group: WorkflowDefinitionsGroup): boolean {
  if (summary.scope !== group.scope) return false
  return group.scope === 'personal' || summary.repoRoot === group.repoRoot
}

function definitionsLoaded(state: WorkflowsState, payload: WorkflowDefinitionsGroupPayload): WorkflowsState {
  const definitions: Record<string, WorkflowDefinitionSummary> = {}
  let changed = false
  for (const [id, existing] of Object.entries(state.definitions)) {
    if (!inGroup(existing, payload)) definitions[id] = existing
  }
  for (const next of payload.definitions) {
    if (!inGroup(next, payload)) continue
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

export function runsToEvict(state: WorkflowsState, max: number): string[] {
  const finished: Array<{ runId: string; finishedAt: number }> = []
  for (const [runId, run] of Object.entries(state.runs)) {
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      finished.push({ runId, finishedAt: run.finishedAt ?? run.startedAt })
    }
  }
  if (finished.length <= max) return []
  finished.sort((a, b) => a.finishedAt - b.finishedAt || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0))
  return finished.slice(0, finished.length - max).map((entry) => entry.runId)
}

export function runStepFacts(step: ResolvedWorkflowStep): Pick<WorkflowRunStep, 'kind' | 'agent'> {
  if (step.kind === 'agent') return { kind: 'agent', agent: step.agent }
  if (step.kind === 'shell') return { kind: 'shell' }
  return {}
}

export interface StepOverrideInput {
  agent?: string
  model?: string
}

export type StepOverrideResult =
  | { ok: true; step: ResolvedAgentStep }
  | { ok: false; reason: 'unsupported-agent' | 'invalid-override' }

export type AppliedStepOverrides =
  | { ok: true; definition: ResolvedDefinition; overriddenFrom?: Record<string, WorkflowStepHarness> }
  | { ok: false; reason: 'invalid-overrides' | 'unsupported-agent' }

export function harnessOf(step: ResolvedAgentStep): WorkflowStepHarness {
  return { agent: step.agent, ...(step.model === undefined ? {} : { model: step.model }) }
}

export function overriddenStep(step: ResolvedAgentStep, override: StepOverrideInput): StepOverrideResult {
  const agent = override.agent ?? step.agent
  if (!isStepHarnessAgent(agent)) return { ok: false, reason: 'unsupported-agent' }
  if (override.model !== undefined && !isWorkflowStepModel(override.model)) return { ok: false, reason: 'invalid-override' }
  const model = override.model ?? (agent === step.agent ? step.model : undefined)
  const next: ResolvedAgentStep = { ...step, agent }
  if (model === undefined) delete next.model
  else next.model = model
  return { ok: true, step: next }
}

export function applyOverrides(
  definition: ResolvedDefinition,
  overrides: Record<string, StepOverrideInput> | undefined
): AppliedStepOverrides {
  const ids = overrides ? Object.keys(overrides) : []
  if (!overrides || ids.length === 0) return { ok: true, definition }
  const agentStepIds = new Set(definition.steps.filter((step) => step.kind === 'agent').map((step) => step.id))
  if (!ids.every((id) => agentStepIds.has(id))) return { ok: false, reason: 'invalid-overrides' }
  const overriddenFrom: Record<string, WorkflowStepHarness> = {}
  const steps: ResolvedWorkflowStep[] = []
  for (const step of definition.steps) {
    if (step.kind !== 'agent' || !Object.hasOwn(overrides, step.id)) {
      steps.push(step)
      continue
    }
    const result = overriddenStep(step, overrides[step.id])
    if (!result.ok) return { ok: false, reason: result.reason === 'unsupported-agent' ? result.reason : 'invalid-overrides' }
    overriddenFrom[step.id] = harnessOf(step)
    steps.push(result.step)
  }
  return { ok: true, definition: { ...definition, steps }, overriddenFrom }
}

export function capStepPermissions<T extends ResolvedWorkflowStep>(step: T): T {
  return step.kind === 'agent' && step.permissions === 'full' ? { ...step, permissions: 'edit' } : step
}

export function capPermissions(definition: ResolvedDefinition): ResolvedDefinition {
  if (!definition.steps.some((step) => step.kind === 'agent' && step.permissions === 'full')) return definition
  return { ...definition, steps: definition.steps.map(capStepPermissions) }
}

export function projectRunRecord(record: WorkflowRunRecord): {
  run: WorkflowRun
  attempts: Record<string, WorkflowAttempt>
} {
  const definitionSteps = new Map(record.definition.steps.map((step) => [step.id, step]))
  const steps: Record<string, WorkflowRunStep> = {}
  for (const [stepId, status] of Object.entries(record.steps)) {
    const step = definitionSteps.get(stepId)
    steps[stepId] = { status, attemptIds: [], ...(step ? runStepFacts(step) : {}) }
  }
  const attempts: Record<string, WorkflowAttempt> = {}
  for (const attempt of record.attempts) {
    steps[attempt.stepId]?.attemptIds.push(attempt.attemptId)
    const ended = attempt.endedAt !== undefined
    const result = ended && attempt.result?.status !== 'needs-input' ? attempt.result : undefined
    attempts[attempt.attemptId] = {
      runId: record.runId,
      stepId: attempt.stepId,
      n: attempt.n,
      status: attempt.status,
      summaryPreview: previewOf(result?.summary ?? ''),
      startedAt: attempt.startedAt,
      ...(ended ? { endedAt: attempt.endedAt } : {}),
      ...(result ? { completedBy: result.completedBy } : {}),
      ...(result?.costUsd === undefined ? {} : { costUsd: result.costUsd }),
      ...(attempt.sessionId === undefined ? {} : { resumable: true })
    }
  }
  const cursorStepId = record.definition.steps[record.cursor]?.id
  const run: WorkflowRun = {
    defId: record.defId,
    defHash: record.defHash,
    worktreePath: record.worktreePath,
    status: record.status,
    ...(record.pausedReason === undefined ? {} : { pausedReason: record.pausedReason }),
    startedAt: record.startedAt,
    ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
    ...(cursorStepId === undefined ? {} : { cursorStepId }),
    steps
  }
  return { run, attempts }
}

export function hydrateWorkflowRuns(
  records: readonly WorkflowRunRecord[]
): Pick<WorkflowsState, 'runs' | 'attempts'> {
  const hydrated: WorkflowsState = { ...initialWorkflows, runs: {}, attempts: {} }
  for (const record of records) {
    const projected = projectRunRecord(record)
    hydrated.runs[record.runId] = projected.run
    Object.assign(hydrated.attempts, projected.attempts)
  }
  const { runs, attempts } = evictRuns(hydrated, runsToEvict(hydrated, RECENT_RUNS_MAX))
  return { runs, attempts }
}

function evictRuns(state: WorkflowsState, runIds: string[]): WorkflowsState {
  const evicted = new Set(runIds.filter((runId) => Object.hasOwn(state.runs, runId)))
  if (evicted.size === 0) return state
  const runs: Record<string, WorkflowRun> = {}
  for (const [runId, run] of Object.entries(state.runs)) {
    if (!evicted.has(runId)) runs[runId] = run
  }
  const attempts: WorkflowsState['attempts'] = {}
  for (const [attemptId, attempt] of Object.entries(state.attempts)) {
    if (!evicted.has(attempt.runId)) attempts[attemptId] = attempt
  }
  return { ...state, runs, attempts }
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
      return definitionsLoaded(state, event.payload)
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
    case 'workflows/stepAgentChanged': {
      const { runId, stepId, agent } = event.payload
      const run = state.runs[runId]
      const step = run?.steps[stepId]
      if (!step || step.kind !== 'agent' || step.agent === agent || TERMINAL_RUN_STATUSES.has(run.status)) return state
      return patchRun(state, runId, patchStep(run, stepId, { ...step, agent }))
    }
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
    case 'workflows/runsEvicted':
      return evictRuns(state, event.payload.runIds)
    case 'workflows/cursorChanged': {
      const { runId, stepId } = event.payload
      const run = state.runs[runId]
      if (
        !run ||
        run.cursorStepId === stepId ||
        !Object.hasOwn(run.steps, stepId) ||
        TERMINAL_RUN_STATUSES.has(run.status)
      ) {
        return state
      }
      return patchRun(state, runId, { ...run, cursorStepId: stepId })
    }
    case 'workflows/attemptSessionRecorded': {
      const { attemptId } = event.payload
      const attempt = state.attempts[attemptId]
      if (!attempt || attempt.resumable || isTerminalRun(state, attempt.runId)) return state
      return { ...state, attempts: { ...state.attempts, [attemptId]: { ...attempt, resumable: true } } }
    }
    case 'workflows/trustGranted': {
      const { defId, hash } = event.payload
      if (state.trust[defId] === hash) return state
      return { ...state, trust: { ...state.trust, [defId]: hash } }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

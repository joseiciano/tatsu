import type {
  CompleteExecutionResult,
  ContinueStepOptions,
  MarkDoneRequest,
  RequestChangesRequest,
  StepActionRefusal,
  StepActionResult,
  WorkflowExecutionStep,
  WorkflowAttemptRecord,
  WorkflowRunRecord,
  WorkflowRunnerDeps,
  StartRefusal,
  StartRunRequest,
  StartRunResult,
  StepResult,
  StopCheckDecision,
  SwapStepRequest
} from './types'
import {
  isAgentSessionId,
  sanitizePasteText,
  StepPauseError,
  StepStartError,
  type RunnableStep,
  type StepAttempt,
  type StepDriverEvent,
  type StepDriverKind,
  type StepExecution
} from './drivers'
import { runContextPath } from './run-artifacts'
import {
  STEP_SUMMARY_MAX_CHARS,
  parallelWriterPairs,
  validateStepOutput,
  type ResolvedAgentStep,
  type ResolvedDefinition,
  type ResolvedWorkflowStep,
  type StepOutputValidation,
  type StepOutputValue,
  type TemplateScope,
  type TemplateStepScope
} from '../../shared/workflow-def'
import type { StateEvent } from '../../shared/state'
import {
  RECENT_RUNS_MAX,
  RESUMABLE_AGENTS,
  WORKFLOW_RUN_RECORD_VERSION,
  applyOverrides,
  capPermissions,
  harnessOf,
  isWorkflowInputNumber,
  overriddenStep,
  runStepFacts,
  runsToEvict,
  type AppliedStepOverrides,
  type WorkflowAttemptStatus,
  type WorkflowContinuation,
  type WorkflowDefinitionDetail,
  type WorkflowInputTrust,
  type WorkflowInputTrustType,
  type WorkflowPausedReason,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowRunStep,
  type WorkflowSnapshotRef,
  type WorkflowStepStatus
} from '../../shared/state/workflows'

const ENDED_EXECUTIONS_MAX = 256
const CONTINUATION_PROMPT_MAX_CHARS = 1024 * 1024
const INPUT_TRUST_TIMEOUT_MS = 10_000
export const RUN_INPUTS_MAX = 64
export const RUN_INPUT_VALUE_MAX_CHARS = 64 * 1024

const ACTION_OK: StepActionResult = { ok: true }

const TERMINAL_RUN_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set(['done', 'failed', 'cancelled'])

const SWAPPABLE_ATTEMPT_STATUSES: ReadonlySet<WorkflowAttemptStatus> = new Set(['failed', 'cancelled', 'interrupted'])

const SETTLED_STEP_STATUSES: ReadonlySet<WorkflowStepStatus> = new Set(['done', 'skipped'])

interface LiveAttempt {
  record: WorkflowAttemptRecord
  kind: StepDriverKind
  executionId?: string
  blockPending?: boolean
  continuedThisTurn?: boolean
  staleStops?: boolean
}

interface RunState {
  record: WorkflowRunRecord
  stepStatus: Record<string, WorkflowStepStatus>
  live: Map<string, LiveAttempt>
  pauses: Map<string, WorkflowPausedReason>
  io: Promise<boolean>
  lastSnapshot?: string
  busy?: boolean
}

interface ActionTarget {
  state: RunState
  step: RunnableStep
}

type SnapshotSlot = 'baseSnapshot' | 'headSnapshot'

interface LaunchOptions {
  resumeSessionId?: string
  prompt?: string
}

interface QueueEntry extends LaunchOptions {
  runId: string
  stepId: string
  continuation?: WorkflowContinuation
}

function capSummary(text: string): string {
  if (text.length <= STEP_SUMMARY_MAX_CHARS) return text
  const last = text.charCodeAt(STEP_SUMMARY_MAX_CHARS - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? STEP_SUMMARY_MAX_CHARS - 1 : STEP_SUMMARY_MAX_CHARS)
}

function inputsRefusal(definition: ResolvedDefinition, inputs: Record<string, unknown>): StartRefusal | null {
  const keys = Object.keys(inputs)
  if (keys.length > RUN_INPUTS_MAX) return 'invalid-inputs'
  for (const key of keys) {
    const value = inputs[key]
    if (!Object.hasOwn(definition.inputs, key)) return 'invalid-inputs'
    if (typeof value !== 'string' || value.length > RUN_INPUT_VALUE_MAX_CHARS) return 'invalid-inputs'
  }
  for (const name of Object.keys(definition.inputs)) {
    const value = Object.hasOwn(inputs, name) ? inputs[name] : undefined
    if (typeof value !== 'string' || value.trim() === '') return 'missing-input'
  }
  return null
}

interface InputTrustLookup {
  name: string
  type: WorkflowInputTrustType
  number: string
}

function trustLookups(definition: ResolvedDefinition, inputs: Record<string, string>): InputTrustLookup[] {
  const lookups: InputTrustLookup[] = []
  for (const [name, input] of Object.entries(definition.inputs)) {
    if (input.type === 'issue' || input.type === 'pr') lookups.push({ name, type: input.type, number: inputs[name] })
  }
  return lookups
}

function userOutput(step: RunnableStep, request: MarkDoneRequest): StepOutputValidation {
  const schema = step.kind === 'agent' ? step.output : undefined
  const declared = schema?.fields ?? {}
  const undeclared = Object.keys(request.fields).some(
    (key) => key === 'status' || key === 'summary' || !Object.hasOwn(declared, key)
  )
  if (undeclared) return { ok: false, errors: [{ field: '', message: 'Fields must be declared step outputs' }] }
  if (typeof request.summary !== 'string') return { ok: false, errors: [{ field: 'summary', message: 'Expected a string' }] }
  return validateStepOutput(schema, { ...request.fields, summary: capSummary(request.summary) })
}

function storedContinuation(record: WorkflowRunRecord, stepId: string): WorkflowContinuation | undefined {
  const stored: unknown = record.continuations
  if (typeof stored !== 'object' || stored === null || !Object.hasOwn(stored, stepId)) return undefined
  const value: unknown = (stored as Record<string, unknown>)[stepId]
  if (typeof value !== 'object' || value === null) return undefined
  const { prompt, fresh } = value as Record<string, unknown>
  if (typeof prompt !== 'string' || prompt.length > CONTINUATION_PROMPT_MAX_CHARS) return undefined
  if (fresh !== undefined && fresh !== true) return undefined
  return fresh === true ? { prompt, fresh } : { prompt }
}

function withPreviousResult(prompt: string, previous: WorkflowAttemptRecord): string {
  return `${prompt}\n\nPrevious result:\n${previous.result?.summary ?? ''}`
}

function isRunnable(step: ResolvedWorkflowStep): step is RunnableStep {
  return step.kind === 'agent' || step.kind === 'shell'
}

function needsOf(steps: readonly ResolvedWorkflowStep[], index: number): readonly string[] {
  const { needs } = steps[index]
  if (Array.isArray(needs)) return needs
  return index === 0 ? [] : [steps[index - 1].id]
}

interface LiveStep {
  state: RunState
  live: LiveAttempt
}

export class WorkflowRunner {
  private readonly runs = new Map<string, RunState>()
  private readonly liveAttempts = new Map<string, string>()
  private readonly executions = new Map<string, string>()
  private readonly endedExecutions = new Map<string, { attemptId: string; stepId: string }>()
  private readonly agentSlots = new Set<string>()
  private queue: QueueEntry[] = []
  private ready = false
  private readonly unsubscribers: Array<() => void>
  private readonly persist: (run: WorkflowRunRecord) => void

  constructor(private readonly deps: WorkflowRunnerDeps) {
    this.persist = deps.persist ?? (() => {})
    this.unsubscribers = (['agent', 'shell'] as const).map((kind) =>
      deps.drivers[kind].onEvent((event) => this.onDriverEvent(kind, event))
    )
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe()
  }

  getRunRecord(runId: string): WorkflowRunRecord | null {
    const state = this.runs.get(runId)
    return state ? structuredClone(state.record) : null
  }

  runIdForAttempt(attemptId: string): string | undefined {
    for (const [runId, state] of this.runs) {
      if (state.record.attempts.some((attempt) => attempt.attemptId === attemptId)) return runId
    }
    return undefined
  }

  stepForExecution(executionId: string): WorkflowExecutionStep | null {
    if (!this.labsOn()) return null
    const live = this.liveAgentStep(executionId)
    if (live) {
      const { attemptId, stepId } = live.live.record
      const step = live.state.record.definition.steps.find((candidate) => candidate.id === stepId)
      if (step?.kind !== 'agent') return null
      return { attemptId, stepId, ...(step.output === undefined ? {} : { output: step.output }), ended: false }
    }
    const ended = this.endedExecutions.get(executionId)
    return ended ? { ...ended, ended: true } : null
  }

  completeExecution(executionId: string, value: StepOutputValue): CompleteExecutionResult {
    if (!this.labsOn()) return { ok: false, reason: 'not-a-step' }
    const live = this.liveAgentStep(executionId)
    if (!live) {
      return { ok: false, reason: this.endedExecutions.has(executionId) ? 'already-completed' : 'not-a-step' }
    }
    return this.complete(live.live.record.attemptId, { ...value, completedBy: 'tool' })
      ? { ok: true }
      : { ok: false, reason: 'already-completed' }
  }

  stopCheck(executionId: string, stopHookActive: boolean): StopCheckDecision {
    if (!this.labsOn()) return 'none'
    const found = this.liveAgentStep(executionId)
    if (!found || stopHookActive || found.live.continuedThisTurn || this.awaitingInput(found.state, found.live)) return 'none'
    const { state, live } = found
    const { record } = live
    live.continuedThisTurn = true
    live.blockPending = true
    record.metrics.continuations += 1
    if (state.pauses.get(record.stepId) === 'needs-approval') this.resume(state, record.stepId)
    this.log(`step continued ${record.metrics.continuations}`, {
      runId: state.record.runId,
      stepId: record.stepId,
      attemptId: record.attemptId
    })
    this.persist(state.record)
    return 'block'
  }

  liveExecutionIds(): string[] {
    return [...this.executions.keys()]
  }

  reconcile(records: readonly WorkflowRunRecord[]): void {
    try {
      this.reconcileRecords(records)
    } finally {
      this.ready = true
    }
  }

  private reconcileRecords(records: readonly WorkflowRunRecord[]): void {
    const adopted = records
      .filter((record) => !TERMINAL_RUN_STATUSES.has(record.status) && !this.runs.has(record.runId))
      .map((record) => this.adopt(structuredClone(record)))
      .sort(
        (a, b) =>
          a.record.startedAt - b.record.startedAt ||
          (a.record.runId < b.record.runId ? -1 : a.record.runId > b.record.runId ? 1 : 0)
      )
    const outcomes = new Map<RunState, string>()
    for (const state of adopted) {
      const queued = state.record.definition.steps.filter(
        (step): step is RunnableStep => isRunnable(step) && state.stepStatus[step.id] === 'queued'
      )
      const requeue = (): void => {
        for (const step of queued) {
          const continuation = storedContinuation(state.record, step.id)
          this.queue.push({ runId: state.record.runId, stepId: step.id, ...(continuation ? { continuation } : {}) })
        }
      }
      const dead = state.record.attempts.filter(
        (attempt) => attempt.status === 'running' && !this.liveAttempts.has(attempt.attemptId)
      )
      if (dead.length > 0) {
        for (const attempt of dead) this.interrupt(state, attempt)
        requeue()
        outcomes.set(state, 'interrupted')
        continue
      }
      if (state.record.status === 'paused' || state.live.size > 0) {
        requeue()
        outcomes.set(state, state.record.status === 'paused' ? 'paused' : 'attached')
        continue
      }
      const ready = this.firstReady(state)
      const waiting = queued.length > 0 ? queued : ready ? [ready] : []
      if (waiting.length > 0 && !this.labsOn()) {
        for (const step of waiting) this.hold(state, step)
        outcomes.set(state, 'held')
      } else if (queued.length > 0) {
        requeue()
        outcomes.set(state, 'requeued')
      } else if (ready || this.allSettled(state)) {
        this.schedule(state)
        outcomes.set(state, 'resumed')
      } else {
        outcomes.set(state, 'unchanged')
      }
    }
    this.drain()
    for (const [state, outcome] of outcomes) {
      if (outcome !== 'paused' && outcome !== 'attached' && outcome !== 'unchanged') this.persist(state.record)
      this.log(`run reconciled ${outcome}`, { runId: state.record.runId })
    }
  }

  async start(request: StartRunRequest): Promise<StartRunResult> {
    if (!this.labsOn()) return this.refuse('labs-off')
    if (!this.ready) return this.refuse('starting')
    const detail = this.deps.loader.getDefinition(request.defId)
    if (!detail) return this.refuse('unknown-definition')
    if (detail.summary.scope === 'repo' && !this.trusted(detail.summary.id, detail.summary.hash)) {
      return this.refuse('untrusted-definition')
    }
    if (!detail.definition) return this.refuse('invalid-definition')
    if (!detail.definition.steps.every(isRunnable)) return this.refuse('unsupported-step')
    const applied = applyOverrides(detail.definition, request.overrides)
    if (!applied.ok) return this.refuse(applied.reason)
    const badInputs = inputsRefusal(applied.definition, request.inputs)
    if (badInputs) return this.refuse(badInputs)
    const placement = this.placementRefusal(request.worktreePath, applied.definition)
    if (placement) return this.refuse(placement)
    const lookups = trustLookups(applied.definition, request.inputs)
    const verdicts =
      lookups.length === 0
        ? []
        : await Promise.all(lookups.map((lookup) => this.inputVerdict(request.worktreePath, lookup)))
    return this.createRun(request, detail, applied, lookups, verdicts)
  }

  private createRun(
    request: StartRunRequest,
    detail: WorkflowDefinitionDetail,
    applied: Extract<AppliedStepOverrides, { ok: true }>,
    lookups: readonly InputTrustLookup[],
    verdicts: readonly WorkflowInputTrust[]
  ): StartRunResult {
    const { store, now, newId } = this.deps
    if (!this.labsOn()) return this.refuse('labs-off')
    if (!this.ready) return this.refuse('starting')
    const placement = this.placementRefusal(request.worktreePath, applied.definition)
    if (placement) return this.refuse(placement)
    const inputsUntrusted = verdicts.some((verdict) => verdict !== 'trusted')
    const definition = inputsUntrusted ? capPermissions(applied.definition) : applied.definition
    if (parallelWriterPairs(definition.steps).length > 0) return this.refuse('parallel-writer')
    const { overriddenFrom } = applied
    const needsFull = definition.steps.some((step) => step.kind === 'agent' && step.permissions === 'full')
    if (needsFull && request.allowFull !== true) return this.refuse('full-permission-unconfirmed')

    const runId = newId()
    const steps: Record<string, WorkflowRunStep> = {}
    const stepStatus: Record<string, WorkflowStepStatus> = {}
    for (const step of definition.steps) {
      steps[step.id] = { status: 'pending', attemptIds: [], ...runStepFacts(step) }
      stepStatus[step.id] = 'pending'
    }
    const cursorStepId = definition.steps[0]?.id
    const run: WorkflowRun = {
      defId: detail.summary.id,
      defHash: detail.summary.hash,
      worktreePath: request.worktreePath,
      status: 'running',
      startedAt: now(),
      ...(cursorStepId === undefined ? {} : { cursorStepId }),
      steps
    }
    const state: RunState = {
      record: {
        version: WORKFLOW_RUN_RECORD_VERSION,
        runId,
        defId: run.defId,
        defHash: run.defHash,
        definition,
        inputs: { ...request.inputs },
        worktreePath: request.worktreePath,
        contextPath: runContextPath(request.worktreePath, runId),
        status: 'running',
        cursor: 0,
        steps: stepStatus,
        startedAt: run.startedAt,
        attempts: [],
        ...(overriddenFrom === undefined ? {} : { overriddenFrom }),
        ...(inputsUntrusted ? { inputsUntrusted } : {})
      },
      stepStatus,
      live: new Map(),
      pauses: new Map(),
      io: this.prepare(runId, request.worktreePath)
    }
    this.runs.set(runId, state)
    store.dispatch({ type: 'workflows/runStarted', payload: { runId, run } })
    this.log('run started', { runId })
    lookups.forEach(({ name, type, number }, i) =>
      this.log(`run input ${verdicts[i]}`, {
        runId,
        input: name,
        type,
        number: isWorkflowInputNumber(number) ? number : 'invalid'
      })
    )
    if (inputsUntrusted) this.log('run capped at edit permissions', { runId })
    for (const stepId of Object.keys(overriddenFrom ?? {})) this.logHarness('step overridden', state, stepId)
    this.schedule(state)
    this.settle(state)
    return { ok: true, runId }
  }

  complete(attemptId: string, completion: StepResult): boolean {
    const result: StepResult = { ...completion }
    const found = this.liveFor(attemptId)
    if (!found) {
      this.log('completion ignored', { attemptId })
      return false
    }
    const { state, live } = found
    const { stepId } = live.record
    this.log(`completion received ${result.status}`, { runId: state.record.runId, stepId, attemptId })
    if (result.status === 'needs-input') {
      live.record.result = result
      this.pause(state, stepId, 'needs-input')
    } else if (result.status === 'done' && this.gated(state, stepId)) {
      this.endAttempt(state, live, 'done', result, false)
      this.setStep(state, stepId, 'awaiting-gate')
      this.pause(state, stepId, 'gate')
    } else if (result.status === 'done') {
      this.resume(state, stepId)
      this.endAttempt(state, live, 'done', result, false)
      this.setStep(state, stepId, 'done')
      this.schedule(state)
    } else {
      this.endAttempt(state, live, 'failed', result, false)
      this.setStep(state, stepId, 'failed')
      this.pause(state, stepId, 'step-failed')
    }
    this.settle(state)
    return true
  }

  cancelRun(runId: string): StepActionResult {
    const state = this.runs.get(runId)
    if (!state) return this.refuseAction('unknown-run', { runId })
    if (state.busy) return this.refuseAction('busy', { runId })
    for (const queuedStepId of this.dequeueRun(runId)) this.setStep(state, queuedStepId, 'cancelled')
    for (const live of [...state.live.values()]) {
      this.endAttempt(state, live, 'cancelled', undefined, true)
      this.setStep(state, live.record.stepId, 'cancelled')
    }
    const finishedAt = this.deps.now()
    state.record.status = 'cancelled'
    state.record.finishedAt = finishedAt
    state.pauses.clear()
    delete state.record.pausedReason
    this.deps.store.dispatch({ type: 'workflows/runCancelled', payload: { runId, finishedAt } })
    this.log('run cancelled', { runId })
    this.runs.delete(runId)
    this.evictFinishedRuns()
    this.settle(state)
    return ACTION_OK
  }

  cancelStep(runId: string, stepId: string): StepActionResult {
    const target = this.actionTarget(runId, stepId)
    if (typeof target === 'string') return this.refuseAction(target, { runId, stepId })
    const { state } = target
    const live = state.live.get(stepId)
    if (live) {
      this.endAttempt(state, live, 'cancelled', undefined, true)
    } else if (!this.dequeue(runId, stepId)) {
      return this.refuseAction('nothing-to-cancel', { runId, stepId })
    }
    this.setStep(state, stepId, 'cancelled')
    this.pause(state, stepId, 'step-failed')
    this.settle(state)
    return ACTION_OK
  }

  retryStep(runId: string, stepId: string): StepActionResult {
    const target = this.retryTarget(runId, stepId)
    if (typeof target === 'string') return this.refuseAction(target, { runId, stepId })
    const { state, step } = target
    this.resume(state, stepId)
    const live = state.live.get(stepId)
    if (live) this.endAttempt(state, live, 'cancelled', undefined, true)
    this.enterStep(state, step)
    this.settle(state)
    return ACTION_OK
  }

  async retryFromClean(runId: string, stepId: string): Promise<StepActionResult> {
    const ids = { runId, stepId }
    const target = this.retryTarget(runId, stepId)
    if (typeof target === 'string') return this.refuseAction(target, ids)
    const { state } = target
    if (state.live.has(stepId)) return this.refuseAction('live-attempt', ids)
    const { artifacts } = this.deps
    const commit = this.lastAttempt(state, stepId)?.baseSnapshot?.commit
    if (!artifacts || commit === undefined) return this.refuseAction('no-snapshot', ids)
    const { worktreePath } = state.record
    state.busy = true
    const restored = await new Promise<boolean>((resolve) => {
      void this.queueIo(state, async () => {
        try {
          await artifacts.restore({ worktreePath, commit })
          resolve(true)
        } catch {
          resolve(false)
        }
      })
    })
    state.busy = false
    if (!restored) return this.refuseAction('restore-failed', ids)
    this.log('step restored to base snapshot', ids)
    const again = this.retryTarget(runId, stepId)
    if (typeof again === 'string') return this.refuseAction(again, ids)
    if (again.state.live.has(stepId)) return this.refuseAction('live-attempt', ids)
    this.resume(again.state, stepId)
    this.enterStep(again.state, again.step)
    this.settle(again.state)
    return ACTION_OK
  }

  resumeStep(runId: string, stepId: string): StepActionResult {
    const ids = { runId, stepId }
    const target = this.retryTarget(runId, stepId)
    if (typeof target === 'string') return this.refuseAction(target, ids)
    const { state, step } = target
    if (step.kind !== 'agent' || !RESUMABLE_AGENTS.has(step.agent)) return this.refuseAction('not-resumable-step', ids)
    if (state.live.has(stepId)) return this.refuseAction('live-attempt', ids)
    const last = this.lastAttempt(state, stepId)
    if (last?.status !== 'interrupted') return this.refuseAction('not-interrupted', ids)
    if (last.sessionId === undefined || !isAgentSessionId(step.agent, last.sessionId)) {
      return this.refuseAction('no-session', ids)
    }
    this.resume(state, stepId)
    this.enterStep(state, step, { resumeSessionId: last.sessionId })
    this.settle(state)
    return ACTION_OK
  }

  swapStep(runId: string, stepId: string, request: SwapStepRequest): StepActionResult {
    const ids = { runId, stepId }
    const target = this.retryTarget(runId, stepId)
    if (typeof target === 'string') return this.refuseAction(target, ids)
    const { state, step } = target
    if (step.kind !== 'agent') return this.refuseAction('not-agent-step', ids)
    if (state.live.has(stepId)) return this.refuseAction('live-attempt', ids)
    const last = this.lastAttempt(state, stepId)
    if (!last || !SWAPPABLE_ATTEMPT_STATUSES.has(last.status)) return this.refuseAction('not-swappable', ids)
    const override = overriddenStep(step, request)
    if (!override.ok) return this.refuseAction(override.reason, ids)
    const effective = override.step
    const hooksRefusal = this.agentHooksRefusal([effective])
    if (hooksRefusal) return this.refuseAction(hooksRefusal, ids)
    if (effective.permissions === 'full' && request.allowFull !== true) {
      return this.refuseAction('full-permission-unconfirmed', ids)
    }
    const { record } = state
    const steps = [...record.definition.steps]
    steps[steps.findIndex((candidate) => candidate.id === stepId)] = effective
    record.definition = { ...record.definition, steps }
    const overriddenFrom = record.overriddenFrom ?? {}
    if (!Object.hasOwn(overriddenFrom, stepId)) record.overriddenFrom = { ...overriddenFrom, [stepId]: harnessOf(step) }
    if (effective.agent !== step.agent) {
      this.deps.store.dispatch({ type: 'workflows/stepAgentChanged', payload: { runId, stepId, agent: effective.agent } })
    }
    this.logHarness('step swapped', state, stepId)
    this.resume(state, stepId)
    this.enterStep(state, effective)
    this.settle(state)
    return ACTION_OK
  }

  skipStep(runId: string, stepId: string): StepActionResult {
    const target = this.launchTarget(runId, stepId)
    if (typeof target === 'string') return this.refuseAction(target, { runId, stepId })
    const { state } = target
    this.resume(state, stepId)
    const live = state.live.get(stepId)
    if (live) this.endAttempt(state, live, 'cancelled', undefined, true)
    else this.dequeue(runId, stepId)
    this.setStep(state, stepId, 'skipped')
    this.schedule(state)
    this.settle(state)
    return ACTION_OK
  }

  markDone(runId: string, stepId: string, request: MarkDoneRequest): StepActionResult {
    const ids = { runId, stepId }
    const target = this.launchTarget(runId, stepId)
    if (typeof target === 'string') return this.refuseAction(target, ids)
    const { state, step } = target
    const status = state.stepStatus[stepId]
    const pausedEnded =
      state.pauses.has(stepId) && (status === 'failed' || status === 'cancelled' || status === 'interrupted')
    const live = state.live.get(stepId)
    if (!live && !pausedEnded) return this.refuseAction('not-completable', ids)
    const output = userOutput(step, request)
    if (!output.ok) {
      this.log('step action refused invalid-output', ids)
      return { ok: false, reason: 'invalid-output', errors: output.errors }
    }
    const { summary, data } = output.value
    const result: StepResult = { status: 'done', summary, completedBy: 'user', ...(data === undefined ? {} : { data }) }
    this.resume(state, stepId)
    if (live) this.endAttempt(state, live, 'done', result, true)
    else this.recordUserCompletion(state, step, result)
    this.setStep(state, stepId, 'done')
    this.log('step marked done', ids)
    this.schedule(state)
    this.settle(state)
    return ACTION_OK
  }

  approveGate(runId: string, stepId: string): StepActionResult {
    const ids = { runId, stepId }
    const target = this.gateTarget(runId, stepId)
    if (typeof target === 'string') return this.refuseAction(target, ids)
    const { state } = target
    state.stepStatus[stepId] = 'done'
    this.resume(state, stepId)
    this.deps.store.dispatch({ type: 'workflows/gateResolved', payload: { runId, stepId, decision: 'approved' } })
    this.log('gate approved', ids)
    this.schedule(state)
    this.settle(state)
    return ACTION_OK
  }

  requestChanges(runId: string, stepId: string, request: RequestChangesRequest): StepActionResult {
    const ids = { runId, stepId }
    const gate = this.gateTarget(runId, stepId)
    if (typeof gate === 'string') return this.refuseAction(gate, ids)
    const target = this.continueTarget(runId, stepId)
    if (typeof target === 'string') return this.refuseAction(target, ids)
    const { state, step } = target
    state.stepStatus[stepId] = 'pending'
    this.deps.store.dispatch({ type: 'workflows/gateResolved', payload: { runId, stepId, decision: 'changes-requested' } })
    this.log('gate changes requested', ids)
    const prompt = sanitizePasteText(request.feedback)
    this.applyContinue(state, step, request.fresh ? { prompt, fresh: true } : { prompt })
    return ACTION_OK
  }

  continueStep(runId: string, stepId: string, prompt: string, options: ContinueStepOptions = {}): StepActionResult {
    const target = this.continueTarget(runId, stepId)
    if (typeof target === 'string') return this.refuseAction(target, { runId, stepId })
    this.applyContinue(target.state, target.step, options.fresh === true ? { prompt, fresh: true } : { prompt })
    return ACTION_OK
  }

  private gateTarget(runId: string, stepId: string): { state: RunState } | StepActionRefusal {
    const state = this.runs.get(runId)
    if (!state || TERMINAL_RUN_STATUSES.has(state.record.status)) return 'unknown-run'
    if (!this.ready) return 'starting'
    if (!this.labsOn()) return 'labs-off'
    if (state.busy) return 'busy'
    if (!state.record.definition.steps.some((candidate) => candidate.id === stepId)) return 'wrong-step'
    if (state.stepStatus[stepId] !== 'awaiting-gate' || state.pauses.get(stepId) !== 'gate') return 'not-awaiting-gate'
    return { state }
  }

  private continueTarget(runId: string, stepId: string): { state: RunState; step: ResolvedAgentStep } | StepActionRefusal {
    const state = this.runs.get(runId)
    if (!state || TERMINAL_RUN_STATUSES.has(state.record.status)) return 'unknown-run'
    if (!this.ready) return 'starting'
    if (!this.labsOn()) return 'labs-off'
    if (state.busy) return 'busy'
    const step = state.record.definition.steps.find((candidate) => candidate.id === stepId)
    if (!step || !isRunnable(step)) return 'wrong-step'
    if (step.kind !== 'agent') return 'not-continuable-step'
    if (state.live.has(stepId) || state.stepStatus[stepId] === 'queued') return 'live-attempt'
    if (!this.lastAttempt(state, stepId)) return 'nothing-to-continue'
    return { state, step }
  }

  private applyContinue(state: RunState, step: ResolvedAgentStep, continuation: WorkflowContinuation): void {
    const { runId } = state.record
    const stepId = step.id
    const ids = { runId, stepId }
    this.resume(state, stepId)
    if (this.queue.length > 0 || this.agentSlots.size >= this.agentCap()) {
      this.queue.push({ runId, stepId, continuation })
      state.record.continuations = { ...state.record.continuations, [stepId]: continuation }
      this.setStep(state, stepId, 'queued')
      this.log('step continue queued', ids)
    } else {
      this.startContinuation(state, step, continuation)
    }
    this.settle(state)
  }

  private gated(state: RunState, stepId: string): boolean {
    return state.record.definition.steps.some((step) => step.id === stepId && step.gate === 'approve')
  }

  private startContinuation(state: RunState, step: ResolvedAgentStep, continuation: WorkflowContinuation): void {
    const ids = { runId: state.record.runId, stepId: step.id }
    this.clearContinuation(state, step.id)
    if (!this.labsOn()) {
      this.hold(state, step)
      return
    }
    const { prompt } = continuation
    const fresh = continuation.fresh === true
    const last = this.lastAttempt(state, step.id)
    const executionId = last?.executionId
    const reusable =
      !fresh &&
      last !== undefined &&
      executionId !== undefined &&
      !this.executions.has(executionId) &&
      (this.deps.hasExecution?.(executionId) ?? false)
    if (reusable && last !== undefined && executionId !== undefined) {
      this.rebind(state, step, last, executionId, prompt)
      return
    }
    const sessionId = fresh ? undefined : this.resumableSession(state, step)
    this.log(sessionId === undefined ? 'step continue fresh session' : 'step continue resumed session', ids)
    const previous = last === undefined ? prompt : withPreviousResult(prompt, last)
    this.launch(state, step, sessionId === undefined ? { prompt: previous } : { resumeSessionId: sessionId, prompt })
  }

  private clearContinuation(state: RunState, stepId: string): void {
    const stored = state.record.continuations
    if (!stored || !Object.hasOwn(stored, stepId)) return
    const { [stepId]: _cleared, ...rest } = stored
    if (Object.keys(rest).length > 0) state.record.continuations = rest
    else delete state.record.continuations
  }

  private adoptContinuations(record: WorkflowRunRecord): void {
    if (record.continuations === undefined) return
    const kept: Record<string, WorkflowContinuation> = {}
    for (const stepId of Object.keys(record.steps)) {
      const continuation = record.steps[stepId] === 'queued' ? storedContinuation(record, stepId) : undefined
      if (continuation) kept[stepId] = continuation
    }
    if (Object.keys(kept).length > 0) record.continuations = kept
    else delete record.continuations
  }

  reschedule(): void {
    for (const state of this.drain()) this.persist(state.record)
  }

  private actionTarget(runId: string, stepId: string): ActionTarget | StepActionRefusal {
    const state = this.runs.get(runId)
    if (!state) return 'unknown-run'
    const step = this.actionable(state, stepId)
    if (!step) return 'wrong-step'
    if (state.busy) return 'busy'
    return { state, step }
  }

  private launchTarget(runId: string, stepId: string): ActionTarget | StepActionRefusal {
    const target = this.actionTarget(runId, stepId)
    if (typeof target === 'string') return target
    return this.ready ? target : 'starting'
  }

  private retryTarget(runId: string, stepId: string): ActionTarget | StepActionRefusal {
    const target = this.launchTarget(runId, stepId)
    if (typeof target === 'string') return target
    const { state } = target
    if (!state.pauses.has(stepId)) return 'not-paused'
    if (!this.labsOn()) return 'labs-off'
    if (state.pauses.get(stepId) === 'needs-approval' && state.live.has(stepId)) return 'awaiting-approval'
    return target
  }

  private refuseAction(reason: StepActionRefusal, ids: Record<string, string>): StepActionResult {
    this.log(`step action refused ${reason}`, ids)
    return { ok: false, reason }
  }

  private lastAttempt(state: RunState, stepId: string): WorkflowAttemptRecord | undefined {
    return state.record.attempts.filter((attempt) => attempt.stepId === stepId).at(-1)
  }

  private recordUserCompletion(state: RunState, step: RunnableStep, result: StepResult): void {
    const { runId } = state.record
    const n = state.record.attempts.filter((attempt) => attempt.stepId === step.id).length + 1
    const attemptId = this.deps.newId()
    const startedAt = this.deps.now()
    const record: WorkflowAttemptRecord = {
      attemptId,
      stepId: step.id,
      n,
      status: 'running',
      startedAt,
      metrics: { continuations: 0, pauses: [] }
    }
    state.record.attempts.push(record)
    this.deps.store.dispatch({
      type: 'workflows/attemptStarted',
      payload: { attemptId, runId, stepId: step.id, n, startedAt }
    })
    this.endAttempt(state, { record, kind: step.kind }, 'done', result, false)
  }

  private adopt(record: WorkflowRunRecord): RunState {
    const { runId, worktreePath } = record
    const state: RunState = {
      record,
      stepStatus: record.steps,
      live: new Map(),
      pauses: new Map(),
      io: this.prepare(runId, worktreePath)
    }
    this.adoptContinuations(record)
    const { steps } = record.definition
    const pausedStep = steps[record.cursor] ?? steps.at(-1)
    if (record.status === 'paused' && record.pausedReason !== undefined && pausedStep) {
      state.pauses.set(pausedStep.id, record.pausedReason)
    }
    if (record.status === 'paused') {
      for (const step of steps) {
        if (record.steps[step.id] === 'awaiting-gate' && !state.pauses.has(step.id)) state.pauses.set(step.id, 'gate')
      }
    }
    for (const attempt of record.attempts) {
      const snapshot = attempt.headSnapshot ?? attempt.baseSnapshot
      if (snapshot) state.lastSnapshot = snapshot.commit
    }
    this.runs.set(runId, state)
    for (const running of record.attempts) {
      if (running.status !== 'running') continue
      const step = steps.find((candidate) => candidate.id === running.stepId)
      const { executionId } = running
      const alive = executionId !== undefined && (this.deps.hasExecution?.(executionId) ?? false)
      if (!alive || !step || !isRunnable(step) || state.live.has(step.id)) continue
      state.live.set(step.id, { record: running, kind: step.kind, executionId })
      this.liveAttempts.set(running.attemptId, runId)
      this.executions.set(executionId, running.attemptId)
      if (step.kind === 'agent') this.agentSlots.add(running.attemptId)
    }
    return state
  }

  private interrupt(state: RunState, attempt: WorkflowAttemptRecord): void {
    const { runId } = state.record
    const { attemptId, stepId } = attempt
    const endedAt = this.deps.now()
    attempt.status = 'interrupted'
    attempt.endedAt = endedAt
    attempt.metrics.wallMs = endedAt - attempt.startedAt
    this.deps.store.dispatch({
      type: 'workflows/attemptEnded',
      payload: { attemptId, status: 'interrupted', endedAt, summary: '' }
    })
    this.log('attempt ended interrupted', { runId, stepId, attemptId })
    this.setStep(state, stepId, 'interrupted')
    this.pause(state, stepId, 'interrupted')
  }

  private agentHooksRefusal(steps: readonly ResolvedWorkflowStep[]): 'hooks-consent' | 'codex-hooks-untrusted' | null {
    const agents = steps.filter((step): step is ResolvedAgentStep => step.kind === 'agent')
    if (agents.length === 0) return null
    const hooks = this.deps.store.getSnapshot().state.hooks
    if (hooks.consent !== 'accepted') return 'hooks-consent'
    if (agents.some((step) => step.agent === 'codex') && hooks.codexTrust?.state !== 'ok') return 'codex-hooks-untrusted'
    return null
  }

  private logHarness(message: string, state: RunState, stepId: string): void {
    const step = state.record.definition.steps.find((candidate) => candidate.id === stepId)
    if (step?.kind !== 'agent') return
    this.log(message, {
      runId: state.record.runId,
      stepId,
      agent: step.agent,
      ...(step.model === undefined ? {} : { model: step.model })
    })
  }

  private placementRefusal(worktreePath: string, definition: ResolvedDefinition): StartRefusal | null {
    if (!this.knownWorktree(worktreePath)) return 'unknown-worktree'
    const hooksRefusal = this.agentHooksRefusal(definition.steps)
    if (hooksRefusal) return hooksRefusal
    if (this.worktreeBusy(worktreePath)) return 'worktree-busy'
    return null
  }

  private async inputVerdict(worktreePath: string, { type, number }: InputTrustLookup): Promise<WorkflowInputTrust> {
    const { inputTrust, inputTrustTimeoutMs = INPUT_TRUST_TIMEOUT_MS } = this.deps
    if (!inputTrust) return 'untrusted'
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<WorkflowInputTrust>((resolve) => {
      timer = setTimeout(() => resolve('untrusted'), inputTrustTimeoutMs)
    })
    try {
      const fetched = Promise.resolve()
        .then(() => inputTrust(worktreePath, type, number))
        .catch((): WorkflowInputTrust => 'untrusted')
      return (await Promise.race([fetched, timedOut])) === 'trusted' ? 'trusted' : 'untrusted'
    } finally {
      clearTimeout(timer)
    }
  }

  private refuse(reason: StartRefusal): StartRunResult {
    this.log(`run refused ${reason}`)
    return { ok: false, reason }
  }

  private knownWorktree(worktreePath: string): boolean {
    return this.deps.store.getSnapshot().state.worktrees.list.some((worktree) => worktree.path === worktreePath)
  }

  private worktreeBusy(worktreePath: string): boolean {
    for (const state of this.runs.values()) {
      if (state.record.worktreePath === worktreePath) return true
    }
    return Object.values(this.deps.store.getSnapshot().state.workflows.runs).some(
      (run) => run.worktreePath === worktreePath && !TERMINAL_RUN_STATUSES.has(run.status)
    )
  }

  private settled(state: RunState, stepId: string): boolean {
    return SETTLED_STEP_STATUSES.has(state.stepStatus[stepId])
  }

  private allSettled(state: RunState): boolean {
    return state.record.definition.steps.every((step) => this.settled(state, step.id))
  }

  private actionable(state: RunState, stepId: string): RunnableStep | undefined {
    const { steps } = state.record.definition
    const index = steps.findIndex((candidate) => candidate.id === stepId)
    const step = steps[index]
    if (!step || !isRunnable(step) || this.settled(state, stepId)) return undefined
    return needsOf(steps, index).every((dep) => this.settled(state, dep)) ? step : undefined
  }

  private firstReady(state: RunState): RunnableStep | undefined {
    for (const step of state.record.definition.steps) {
      if (state.stepStatus[step.id] !== 'pending') continue
      const ready = this.actionable(state, step.id)
      if (ready) return ready
    }
    return undefined
  }

  private cursorIndex(state: RunState): number {
    const { steps } = state.record.definition
    const head = state.pauses.keys().next()
    const paused = head.done ? -1 : steps.findIndex((step) => step.id === head.value)
    if (paused >= 0) return paused
    const earliest = steps.findIndex((step) => !this.settled(state, step.id))
    return earliest < 0 ? steps.length : earliest
  }

  private syncCursor(state: RunState): void {
    const cursor = this.cursorIndex(state)
    if (cursor === state.record.cursor) return
    state.record.cursor = cursor
    const step = state.record.definition.steps[cursor]
    if (step) {
      this.deps.store.dispatch({ type: 'workflows/cursorChanged', payload: { runId: state.record.runId, stepId: step.id } })
    }
  }

  private liveAgentStep(executionId: string): LiveStep | undefined {
    const attemptId = this.executions.get(executionId)
    const found = attemptId === undefined ? undefined : this.liveFor(attemptId)
    return found?.live.kind === 'agent' ? found : undefined
  }

  private rememberEnded(executionId: string, attemptId: string, stepId: string): void {
    this.endedExecutions.set(executionId, { attemptId, stepId })
    if (this.endedExecutions.size <= ENDED_EXECUTIONS_MAX) return
    const oldest = this.endedExecutions.keys().next()
    if (!oldest.done) this.endedExecutions.delete(oldest.value)
  }

  private liveFor(attemptId: string): LiveStep | undefined {
    const runId = this.liveAttempts.get(attemptId)
    const state = runId === undefined ? undefined : this.runs.get(runId)
    if (!state) return undefined
    for (const live of state.live.values()) {
      if (live.record.attemptId === attemptId) return { state, live }
    }
    return undefined
  }

  private trusted(defId: string, hash: string): boolean {
    const trust = this.deps.store.getSnapshot().state.workflows.trust
    return Object.hasOwn(trust, defId) && trust[defId] === hash
  }

  private labsOn(): boolean {
    return this.deps.store.getSnapshot().state.settings.labs.workflows
  }

  private hold(state: RunState, step: RunnableStep): void {
    this.clearContinuation(state, step.id)
    this.setStep(state, step.id, 'pending')
    this.pause(state, step.id, 'interrupted')
    this.log('step held labs-off', { runId: state.record.runId, stepId: step.id })
  }

  private agentCap(): number {
    return this.deps.store.getSnapshot().state.settings.workflows.maxConcurrentAgents
  }

  private enterStep(state: RunState, step: RunnableStep, options: LaunchOptions = {}): void {
    if (step.kind === 'shell' || (this.queue.length === 0 && this.agentSlots.size < this.agentCap())) {
      this.launch(state, step, options)
      return
    }
    this.clearContinuation(state, step.id)
    this.queue.push({ ...options, runId: state.record.runId, stepId: step.id })
    this.setStep(state, step.id, 'queued')
  }

  private schedule(state: RunState): void {
    this.syncCursor(state)
    if (state.pauses.size > 0 || state.live.size > 0) return
    if (Object.values(state.stepStatus).includes('queued')) return
    const next = this.firstReady(state)
    if (next) this.enterStep(state, next)
    else if (this.allSettled(state)) this.finish(state)
  }

  private finish(state: RunState): void {
    const { runId } = state.record
    const finishedAt = this.deps.now()
    state.record.status = 'done'
    state.record.finishedAt = finishedAt
    this.deps.store.dispatch({
      type: 'workflows/runFinished',
      payload: { runId, status: 'done', finishedAt }
    })
    this.log('run finished done', { runId })
    this.runs.delete(runId)
    this.evictFinishedRuns()
  }

  private evictFinishedRuns(): void {
    const runIds = runsToEvict(this.deps.store.getSnapshot().state.workflows, RECENT_RUNS_MAX)
    if (runIds.length === 0) return
    this.deps.store.dispatch({ type: 'workflows/runsEvicted', payload: { runIds } })
    this.log(`runs evicted ${runIds.length}`)
  }

  private prepare(runId: string, worktreePath: string): Promise<boolean> {
    const { artifacts } = this.deps
    if (!artifacts) return Promise.resolve(false)
    return artifacts.prepare({ worktreePath, runId }).then(
      () => true,
      () => {
        this.log('run artifacts unavailable', { runId })
        return false
      }
    )
  }

  private queueIo(state: RunState, task: (prepared: boolean) => Promise<void>): Promise<void> {
    const next = state.io.then(async (prepared) => {
      await task(prepared)
      return prepared
    })
    state.io = next.catch(() => false)
    return next.then(
      () => undefined,
      () => undefined
    )
  }

  private snapshotAttempt(state: RunState, record: WorkflowAttemptRecord, slot: SnapshotSlot): Promise<void> {
    const { artifacts } = this.deps
    if (!artifacts) return Promise.resolve()
    const { runId, worktreePath } = state.record
    const { stepId, attemptId } = record
    const n = 2 * (record.n - 1) + (slot === 'headSnapshot' ? 1 : 0)
    const label = slot === 'baseSnapshot' ? 'base' : 'head'
    return this.queueIo(state, async (prepared) => {
      if (!prepared) {
        this.log(`${label} snapshot skipped`, { runId, stepId, attemptId })
        return
      }
      let snapshot: WorkflowSnapshotRef
      try {
        snapshot = await artifacts.snapshot({ worktreePath, runId, stepId, n, parent: state.lastSnapshot })
      } catch {
        this.log(`${label} snapshot failed`, { runId, stepId, attemptId })
        return
      }
      record[slot] = snapshot
      state.lastSnapshot = snapshot.commit
      this.persist(state.record)
    })
  }

  private appendContext(state: RunState, record: WorkflowAttemptRecord): void {
    const { artifacts } = this.deps
    const result = record.result
    if (!artifacts || !result) return
    const { runId, contextPath } = state.record
    const section = `## ${record.stepId} (attempt ${record.n})\n\nStatus: ${record.status}\n\n${result.summary}\n\n`
    void this.queueIo(state, async (prepared) => {
      if (!prepared) return
      try {
        await artifacts.appendContext({ contextPath, section })
      } catch {
        this.log('context append failed', { runId, stepId: record.stepId, attemptId: record.attemptId })
      }
    })
  }

  private scopeFor(state: RunState): TemplateScope {
    const { record, stepStatus } = state
    const steps: Record<string, TemplateStepScope> = {}
    for (const [stepId, status] of Object.entries(stepStatus)) {
      if (status !== 'pending') steps[stepId] = { status }
    }
    for (const attempt of record.attempts) {
      const { result } = attempt
      if (!result || stepStatus[attempt.stepId] === 'skipped') continue
      steps[attempt.stepId] = {
        status: stepStatus[attempt.stepId],
        summary: result.summary,
        ...(result.data === undefined ? {} : { data: result.data })
      }
    }
    return {
      inputs: { ...record.inputs },
      steps,
      run: { id: record.runId, worktree: record.worktreePath, contextPath: record.contextPath }
    }
  }

  private openAttempt(state: RunState, step: RunnableStep): LiveAttempt {
    const { store, now, newId } = this.deps
    const { runId } = state.record
    const n = state.record.attempts.filter((attempt) => attempt.stepId === step.id).length + 1
    const attemptId = newId()
    const startedAt = now()
    const record: WorkflowAttemptRecord = {
      attemptId,
      stepId: step.id,
      n,
      status: 'running',
      startedAt,
      ...(step.kind === 'agent' ? harnessOf(step) : {}),
      metrics: { continuations: 0, pauses: [] }
    }
    const live: LiveAttempt = { record, kind: step.kind }
    state.record.attempts.push(record)
    state.live.set(step.id, live)
    this.liveAttempts.set(attemptId, runId)
    if (step.kind === 'agent') this.agentSlots.add(attemptId)
    this.setStep(state, step.id, 'running')
    store.dispatch({
      type: 'workflows/attemptStarted',
      payload: { attemptId, runId, stepId: step.id, n, startedAt }
    })
    this.log('attempt started', { runId, stepId: step.id, attemptId })
    return live
  }

  private stepAttempt(
    state: RunState,
    step: RunnableStep,
    record: WorkflowAttemptRecord,
    scope: TemplateScope
  ): StepAttempt {
    const { runId, worktreePath, inputs } = state.record
    const { attemptId, n } = record
    return {
      runId,
      stepId: step.id,
      attemptId,
      n,
      worktreePath,
      inputs,
      step,
      scope,
      bind: (execution: StepExecution): boolean => this.bind(attemptId, execution)
    }
  }

  private launch(state: RunState, step: RunnableStep, options: LaunchOptions = {}): void {
    if (!this.labsOn()) {
      this.hold(state, step)
      return
    }
    const { runId } = state.record
    const { resumeSessionId, prompt } = options
    const scope = this.scopeFor(state)
    const { record } = this.openAttempt(state, step)
    const { attemptId } = record
    const driver = this.deps.drivers[step.kind]
    const attempt: StepAttempt = {
      ...this.stepAttempt(state, step, record, scope),
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
      ...(prompt === undefined ? {} : { prompt })
    }
    const startDriver = (): Promise<StepExecution> | StepExecution => driver.start(attempt)
    const started: Promise<StepExecution | null> = this.deps.artifacts
      ? this.snapshotAttempt(state, record, 'baseSnapshot').then(() =>
          this.liveFor(attemptId) ? startDriver() : null
        )
      : Promise.resolve().then(startDriver)
    started
      .then(
        (execution) => {
          if (execution) this.onStarted(attemptId, step.kind, execution)
        },
        (err: unknown) => this.onStartFailed(attemptId, err)
      )
      .catch(() => this.log('driver callback failed', { runId, stepId: step.id, attemptId }))
  }

  private rebind(
    state: RunState,
    step: ResolvedAgentStep,
    previous: WorkflowAttemptRecord,
    executionId: string,
    prompt: string
  ): void {
    const { runId, worktreePath } = state.record
    const scope = this.scopeFor(state)
    const live = this.openAttempt(state, step)
    const { record } = live
    const { attemptId } = record
    const ids = { runId, stepId: step.id, attemptId }
    live.staleStops = true
    this.endedExecutions.delete(executionId)
    const { sessionId } = previous
    this.bind(attemptId, sessionId === undefined ? { executionId } : { executionId, sessionId })
    this.deps.retagStepTab?.(worktreePath, executionId, { runId, stepId: step.id, attemptId })
    this.log('attempt continued', ids)
    const attempt = this.stepAttempt(state, step, record, scope)
    this.snapshotAttempt(state, record, 'baseSnapshot')
      .then(() => (this.liveFor(attemptId) ? this.deps.drivers.agent.continue(attempt, executionId, prompt) : undefined))
      .then(
        () => undefined,
        (err: unknown) => this.onStartFailed(attemptId, err)
      )
      .catch(() => this.log('driver callback failed', ids))
  }

  private resumableSession(state: RunState, step: ResolvedAgentStep): string | undefined {
    if (!RESUMABLE_AGENTS.has(step.agent)) return undefined
    const attempts = state.record.attempts
    for (let i = attempts.length - 1; i >= 0; i--) {
      const { stepId, sessionId, agent } = attempts[i]
      if (stepId !== step.id || sessionId === undefined) continue
      if (agent !== undefined && agent !== step.agent) return undefined
      return isAgentSessionId(step.agent, sessionId) ? sessionId : undefined
    }
    return undefined
  }

  private bind(attemptId: string, execution: StepExecution): boolean {
    const found = this.liveFor(attemptId)
    if (!found) return false
    const { state, live } = found
    const { executionId, sessionId } = execution
    if (live.executionId !== undefined) {
      return live.executionId === executionId && (sessionId === undefined || live.record.sessionId === sessionId)
    }
    live.executionId = executionId
    live.record.executionId = executionId
    if (sessionId !== undefined) live.record.sessionId = sessionId
    this.executions.set(executionId, attemptId)
    this.persist(state.record)
    if (sessionId !== undefined) {
      this.deps.store.dispatch({ type: 'workflows/attemptSessionRecorded', payload: { attemptId } })
    }
    return true
  }

  private onStarted(attemptId: string, kind: StepDriverKind, execution: StepExecution): void {
    if (this.bind(attemptId, execution)) return
    this.deps.drivers[kind].cancel(execution.executionId)
    this.deps.drivers[kind].release?.(execution.executionId)
    this.log('late execution cancelled', { attemptId })
  }

  private onStartFailed(attemptId: string, err: unknown): void {
    const found = this.liveFor(attemptId)
    if (!found) return
    const { state, live } = found
    const { stepId } = live.record
    const paused = err instanceof StepPauseError ? err : undefined
    this.log(paused ? `attempt start paused ${paused.reason}` : 'attempt start failed', {
      runId: state.record.runId,
      stepId,
      attemptId
    })
    const summary = err instanceof StepStartError || err instanceof StepPauseError ? err.summary : undefined
    const result: StepResult | undefined =
      summary === undefined ? undefined : { status: 'failed', summary, completedBy: 'exit' }
    this.endAttempt(state, live, 'failed', result, false)
    this.setStep(state, stepId, 'failed')
    this.pause(state, stepId, paused?.reason ?? 'step-failed')
    this.settle(state)
  }

  private onDriverEvent(kind: StepDriverKind, event: StepDriverEvent): void {
    const attemptId = this.executions.get(event.executionId)
    const found = attemptId === undefined ? undefined : this.liveFor(attemptId)
    if (attemptId === undefined || !found || found.live.kind !== kind) return
    const { state, live } = found
    const { stepId } = live.record
    switch (event.type) {
      case 'exited': {
        this.complete(attemptId, {
          status: kind === 'shell' && event.code === 0 ? 'done' : 'failed',
          summary: event.summary ?? '',
          completedBy: 'exit',
          ...(event.code === null ? {} : { exitCode: event.code })
        })
        return
      }
      case 'turnEnded':
        if (live.staleStops) {
          if (event.stopHookActive === true || (event.continued === true && live.blockPending !== true)) {
            this.log('stale turn end ignored', { runId: state.record.runId, stepId, attemptId })
            return
          }
          live.staleStops = false
        }
        this.onTurnEnded(state, live, event.lastMessage, event.continued === true)
        return
      case 'promptSubmitted':
        live.staleStops = false
        live.continuedThisTurn = false
        if (state.pauses.get(stepId) === 'needs-approval') {
          this.resume(state, stepId)
          this.persist(state.record)
        }
        return
      case 'needsApproval':
        this.pause(state, stepId, 'needs-approval')
        this.persist(state.record)
        return
      case 'sessionDiscovered':
        this.onSessionDiscovered(state, live, event.sessionId)
        return
      default: {
        const _exhaustive: never = event
        void _exhaustive
      }
    }
  }

  private onSessionDiscovered(state: RunState, live: LiveAttempt, sessionId: string): void {
    if (live.kind !== 'agent') return
    const { attemptId, stepId } = live.record
    const ids = { runId: state.record.runId, stepId, attemptId }
    const step = state.record.definition.steps.find((candidate) => candidate.id === stepId)
    if (step?.kind !== 'agent' || !isAgentSessionId(step.agent, sessionId)) {
      this.log('discovered session id rejected', ids)
      return
    }
    const previous = live.record.sessionId
    if (previous === sessionId) return
    live.record.sessionId = sessionId
    this.persist(state.record)
    if (previous !== undefined) {
      this.log('discovered session id replaced', ids)
      return
    }
    this.log('discovered session id recorded', ids)
    this.deps.store.dispatch({ type: 'workflows/attemptSessionRecorded', payload: { attemptId } })
  }

  private awaitingInput(state: RunState, live: LiveAttempt): boolean {
    return state.pauses.get(live.record.stepId) === 'needs-input' || live.record.result?.status === 'needs-input'
  }

  private onTurnEnded(state: RunState, live: LiveAttempt, lastMessage: string | undefined, continued: boolean): void {
    if (live.kind !== 'agent') return
    const { attemptId, stepId } = live.record
    const ids = { runId: state.record.runId, stepId, attemptId }
    const blockPending = live.blockPending === true
    live.blockPending = false
    if (blockPending && continued) {
      this.log('turn end ignored continuation', ids)
      return
    }
    if (blockPending) this.log('continuation not delivered', ids)
    if (this.awaitingInput(state, live)) {
      this.log('turn end ignored needs-input', ids)
      return
    }
    const step = state.record.definition.steps.find((candidate) => candidate.id === stepId)
    const required = step?.kind === 'agent' ? (step.output?.required?.length ?? 0) : 0
    if (required > 0) {
      this.log('turn ended without required outputs', ids)
      this.pause(state, stepId, 'needs-input')
      this.persist(state.record)
      return
    }
    this.log('step fallback completion', ids)
    this.complete(attemptId, { status: 'done', summary: capSummary(lastMessage ?? ''), completedBy: 'fallback' })
  }

  private endAttempt(
    state: RunState,
    live: LiveAttempt,
    status: Exclude<WorkflowAttemptStatus, 'running' | 'interrupted'>,
    result: StepResult | undefined,
    cancelExecution: boolean
  ): void {
    const { attemptId, stepId } = live.record
    if (state.live.get(stepId) === live) state.live.delete(stepId)
    const endedAt = this.deps.now()
    live.record.status = status
    live.record.endedAt = endedAt
    live.record.metrics.wallMs = endedAt - live.record.startedAt
    if (result) {
      live.record.result = result
      live.record.metrics.completedBy = result.completedBy
      if (result.costUsd !== undefined) live.record.metrics.costUsd = result.costUsd
    }
    if (status === 'done' && state.record.timeToFirstDoneMs === undefined) {
      state.record.timeToFirstDoneMs = endedAt - state.record.startedAt
    }
    this.liveAttempts.delete(attemptId)
    this.agentSlots.delete(attemptId)
    if (live.executionId !== undefined) {
      this.executions.delete(live.executionId)
      if (live.kind === 'agent') this.rememberEnded(live.executionId, attemptId, stepId)
      const driver = this.deps.drivers[live.kind]
      if (cancelExecution) driver.cancel(live.executionId)
      driver.release?.(live.executionId)
    }
    this.deps.store.dispatch({
      type: 'workflows/attemptEnded',
      payload: {
        attemptId,
        status,
        endedAt,
        summary: result?.summary ?? '',
        ...(result ? { completedBy: result.completedBy } : {}),
        ...(result?.costUsd === undefined ? {} : { costUsd: result.costUsd })
      }
    })
    this.log(`attempt ended ${status}`, { runId: state.record.runId, stepId, attemptId })
    void this.snapshotAttempt(state, live.record, 'headSnapshot')
    this.appendContext(state, live.record)
  }

  private setStep(state: RunState, stepId: string, status: WorkflowStepStatus): void {
    if (state.stepStatus[stepId] === status) return
    state.stepStatus[stepId] = status
    const runId = state.record.runId
    const { store } = this.deps
    const dispatch = (event: StateEvent): void => store.dispatch(event)
    if (status === 'queued') dispatch({ type: 'workflows/stepQueued', payload: { runId, stepId } })
    else if (status === 'running') dispatch({ type: 'workflows/stepStarted', payload: { runId, stepId } })
    else if (status === 'skipped') dispatch({ type: 'workflows/stepSkipped', payload: { runId, stepId } })
    else dispatch({ type: 'workflows/stepStatusChanged', payload: { runId, stepId, status } })
    this.log(`step ${status}`, { runId, stepId })
  }

  private headReason(state: RunState): WorkflowPausedReason | undefined {
    const head = state.pauses.values().next()
    return head.done ? undefined : head.value
  }

  private pause(state: RunState, stepId: string, reason: WorkflowPausedReason): void {
    if (state.pauses.get(stepId) === reason) return
    const { record } = state
    const before = record.status === 'paused' ? record.pausedReason : undefined
    state.pauses.set(stepId, reason)
    const head = this.headReason(state) ?? reason
    record.status = 'paused'
    record.pausedReason = head
    const attempt = state.live.get(stepId)?.record ?? this.lastAttempt(state, stepId)
    if (attempt) attempt.metrics.pauses.push({ reason, at: this.deps.now() })
    this.syncCursor(state)
    if (head === before) {
      this.log(`step paused ${reason}`, { runId: record.runId, stepId })
      return
    }
    this.deps.store.dispatch({ type: 'workflows/runPaused', payload: { runId: record.runId, reason: head } })
    this.log(`run paused ${head}`, { runId: record.runId })
  }

  private resume(state: RunState, stepId: string): void {
    const { record } = state
    const removed = state.pauses.delete(stepId)
    if (record.status !== 'paused' || (!removed && state.pauses.size > 0)) return
    const head = this.headReason(state)
    this.syncCursor(state)
    if (head === undefined) {
      record.status = 'running'
      delete record.pausedReason
      this.deps.store.dispatch({ type: 'workflows/runResumed', payload: { runId: record.runId } })
      this.log('run resumed', { runId: record.runId })
      return
    }
    if (head === record.pausedReason) return
    record.pausedReason = head
    this.deps.store.dispatch({ type: 'workflows/runPaused', payload: { runId: record.runId, reason: head } })
    this.log(`run paused ${head}`, { runId: record.runId })
  }

  private dequeue(runId: string, stepId: string): boolean {
    const before = this.queue.length
    this.queue = this.queue.filter((queued) => queued.runId !== runId || queued.stepId !== stepId)
    const state = this.runs.get(runId)
    if (state) this.clearContinuation(state, stepId)
    return this.queue.length < before
  }

  private dequeueRun(runId: string): string[] {
    const removed = this.queue.filter((queued) => queued.runId === runId).map((queued) => queued.stepId)
    this.queue = this.queue.filter((queued) => queued.runId !== runId)
    const state = this.runs.get(runId)
    if (state) delete state.record.continuations
    return removed
  }

  private drain(): RunState[] {
    const launched: RunState[] = []
    let i = 0
    while (i < this.queue.length && this.agentSlots.size < this.agentCap()) {
      const entry = this.queue[i]
      const state = this.runs.get(entry.runId)
      const step = state?.record.definition.steps.find((candidate) => candidate.id === entry.stepId)
      if (!state || !step || !isRunnable(step) || state.stepStatus[step.id] !== 'queued' || state.live.has(step.id)) {
        this.queue.splice(i, 1)
        continue
      }
      if (state.live.size > 0 || (state.pauses.size > 0 && (!entry.continuation || state.pauses.has(step.id)))) {
        i += 1
        continue
      }
      this.queue.splice(i, 1)
      if (entry.continuation && step.kind === 'agent') this.startContinuation(state, step, entry.continuation)
      else this.launch(state, step, entry)
      launched.push(state)
    }
    return launched
  }

  private settle(state: RunState): void {
    this.persist(state.record)
    this.drain()
  }

  private log(message: string, ids?: Record<string, string>): void {
    this.deps.log('workflow', message, ids)
  }
}

import type {
  CompleteExecutionResult,
  WorkflowExecutionStep,
  WorkflowAttemptRecord,
  WorkflowRunRecord,
  WorkflowRunnerDeps,
  StartRefusal,
  StartRunRequest,
  StartRunResult,
  StepResult
} from './types'
import { StepStartError, type RunnableStep, type StepDriverEvent, type StepDriverKind, type StepExecution } from './drivers'
import { runContextPath } from './run-artifacts'
import type {
  ResolvedWorkflowStep,
  StepOutputValue,
  TemplateScope,
  TemplateStepScope
} from '../../shared/workflow-def'
import type { StateEvent } from '../../shared/state'
import {
  RECENT_RUNS_MAX,
  WORKFLOW_RUN_RECORD_VERSION,
  runsToEvict,
  type WorkflowAttemptStatus,
  type WorkflowPausedReason,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowRunStep,
  type WorkflowSnapshotRef,
  type WorkflowStepStatus
} from '../../shared/state/workflows'

const ENDED_EXECUTIONS_MAX = 256

const TERMINAL_RUN_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set(['done', 'failed', 'cancelled'])

interface LiveAttempt {
  record: WorkflowAttemptRecord
  kind: StepDriverKind
  executionId?: string
}

interface RunState {
  record: WorkflowRunRecord
  stepStatus: Record<string, WorkflowStepStatus>
  live: LiveAttempt | null
  io: Promise<boolean>
  lastSnapshot?: string
}

type SnapshotSlot = 'baseSnapshot' | 'headSnapshot'

interface QueueEntry {
  runId: string
  stepId: string
}

function isRunnable(step: ResolvedWorkflowStep): step is RunnableStep {
  return step.kind === 'agent' || step.kind === 'shell'
}

export class WorkflowRunner {
  private readonly runs = new Map<string, RunState>()
  private readonly liveAttempts = new Map<string, string>()
  private readonly executions = new Map<string, string>()
  private readonly endedExecutions = new Map<string, { attemptId: string; stepId: string }>()
  private readonly agentSlots = new Set<string>()
  private queue: QueueEntry[] = []
  private readonly unsubscribers: Array<() => void>
  private readonly persist: (run: WorkflowRunRecord) => void

  constructor(private readonly deps: WorkflowRunnerDeps) {
    this.persist = deps.persist ?? (() => {})
    this.unsubscribers = [deps.drivers.agent, deps.drivers.shell].map((driver) =>
      driver.onEvent((event) => this.onDriverEvent(event))
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
      const { attemptId, stepId } = live.record
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
    return this.complete(live.record.attemptId, { ...value, completedBy: 'tool' })
      ? { ok: true }
      : { ok: false, reason: 'already-completed' }
  }

  reconcile(records: readonly WorkflowRunRecord[]): void {
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
      const running = state.record.attempts.find((attempt) => attempt.status === 'running')
      if (running && !state.live) {
        this.interrupt(state, running)
        outcomes.set(state, 'interrupted')
        continue
      }
      if (state.record.status === 'paused') {
        outcomes.set(state, 'paused')
        continue
      }
      if (state.live) {
        outcomes.set(state, 'attached')
        continue
      }
      const step = this.currentStep(state)
      const status = step && state.stepStatus[step.id]
      if (step && (status === 'queued' || status === 'pending') && !this.labsOn()) {
        this.hold(state, step)
        outcomes.set(state, 'held')
      } else if (step && state.stepStatus[step.id] === 'queued') {
        this.queue.push({ runId: state.record.runId, stepId: step.id })
        outcomes.set(state, 'requeued')
      } else if (!step || state.stepStatus[step.id] === 'pending') {
        this.enterStep(state)
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

  start(request: StartRunRequest): StartRunResult {
    const { store, loader, now, newId } = this.deps
    if (!this.labsOn()) return this.refuse('labs-off')
    const detail = loader.getDefinition(request.defId)
    if (!detail) return this.refuse('unknown-definition')
    const definition = detail.definition
    if (!definition) return this.refuse('invalid-definition')
    if (!definition.steps.every(isRunnable)) return this.refuse('unsupported-step')
    if (this.worktreeBusy(request.worktreePath)) return this.refuse('worktree-busy')

    const runId = newId()
    const steps: Record<string, WorkflowRunStep> = {}
    const stepStatus: Record<string, WorkflowStepStatus> = {}
    for (const step of definition.steps) {
      steps[step.id] = { status: 'pending', attemptIds: [] }
      stepStatus[step.id] = 'pending'
    }
    const run: WorkflowRun = {
      defId: detail.summary.id,
      defHash: detail.summary.hash,
      worktreePath: request.worktreePath,
      status: 'running',
      startedAt: now(),
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
        attempts: []
      },
      stepStatus,
      live: null,
      io: this.prepare(runId, request.worktreePath)
    }
    this.runs.set(runId, state)
    store.dispatch({ type: 'workflows/runStarted', payload: { runId, run } })
    this.log('run started', { runId })
    this.enterStep(state)
    this.settle(state)
    return { ok: true, runId }
  }

  complete(attemptId: string, completion: StepResult): boolean {
    const result: StepResult = { ...completion }
    const state = this.runForLiveAttempt(attemptId)
    if (!state?.live) {
      this.log('completion ignored', { attemptId })
      return false
    }
    const { stepId } = state.live.record
    this.log(`completion received ${result.status}`, { runId: state.record.runId, stepId, attemptId })
    if (result.status === 'needs-input') {
      state.live.record.result = result
      this.pause(state, 'needs-input')
    } else if (result.status === 'done') {
      this.resume(state)
      this.endAttempt(state, 'done', result, false)
      this.setStep(state, stepId, 'done')
      this.advance(state)
    } else {
      this.endAttempt(state, 'failed', result, false)
      this.setStep(state, stepId, 'failed')
      this.pause(state, 'step-failed')
    }
    this.settle(state)
    return true
  }

  cancelRun(runId: string): boolean {
    const state = this.runs.get(runId)
    if (!state) return false
    const queuedStepId = this.dequeue(runId)
    if (queuedStepId) this.setStep(state, queuedStepId, 'cancelled')
    if (state.live) {
      const { stepId } = state.live.record
      this.endAttempt(state, 'cancelled', undefined, true)
      this.setStep(state, stepId, 'cancelled')
    }
    const finishedAt = this.deps.now()
    state.record.status = 'cancelled'
    state.record.finishedAt = finishedAt
    delete state.record.pausedReason
    this.deps.store.dispatch({ type: 'workflows/runCancelled', payload: { runId, finishedAt } })
    this.log('run cancelled', { runId })
    this.runs.delete(runId)
    this.evictFinishedRuns()
    this.settle(state)
    return true
  }

  cancelStep(runId: string): boolean {
    const state = this.runs.get(runId)
    if (!state) return false
    if (state.live) {
      const { stepId } = state.live.record
      this.endAttempt(state, 'cancelled', undefined, true)
      this.setStep(state, stepId, 'cancelled')
    } else {
      const queuedStepId = this.dequeue(runId)
      if (!queuedStepId) return false
      this.setStep(state, queuedStepId, 'cancelled')
    }
    this.pause(state, 'step-failed')
    this.settle(state)
    return true
  }

  retry(runId: string): boolean {
    const state = this.runs.get(runId)
    if (!state || state.record.status !== 'paused' || !this.labsOn()) return false
    this.resume(state)
    if (state.live) this.endAttempt(state, 'cancelled', undefined, true)
    this.enterStep(state)
    this.settle(state)
    return true
  }

  skip(runId: string): boolean {
    const state = this.runs.get(runId)
    const step = state && this.currentStep(state)
    if (!state || !step) return false
    this.resume(state)
    if (state.live) this.endAttempt(state, 'cancelled', undefined, true)
    else this.dequeue(runId)
    this.setStep(state, step.id, 'skipped')
    this.advance(state)
    this.settle(state)
    return true
  }

  markDone(runId: string): boolean {
    const state = this.runs.get(runId)
    const step = state && this.currentStep(state)
    if (!state || !step) return false
    const status = state.stepStatus[step.id]
    const pausedEnded =
      state.record.status === 'paused' && (status === 'failed' || status === 'cancelled')
    if (!state.live && !pausedEnded) return false
    this.resume(state)
    if (state.live) {
      this.endAttempt(state, 'done', { status: 'done', summary: '', completedBy: 'user' }, true)
    }
    this.setStep(state, step.id, 'done')
    this.log('step marked done', { runId, stepId: step.id })
    this.advance(state)
    this.settle(state)
    return true
  }

  private adopt(record: WorkflowRunRecord): RunState {
    const { runId, worktreePath } = record
    const state: RunState = {
      record,
      stepStatus: record.steps,
      live: null,
      io: this.prepare(runId, worktreePath)
    }
    for (const attempt of record.attempts) {
      const snapshot = attempt.headSnapshot ?? attempt.baseSnapshot
      if (snapshot) state.lastSnapshot = snapshot.commit
    }
    this.runs.set(runId, state)
    const running = record.attempts.find((attempt) => attempt.status === 'running')
    const step = record.definition.steps.find((candidate) => candidate.id === running?.stepId)
    const executionId = running?.executionId
    const alive = executionId !== undefined && (this.deps.hasExecution?.(executionId) ?? false)
    if (running && executionId !== undefined && alive && step && isRunnable(step)) {
      state.live = { record: running, kind: step.kind, executionId }
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
    this.pause(state, 'interrupted')
  }

  private refuse(reason: StartRefusal): StartRunResult {
    this.log(`run refused ${reason}`)
    return { ok: false, reason }
  }

  private worktreeBusy(worktreePath: string): boolean {
    for (const state of this.runs.values()) {
      if (state.record.worktreePath === worktreePath) return true
    }
    return Object.values(this.deps.store.getSnapshot().state.workflows.runs).some(
      (run) => run.worktreePath === worktreePath && !TERMINAL_RUN_STATUSES.has(run.status)
    )
  }

  private currentStep(state: RunState): RunnableStep | undefined {
    const step = state.record.definition.steps[state.record.cursor]
    return step && isRunnable(step) ? step : undefined
  }

  private liveAgentStep(executionId: string): { state: RunState; record: WorkflowAttemptRecord } | undefined {
    const attemptId = this.executions.get(executionId)
    const state = attemptId === undefined ? undefined : this.runForLiveAttempt(attemptId)
    return state?.live?.kind === 'agent' ? { state, record: state.live.record } : undefined
  }

  private rememberEnded(executionId: string, attemptId: string, stepId: string): void {
    this.endedExecutions.set(executionId, { attemptId, stepId })
    if (this.endedExecutions.size <= ENDED_EXECUTIONS_MAX) return
    const oldest = this.endedExecutions.keys().next()
    if (!oldest.done) this.endedExecutions.delete(oldest.value)
  }

  private runForLiveAttempt(attemptId: string): RunState | undefined {
    const runId = this.liveAttempts.get(attemptId)
    const state = runId === undefined ? undefined : this.runs.get(runId)
    return state?.live?.record.attemptId === attemptId ? state : undefined
  }

  private labsOn(): boolean {
    return this.deps.store.getSnapshot().state.settings.labs.workflows
  }

  private hold(state: RunState, step: RunnableStep): void {
    this.setStep(state, step.id, 'pending')
    this.pause(state, 'interrupted')
    this.log('step held labs-off', { runId: state.record.runId, stepId: step.id })
  }

  private agentCap(): number {
    return this.deps.store.getSnapshot().state.settings.workflows.maxConcurrentAgents
  }

  private enterStep(state: RunState): void {
    const step = this.currentStep(state)
    if (!step) {
      this.finish(state)
      return
    }
    if (step.kind === 'shell' || (this.queue.length === 0 && this.agentSlots.size < this.agentCap())) {
      this.launch(state, step)
      return
    }
    this.queue.push({ runId: state.record.runId, stepId: step.id })
    this.setStep(state, step.id, 'queued')
  }

  private advance(state: RunState): void {
    state.record.cursor += 1
    this.enterStep(state)
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
      if (!result) continue
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

  private launch(state: RunState, step: RunnableStep): void {
    if (!this.labsOn()) {
      this.hold(state, step)
      return
    }
    const { store, now, newId, drivers } = this.deps
    const { runId, worktreePath, inputs } = state.record
    const n = state.record.attempts.filter((attempt) => attempt.stepId === step.id).length + 1
    const attemptId = newId()
    const scope = this.scopeFor(state)
    const startedAt = now()
    const record: WorkflowAttemptRecord = {
      attemptId,
      stepId: step.id,
      n,
      status: 'running',
      startedAt,
      metrics: { continuations: 0, pauses: [] }
    }
    state.record.attempts.push(record)
    state.live = { record, kind: step.kind }
    this.liveAttempts.set(attemptId, runId)
    if (step.kind === 'agent') this.agentSlots.add(attemptId)
    this.setStep(state, step.id, 'running')
    store.dispatch({
      type: 'workflows/attemptStarted',
      payload: { attemptId, runId, stepId: step.id, n, startedAt }
    })
    this.log('attempt started', { runId, stepId: step.id, attemptId })
    const driver = drivers[step.kind]
    const startDriver = (): Promise<StepExecution> | StepExecution =>
      driver.start({ runId, stepId: step.id, attemptId, n, worktreePath, inputs, step, scope })
    const started: Promise<StepExecution | null> = this.deps.artifacts
      ? this.snapshotAttempt(state, record, 'baseSnapshot').then(() =>
          this.runForLiveAttempt(attemptId) ? startDriver() : null
        )
      : Promise.resolve().then(startDriver)
    started
      .then(
        (execution) => {
          if (execution) this.onStarted(attemptId, step.kind, execution.executionId)
        },
        (err: unknown) => this.onStartFailed(attemptId, err)
      )
      .catch(() => this.log('driver callback failed', { runId, stepId: step.id, attemptId }))
  }

  private onStarted(attemptId: string, kind: StepDriverKind, executionId: string): void {
    const state = this.runForLiveAttempt(attemptId)
    if (!state?.live) {
      this.deps.drivers[kind].cancel(executionId)
      this.log('late execution cancelled', { attemptId })
      return
    }
    state.live.executionId = executionId
    state.live.record.executionId = executionId
    this.executions.set(executionId, attemptId)
    this.persist(state.record)
  }

  private onStartFailed(attemptId: string, err: unknown): void {
    const state = this.runForLiveAttempt(attemptId)
    if (!state?.live) return
    const { stepId } = state.live.record
    this.log('attempt start failed', { runId: state.record.runId, stepId, attemptId })
    const result: StepResult | undefined =
      err instanceof StepStartError ? { status: 'failed', summary: err.summary, completedBy: 'exit' } : undefined
    this.endAttempt(state, 'failed', result, false)
    this.setStep(state, stepId, 'failed')
    this.pause(state, 'step-failed')
    this.settle(state)
  }

  private onDriverEvent(event: StepDriverEvent): void {
    const attemptId = this.executions.get(event.executionId)
    if (attemptId === undefined) return
    switch (event.type) {
      case 'exited': {
        const kind = this.runForLiveAttempt(attemptId)?.live?.kind
        this.complete(attemptId, {
          status: kind === 'shell' && event.code === 0 ? 'done' : 'failed',
          summary: event.summary ?? '',
          completedBy: 'exit',
          ...(event.code === null ? {} : { exitCode: event.code })
        })
        return
      }
      case 'turnEnded':
        return
      default: {
        const _exhaustive: never = event
        void _exhaustive
      }
    }
  }

  private endAttempt(
    state: RunState,
    status: Exclude<WorkflowAttemptStatus, 'running' | 'interrupted'>,
    result: StepResult | undefined,
    cancelExecution: boolean
  ): void {
    const live = state.live
    if (!live) return
    state.live = null
    const { attemptId, stepId } = live.record
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
      if (cancelExecution) this.deps.drivers[live.kind].cancel(live.executionId)
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

  private pause(state: RunState, reason: WorkflowPausedReason): void {
    const { record } = state
    if (record.status === 'paused' && record.pausedReason === reason) return
    record.status = 'paused'
    record.pausedReason = reason
    const attempt = state.live?.record ?? record.attempts.at(-1)
    if (attempt && (state.live || attempt.stepId === this.currentStep(state)?.id)) {
      attempt.metrics.pauses.push({ reason, at: this.deps.now() })
    }
    this.deps.store.dispatch({ type: 'workflows/runPaused', payload: { runId: record.runId, reason } })
    this.log(`run paused ${reason}`, { runId: record.runId })
  }

  private resume(state: RunState): void {
    const { record } = state
    if (record.status !== 'paused') return
    record.status = 'running'
    delete record.pausedReason
    this.deps.store.dispatch({ type: 'workflows/runResumed', payload: { runId: record.runId } })
    this.log('run resumed', { runId: record.runId })
  }

  private dequeue(runId: string): string | undefined {
    const entry = this.queue.find((queued) => queued.runId === runId)
    if (!entry) return undefined
    this.queue = this.queue.filter((queued) => queued.runId !== runId)
    return entry.stepId
  }

  private drain(): void {
    while (this.queue.length > 0 && this.agentSlots.size < this.agentCap()) {
      const entry = this.queue.shift()
      const state = entry && this.runs.get(entry.runId)
      const step = state && this.currentStep(state)
      if (!state || !step || state.live || step.id !== entry.stepId) continue
      this.launch(state, step)
    }
  }

  private settle(state: RunState): void {
    this.persist(state.record)
    this.drain()
  }

  private log(message: string, ids?: Record<string, string>): void {
    this.deps.log('workflow', message, ids)
  }
}

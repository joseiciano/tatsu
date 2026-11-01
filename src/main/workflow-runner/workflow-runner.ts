import type {
  WorkflowAttemptRecord,
  WorkflowRunRecord,
  WorkflowRunnerDeps,
  StartRefusal,
  StartRunRequest,
  StartRunResult,
  StepResult
} from './types'
import type { RunnableStep, StepDriverEvent, StepDriverKind } from './drivers/types'
import type { ResolvedWorkflowStep } from '../../shared/workflow-def'
import type { StateEvent } from '../../shared/state'
import type {
  WorkflowAttemptStatus,
  WorkflowPausedReason,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowRunStep,
  WorkflowStepStatus
} from '../../shared/state/workflows'

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
}

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

  start(request: StartRunRequest): StartRunResult {
    const { store, loader, now, newId } = this.deps
    if (!store.getSnapshot().state.settings.labs.workflows) return this.refuse('labs-off')
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
        runId,
        defId: run.defId,
        defHash: run.defHash,
        definition,
        inputs: { ...request.inputs },
        worktreePath: request.worktreePath,
        status: 'running',
        cursor: 0,
        attempts: []
      },
      stepStatus,
      live: null
    }
    this.runs.set(runId, state)
    store.dispatch({ type: 'workflows/runStarted', payload: { runId, run } })
    this.log('run started', { runId })
    this.enterStep(state)
    this.settle(state)
    return { ok: true, runId }
  }

  complete(attemptId: string, result: StepResult): boolean {
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
    state.record.status = 'cancelled'
    delete state.record.pausedReason
    this.deps.store.dispatch({
      type: 'workflows/runCancelled',
      payload: { runId, finishedAt: this.deps.now() }
    })
    this.log('run cancelled', { runId })
    this.runs.delete(runId)
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
    if (!state || state.record.status !== 'paused') return false
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

  private runForLiveAttempt(attemptId: string): RunState | undefined {
    const runId = this.liveAttempts.get(attemptId)
    const state = runId === undefined ? undefined : this.runs.get(runId)
    return state?.live?.record.attemptId === attemptId ? state : undefined
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
    state.record.status = 'done'
    this.deps.store.dispatch({
      type: 'workflows/runFinished',
      payload: { runId, status: 'done', finishedAt: this.deps.now() }
    })
    this.log('run finished done', { runId })
    this.runs.delete(runId)
  }

  private launch(state: RunState, step: RunnableStep): void {
    const { store, now, newId, drivers } = this.deps
    const { runId, worktreePath, inputs } = state.record
    const n = state.record.attempts.filter((attempt) => attempt.stepId === step.id).length + 1
    const attemptId = newId()
    const record: WorkflowAttemptRecord = { attemptId, stepId: step.id, n, status: 'running' }
    state.record.attempts.push(record)
    state.live = { record, kind: step.kind }
    this.liveAttempts.set(attemptId, runId)
    if (step.kind === 'agent') this.agentSlots.add(attemptId)
    this.setStep(state, step.id, 'running')
    store.dispatch({
      type: 'workflows/attemptStarted',
      payload: { attemptId, runId, stepId: step.id, n, startedAt: now() }
    })
    this.log('attempt started', { runId, stepId: step.id, attemptId })
    const driver = drivers[step.kind]
    Promise.resolve()
      .then(() => driver.start({ runId, stepId: step.id, attemptId, n, worktreePath, inputs, step }))
      .then(
        (execution) => this.onStarted(attemptId, step.kind, execution.executionId),
        () => this.onStartFailed(attemptId)
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
    this.executions.set(executionId, attemptId)
  }

  private onStartFailed(attemptId: string): void {
    const state = this.runForLiveAttempt(attemptId)
    if (!state?.live) return
    const { stepId } = state.live.record
    this.log('attempt start failed', { runId: state.record.runId, stepId, attemptId })
    this.endAttempt(state, 'failed', undefined, false)
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
          summary: '',
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
    live.record.status = status
    if (result) live.record.result = result
    this.liveAttempts.delete(attemptId)
    this.agentSlots.delete(attemptId)
    if (live.executionId !== undefined) {
      this.executions.delete(live.executionId)
      if (cancelExecution) this.deps.drivers[live.kind].cancel(live.executionId)
    }
    this.deps.store.dispatch({
      type: 'workflows/attemptEnded',
      payload: {
        attemptId,
        status,
        endedAt: this.deps.now(),
        summary: result?.summary ?? '',
        ...(result ? { completedBy: result.completedBy } : {}),
        ...(result?.costUsd === undefined ? {} : { costUsd: result.costUsd })
      }
    })
    this.log(`attempt ended ${status}`, { runId: state.record.runId, stepId, attemptId })
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

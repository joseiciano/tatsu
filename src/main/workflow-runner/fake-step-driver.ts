import type {
  StepAttempt,
  StepDriver,
  StepDriverEvent,
  StepDriverListener,
  StepExecution
} from './drivers/types'
import type { WorkflowRunner } from './workflow-runner'
import type { Worktree } from '../../shared/state/worktrees'
import type { TimerHandle } from '../workflow-defs-loader'

export type FakeStartBehavior = 'ok' | 'reject' | 'throw' | 'defer'

export class FakeStepDriver implements StepDriver {
  readonly started: StepAttempt[] = []
  readonly cancelled: string[] = []
  readonly released: string[] = []
  readonly continued: Array<{ attempt: StepAttempt; executionId: string; prompt: string }> = []
  continueError: Error | undefined
  sessionId: string | undefined
  private readonly listeners = new Set<StepDriverListener>()
  private readonly executionsByAttempt = new Map<string, string>()
  private readonly deferred = new Map<string, () => void>()
  private count = 0

  constructor(
    private readonly prefix: string,
    private readonly script: (attempt: StepAttempt) => FakeStartBehavior = () => 'ok',
    private readonly errorMessage = 'fake driver failure'
  ) {}

  start(attempt: StepAttempt): Promise<StepExecution> | StepExecution {
    this.started.push(attempt)
    const behavior = this.script(attempt)
    if (behavior === 'throw') throw new Error(this.errorMessage)
    if (behavior === 'reject') return Promise.reject(new Error(this.errorMessage))
    const executionId = `${this.prefix}-exec-${++this.count}`
    const execution: StepExecution =
      this.sessionId === undefined ? { executionId } : { executionId, sessionId: this.sessionId }
    this.executionsByAttempt.set(attempt.attemptId, executionId)
    if (behavior === 'defer') {
      return new Promise((resolve) => {
        this.deferred.set(attempt.attemptId, () => resolve(execution))
      })
    }
    return execution
  }

  continue(attempt: StepAttempt, executionId: string, prompt: string): Promise<void> {
    this.continued.push({ attempt, executionId, prompt })
    if (this.continueError) return Promise.reject(this.continueError)
    if (!attempt.bind({ executionId })) return Promise.reject(new Error('attempt ended before continue'))
    return Promise.resolve()
  }

  cancel(executionId: string): void {
    this.cancelled.push(executionId)
  }

  release(executionId: string): void {
    this.released.push(executionId)
  }

  onEvent(listener: StepDriverListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  executionFor(attemptId: string): string {
    const executionId = this.executionsByAttempt.get(attemptId)
    if (executionId === undefined) throw new Error(`no execution for ${attemptId}`)
    return executionId
  }

  resolveDeferred(attemptId: string): void {
    const resolve = this.deferred.get(attemptId)
    if (!resolve) throw new Error(`no deferred start for ${attemptId}`)
    this.deferred.delete(attemptId)
    resolve()
  }

  emit(event: StepDriverEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

export function currentStepId(runner: Pick<WorkflowRunner, 'getRunRecord'>, runId: string): string {
  const record = runner.getRunRecord(runId)
  return record?.definition.steps[record.cursor]?.id ?? ''
}

export function worktreeFixture(path: string): Worktree {
  return { path, branch: 'main', head: 'abc', isBare: false, isMain: false, createdAt: 0, repoRoot: path }
}

export function fakeTimers() {
  const pending = new Map<TimerHandle, { fn: () => void; ms: number }>()
  return {
    setTimer: (fn: () => void, ms: number): TimerHandle => {
      const handle = setTimeout(() => {}, 0)
      clearTimeout(handle)
      pending.set(handle, { fn, ms })
      return handle
    },
    clearTimer: (handle: TimerHandle): void => {
      pending.delete(handle)
    },
    delays: (): number[] => [...pending.values()].map((timer) => timer.ms),
    fire: (): void => {
      const due = [...pending.values()]
      pending.clear()
      for (const timer of due) timer.fn()
    }
  }
}

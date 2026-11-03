import { describe, expect, it } from 'vitest'
import { runDetailModel, type RunDetailActionKind } from '.'
import type {
  WorkflowAttemptRecord,
  WorkflowPausedReason,
  WorkflowRun,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowStepStatus
} from '../../../../shared/state/workflows'
import type { ResolvedWorkflowStep } from '../../../../shared/workflow-def'

const NOW = 1_000_000

const PLAN: ResolvedWorkflowStep = { id: 'plan', kind: 'shell', run: 'make plan', needs: [] }
const EXIT: ResolvedWorkflowStep = {
  id: 'exit',
  kind: 'agent',
  agent: 'claude',
  prompt: 'go',
  permissions: 'read-only',
  allow: [],
  needs: ['plan']
}

const SNAPSHOT = { commit: 'c1', ref: 'refs/harness/base' }

function attempt(overrides: Partial<WorkflowAttemptRecord> & Pick<WorkflowAttemptRecord, 'attemptId' | 'stepId'>): WorkflowAttemptRecord {
  return { n: 1, status: 'done', startedAt: NOW - 10_000, endedAt: NOW - 5_000, metrics: { continuations: 0, pauses: [] }, ...overrides }
}

function record(
  attempts: WorkflowAttemptRecord[],
  opts: { status?: WorkflowRunStatus; pausedReason?: WorkflowPausedReason; cursor?: number; steps?: Record<string, WorkflowStepStatus> } = {}
): WorkflowRunRecord {
  return {
    version: 1,
    runId: 'r1',
    defId: 'personal:ship',
    defHash: 'h',
    definition: { name: 'ship', inputs: {}, steps: [PLAN, EXIT] },
    inputs: {},
    worktreePath: '/wt/feature',
    contextPath: '/ctx',
    status: opts.status ?? 'paused',
    ...(opts.pausedReason ? { pausedReason: opts.pausedReason } : {}),
    cursor: opts.cursor ?? 1,
    steps: opts.steps ?? { plan: 'done', exit: 'failed' },
    startedAt: NOW - 60_000,
    attempts
  }
}

function sliceRun(rec: WorkflowRunRecord): WorkflowRun {
  return {
    defId: rec.defId,
    defHash: rec.defHash,
    worktreePath: rec.worktreePath,
    status: rec.status,
    ...(rec.pausedReason ? { pausedReason: rec.pausedReason } : {}),
    startedAt: rec.startedAt,
    steps: Object.fromEntries(Object.entries(rec.steps).map(([id, status]) => [id, { status, attemptIds: [] }]))
  }
}

function actionsFor(rec: WorkflowRunRecord, tabExists = false): RunDetailActionKind[] {
  return runDetailModel({ record: rec, run: sliceRun(rec), tabExists, now: NOW }).actions
}

const PLAN_DONE = attempt({ attemptId: 'a-plan', stepId: 'plan', startedAt: NOW - 50_000, endedAt: NOW - 45_000, metrics: { continuations: 0, pauses: [], completedBy: 'exit' } })

describe('runDetailModel timeline', () => {
  it('lists every attempt in step order then attempt number, with status, completion, duration and cost', () => {
    const rec = record(
      [
        attempt({
          attemptId: 'a-exit-2',
          stepId: 'exit',
          n: 2,
          status: 'done',
          startedAt: NOW - 20_000,
          endedAt: NOW - 20_000,
          result: { status: 'done', summary: 'by hand', completedBy: 'user' }
        }),
        PLAN_DONE,
        attempt({
          attemptId: 'a-exit-1',
          stepId: 'exit',
          n: 1,
          status: 'failed',
          startedAt: NOW - 40_000,
          endedAt: NOW - 25_000,
          metrics: { continuations: 0, pauses: [], completedBy: 'exit', costUsd: 0.125 }
        })
      ],
      { status: 'done', cursor: 2, steps: { plan: 'done', exit: 'done' } }
    )
    const { timeline } = runDetailModel({ record: rec, run: sliceRun(rec), tabExists: false, now: NOW })
    expect(timeline).toEqual([
      { attemptId: 'a-plan', stepId: 'plan', n: 1, status: 'done', statusLabel: 'done', completedBy: 'process exit', duration: '5s', cost: '—' },
      { attemptId: 'a-exit-1', stepId: 'exit', n: 1, status: 'failed', statusLabel: 'failed', completedBy: 'process exit', duration: '15s', cost: '$0.13' },
      { attemptId: 'a-exit-2', stepId: 'exit', n: 2, status: 'done', statusLabel: 'done', completedBy: 'you (Mark done)', duration: '0s', cost: '—' }
    ])
  })

  it('times a running attempt up to now and leaves an unfinished, stopped attempt without a duration', () => {
    const rec = record(
      [
        attempt({ attemptId: 'a-plan', stepId: 'plan', status: 'interrupted', startedAt: NOW - 30_000, endedAt: undefined }),
        attempt({ attemptId: 'a-exit', stepId: 'exit', status: 'running', startedAt: NOW - 65_000, endedAt: undefined })
      ],
      { status: 'running', steps: { plan: 'interrupted', exit: 'running' } }
    )
    const { timeline } = runDetailModel({ record: rec, run: sliceRun(rec), tabExists: false, now: NOW })
    expect(timeline.map((row) => [row.attemptId, row.statusLabel, row.duration, row.completedBy])).toEqual([
      ['a-plan', 'interrupted', '—', null],
      ['a-exit', 'running', '1m 05s', null]
    ])
  })

  it('names the latest attempt', () => {
    const rec = record([PLAN_DONE, attempt({ attemptId: 'a-exit', stepId: 'exit', status: 'failed' })], { pausedReason: 'step-failed' })
    expect(runDetailModel({ record: rec, run: sliceRun(rec), tabExists: false, now: NOW }).latestAttemptId).toBe('a-exit')
    const empty = record([], { status: 'queued', cursor: 0, steps: { plan: 'pending', exit: 'pending' } })
    expect(runDetailModel({ record: empty, run: sliceRun(empty), tabExists: false, now: NOW }).latestAttemptId).toBeNull()
  })
})

describe('runDetailModel actions', () => {
  const failedExit = (extra: Partial<WorkflowAttemptRecord> = {}) =>
    attempt({ attemptId: 'a-exit', stepId: 'exit', status: 'failed', ...extra })

  it('offers Retry, Retry from clean, Mark done, Skip and Cancel run on a failed agent step with a base snapshot', () => {
    const rec = record([PLAN_DONE, failedExit({ baseSnapshot: SNAPSHOT })], { pausedReason: 'step-failed' })
    expect(actionsFor(rec)).toEqual(['retry', 'retry-from-clean', 'mark-done', 'skip', 'cancel-run'])
    expect(runDetailModel({ record: rec, run: sliceRun(rec), tabExists: false, now: NOW }).actionStepId).toBe('exit')
  })

  it('hides Retry from clean when the latest attempt has no base snapshot', () => {
    const rec = record([PLAN_DONE, failedExit({ baseSnapshot: SNAPSHOT, attemptId: 'a-old' }), failedExit({ n: 2 })], {
      pausedReason: 'step-failed'
    })
    expect(actionsFor(rec)).toEqual(['retry', 'mark-done', 'skip', 'cancel-run'])
  })

  it('offers Mark done, Retry, Skip and Cancel run when the step needs input', () => {
    const rec = record([PLAN_DONE, attempt({ attemptId: 'a-exit', stepId: 'exit', status: 'running', endedAt: undefined })], {
      pausedReason: 'needs-input',
      steps: { plan: 'done', exit: 'running' }
    })
    expect(actionsFor(rec)).toEqual(['retry', 'mark-done', 'skip', 'cancel-step', 'cancel-run'])
  })

  it('offers Resume for an interrupted Claude attempt with a session', () => {
    const rec = record([PLAN_DONE, attempt({ attemptId: 'a-exit', stepId: 'exit', status: 'interrupted', sessionId: 's1' })], {
      pausedReason: 'interrupted',
      steps: { plan: 'done', exit: 'interrupted' }
    })
    expect(actionsFor(rec)).toEqual(['resume', 'retry', 'cancel-run'])
  })

  it('offers Cancel step and Cancel run while a step runs, plus Jump to tab when its tab exists', () => {
    const rec = record([PLAN_DONE, attempt({ attemptId: 'a-exit', stepId: 'exit', status: 'running', endedAt: undefined })], {
      status: 'running',
      steps: { plan: 'done', exit: 'running' }
    })
    expect(actionsFor(rec)).toEqual(['cancel-step', 'cancel-run'])
    expect(actionsFor(rec, true)).toEqual(['cancel-step', 'cancel-run', 'jump'])
  })

  it('offers only Cancel run on a queued run and only Jump to tab on a finished one', () => {
    const queued = record([], { status: 'queued', cursor: 0, steps: { plan: 'pending', exit: 'pending' } })
    expect(actionsFor(queued)).toEqual(['cancel-run'])
    const done = record([PLAN_DONE], { status: 'done', cursor: 2, steps: { plan: 'done', exit: 'done' } })
    expect(actionsFor(done)).toEqual([])
    expect(actionsFor(done, true)).toEqual(['jump'])
  })

  it('reads run status from the live slice over the fetched record', () => {
    const rec = record([PLAN_DONE, failedExit({ baseSnapshot: SNAPSHOT })], { pausedReason: 'step-failed' })
    const cancelled: WorkflowRun = { ...sliceRun(rec), status: 'cancelled', pausedReason: undefined }
    expect(runDetailModel({ record: rec, run: cancelled, tabExists: false, now: NOW }).actions).toEqual([])
  })

  it('drops step actions when the cursor names no step', () => {
    const rec = record([PLAN_DONE], { pausedReason: 'budget', cursor: 2 })
    expect(actionsFor(rec)).toEqual(['cancel-run'])
  })
})

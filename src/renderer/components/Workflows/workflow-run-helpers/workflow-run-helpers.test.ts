import { describe, expect, it, vi } from 'vitest'
import {
  pausedReasonLabel,
  budgetFloorUsd,
  parseBudgetInput,
  suggestedBudgetUsd,
  confirmRetryFromClean,
  currentStepId,
  recordStepContext,
  runNeedsYouAction,
  sliceStepContext,
  deriveStepStrip,
  displayStepStatus,
  needsYouActions,
  stepOrderFor,
  type NeedsYouActionKind,
  type NeedsYouAttemptInfo,
  type NeedsYouStepInfo
} from '.'
import type {
  WorkflowAttempt,
  WorkflowAttemptRecord,
  WorkflowDefinitionSummary,
  WorkflowPausedReason,
  WorkflowRunRecord,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStepStatus
} from '../../../../shared/state/workflows'
import type { ResolvedWorkflowStep } from '../../../../shared/workflow-def'

function run(
  steps: Record<string, WorkflowStepStatus>,
  status: WorkflowRunStatus = 'running',
  pausedReason?: WorkflowPausedReason
): WorkflowRun {
  return {
    defId: 'personal:wf',
    defHash: 'h1',
    worktreePath: '/wt/a',
    status,
    ...(pausedReason ? { pausedReason } : {}),
    startedAt: 1,
    steps: Object.fromEntries(Object.entries(steps).map(([id, s]) => [id, { status: s, attemptIds: [] }]))
  }
}

function summary(stepIds: string[], hash = 'h1'): WorkflowDefinitionSummary {
  return { id: 'personal:wf', name: 'wf', scope: 'personal', path: '/d/wf.yaml', hash, stepIds, issues: [] }
}

describe('deriveStepStrip', () => {
  it.each<[WorkflowStepStatus, string]>([
    ['done', '✓'],
    ['running', '●'],
    ['failed', '✕'],
    ['skipped', '↷'],
    ['pending', '○'],
    ['queued', '○'],
    ['awaiting-gate', '!'],
    ['cancelled', '✕'],
    ['interrupted', '!']
  ])('renders a %s step as %s', (status, glyph) => {
    const strip = deriveStepStrip(run({ only: status }), ['only'])
    expect(strip).toEqual([{ id: 'only', status, glyph, paused: false }])
  })

  it('marks every running branch running', () => {
    const strip = deriveStepStrip(run({ plan: 'done', left: 'running', right: 'running', join: 'pending' }), ['plan', 'left', 'right', 'join'])
    expect(strip.map((s) => [s.id, s.status, s.glyph])).toEqual([
      ['plan', 'done', '✓'],
      ['left', 'running', '●'],
      ['right', 'running', '●'],
      ['join', 'pending', '○']
    ])
  })

  it('keeps a sibling running while another branch has paused the run', () => {
    const strip = deriveStepStrip(
      { ...run({ plan: 'done', left: 'failed', right: 'running' }, 'paused', 'step-failed'), cursorStepId: 'left' },
      ['plan', 'left', 'right']
    )
    expect(strip.map((s) => [s.id, s.glyph, s.paused])).toEqual([
      ['plan', '✓', false],
      ['left', '!', true],
      ['right', '●', false]
    ])
  })

  it('marks only the current step of a paused run with !', () => {
    const strip = deriveStepStrip(run({ plan: 'done', build: 'failed', test: 'pending' }, 'paused', 'step-failed'), [
      'plan',
      'build',
      'test'
    ])
    expect(strip.map((s) => s.glyph)).toEqual(['✓', '!', '○'])
    expect(strip.map((s) => s.paused)).toEqual([false, true, false])
  })

  it('marks the cursor step of a run paused at its loop cap even though that step is done', () => {
    const strip = deriveStepStrip(
      { ...run({ build: 'done', review: 'done', publish: 'pending' }, 'paused', 'loop-cap'), cursorStepId: 'review' },
      ['build', 'review', 'publish']
    )
    expect(strip.map((s) => s.glyph)).toEqual(['✓', '!', '○'])
    expect(strip.map((s) => s.paused)).toEqual([false, true, false])
  })

  it('marks no step of a budget-paused run as needing you, even the cursor step that is still running', () => {
    const strip = deriveStepStrip(
      { ...run({ plan: 'running', build: 'pending' }, 'paused', 'budget'), cursorStepId: 'plan' },
      ['plan', 'build']
    )
    expect(strip.map((s) => [s.glyph, s.paused])).toEqual([
      ['●', false],
      ['○', false]
    ])
  })

  it('shows a gated step of a cancelled run as cancelled, not waiting at its gate', () => {
    const strip = deriveStepStrip(run({ plan: 'awaiting-gate', test: 'pending' }, 'cancelled'), ['plan', 'test'])
    expect(strip.map((s) => [s.status, s.glyph, s.paused])).toEqual([
      ['cancelled', '✕', false],
      ['pending', '○', false]
    ])
  })

  it('follows the given order and drops ids the run does not have', () => {
    const strip = deriveStepStrip(run({ a: 'done', b: 'running' }), ['b', 'gone', 'a'])
    expect(strip.map((s) => s.id)).toEqual(['b', 'a'])
  })
})

describe('displayStepStatus', () => {
  it.each<[WorkflowRunStatus, WorkflowStepStatus, WorkflowStepStatus]>([
    ['cancelled', 'awaiting-gate', 'cancelled'],
    ['failed', 'awaiting-gate', 'cancelled'],
    ['done', 'awaiting-gate', 'cancelled'],
    ['paused', 'awaiting-gate', 'awaiting-gate'],
    ['running', 'awaiting-gate', 'awaiting-gate'],
    ['queued', 'awaiting-gate', 'awaiting-gate'],
    ['cancelled', 'done', 'done'],
    ['cancelled', 'pending', 'pending'],
    ['paused', 'failed', 'failed']
  ])('a %s run shows a %s step as %s', (runStatus, stepStatus, expected) => {
    expect(displayStepStatus(runStatus, stepStatus)).toBe(expected)
  })
})

describe('stepOrderFor', () => {
  const r = run({ plan: 'done', build: 'pending' })

  it('uses the definition step ids when the hash matches', () => {
    expect(stepOrderFor(r, summary(['build', 'plan']))).toEqual(['build', 'plan'])
  })

  it("falls back to the run's own steps when the definition is gone or changed", () => {
    expect(stepOrderFor(r, null)).toEqual(['plan', 'build'])
    expect(stepOrderFor(r, summary(['other'], 'h2'))).toEqual(['plan', 'build'])
  })
})

describe('currentStepId', () => {
  it('is the first step that is neither done nor skipped', () => {
    expect(currentStepId(run({ a: 'done', b: 'skipped', c: 'failed', d: 'pending' }), ['a', 'b', 'c', 'd'])).toBe('c')
  })

  it('is null when every step finished', () => {
    expect(currentStepId(run({ a: 'done' }), ['a'])).toBeNull()
  })
})

const CLAUDE: NeedsYouStepInfo = { kind: 'agent', agent: 'claude' }
const CODEX: NeedsYouStepInfo = { kind: 'agent', agent: 'codex' }
const OPENCODE: NeedsYouStepInfo = { kind: 'agent', agent: 'opencode' }
const SHELL: NeedsYouStepInfo = { kind: 'shell' }
const FAILED: NeedsYouAttemptInfo = { status: 'failed', resumable: false }
const FAILED_WITH_SNAPSHOT: NeedsYouAttemptInfo = { status: 'failed', resumable: false, hasBaseSnapshot: true }
const LIVE: NeedsYouAttemptInfo = { status: 'running', resumable: true }
const DONE: NeedsYouAttemptInfo = { status: 'done', resumable: true }
const INTERRUPTED_SESSION: NeedsYouAttemptInfo = { status: 'interrupted', resumable: true }

describe('pausedReasonLabel', () => {
  it('reads a step-failed pause on a cancelled step as cancelled by user', () => {
    expect(pausedReasonLabel('step-failed', 'cancelled')).toBe('Cancelled by user')
  })

  it('keeps the reason label for every other step status and reason', () => {
    expect(pausedReasonLabel('step-failed', 'failed')).toBe('Step failed')
    expect(pausedReasonLabel('step-failed', null)).toBe('Step failed')
    expect(pausedReasonLabel('interrupted', 'cancelled')).toBe('Interrupted')
  })
})

describe('needsYouActions', () => {
  it.each<[string, WorkflowPausedReason, NeedsYouStepInfo | null, NeedsYouAttemptInfo | null, boolean, NeedsYouActionKind[]]>([
    ['step-failed with a tab', 'step-failed', SHELL, FAILED_WITH_SNAPSHOT, true, ['retry', 'retry-from-clean', 'skip', 'cancel', 'jump']],
    ['step-failed without a tab', 'step-failed', SHELL, FAILED_WITH_SNAPSHOT, false, ['retry', 'retry-from-clean', 'skip', 'cancel']],
    ['step-failed without a base snapshot', 'step-failed', SHELL, FAILED, true, ['retry', 'skip', 'cancel', 'jump']],
    ['step-failed before the record loaded', 'step-failed', null, null, false, ['retry', 'skip', 'cancel']],
    ['needs-input with a tab', 'needs-input', CLAUDE, LIVE, true, ['jump', 'retry', 'skip', 'cancel']],
    ['needs-input without a tab', 'needs-input', CLAUDE, FAILED, false, ['retry', 'skip', 'cancel']],
    ['needs-approval with a tab', 'needs-approval', CLAUDE, LIVE, true, ['jump', 'cancel']],
    ['needs-approval without a tab', 'needs-approval', CLAUDE, LIVE, false, ['cancel']],
    ['interrupted Claude step with a session', 'interrupted', CLAUDE, INTERRUPTED_SESSION, true, ['resume', 'retry', 'cancel']],
    ['interrupted Claude step without a session', 'interrupted', CLAUDE, { status: 'interrupted', resumable: false }, false, ['retry', 'cancel']],
    ['interrupted Codex step with a session', 'interrupted', CODEX, INTERRUPTED_SESSION, false, ['resume', 'retry', 'cancel']],
    ['interrupted opencode step with a session', 'interrupted', OPENCODE, INTERRUPTED_SESSION, false, ['resume', 'retry', 'cancel']],
    ['interrupted opencode step without a session', 'interrupted', OPENCODE, { status: 'interrupted', resumable: false }, false, ['retry', 'cancel']],
    ['interrupted shell step', 'interrupted', SHELL, INTERRUPTED_SESSION, false, ['retry', 'cancel']],
    ['interrupted run held while labs was off', 'interrupted', CLAUDE, null, false, ['retry', 'cancel']],
    ['interrupted step not loaded yet', 'interrupted', null, null, false, ['retry', 'cancel']],
    ['trust with no tab', 'trust', CLAUDE, FAILED, false, ['retry', 'cancel']],
    ['trust with a tab', 'trust', CLAUDE, FAILED, true, ['retry', 'cancel', 'jump']],
    ['gate on an agent step with a tab', 'gate', CLAUDE, DONE, true, ['approve', 'request-changes', 'cancel', 'jump']],
    ['gate on an agent step without a tab', 'gate', CODEX, DONE, false, ['approve', 'request-changes', 'cancel']],
    ['gate on a shell step', 'gate', SHELL, DONE, false, ['approve', 'cancel']],
    ['gate before the step loaded', 'gate', null, null, true, ['approve', 'cancel', 'jump']],
    ['budget', 'budget', null, null, false, ['raise-budget', 'cancel']],
    ['budget with a live step tab', 'budget', CLAUDE, null, true, ['raise-budget', 'cancel']],
    ['loop-cap with a tab', 'loop-cap', CLAUDE, DONE, true, ['loop-again', 'loop-continue', 'cancel', 'jump']],
    ['loop-cap on a shell step', 'loop-cap', SHELL, DONE, false, ['loop-again', 'loop-continue', 'cancel']],
    ['loop-cap before the step loaded', 'loop-cap', null, null, false, ['loop-again', 'loop-continue', 'cancel']],
    ['timeout with a tab', 'timeout', CLAUDE, null, true, ['keep-waiting', 'cancel', 'jump']],
    ['timeout on a shell step', 'timeout', SHELL, null, false, ['keep-waiting', 'cancel']],
    ['restack-conflict', 'restack-conflict', null, null, false, ['cancel']]
  ])('%s', (_name, reason, step, attempt, tabExists, expected) => {
    expect(needsYouActions({ reason, step, attempt, tabExists })).toEqual(expected)
  })

  it('offers Resume only when the last attempt was interrupted', () => {
    expect(needsYouActions({ reason: 'interrupted', step: CLAUDE, attempt: { status: 'failed', resumable: true }, tabExists: false })).toEqual([
      'retry',
      'cancel'
    ])
  })
})

function record(steps: ResolvedWorkflowStep[], cursor: number, attempts: Partial<WorkflowAttemptRecord>[]): WorkflowRunRecord {
  return {
    version: 1,
    runId: 'r',
    defId: 'personal:wf',
    defHash: 'h1',
    definition: { name: 'wf', inputs: {}, steps },
    inputs: {},
    worktreePath: '/wt/a',
    contextPath: '/ctx',
    status: 'paused',
    cursor,
    steps: {},
    startedAt: 1,
    attempts: attempts.map((a, i) => ({
      attemptId: `a${i}`,
      stepId: 'plan',
      n: i + 1,
      status: 'failed',
      startedAt: i,
      metrics: { continuations: 0, pauses: [] },
      ...a
    }))
  }
}

const PLAN_STEP: ResolvedWorkflowStep = { id: 'plan', kind: 'shell', run: 'make', needs: [] }
const FIX_STEP: ResolvedWorkflowStep = {
  id: 'fix',
  kind: 'agent',
  agent: 'claude',
  prompt: 'go',
  permissions: 'edit',
  allow: [],
  needs: ['plan']
}

describe('recordStepContext', () => {
  it("reads the cursor step's kind and its latest attempt", () => {
    const rec = record([PLAN_STEP, FIX_STEP], 1, [
      { stepId: 'plan', status: 'done' },
      { stepId: 'fix', status: 'failed', sessionId: 'old' },
      { stepId: 'fix', status: 'interrupted', sessionId: 'new' }
    ])
    expect(recordStepContext(rec)).toEqual({
      stepId: 'fix',
      step: { kind: 'agent', agent: 'claude' },
      attempt: { status: 'interrupted', resumable: true, hasBaseSnapshot: false }
    })
  })

  it("reports whether the cursor step's latest attempt has a base snapshot", () => {
    const snapshot = { commit: 'c1', ref: 'refs/harness/base' }
    const withSnapshot = record([PLAN_STEP], 0, [{ status: 'failed' }, { status: 'failed', baseSnapshot: snapshot }])
    const latestWithout = record([PLAN_STEP], 0, [{ status: 'failed', baseSnapshot: snapshot }, { status: 'failed' }])
    expect(recordStepContext(withSnapshot)?.attempt?.hasBaseSnapshot).toBe(true)
    expect(recordStepContext(latestWithout)?.attempt?.hasBaseSnapshot).toBe(false)
  })

  it('has no attempt for a step that never started', () => {
    expect(recordStepContext(record([PLAN_STEP], 0, []))).toEqual({ stepId: 'plan', step: { kind: 'shell' }, attempt: null })
  })

  it('is null when the cursor is past the last step', () => {
    expect(recordStepContext(record([PLAN_STEP], 1, []))).toBeNull()
  })
})

describe('sliceStepContext', () => {
  function slicedRun(cursorStepId: string | undefined, withKinds = true): WorkflowRun {
    return {
      ...run({ plan: 'done', fix: 'interrupted' }, 'paused', 'interrupted'),
      ...(cursorStepId === undefined ? {} : { cursorStepId }),
      steps: {
        plan: { status: 'done', attemptIds: ['a0'], ...(withKinds ? { kind: 'shell' as const } : {}) },
        fix: { status: 'interrupted', attemptIds: ['a1'], ...(withKinds ? { kind: 'agent' as const, agent: 'claude' as const } : {}) }
      }
    }
  }
  const interrupted: WorkflowAttempt = { runId: 'r', stepId: 'fix', n: 1, status: 'interrupted', summaryPreview: '', startedAt: 1, endedAt: 2 }

  it("reads the cursor step's kind, agent and the last attempt's resumability from the slice", () => {
    expect(sliceStepContext(slicedRun('fix'), { ...interrupted, resumable: true })).toEqual({
      stepId: 'fix',
      step: { kind: 'agent', agent: 'claude' },
      attempt: { status: 'interrupted', resumable: true }
    })
    expect(sliceStepContext(slicedRun('fix'), interrupted)?.attempt).toEqual({ status: 'interrupted', resumable: false })
    expect(sliceStepContext(slicedRun('plan'), null)).toEqual({ stepId: 'plan', step: { kind: 'shell' }, attempt: null })
  })

  it('is null when an old server sent no cursor or no step kind', () => {
    expect(sliceStepContext(slicedRun(undefined), interrupted)).toBeNull()
    expect(sliceStepContext(slicedRun('fix', false), interrupted)).toBeNull()
  })
})

describe('runNeedsYouAction', () => {
  function api() {
    const ok = { ok: true } as const
    return {
      retryWorkflowStep: vi.fn(async () => ok),
      skipWorkflowStep: vi.fn(async () => ok),
      resumeWorkflowStep: vi.fn(async () => ok),
      cancelWorkflowRun: vi.fn(async () => ok),
      retryWorkflowStepFromClean: vi.fn(async () => ok),
      approveWorkflowGate: vi.fn(async () => ok),
      resolveWorkflowLoopCap: vi.fn(async () => ok),
      keepWaitingWorkflowStep: vi.fn(async () => ok)
    }
  }

  it.each([
    ['retry', 'retryWorkflowStep', ['r', 's']],
    ['skip', 'skipWorkflowStep', ['r', 's']],
    ['resume', 'resumeWorkflowStep', ['r', 's']],
    ['cancel', 'cancelWorkflowRun', ['r']],
    ['approve', 'approveWorkflowGate', ['r', 's']],
    ['loop-again', 'resolveWorkflowLoopCap', ['r', 's', 'again']],
    ['loop-continue', 'resolveWorkflowLoopCap', ['r', 's', 'continue']],
    ['keep-waiting', 'keepWaitingWorkflowStep', ['r', 's']]
  ] as const)('%s calls %s', async (kind, method, args) => {
    const backend = api()
    await expect(runNeedsYouAction(backend, kind, 'r', 's')).resolves.toEqual({ ok: true })
    expect(backend[method]).toHaveBeenCalledWith(...args)
    expect(backend.retryWorkflowStepFromClean).not.toHaveBeenCalled()
  })

  it('retries from clean only with the explicit confirmation', async () => {
    const backend = api()
    await confirmRetryFromClean(backend, 'r', 's')
    expect(backend.retryWorkflowStepFromClean).toHaveBeenCalledWith('r', 's', { confirmed: true })
  })
})

describe('budget input helpers', () => {
  it('floors the new budget one cent above the total, capped at the maximum', () => {
    expect(budgetFloorUsd(0)).toBe(0.01)
    expect(budgetFloorUsd(0.06)).toBe(0.07)
    expect(budgetFloorUsd(0.0649)).toBe(0.07)
    expect(budgetFloorUsd(20000)).toBe(10000)
  })

  it('suggests double the larger of the spend and the budget, never below the floor nor above the maximum', () => {
    expect(suggestedBudgetUsd(0.06, 0.01)).toBe(0.12)
    expect(suggestedBudgetUsd(0.09, 0.01)).toBe(0.18)
    expect(suggestedBudgetUsd(0.06, 1)).toBe(2)
    expect(suggestedBudgetUsd(0, undefined)).toBe(0.01)
    expect(suggestedBudgetUsd(1, 8000)).toBe(10000)
  })

  it('accepts only a plain amount above the total and at most the maximum', () => {
    expect(parseBudgetInput('1', 0.06)).toBe(1)
    expect(parseBudgetInput(' 0.07 ', 0.06)).toBe(0.07)
    expect(parseBudgetInput('10000', 0.06)).toBe(10000)
    for (const text of ['', '0.06', '0.05', '0', '-1', '10000.01', 'abc', '1e2', 'Infinity', '0x10', '1,5']) {
      expect(parseBudgetInput(text, 0.06)).toBeNull()
    }
  })
})

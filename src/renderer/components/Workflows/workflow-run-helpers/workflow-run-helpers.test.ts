import { describe, expect, it, vi } from 'vitest'
import {
  confirmRetryFromClean,
  currentStepId,
  recordStepContext,
  runNeedsYouAction,
  deriveStepStrip,
  needsYouActions,
  stepOrderFor,
  type NeedsYouActionKind,
  type NeedsYouAttemptInfo,
  type NeedsYouStepInfo
} from '.'
import type {
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

  it('marks only the current step of a paused run with !', () => {
    const strip = deriveStepStrip(run({ plan: 'done', build: 'failed', test: 'pending' }, 'paused', 'step-failed'), [
      'plan',
      'build',
      'test'
    ])
    expect(strip.map((s) => s.glyph)).toEqual(['✓', '!', '○'])
    expect(strip.map((s) => s.paused)).toEqual([false, true, false])
  })

  it('follows the given order and drops ids the run does not have', () => {
    const strip = deriveStepStrip(run({ a: 'done', b: 'running' }), ['b', 'gone', 'a'])
    expect(strip.map((s) => s.id)).toEqual(['b', 'a'])
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
const SHELL: NeedsYouStepInfo = { kind: 'shell' }
const FAILED: NeedsYouAttemptInfo = { status: 'failed' }
const LIVE: NeedsYouAttemptInfo = { status: 'running', sessionId: 's-1' }
const INTERRUPTED_SESSION: NeedsYouAttemptInfo = { status: 'interrupted', sessionId: 's-1' }

describe('needsYouActions', () => {
  it.each<[string, WorkflowPausedReason, NeedsYouStepInfo | null, NeedsYouAttemptInfo | null, boolean, NeedsYouActionKind[]]>([
    ['step-failed with a tab', 'step-failed', SHELL, FAILED, true, ['retry', 'retry-from-clean', 'skip', 'cancel', 'jump']],
    ['step-failed without a tab', 'step-failed', SHELL, FAILED, false, ['retry', 'retry-from-clean', 'skip', 'cancel']],
    ['needs-input with a tab', 'needs-input', CLAUDE, LIVE, true, ['jump', 'retry', 'skip', 'cancel']],
    ['needs-input without a tab', 'needs-input', CLAUDE, FAILED, false, ['retry', 'skip', 'cancel']],
    ['needs-approval with a tab', 'needs-approval', CLAUDE, LIVE, true, ['jump', 'cancel']],
    ['needs-approval without a tab', 'needs-approval', CLAUDE, LIVE, false, ['cancel']],
    ['interrupted Claude step with a session', 'interrupted', CLAUDE, INTERRUPTED_SESSION, true, ['resume', 'retry', 'cancel']],
    ['interrupted Claude step without a session', 'interrupted', CLAUDE, { status: 'interrupted' }, false, ['retry', 'cancel']],
    ['interrupted non-Claude agent step', 'interrupted', CODEX, INTERRUPTED_SESSION, false, ['retry', 'cancel']],
    ['interrupted shell step', 'interrupted', SHELL, INTERRUPTED_SESSION, false, ['retry', 'cancel']],
    ['interrupted run held while labs was off', 'interrupted', CLAUDE, null, false, ['retry', 'cancel']],
    ['interrupted step not loaded yet', 'interrupted', null, null, false, ['retry', 'cancel']],
    ['trust with no tab', 'trust', CLAUDE, FAILED, false, ['retry', 'cancel']],
    ['trust with a tab', 'trust', CLAUDE, FAILED, true, ['retry', 'cancel', 'jump']],
    ['gate', 'gate', null, null, true, ['cancel', 'jump']],
    ['budget', 'budget', null, null, false, ['cancel']],
    ['loop-cap', 'loop-cap', null, null, false, ['cancel']],
    ['timeout', 'timeout', null, null, false, ['cancel']],
    ['restack-conflict', 'restack-conflict', null, null, false, ['cancel']]
  ])('%s', (_name, reason, step, attempt, tabExists, expected) => {
    expect(needsYouActions({ reason, step, attempt, tabExists })).toEqual(expected)
  })

  it('offers Resume only when the last attempt was interrupted', () => {
    expect(needsYouActions({ reason: 'interrupted', step: CLAUDE, attempt: { status: 'failed', sessionId: 's' }, tabExists: false })).toEqual([
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
      attempt: { status: 'interrupted', sessionId: 'new' }
    })
  })

  it('has no attempt for a step that never started', () => {
    expect(recordStepContext(record([PLAN_STEP], 0, []))).toEqual({ stepId: 'plan', step: { kind: 'shell' }, attempt: null })
  })

  it('is null when the cursor is past the last step', () => {
    expect(recordStepContext(record([PLAN_STEP], 1, []))).toBeNull()
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
      retryWorkflowStepFromClean: vi.fn(async () => ok)
    }
  }

  it.each([
    ['retry', 'retryWorkflowStep', ['r', 's']],
    ['skip', 'skipWorkflowStep', ['r', 's']],
    ['resume', 'resumeWorkflowStep', ['r', 's']],
    ['cancel', 'cancelWorkflowRun', ['r']]
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

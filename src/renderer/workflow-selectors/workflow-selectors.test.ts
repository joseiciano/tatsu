import { describe, expect, it } from 'vitest'
import {
  createPausedRunIdsSelector,
  createRunAttemptsSelector,
  findWorkflowStepTab,
  selectWorkflowRunIdForWorktree,
  workflowRunRecordKey
} from '.'
import type { WorkflowAttempt, WorkflowRun, WorkflowRunStatus, WorkflowsState } from '../../shared/state/workflows'
import type { PaneLeaf, PaneNode, TerminalTab } from '../../shared/state/terminals'

function run(status: WorkflowRunStatus, overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return { defId: 'personal:wf', defHash: 'h', worktreePath: '/wt/a', status, startedAt: 1, steps: {}, ...overrides }
}

function attempt(runId: string, startedAt: number, endedAt?: number): WorkflowAttempt {
  return {
    runId,
    stepId: 's',
    n: 1,
    status: endedAt === undefined ? 'running' : 'failed',
    summaryPreview: '',
    startedAt,
    ...(endedAt === undefined ? {} : { endedAt })
  }
}

function state(runs: Record<string, WorkflowRun>, attempts: Record<string, WorkflowAttempt> = {}): WorkflowsState {
  return { definitions: {}, runs, attempts, trust: {} }
}

describe('createPausedRunIdsSelector', () => {
  it('lists paused runs only, oldest pause first', () => {
    const select = createPausedRunIdsSelector()
    const ids = select(
      state(
        {
          late: run('paused', { startedAt: 1, steps: { s: { status: 'failed', attemptIds: ['a1'] } } }),
          early: run('paused', { startedAt: 5, steps: { s: { status: 'failed', attemptIds: ['a2'] } } }),
          held: run('paused', { startedAt: 30 }),
          busy: run('running'),
          over: run('done')
        },
        { a1: attempt('late', 2, 50), a2: attempt('early', 6, 20) }
      )
    )
    expect(ids).toEqual(['early', 'held', 'late'])
  })

  it('orders a live attempt by its start and breaks ties by run id', () => {
    const select = createPausedRunIdsSelector()
    const ids = select(
      state(
        {
          b: run('paused', { startedAt: 10 }),
          a: run('paused', { startedAt: 10 }),
          live: run('paused', { startedAt: 1, steps: { s: { status: 'running', attemptIds: ['l1'] } } })
        },
        { l1: attempt('live', 5) }
      )
    )
    expect(ids).toEqual(['live', 'a', 'b'])
  })

  it('returns the same array when an unrelated run changes', () => {
    const select = createPausedRunIdsSelector()
    const first = select(state({ p: run('paused'), r: run('running') }))
    const second = select(state({ p: run('paused'), r: run('running', { costUsd: 1 }) }))
    expect(second).toBe(first)
  })

  it('returns a new array when a run pauses', () => {
    const select = createPausedRunIdsSelector()
    const first = select(state({ p: run('paused'), r: run('running') }))
    const second = select(state({ p: run('paused'), r: run('paused', { startedAt: 2 }) }))
    expect(second).not.toBe(first)
    expect(second).toEqual(['p', 'r'])
  })

  it('returns the cached array for the same maps without recomputing', () => {
    const select = createPausedRunIdsSelector()
    const s = state({ p: run('paused') })
    expect(select(s)).toBe(select({ ...s }))
  })
})

describe('selectWorkflowRunIdForWorktree', () => {
  it.each<WorkflowRunStatus>(['queued', 'running', 'paused'])('finds a %s run on the exact path', (status) => {
    const runs = { done: run('done'), live: run(status) }
    expect(selectWorkflowRunIdForWorktree(runs, '/wt/a')).toBe('live')
  })

  it.each<WorkflowRunStatus>(['done', 'failed', 'cancelled'])('ignores a %s run', (status) => {
    expect(selectWorkflowRunIdForWorktree({ r: run(status) }, '/wt/a')).toBeNull()
  })

  it('ignores runs on other worktrees, including path prefixes', () => {
    const runs = { r: run('running', { worktreePath: '/wt/a-2' }) }
    expect(selectWorkflowRunIdForWorktree(runs, '/wt/a')).toBeNull()
    expect(selectWorkflowRunIdForWorktree(runs, '/wt/a-2')).toBe('r')
  })
})

function tab(id: string, workflow?: TerminalTab['workflow']): TerminalTab {
  return { id, type: 'agent', label: id, ...(workflow ? { workflow } : {}) }
}

function leaf(id: string, tabs: TerminalTab[]): PaneLeaf {
  return { type: 'leaf', id, tabs, activeTabId: tabs[0]?.id ?? '' }
}

describe('findWorkflowStepTab', () => {
  const ref = { runId: 'r', stepId: 'build', attemptId: 'a2' }
  const old = tab('t-old', { runId: 'r', stepId: 'build', attemptId: 'a1' })
  const current = tab('t-new', { runId: 'r', stepId: 'build', attemptId: 'a2' })
  const other = tab('t-other', { runId: 'x', stepId: 'build', attemptId: 'a9' })

  it('finds the tab of the given attempt inside a split', () => {
    const right = leaf('p2', [other, current])
    const tree: PaneNode = { type: 'split', id: 's', direction: 'horizontal', ratio: 0.5, children: [leaf('p1', [old]), right] }
    expect(findWorkflowStepTab(tree, ref)).toEqual({ leaf: right, tabId: 't-new' })
  })

  it('falls back to the last tab of the same step when the attempt has none', () => {
    const only = leaf('p1', [old, tab('plain')])
    expect(findWorkflowStepTab(only, ref)).toEqual({ leaf: only, tabId: 't-old' })
  })

  it('is null without a matching tab or pane tree', () => {
    expect(findWorkflowStepTab(leaf('p1', [other, tab('plain')]), ref)).toBeNull()
    expect(findWorkflowStepTab(undefined, ref)).toBeNull()
  })
})

describe('createRunAttemptsSelector', () => {
  const steps = { plan: { status: 'done' as const, attemptIds: ['a1'] }, build: { status: 'running' as const, attemptIds: ['a2', 'gone'] } }

  it('lists the run attempts that exist, step by step', () => {
    const select = createRunAttemptsSelector()
    const a1 = attempt('r', 1, 2)
    const a2 = attempt('r', 3)
    expect(select(state({ r: run('running', { steps }) }, { a1, a2, other: attempt('x', 1) }), 'r')).toEqual([a1, a2])
  })

  it('keeps the same array while the run attempts are unchanged', () => {
    const select = createRunAttemptsSelector()
    const attempts = { a1: attempt('r', 1, 2), a2: attempt('r', 3) }
    const first = select(state({ r: run('running', { steps }) }, attempts), 'r')
    const unrelated = { ...attempts, other: attempt('x', 1) }
    expect(select(state({ r: run('paused', { steps }) }, unrelated), 'r')).toBe(first)
  })

  it('returns a new array when one of the run attempts changes', () => {
    const select = createRunAttemptsSelector()
    const attempts = { a1: attempt('r', 1, 2), a2: attempt('r', 3) }
    const first = select(state({ r: run('running', { steps }) }, attempts), 'r')
    const next = select(state({ r: run('running', { steps }) }, { ...attempts, a2: attempt('r', 3, 4) }), 'r')
    expect(next).not.toBe(first)
    expect(next[1].endedAt).toBe(4)
  })

  it('is empty for an unknown run', () => {
    expect(createRunAttemptsSelector()(state({}), 'missing')).toEqual([])
  })
})

describe('workflowRunRecordKey', () => {
  const steps = { plan: { status: 'done' as const, attemptIds: ['a1'] }, build: { status: 'running' as const, attemptIds: ['a2'] } }
  const attempts = { a1: attempt('r', 1, 2), a2: attempt('r', 3) }
  const key = (runs: Record<string, WorkflowRun>, atts: Record<string, WorkflowAttempt> = attempts) =>
    workflowRunRecordKey(state(runs, atts), 'r')

  it('stays the same while only streamed attempt fields change', () => {
    const base = key({ r: run('running', { steps }) })
    const streamed = { ...attempts, a2: { ...attempts.a2, summaryPreview: 'more text', costUsd: 0.5 } }
    expect(key({ r: run('running', { steps }) }, streamed)).toBe(base)
    expect(key({ r: run('running', { steps }), other: run('done') })).toBe(base)
  })

  it('changes when the run status, an attempt status or the attempt id set changes', () => {
    const base = key({ r: run('running', { steps }) })
    expect(key({ r: run('paused', { steps, pausedReason: 'step-failed' }) })).not.toBe(base)
    expect(key({ r: run('running', { steps }) }, { ...attempts, a2: attempt('r', 3, 4) })).not.toBe(base)
    const retried = { ...steps, build: { status: 'running' as const, attemptIds: ['a2', 'a3'] } }
    expect(key({ r: run('running', { steps: retried }) }, { ...attempts, a3: attempt('r', 5) })).not.toBe(base)
  })

  it('is null for an unknown run', () => {
    expect(workflowRunRecordKey(state({}), 'missing')).toBeNull()
  })
})

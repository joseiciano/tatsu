import { describe, it, expect } from 'vitest'
import {
  initialWorkflows,
  SUMMARY_PREVIEW_MAX,
  workflowsReducer,
  type WorkflowAttempt,
  type WorkflowDefinitionSummary,
  type WorkflowRun,
  type WorkflowScope,
  type WorkflowsEvent,
  type WorkflowsState
} from './index'

function summary(
  slug: string,
  overrides: Partial<WorkflowDefinitionSummary> = {}
): WorkflowDefinitionSummary {
  return {
    id: `personal:${slug}`,
    name: slug,
    scope: 'personal',
    path: `/home/u/.tatsu/workflows/${slug}.yaml`,
    hash: `hash-${slug}`,
    stepIds: ['plan', 'build'],
    issues: [],
    ...overrides
  }
}

function load(
  state: WorkflowsState,
  definitions: WorkflowDefinitionSummary[],
  scope: WorkflowScope = 'personal'
): WorkflowsState {
  return workflowsReducer(state, {
    type: 'workflows/definitionsLoaded',
    payload: { scope, definitions }
  })
}

const REPO_SCOPE = 'repo' as WorkflowScope

function repoSummary(slug: string): WorkflowDefinitionSummary {
  return summary(slug, { id: `repo:${slug}`, scope: REPO_SCOPE })
}

describe('workflowsReducer', () => {
  it('definitionsLoaded replaces the personal entries keyed by id', () => {
    const start: WorkflowsState = {
      ...initialWorkflows,
      definitions: { 'personal:old': summary('old') }
    }
    const broken = summary('broken', {
      stepIds: [],
      issues: ['steps[0].needs references unknown step "nope"']
    })
    const next = load(start, [summary('a'), broken])
    expect(next.definitions).toEqual({
      'personal:a': summary('a'),
      'personal:broken': broken
    })
  })

  it('definitionsLoaded removes personal entries absent from the payload', () => {
    const start = load(initialWorkflows, [summary('a'), summary('b')])
    const next = load(start, [summary('a')])
    expect(Object.keys(next.definitions)).toEqual(['personal:a'])
  })

  it('definitionsLoaded keeps the reference of each unchanged entry', () => {
    const start = load(initialWorkflows, [summary('a'), summary('b')])
    const next = load(start, [summary('a'), summary('b', { hash: 'hash-b2' })])
    expect(next).not.toBe(start)
    expect(next.definitions['personal:a']).toBe(start.definitions['personal:a'])
    expect(next.definitions['personal:b']).not.toBe(start.definitions['personal:b'])
    expect(next.definitions['personal:b'].hash).toBe('hash-b2')
  })

  it('definitionsLoaded treats a changed array element as a change', () => {
    const start = load(initialWorkflows, [summary('a', { issues: ['first issue'] })])
    const next = load(start, [summary('a', { issues: ['second issue'] })])
    expect(next).not.toBe(start)
    expect(next.definitions['personal:a'].issues).toEqual(['second issue'])
  })

  it('definitionsLoaded returns the same state when content is unchanged', () => {
    const start = load(initialWorkflows, [summary('a'), summary('b')])
    const next = load(start, [summary('b'), summary('a')])
    expect(next).toBe(start)
  })

  it('definitionsLoaded with no definitions on empty state returns the same state', () => {
    expect(load(initialWorkflows, [])).toBe(initialWorkflows)
  })

  it('definitionsLoaded leaves entries of other scopes untouched', () => {
    const repo = repoSummary('shared')
    const start: WorkflowsState = {
      ...initialWorkflows,
      definitions: { 'repo:shared': repo, 'personal:a': summary('a') }
    }
    const next = load(start, [summary('b')])
    expect(next.definitions['repo:shared']).toBe(repo)
    expect(Object.keys(next.definitions).sort()).toEqual(['personal:b', 'repo:shared'])
  })
})

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    defId: 'personal:a',
    defHash: 'hash-a',
    worktreePath: '/repo/wt-a',
    status: 'running',
    startedAt: 1000,
    steps: {
      plan: { status: 'running', attemptIds: ['att-a1'] },
      build: { status: 'pending', attemptIds: [] }
    },
    ...overrides
  }
}

function attempt(overrides: Partial<WorkflowAttempt> = {}): WorkflowAttempt {
  return {
    runId: 'run-a',
    stepId: 'plan',
    n: 1,
    status: 'running',
    summaryPreview: '',
    startedAt: 1100,
    ...overrides
  }
}

function fixture(runA: Partial<WorkflowRun> = {}): WorkflowsState {
  return {
    definitions: { 'personal:a': summary('a') },
    runs: {
      'run-a': run(runA),
      'run-b': run({
        defId: 'personal:b',
        worktreePath: '/repo/wt-b',
        steps: { plan: { status: 'running', attemptIds: ['att-b1'] } }
      })
    },
    attempts: {
      'att-a1': attempt(),
      'att-b1': attempt({ runId: 'run-b' })
    }
  }
}

describe('workflowsReducer runs and attempts', () => {
  it('starts with empty runs and attempts', () => {
    expect(initialWorkflows.runs).toEqual({})
    expect(initialWorkflows.attempts).toEqual({})
  })

  it('definitionsLoaded keeps the runs and attempts references', () => {
    const start = fixture()
    const next = load(start, [summary('a', { hash: 'hash-a2' })])
    expect(next).not.toBe(start)
    expect(next.runs).toBe(start.runs)
    expect(next.attempts).toBe(start.attempts)
  })

  it('runStarted adds the run record', () => {
    const start = fixture()
    const added = run({ status: 'queued', worktreePath: '/repo/wt-c' })
    const next = workflowsReducer(start, {
      type: 'workflows/runStarted',
      payload: { runId: 'run-c', run: added }
    })
    expect(next.runs['run-c']).toBe(added)
    expect(
      workflowsReducer(next, {
        type: 'workflows/runStarted',
        payload: { runId: 'run-c', run: run() }
      })
    ).toBe(next)
  })

  it('runPaused sets the status and reason', () => {
    const start = fixture()
    const next = workflowsReducer(start, {
      type: 'workflows/runPaused',
      payload: { runId: 'run-a', reason: 'gate' }
    })
    expect(next.runs['run-a'].status).toBe('paused')
    expect(next.runs['run-a'].pausedReason).toBe('gate')
    expect(
      workflowsReducer(next, {
        type: 'workflows/runPaused',
        payload: { runId: 'run-a', reason: 'gate' }
      })
    ).toBe(next)
    const repaused = workflowsReducer(next, {
      type: 'workflows/runPaused',
      payload: { runId: 'run-a', reason: 'budget' }
    })
    expect(repaused.runs['run-a'].pausedReason).toBe('budget')
    expect(
      workflowsReducer(start, {
        type: 'workflows/runPaused',
        payload: { runId: 'nope', reason: 'gate' }
      })
    ).toBe(start)

    for (const status of ['done', 'cancelled'] as const) {
      const ended = fixture({ status, finishedAt: 5000 })
      expect(
        workflowsReducer(ended, {
          type: 'workflows/runPaused',
          payload: { runId: 'run-a', reason: 'gate' }
        })
      ).toBe(ended)
    }
  })

  it('runResumed sets running and removes the paused reason', () => {
    const start = fixture({ status: 'paused', pausedReason: 'needs-input' })
    const next = workflowsReducer(start, {
      type: 'workflows/runResumed',
      payload: { runId: 'run-a' }
    })
    expect(next.runs['run-a'].status).toBe('running')
    expect(next.runs['run-a']).not.toHaveProperty('pausedReason')
    expect(
      workflowsReducer(next, { type: 'workflows/runResumed', payload: { runId: 'run-a' } })
    ).toBe(next)
    expect(
      workflowsReducer(start, { type: 'workflows/runResumed', payload: { runId: 'nope' } })
    ).toBe(start)
  })

  it('runCancelled sets cancelled and finishedAt', () => {
    const start = fixture()
    const next = workflowsReducer(start, {
      type: 'workflows/runCancelled',
      payload: { runId: 'run-a', finishedAt: 5000 }
    })
    expect(next.runs['run-a'].status).toBe('cancelled')
    expect(next.runs['run-a'].finishedAt).toBe(5000)
    expect(
      workflowsReducer(next, {
        type: 'workflows/runCancelled',
        payload: { runId: 'run-a', finishedAt: 6000 }
      })
    ).toBe(next)
    expect(
      workflowsReducer(start, {
        type: 'workflows/runCancelled',
        payload: { runId: 'nope', finishedAt: 5000 }
      })
    ).toBe(start)

    const paused = fixture({ status: 'paused', pausedReason: 'gate' })
    const cancelled = workflowsReducer(paused, {
      type: 'workflows/runCancelled',
      payload: { runId: 'run-a', finishedAt: 5000 }
    })
    expect(cancelled.runs['run-a'].status).toBe('cancelled')
    expect(cancelled.runs['run-a']).not.toHaveProperty('pausedReason')
  })

  it('runFinished sets the outcome, cost, and clears the paused reason', () => {
    const start = fixture({ status: 'paused', pausedReason: 'step-failed' })
    const next = workflowsReducer(start, {
      type: 'workflows/runFinished',
      payload: { runId: 'run-a', status: 'failed', finishedAt: 7000, costUsd: 1.25 }
    })
    expect(next.runs['run-a'].status).toBe('failed')
    expect(next.runs['run-a'].finishedAt).toBe(7000)
    expect(next.runs['run-a'].costUsd).toBe(1.25)
    expect(next.runs['run-a']).not.toHaveProperty('pausedReason')
    expect(
      workflowsReducer(next, {
        type: 'workflows/runFinished',
        payload: { runId: 'run-a', status: 'done', finishedAt: 8000 }
      })
    ).toBe(next)
    const done = workflowsReducer(fixture(), {
      type: 'workflows/runFinished',
      payload: { runId: 'run-a', status: 'done', finishedAt: 7000 }
    })
    expect(done.runs['run-a']).not.toHaveProperty('costUsd')
    expect(
      workflowsReducer(start, {
        type: 'workflows/runFinished',
        payload: { runId: 'nope', status: 'done', finishedAt: 7000 }
      })
    ).toBe(start)
  })

  it.each([
    ['stepQueued', 'queued'],
    ['stepStarted', 'running'],
    ['stepSkipped', 'skipped']
  ] as const)('%s sets the step status to %s', (name, status) => {
    const start = fixture()
    const event = {
      type: `workflows/${name}`,
      payload: { runId: 'run-a', stepId: 'build' }
    } as const
    const next = workflowsReducer(start, event)
    expect(next.runs['run-a'].steps.build).toEqual({ status, attemptIds: [] })
    expect(workflowsReducer(next, event)).toBe(next)
    expect(
      workflowsReducer(start, { ...event, payload: { runId: 'run-a', stepId: 'nope' } })
    ).toBe(start)
    expect(
      workflowsReducer(start, { ...event, payload: { runId: 'nope', stepId: 'build' } })
    ).toBe(start)
  })

  it('stepStatusChanged sets the given step status', () => {
    const start = fixture()
    const next = workflowsReducer(start, {
      type: 'workflows/stepStatusChanged',
      payload: { runId: 'run-a', stepId: 'plan', status: 'awaiting-gate' }
    })
    expect(next.runs['run-a'].steps.plan.status).toBe('awaiting-gate')
    expect(next.runs['run-a'].steps.plan.attemptIds).toBe(start.runs['run-a'].steps.plan.attemptIds)
    expect(
      workflowsReducer(start, {
        type: 'workflows/stepStatusChanged',
        payload: { runId: 'run-a', stepId: 'plan', status: 'running' }
      })
    ).toBe(start)
    expect(
      workflowsReducer(start, {
        type: 'workflows/stepStatusChanged',
        payload: { runId: 'nope', stepId: 'plan', status: 'done' }
      })
    ).toBe(start)
  })

  it('attemptStarted adds the attempt and appends its id to the step', () => {
    const start = fixture()
    const next = workflowsReducer(start, {
      type: 'workflows/attemptStarted',
      payload: { attemptId: 'att-a2', runId: 'run-a', stepId: 'plan', n: 2, startedAt: 2000 }
    })
    expect(next.attempts['att-a2']).toEqual({
      runId: 'run-a',
      stepId: 'plan',
      n: 2,
      status: 'running',
      summaryPreview: '',
      startedAt: 2000
    })
    expect(next.runs['run-a'].steps.plan.attemptIds).toEqual(['att-a1', 'att-a2'])
    expect(start.runs['run-a'].steps.plan.attemptIds).toEqual(['att-a1'])
    expect(
      workflowsReducer(start, {
        type: 'workflows/attemptStarted',
        payload: { attemptId: 'att-a1', runId: 'run-a', stepId: 'plan', n: 1, startedAt: 2000 }
      })
    ).toBe(start)
    expect(
      workflowsReducer(start, {
        type: 'workflows/attemptStarted',
        payload: { attemptId: 'att-x', runId: 'run-a', stepId: 'nope', n: 1, startedAt: 2000 }
      })
    ).toBe(start)
    expect(
      workflowsReducer(start, {
        type: 'workflows/attemptStarted',
        payload: { attemptId: 'att-x', runId: 'nope', stepId: 'plan', n: 1, startedAt: 2000 }
      })
    ).toBe(start)
  })

  it('attemptEnded records the outcome and a summary preview', () => {
    const start = fixture()
    const next = workflowsReducer(start, {
      type: 'workflows/attemptEnded',
      payload: {
        attemptId: 'att-a1',
        status: 'done',
        endedAt: 3000,
        summary: 'planned it',
        completedBy: 'tool',
        costUsd: 0.5
      }
    })
    expect(next.attempts['att-a1']).toEqual({
      ...start.attempts['att-a1'],
      status: 'done',
      endedAt: 3000,
      summaryPreview: 'planned it',
      completedBy: 'tool',
      costUsd: 0.5
    })
    expect(
      workflowsReducer(next, {
        type: 'workflows/attemptEnded',
        payload: { attemptId: 'att-a1', status: 'failed', endedAt: 4000, summary: '' }
      })
    ).toBe(next)
    expect(
      workflowsReducer(start, {
        type: 'workflows/attemptEnded',
        payload: { attemptId: 'nope', status: 'done', endedAt: 3000, summary: '' }
      })
    ).toBe(start)
  })

  it('attemptEnded truncates a 5 KB summary to the preview limit', () => {
    const summaryText = 'x'.repeat(5 * 1024)
    const next = workflowsReducer(fixture(), {
      type: 'workflows/attemptEnded',
      payload: { attemptId: 'att-a1', status: 'done', endedAt: 3000, summary: summaryText }
    })
    expect(SUMMARY_PREVIEW_MAX).toBe(200)
    expect(next.attempts['att-a1'].summaryPreview).toBe(summaryText.slice(0, 200))
    expect(next.attempts['att-a1'].summaryPreview).toHaveLength(200)
  })

  const changingEvents: WorkflowsEvent[] = [
    { type: 'workflows/runStarted', payload: { runId: 'run-c', run: run() } },
    { type: 'workflows/runPaused', payload: { runId: 'run-a', reason: 'gate' } },
    { type: 'workflows/runCancelled', payload: { runId: 'run-a', finishedAt: 5000 } },
    {
      type: 'workflows/runFinished',
      payload: { runId: 'run-a', status: 'done', finishedAt: 5000 }
    },
    { type: 'workflows/stepQueued', payload: { runId: 'run-a', stepId: 'build' } },
    { type: 'workflows/stepStarted', payload: { runId: 'run-a', stepId: 'build' } },
    { type: 'workflows/stepSkipped', payload: { runId: 'run-a', stepId: 'build' } },
    {
      type: 'workflows/stepStatusChanged',
      payload: { runId: 'run-a', stepId: 'build', status: 'done' }
    },
    {
      type: 'workflows/attemptStarted',
      payload: { attemptId: 'att-a2', runId: 'run-a', stepId: 'build', n: 1, startedAt: 2000 }
    },
    {
      type: 'workflows/attemptEnded',
      payload: { attemptId: 'att-a1', status: 'done', endedAt: 3000, summary: 'ok' }
    }
  ]

  it.each(changingEvents.map((event) => [event.type, event] as const))(
    '%s keeps unrelated references',
    (_type, event) => {
      const start = fixture()
      const next = workflowsReducer(start, event)
      expect(next).not.toBe(start)
      expect(next.definitions).toBe(start.definitions)
      expect(next.runs['run-b']).toBe(start.runs['run-b'])
      expect(next.attempts['att-b1']).toBe(start.attempts['att-b1'])
      expect(next.runs['run-a'].steps.plan).toBe(start.runs['run-a'].steps.plan)
      if (event.type !== 'workflows/attemptStarted' && event.type !== 'workflows/attemptEnded') {
        expect(next.attempts).toBe(start.attempts)
      }
      if (event.type === 'workflows/attemptEnded') {
        expect(next.runs).toBe(start.runs)
      }
    }
  )

  it('runResumed keeps unrelated references', () => {
    const start = fixture({ status: 'paused', pausedReason: 'gate' })
    const next = workflowsReducer(start, { type: 'workflows/runResumed', payload: { runId: 'run-a' } })
    expect(next.definitions).toBe(start.definitions)
    expect(next.attempts).toBe(start.attempts)
    expect(next.runs['run-b']).toBe(start.runs['run-b'])
    expect(next.runs['run-a'].steps).toBe(start.runs['run-a'].steps)
  })
})

describe('workflowsReducer terminal-run guards', () => {
  const terminal = [
    ['done', { status: 'done', finishedAt: 5000 }],
    ['failed', { status: 'failed', finishedAt: 5000 }],
    ['cancelled', { status: 'cancelled', finishedAt: 5000 }]
  ] as const

  const guarded: WorkflowsEvent[] = [
    { type: 'workflows/stepQueued', payload: { runId: 'run-a', stepId: 'build' } },
    { type: 'workflows/stepStarted', payload: { runId: 'run-a', stepId: 'build' } },
    { type: 'workflows/stepSkipped', payload: { runId: 'run-a', stepId: 'build' } },
    {
      type: 'workflows/stepStatusChanged',
      payload: { runId: 'run-a', stepId: 'plan', status: 'done' }
    },
    {
      type: 'workflows/attemptStarted',
      payload: { attemptId: 'att-a2', runId: 'run-a', stepId: 'build', n: 1, startedAt: 2000 }
    },
    {
      type: 'workflows/attemptEnded',
      payload: { attemptId: 'att-a1', status: 'done', endedAt: 3000, summary: 'late' }
    }
  ]

  it.each(
    guarded.flatMap((event) =>
      terminal.map(([status, overrides]) => [event.type, status, event, overrides] as const)
    )
  )('%s is a no-op on a %s run', (_type, _status, event, overrides) => {
    const start = fixture(overrides)
    expect(workflowsReducer(start, event)).toBe(start)
  })

  it('attemptEnded still applies to an attempt of another, live run', () => {
    const start = fixture({ status: 'cancelled', finishedAt: 5000 })
    const next = workflowsReducer(start, {
      type: 'workflows/attemptEnded',
      payload: { attemptId: 'att-b1', status: 'done', endedAt: 3000, summary: 'ok' }
    })
    expect(next.attempts['att-b1'].status).toBe('done')
  })

  it('runCancelled clears the paused reason', () => {
    const start = fixture({ status: 'paused', pausedReason: 'step-failed' })
    const next = workflowsReducer(start, {
      type: 'workflows/runCancelled',
      payload: { runId: 'run-a', finishedAt: 5000 }
    })
    expect(next.runs['run-a'].status).toBe('cancelled')
    expect(next.runs['run-a']).not.toHaveProperty('pausedReason')
  })

  it('attemptEnded does not split a surrogate pair at the preview limit', () => {
    const summaryText = 'x'.repeat(SUMMARY_PREVIEW_MAX - 1) + '\u{1F600}' + 'tail'
    const next = workflowsReducer(fixture(), {
      type: 'workflows/attemptEnded',
      payload: { attemptId: 'att-a1', status: 'done', endedAt: 3000, summary: summaryText }
    })
    const preview = next.attempts['att-a1'].summaryPreview
    expect(preview).toBe('x'.repeat(SUMMARY_PREVIEW_MAX - 1))
    expect(preview).not.toMatch(/[\uD800-\uDBFF]$/)
  })

  it('attemptEnded keeps a surrogate pair that ends exactly at the preview limit', () => {
    const summaryText = 'x'.repeat(SUMMARY_PREVIEW_MAX - 2) + '\u{1F600}' + 'tail'
    const next = workflowsReducer(fixture(), {
      type: 'workflows/attemptEnded',
      payload: { attemptId: 'att-a1', status: 'done', endedAt: 3000, summary: summaryText }
    })
    expect(next.attempts['att-a1'].summaryPreview).toBe(
      'x'.repeat(SUMMARY_PREVIEW_MAX - 2) + '\u{1F600}'
    )
  })
})

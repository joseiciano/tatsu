import { describe, it, expect } from 'vitest'
import {
  initialWorkflows,
  RECENT_RUNS_MAX,
  SUMMARY_PREVIEW_MAX,
  WORKFLOW_RUN_RECORD_VERSION,
  hydrateWorkflowRuns,
  projectRunRecord,
  runStepFacts,
  runsToEvict,
  workflowsReducer,
  type WorkflowAttempt,
  type WorkflowDefinitionSummary,
  type WorkflowRun,
  type WorkflowRunRecord,
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

function load(state: WorkflowsState, definitions: WorkflowDefinitionSummary[]): WorkflowsState {
  return workflowsReducer(state, {
    type: 'workflows/definitionsLoaded',
    payload: { scope: 'personal', definitions }
  })
}

function loadRepo(state: WorkflowsState, repoRoot: string, definitions: WorkflowDefinitionSummary[]): WorkflowsState {
  return workflowsReducer(state, {
    type: 'workflows/definitionsLoaded',
    payload: { scope: 'repo', repoRoot, definitions }
  })
}

const REPO_A = '/repos/a'
const REPO_B = '/repos/b'

function repoSummary(slug: string, repoRoot = REPO_A): WorkflowDefinitionSummary {
  return summary(slug, {
    id: `repo:${repoRoot === REPO_A ? 'aaaaaaaaaaaa' : 'bbbbbbbbbbbb'}:${slug}`,
    scope: 'repo',
    repoRoot,
    path: `${repoRoot}/.harness/workflows/${slug}.yaml`
  })
}

function threeGroups(): WorkflowsState {
  let state = load(initialWorkflows, [summary('mine')])
  state = loadRepo(state, REPO_A, [repoSummary('shared', REPO_A)])
  return loadRepo(state, REPO_B, [repoSummary('shared', REPO_B)])
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

  it('a personal load leaves both repo groups untouched', () => {
    const start = threeGroups()
    const next = load(start, [summary('b')])
    expect(next.definitions['repo:aaaaaaaaaaaa:shared']).toBe(start.definitions['repo:aaaaaaaaaaaa:shared'])
    expect(next.definitions['repo:bbbbbbbbbbbb:shared']).toBe(start.definitions['repo:bbbbbbbbbbbb:shared'])
    expect(Object.keys(next.definitions).sort()).toEqual([
      'personal:b',
      'repo:aaaaaaaaaaaa:shared',
      'repo:bbbbbbbbbbbb:shared'
    ])
  })

  it('a repo A load replaces only repo A and leaves personal and repo B untouched', () => {
    const start = threeGroups()
    const next = loadRepo(start, REPO_A, [repoSummary('other', REPO_A)])
    expect(next.definitions['personal:mine']).toBe(start.definitions['personal:mine'])
    expect(next.definitions['repo:bbbbbbbbbbbb:shared']).toBe(start.definitions['repo:bbbbbbbbbbbb:shared'])
    expect(Object.keys(next.definitions).sort()).toEqual([
      'personal:mine',
      'repo:aaaaaaaaaaaa:other',
      'repo:bbbbbbbbbbbb:shared'
    ])
  })

  it('a repo B load replaces only repo B and leaves personal and repo A untouched', () => {
    const start = threeGroups()
    const changed = { ...repoSummary('shared', REPO_B), hash: 'hash-b2' }
    const next = loadRepo(start, REPO_B, [changed])
    expect(next.definitions['personal:mine']).toBe(start.definitions['personal:mine'])
    expect(next.definitions['repo:aaaaaaaaaaaa:shared']).toBe(start.definitions['repo:aaaaaaaaaaaa:shared'])
    expect(next.definitions['repo:bbbbbbbbbbbb:shared']).toBe(changed)
  })

  it('an empty repo load drops that repo group only', () => {
    const start = threeGroups()
    const next = loadRepo(start, REPO_A, [])
    expect(Object.keys(next.definitions).sort()).toEqual(['personal:mine', 'repo:bbbbbbbbbbbb:shared'])
  })

  it('an unchanged repo load returns the same state', () => {
    const start = threeGroups()
    expect(loadRepo(start, REPO_A, [repoSummary('shared', REPO_A)])).toBe(start)
  })

  it('drops incoming summaries that do not belong to the payload group', () => {
    const next = loadRepo(initialWorkflows, REPO_A, [
      repoSummary('ok', REPO_A),
      repoSummary('stray', REPO_B),
      summary('personal-stray')
    ])
    expect(Object.keys(next.definitions)).toEqual(['repo:aaaaaaaaaaaa:ok'])
    const personal = load(initialWorkflows, [summary('a'), repoSummary('stray', REPO_A)])
    expect(Object.keys(personal.definitions)).toEqual(['personal:a'])
  })

  it('treats a changed repoRoot as a change', () => {
    const start = loadRepo(initialWorkflows, REPO_A, [repoSummary('x', REPO_A)])
    const moved = { ...repoSummary('x', REPO_A), repoRoot: REPO_B }
    const next = loadRepo(start, REPO_B, [moved])
    expect(next.definitions['repo:aaaaaaaaaaaa:x']).toBe(moved)
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

describe('workflowsReducer runsEvicted', () => {
  it('removes the listed runs and their attempts and keeps everything else by reference', () => {
    const start = fixture({ status: 'done', finishedAt: 2000 })
    const next = workflowsReducer(start, {
      type: 'workflows/runsEvicted',
      payload: { runIds: ['run-a'] }
    })
    expect(Object.keys(next.runs)).toEqual(['run-b'])
    expect(Object.keys(next.attempts)).toEqual(['att-b1'])
    expect(next.runs['run-b']).toBe(start.runs['run-b'])
    expect(next.attempts['att-b1']).toBe(start.attempts['att-b1'])
    expect(next.definitions).toBe(start.definitions)
  })

  it('is a no-op that returns the same state when no listed run exists', () => {
    const start = fixture()
    for (const runIds of [[], ['run-missing'], ['constructor', '__proto__']]) {
      expect(workflowsReducer(start, { type: 'workflows/runsEvicted', payload: { runIds } })).toBe(start)
    }
  })
})

describe('runsToEvict', () => {
  function finishedRuns(count: number): WorkflowsState {
    const runs: Record<string, WorkflowRun> = {}
    for (let i = 0; i < count; i++) {
      runs[`run-${String(i).padStart(3, '0')}`] = run({ status: i % 2 ? 'cancelled' : 'done', finishedAt: 5000 - i })
    }
    return { ...initialWorkflows, runs }
  }

  it('returns nothing while finished runs are within the cap', () => {
    expect(RECENT_RUNS_MAX).toBe(50)
    expect(runsToEvict(finishedRuns(50), RECENT_RUNS_MAX)).toEqual([])
  })

  it('returns the oldest finished runs beyond the cap and ignores live runs', () => {
    const state = finishedRuns(52)
    state.runs['run-live'] = run({ status: 'paused', startedAt: 1 })
    expect(runsToEvict(state, RECENT_RUNS_MAX)).toEqual(['run-051', 'run-050'])
  })

  it('breaks finishedAt ties by run id', () => {
    const state: WorkflowsState = {
      ...initialWorkflows,
      runs: {
        'run-b': run({ status: 'done', finishedAt: 10 }),
        'run-a': run({ status: 'done', finishedAt: 10 }),
        'run-c': run({ status: 'done', finishedAt: 20 })
      }
    }
    expect(runsToEvict(state, 1)).toEqual(['run-a', 'run-b'])
  })
})

function runRecord(runId: string, overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    version: WORKFLOW_RUN_RECORD_VERSION,
    runId,
    defId: 'personal:one',
    defHash: 'hash-1',
    definition: { name: 'one', inputs: {}, steps: [] },
    inputs: {},
    worktreePath: '/repo/wt',
    contextPath: `/repo/wt/.harness/runs/${runId}/context.md`,
    status: 'done',
    cursor: 0,
    steps: {},
    startedAt: 100,
    finishedAt: 200,
    attempts: [],
    ...overrides
  }
}

describe('projectRunRecord', () => {
  it('projects a record into the run and attempt rows the runtime events would build', () => {
    const long = `${'a'.repeat(SUMMARY_PREVIEW_MAX - 1)}\u{1F600}tail`
    const projected = projectRunRecord(
      runRecord('run-1', {
        status: 'paused',
        pausedReason: 'step-failed',
        finishedAt: undefined,
        steps: { plan: 'done', build: 'failed', ship: 'pending' },
        attempts: [
          {
            attemptId: 'att-1',
            stepId: 'plan',
            n: 1,
            status: 'done',
            startedAt: 110,
            endedAt: 120,
            result: { status: 'done', summary: long, completedBy: 'tool', costUsd: 0.5 },
            metrics: { continuations: 0, pauses: [] }
          },
          {
            attemptId: 'att-2',
            stepId: 'build',
            n: 1,
            status: 'running',
            startedAt: 130,
            result: { status: 'needs-input', summary: 'waiting', completedBy: 'tool' },
            metrics: { continuations: 0, pauses: [] }
          },
          {
            attemptId: 'att-3',
            stepId: 'build',
            n: 2,
            status: 'interrupted',
            startedAt: 140,
            endedAt: 150,
            result: { status: 'needs-input', summary: 'asked', completedBy: 'tool' },
            metrics: { continuations: 0, pauses: [] }
          }
        ]
      })
    )
    expect(projected.attempts['att-3']).toEqual({
      runId: 'run-1',
      stepId: 'build',
      n: 2,
      status: 'interrupted',
      summaryPreview: '',
      startedAt: 140,
      endedAt: 150
    })
    expect(projected.run).toEqual({
      defId: 'personal:one',
      defHash: 'hash-1',
      worktreePath: '/repo/wt',
      status: 'paused',
      pausedReason: 'step-failed',
      startedAt: 100,
      steps: {
        plan: { status: 'done', attemptIds: ['att-1'] },
        build: { status: 'failed', attemptIds: ['att-2', 'att-3'] },
        ship: { status: 'pending', attemptIds: [] }
      }
    })
    expect(projected.attempts['att-1']).toEqual({
      runId: 'run-1',
      stepId: 'plan',
      n: 1,
      status: 'done',
      summaryPreview: 'a'.repeat(SUMMARY_PREVIEW_MAX - 1),
      startedAt: 110,
      endedAt: 120,
      completedBy: 'tool',
      costUsd: 0.5
    })
    expect(projected.attempts['att-2']).toEqual({
      runId: 'run-1',
      stepId: 'build',
      n: 1,
      status: 'running',
      summaryPreview: '',
      startedAt: 130
    })
  })
})

describe('hydrateWorkflowRuns', () => {
  it('keeps every live run plus the newest finished runs up to the cap', () => {
    const records: WorkflowRunRecord[] = []
    for (let i = 0; i < RECENT_RUNS_MAX + 3; i++) {
      const runId = `run-${String(i).padStart(3, '0')}`
      records.push(
        runRecord(runId, {
          finishedAt: 1000 + i,
          steps: { plan: 'done' },
          attempts: [
            {
              attemptId: `att-${runId}`,
              stepId: 'plan',
              n: 1,
              status: 'done',
              startedAt: 1,
              endedAt: 2,
              metrics: { continuations: 0, pauses: [] }
            }
          ]
        })
      )
    }
    records.push(runRecord('run-live', { status: 'running', finishedAt: undefined, startedAt: 1 }))
    const hydrated = hydrateWorkflowRuns(records)
    expect(Object.keys(hydrated.runs)).toHaveLength(RECENT_RUNS_MAX + 1)
    expect(hydrated.runs['run-live']).toBeDefined()
    for (const evicted of ['run-000', 'run-001', 'run-002']) {
      expect(hydrated.runs[evicted]).toBeUndefined()
      expect(hydrated.attempts[`att-${evicted}`]).toBeUndefined()
    }
    expect(hydrated.runs['run-003']).toBeDefined()
    expect(hydrated.attempts['att-run-003']).toBeDefined()
  })

  it('returns empty maps for no records', () => {
    expect(hydrateWorkflowRuns([])).toEqual({ runs: {}, attempts: {} })
  })
})

describe('workflowsReducer cursorChanged', () => {
  it('moves the cursor to the named step', () => {
    const start = fixture({ cursorStepId: 'plan' })
    const next = workflowsReducer(start, {
      type: 'workflows/cursorChanged',
      payload: { runId: 'run-a', stepId: 'build' }
    })
    expect(next.runs['run-a'].cursorStepId).toBe('build')
    expect(next.runs['run-b']).toBe(start.runs['run-b'])
    expect(next.attempts).toBe(start.attempts)
  })

  it('returns the same state for the same step, an unknown step or run, or a terminal run', () => {
    const start = fixture({ cursorStepId: 'plan' })
    const done = fixture({ cursorStepId: 'plan', status: 'done', finishedAt: 2000 })
    const events: Array<[WorkflowsState, string, string]> = [
      [start, 'run-a', 'plan'],
      [start, 'run-a', 'ship'],
      [start, 'run-x', 'build'],
      [done, 'run-a', 'build']
    ]
    for (const [state, runId, stepId] of events) {
      expect(workflowsReducer(state, { type: 'workflows/cursorChanged', payload: { runId, stepId } })).toBe(state)
    }
  })
})

describe('workflowsReducer attemptSessionRecorded', () => {
  it('marks the attempt resumable once and keeps other references', () => {
    const start = fixture()
    const event: WorkflowsEvent = { type: 'workflows/attemptSessionRecorded', payload: { attemptId: 'att-a1' } }
    const next = workflowsReducer(start, event)
    expect(next.attempts['att-a1']).toEqual({ ...start.attempts['att-a1'], resumable: true })
    expect(next.attempts['att-b1']).toBe(start.attempts['att-b1'])
    expect(next.runs).toBe(start.runs)
    expect(workflowsReducer(next, event)).toBe(next)
  })

  it('returns the same state for an unknown attempt or an attempt of a terminal run', () => {
    const start = fixture({ status: 'cancelled', finishedAt: 2000 })
    for (const attemptId of ['att-zz', 'att-a1']) {
      expect(
        workflowsReducer(start, { type: 'workflows/attemptSessionRecorded', payload: { attemptId } })
      ).toBe(start)
    }
  })
})

describe('runStepFacts', () => {
  it('carries the kind and agent of runnable steps only', () => {
    expect(
      runStepFacts({ id: 'a', kind: 'agent', agent: 'claude', prompt: 'p', permissions: 'read-only', allow: [], needs: [] })
    ).toEqual({ kind: 'agent', agent: 'claude' })
    expect(runStepFacts({ id: 's', kind: 'shell', run: 'true', needs: [] })).toEqual({ kind: 'shell' })
    expect(runStepFacts({ id: 'f', kind: 'foreach', needs: [] })).toEqual({})
  })
})

describe('projectRunRecord step facts, cursor and resumability', () => {
  const definition: WorkflowRunRecord['definition'] = {
    name: 'two',
    inputs: {},
    steps: [
      { id: 'plan', kind: 'agent', agent: 'claude', prompt: 'p', permissions: 'read-only', allow: [], needs: [] },
      { id: 'test', kind: 'shell', run: 'true', needs: [] }
    ]
  }

  it('hydrates an interrupted attempt with a session as resumable and the cursor step id', () => {
    const projected = projectRunRecord(
      runRecord('run-1', {
        status: 'paused',
        pausedReason: 'interrupted',
        finishedAt: undefined,
        definition,
        cursor: 0,
        steps: { plan: 'interrupted', test: 'pending' },
        attempts: [
          {
            attemptId: 'att-1',
            stepId: 'plan',
            n: 1,
            status: 'interrupted',
            startedAt: 110,
            endedAt: 120,
            executionId: 'exec-1',
            sessionId: '6f1c2a4e-1b2c-4d3e-8f90-123456789abc',
            metrics: { continuations: 0, pauses: [] }
          }
        ]
      })
    )
    expect(projected.attempts['att-1'].resumable).toBe(true)
    expect(projected.run.cursorStepId).toBe('plan')
    expect(projected.run.steps).toEqual({
      plan: { status: 'interrupted', attemptIds: ['att-1'], kind: 'agent', agent: 'claude' },
      test: { status: 'pending', attemptIds: [], kind: 'shell' }
    })
    expect(JSON.stringify(projected)).not.toContain('6f1c2a4e')
  })

  it('omits resumable without a session and the cursor step id when the cursor is out of range', () => {
    const projected = projectRunRecord(
      runRecord('run-2', {
        definition,
        cursor: 2,
        steps: { plan: 'done', test: 'done' },
        attempts: [
          {
            attemptId: 'att-2',
            stepId: 'test',
            n: 1,
            status: 'done',
            startedAt: 110,
            endedAt: 120,
            metrics: { continuations: 0, pauses: [] }
          }
        ]
      })
    )
    expect('resumable' in projected.attempts['att-2']).toBe(false)
    expect('cursorStepId' in projected.run).toBe(false)
  })
})

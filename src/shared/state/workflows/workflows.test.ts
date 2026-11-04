import { describe, it, expect } from 'vitest'
import {
  initialWorkflows,
  RECENT_RUNS_MAX,
  SUMMARY_PREVIEW_MAX,
  WORKFLOW_RUN_RECORD_VERSION,
  capPermissions,
  deriveChainStatus,
  hydrateWorkflowRuns,
  projectRunRecord,
  runStepFacts,
  runsToEvict,
  workflowsReducer,
  type WorkflowAttempt,
  type WorkflowChain,
  type WorkflowChainItem,
  type WorkflowChainStatusResult,
  type WorkflowDefinitionSummary,
  type WorkflowRun,
  type WorkflowRunRecord,
  type WorkflowsEvent,
  type WorkflowsState
} from './index'
import { validateWorkflowDefinition } from '../../workflow-def'

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
  it('definitionSaved upserts one summary, keeps sibling references and no-ops on an identical summary', () => {
    const start = threeGroups()
    const added = workflowsReducer(start, { type: 'workflows/definitionSaved', payload: summary('copy') })
    expect(added.definitions['personal:copy']).toEqual(summary('copy'))
    expect(added.definitions['personal:mine']).toBe(start.definitions['personal:mine'])
    expect(added.definitions[repoSummary('shared').id]).toBe(start.definitions[repoSummary('shared').id])

    const edited = workflowsReducer(added, {
      type: 'workflows/definitionSaved',
      payload: repoSummary('shared', REPO_A)
    })
    expect(edited).toBe(added)
    const rehashed = workflowsReducer(added, {
      type: 'workflows/definitionSaved',
      payload: { ...repoSummary('shared', REPO_A), hash: 'changed' }
    })
    expect(rehashed.definitions[repoSummary('shared').id].hash).toBe('changed')
    expect(rehashed.definitions['personal:copy']).toBe(added.definitions['personal:copy'])
    expect(rehashed.trust).toBe(added.trust)
  })

  it('definitionDeleted removes only the named summary and no-ops on an unknown id', () => {
    const start = threeGroups()
    const next = workflowsReducer(start, { type: 'workflows/definitionDeleted', payload: { defId: 'personal:mine' } })
    expect(Object.keys(next.definitions).sort()).toEqual([repoSummary('shared', REPO_A).id, repoSummary('shared', REPO_B).id].sort())
    expect(next.definitions[repoSummary('shared', REPO_B).id]).toBe(start.definitions[repoSummary('shared', REPO_B).id])
    expect(workflowsReducer(next, { type: 'workflows/definitionDeleted', payload: { defId: 'personal:mine' } })).toBe(next)
    expect(workflowsReducer(next, { type: 'workflows/definitionDeleted', payload: { defId: 'toString' } })).toBe(next)
  })

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
    trust: {},
    chains: {},
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

describe('workflowsReducer stepAgentChanged', () => {
  const agentRun = (status: WorkflowRun['status'] = 'paused'): WorkflowsState =>
    fixture({
      status,
      steps: {
        plan: { status: 'failed', attemptIds: ['att-a1'], kind: 'agent', agent: 'claude' },
        build: { status: 'pending', attemptIds: [], kind: 'shell' }
      }
    })

  it('sets the agent of the named step and keeps other references', () => {
    const start = agentRun()
    const next = workflowsReducer(start, {
      type: 'workflows/stepAgentChanged',
      payload: { runId: 'run-a', stepId: 'plan', agent: 'codex' }
    })
    expect(next.runs['run-a'].steps.plan).toEqual({ ...start.runs['run-a'].steps.plan, agent: 'codex' })
    expect(next.runs['run-a'].steps.build).toBe(start.runs['run-a'].steps.build)
    expect(next.runs['run-b']).toBe(start.runs['run-b'])
    expect(next.attempts).toBe(start.attempts)
  })

  it('returns the same state for the same agent, a non-agent or unknown step, an unknown run, or a terminal run', () => {
    const start = agentRun()
    const done = agentRun('done')
    const cases: Array<[WorkflowsState, string, string]> = [
      [start, 'run-a', 'plan'],
      [start, 'run-a', 'build'],
      [start, 'run-a', 'ship'],
      [start, 'run-x', 'plan'],
      [done, 'run-a', 'plan']
    ]
    for (const [state, runId, stepId] of cases) {
      const agent = state === start && stepId === 'plan' ? 'claude' : 'codex'
      expect(workflowsReducer(state, { type: 'workflows/stepAgentChanged', payload: { runId, stepId, agent } })).toBe(state)
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

describe('workflowsReducer trustGranted', () => {
  const defId = 'repo:abcdefabcdef:ship'
  const hashA = 'a'.repeat(64)
  const hashB = 'b'.repeat(64)

  it('records the trusted hash for a definition and replaces an older one', () => {
    const first = workflowsReducer(initialWorkflows, {
      type: 'workflows/trustGranted',
      payload: { defId, hash: hashA }
    })
    expect(first.trust).toEqual({ [defId]: hashA })
    const second = workflowsReducer(first, { type: 'workflows/trustGranted', payload: { defId, hash: hashB } })
    expect(second.trust).toEqual({ [defId]: hashB })
    expect(second.definitions).toBe(first.definitions)
  })

  it('returns the same state when the hash is already trusted', () => {
    const start = { ...initialWorkflows, trust: { [defId]: hashA } }
    expect(workflowsReducer(start, { type: 'workflows/trustGranted', payload: { defId, hash: hashA } })).toBe(start)
  })
})

describe('workflowsReducer gateResolved', () => {
  const gated = () =>
    fixture({
      status: 'paused',
      pausedReason: 'gate',
      steps: {
        plan: { status: 'awaiting-gate', attemptIds: ['att-a1'] },
        build: { status: 'pending', attemptIds: [] }
      }
    })

  it('approved moves an awaiting-gate step to done and keeps its attempts', () => {
    const start = gated()
    const next = workflowsReducer(start, {
      type: 'workflows/gateResolved',
      payload: { runId: 'run-a', stepId: 'plan', decision: 'approved' }
    })
    expect(next.runs['run-a'].steps.plan.status).toBe('done')
    expect(next.runs['run-a'].steps.plan.attemptIds).toBe(start.runs['run-a'].steps.plan.attemptIds)
    expect(next.runs['run-a'].steps.build).toBe(start.runs['run-a'].steps.build)
    expect(next.runs['run-b']).toBe(start.runs['run-b'])
  })

  it('changes-requested moves an awaiting-gate step back to pending', () => {
    const start = gated()
    const next = workflowsReducer(start, {
      type: 'workflows/gateResolved',
      payload: { runId: 'run-a', stepId: 'plan', decision: 'changes-requested' }
    })
    expect(next.runs['run-a'].steps.plan).toEqual({ status: 'pending', attemptIds: ['att-a1'] })
    expect(next.runs['run-a'].pausedReason).toBe('gate')
  })

  it.each(['approved', 'changes-requested'] as const)(
    'returns the same state for %s when the step is not awaiting its gate, unknown, or the run is finished',
    (decision) => {
      const resolve = (state: ReturnType<typeof fixture>, runId: string, stepId: string) =>
        workflowsReducer(state, { type: 'workflows/gateResolved', payload: { runId, stepId, decision } })
      const running = fixture()
      expect(resolve(running, 'run-a', 'plan')).toBe(running)
      const start = gated()
      expect(resolve(start, 'run-a', 'nope')).toBe(start)
      expect(resolve(start, 'nope', 'plan')).toBe(start)
      const cancelled = fixture({
        status: 'cancelled',
        finishedAt: 5000,
        steps: { plan: { status: 'awaiting-gate', attemptIds: ['att-a1'] } }
      })
      expect(resolve(cancelled, 'run-a', 'plan')).toBe(cancelled)
    }
  )

  it('autopilot moves an awaiting-gate step to done and keeps its attempts', () => {
    const start = fixture({
      steps: { plan: { status: 'awaiting-gate', attemptIds: ['att-a1'] }, build: { status: 'pending', attemptIds: [] } }
    })
    const next = workflowsReducer(start, {
      type: 'workflows/gateResolved',
      payload: { runId: 'run-a', stepId: 'plan', decision: 'autopilot' }
    })
    expect(next.runs['run-a'].steps.plan).toEqual({ status: 'done', attemptIds: ['att-a1'] })
    expect(next.runs['run-a'].steps.build).toBe(start.runs['run-a'].steps.build)
    expect(next.runs['run-b']).toBe(start.runs['run-b'])
  })

  it.each(['pending', 'queued', 'running', 'failed', 'done'] as const)('autopilot returns the same state for a %s step', (status) => {
    const start = fixture({ steps: { plan: { status, attemptIds: [] } } })
    expect(
      workflowsReducer(start, {
        type: 'workflows/gateResolved',
        payload: { runId: 'run-a', stepId: 'plan', decision: 'autopilot' }
      })
    ).toBe(start)
  })
})

describe('capPermissions', () => {
  function resolved(source: string) {
    const { definition } = validateWorkflowDefinition(source)
    if (!definition) throw new Error('fixture did not resolve')
    return definition
  }

  it('lowers full agent steps to edit and leaves read-only, edit and shell steps alone', () => {
    const definition = resolved(`name: mixed
steps:
  - id: a
    agent: claude
    permissions: full
    prompt: a
  - id: b
    agent: claude
    permissions: read-only
    prompt: b
  - id: c
    agent: claude
    permissions: edit
    prompt: c
  - id: d
    kind: shell
    run: echo d
`)
    const capped = capPermissions(definition)
    expect(capped.steps.map((step) => (step.kind === 'agent' ? step.permissions : step.kind))).toEqual([
      'edit',
      'read-only',
      'edit',
      'shell'
    ])
    expect(capped.steps[1]).toBe(definition.steps[1])
    expect(definition.steps[0]).toMatchObject({ permissions: 'full' })
  })

  it('returns the same definition when no step has full permissions', () => {
    const definition = resolved(`name: plain
steps:
  - id: a
    agent: claude
    prompt: a
`)
    expect(capPermissions(definition)).toBe(definition)
  })
})

describe('workflowsReducer attemptCostChanged', () => {
  const costChanged = (attemptId: string, costUsd: number): WorkflowsEvent => ({
    type: 'workflows/attemptCostChanged',
    payload: { attemptId, costUsd }
  })

  it('records the cost on one attempt and keeps other references', () => {
    const start = fixture()
    const next = workflowsReducer(start, costChanged('att-a1', 0.25))
    expect(next.attempts['att-a1']).toEqual({ ...start.attempts['att-a1'], costUsd: 0.25 })
    expect(next.attempts['att-b1']).toBe(start.attempts['att-b1'])
    expect(next.runs).toBe(start.runs)
  })

  it('returns the same state for the same cost', () => {
    const next = workflowsReducer(fixture(), costChanged('att-a1', 0.25))
    expect(workflowsReducer(next, costChanged('att-a1', 0.25))).toBe(next)
  })

  it('returns the same state for an unknown attempt or a non-finite or negative cost', () => {
    const start = fixture()
    for (const event of [
      costChanged('att-zz', 0.25),
      costChanged('att-a1', Number.NaN),
      costChanged('att-a1', Number.POSITIVE_INFINITY),
      costChanged('att-a1', -0.01)
    ]) {
      expect(workflowsReducer(start, event)).toBe(start)
    }
  })

  it('still records the late cost of an attempt on a finished run', () => {
    const start = fixture({ status: 'done', finishedAt: 5000 })
    const next = workflowsReducer(start, costChanged('att-a1', 0.4))
    expect(next.attempts['att-a1'].costUsd).toBe(0.4)
  })
})

describe('projectRunRecord measured cost', () => {
  it('prefers the attempt metrics cost over the result cost', () => {
    const projected = projectRunRecord(
      runRecord('run-1', {
        steps: { plan: 'done', build: 'running', ship: 'pending' },
        attempts: [
          {
            attemptId: 'att-1',
            stepId: 'plan',
            n: 1,
            status: 'done',
            startedAt: 110,
            endedAt: 120,
            result: { status: 'done', summary: 'ok', completedBy: 'tool', costUsd: 0.5 },
            metrics: { continuations: 0, pauses: [], costUsd: 0.75 }
          },
          {
            attemptId: 'att-2',
            stepId: 'build',
            n: 1,
            status: 'running',
            startedAt: 130,
            metrics: { continuations: 0, pauses: [], costUsd: 0.1 }
          }
        ]
      })
    )
    expect(projected.attempts['att-1'].costUsd).toBe(0.75)
    expect(projected.attempts['att-2'].costUsd).toBe(0.1)
  })
})

describe('workflowsReducer runBudgetChanged', () => {
  const budgetChanged = (runId: string, budgetUsd: number): WorkflowsEvent => ({
    type: 'workflows/runBudgetChanged',
    payload: { runId, budgetUsd }
  })

  it('records the budget on one run and keeps the other run and the attempts', () => {
    const start = fixture()
    const next = workflowsReducer(start, budgetChanged('run-a', 2.5))
    expect(next.runs['run-a']).toEqual({ ...start.runs['run-a'], budgetUsd: 2.5 })
    expect(next.runs['run-b']).toBe(start.runs['run-b'])
    expect(next.attempts).toBe(start.attempts)
  })

  it('replaces an earlier budget and returns the same state for the same budget', () => {
    const raised = workflowsReducer(workflowsReducer(fixture(), budgetChanged('run-a', 1)), budgetChanged('run-a', 3))
    expect(raised.runs['run-a'].budgetUsd).toBe(3)
    expect(workflowsReducer(raised, budgetChanged('run-a', 3))).toBe(raised)
  })

  it('returns the same state for an unknown or finished run or an invalid budget', () => {
    const start = fixture()
    for (const event of [
      budgetChanged('run-zz', 1),
      budgetChanged('run-a', 0),
      budgetChanged('run-a', -1),
      budgetChanged('run-a', Number.NaN),
      budgetChanged('run-a', Number.POSITIVE_INFINITY),
      budgetChanged('run-a', 10001)
    ]) {
      expect(workflowsReducer(start, event)).toBe(start)
    }
    const finished = fixture({ status: 'done', finishedAt: 5000 })
    expect(workflowsReducer(finished, budgetChanged('run-a', 1))).toBe(finished)
  })

  it('runStarted carries the budget of a new run', () => {
    const next = workflowsReducer(initialWorkflows, {
      type: 'workflows/runStarted',
      payload: { runId: 'run-new', run: run({ budgetUsd: 0.5 }) }
    })
    expect(next.runs['run-new'].budgetUsd).toBe(0.5)
  })
})

describe('projectRunRecord budget', () => {
  it('keeps the budget of a record through hydration', () => {
    const hydrated = hydrateWorkflowRuns([runRecord('run-1', { status: 'paused', pausedReason: 'budget', budgetUsd: 0.25 })])
    expect(hydrated.runs['run-1'].budgetUsd).toBe(0.25)
    expect(hydrated.runs['run-1'].pausedReason).toBe('budget')
  })

  it('leaves the budget absent when the record has none or an invalid one', () => {
    expect(projectRunRecord(runRecord('run-1')).run).not.toHaveProperty('budgetUsd')
    expect(projectRunRecord(runRecord('run-1', { budgetUsd: -2 })).run).not.toHaveProperty('budgetUsd')
  })
})

function chain(overrides: Partial<WorkflowChain> = {}): WorkflowChain {
  return {
    chainId: 'chain-1',
    defId: 'personal:a',
    repoRoot: '/repo',
    mode: 'stacked',
    items: [
      { id: 'i1', title: 'First', branch: 'feat/one', baseBranch: 'main' },
      { id: 'i2', title: 'Second', prevItemId: 'i1' },
      { id: 'i3', title: 'Third', prevItemId: 'i2' }
    ],
    draftPrs: false,
    childRunIds: {},
    startedAt: 500,
    ...overrides
  }
}

function withChain(overrides: Partial<WorkflowChain> = {}): WorkflowsState {
  const c = chain(overrides)
  return { ...fixture(), chains: { [c.chainId]: c } }
}

describe('workflowsReducer chainStarted', () => {
  it('adds a chain and keeps the runs and other chains', () => {
    const start = withChain()
    const other = chain({ chainId: 'chain-2' })
    const next = workflowsReducer(start, { type: 'workflows/chainStarted', payload: { chain: other } })
    expect(next.chains['chain-2']).toBe(other)
    expect(next.chains['chain-1']).toBe(start.chains['chain-1'])
    expect(next.runs).toBe(start.runs)
  })

  it('returns the same state when the chain id already exists', () => {
    const start = withChain()
    const next = workflowsReducer(start, {
      type: 'workflows/chainStarted',
      payload: { chain: chain({ mode: 'independent' }) }
    })
    expect(next).toBe(start)
  })

  it('adds a chain whose id is an Object.prototype key', () => {
    const next = workflowsReducer(initialWorkflows, {
      type: 'workflows/chainStarted',
      payload: { chain: chain({ chainId: 'constructor' }) }
    })
    expect(Object.hasOwn(next.chains, 'constructor')).toBe(true)
  })
})

describe('workflowsReducer chainItemsChanged', () => {
  const itemsChanged = (items: Array<Pick<WorkflowChainItem, 'id'> & Partial<WorkflowChainItem>>, chainId = 'chain-1'): WorkflowsEvent => ({
    type: 'workflows/chainItemsChanged',
    payload: { chainId, items }
  })

  it('patches named fields of one item and keeps the other item references', () => {
    const start = withChain()
    const next = workflowsReducer(start, itemsChanged([{ id: 'i2', branch: 'feat/two', baseBranch: 'feat/one' }]))
    const before = start.chains['chain-1'].items
    const after = next.chains['chain-1'].items
    expect(after[1]).toEqual({ id: 'i2', title: 'Second', prevItemId: 'i1', branch: 'feat/two', baseBranch: 'feat/one' })
    expect(after[0]).toBe(before[0])
    expect(after[2]).toBe(before[2])
    expect(next.runs).toBe(start.runs)
  })

  it('applies several patches in one event, including two patches to the same item', () => {
    const next = workflowsReducer(
      withChain(),
      itemsChanged([{ id: 'i1', prNumber: 7 }, { id: 'i3', skipped: true }, { id: 'i1', title: 'First (renamed)' }])
    )
    const items = next.chains['chain-1'].items
    expect(items[0]).toEqual({ id: 'i1', title: 'First (renamed)', branch: 'feat/one', baseBranch: 'main', prNumber: 7 })
    expect(items[2].skipped).toBe(true)
  })

  it('treats a field set to undefined as omitted and leaves the existing value', () => {
    const next = workflowsReducer(withChain(), itemsChanged([{ id: 'i1', title: 'Renamed', branch: undefined }]))
    const item = next.chains['chain-1'].items[0]
    expect(item.title).toBe('Renamed')
    expect(item.branch).toBe('feat/one')
  })

  it('patches known items and ignores unknown item ids in the same event', () => {
    const next = workflowsReducer(withChain(), itemsChanged([{ id: 'zz', title: 'x' }, { id: 'i2', prNumber: 9 }]))
    expect(next.chains['chain-1'].items.map((item) => item.id)).toEqual(['i1', 'i2', 'i3'])
    expect(next.chains['chain-1'].items[1].prNumber).toBe(9)
  })

  it('returns the same state for an unknown chain, only unknown items, or values already set', () => {
    const start = withChain()
    for (const event of [
      itemsChanged([{ id: 'i1', title: 'x' }], 'chain-zz'),
      itemsChanged([{ id: 'zz', title: 'x' }]),
      itemsChanged([{ id: 'i1', title: 'First', branch: 'feat/one' }]),
      itemsChanged([{ id: 'i2', branch: undefined }]),
      itemsChanged([])
    ]) {
      expect(workflowsReducer(start, event)).toBe(start)
    }
  })
})

describe('workflowsReducer chainChildRunLinked', () => {
  const linked = (itemId: string, runId: string, chainId = 'chain-1'): WorkflowsEvent => ({
    type: 'workflows/chainChildRunLinked',
    payload: { chainId, itemId, runId }
  })

  it('links a child run to an item and keeps the items reference', () => {
    const start = withChain()
    const next = workflowsReducer(start, linked('i1', 'run-a'))
    expect(next.chains['chain-1'].childRunIds).toEqual({ i1: 'run-a' })
    expect(next.chains['chain-1'].items).toBe(start.chains['chain-1'].items)
  })

  it('relinks an item to a fresh run on retry', () => {
    const next = workflowsReducer(withChain({ childRunIds: { i1: 'run-a' } }), linked('i1', 'run-b'))
    expect(next.chains['chain-1'].childRunIds).toEqual({ i1: 'run-b' })
  })

  it('returns the same state for an unknown chain, an item not in the chain, or the same run', () => {
    const start = withChain({ childRunIds: { i1: 'run-a' } })
    for (const event of [linked('i1', 'run-b', 'chain-zz'), linked('zz', 'run-b'), linked('i1', 'run-a')]) {
      expect(workflowsReducer(start, event)).toBe(start)
    }
  })
})

describe('workflowsReducer chainFinished', () => {
  const finished = (finishedAt: number, chainId = 'chain-1'): WorkflowsEvent => ({
    type: 'workflows/chainFinished',
    payload: { chainId, status: 'done', finishedAt }
  })

  it('records only finishedAt and never stores a status', () => {
    const start = withChain()
    const next = workflowsReducer(start, finished(9000))
    expect(next.chains['chain-1']).toEqual({ ...start.chains['chain-1'], finishedAt: 9000 })
    expect(next.chains['chain-1']).not.toHaveProperty('status')
  })

  it('returns the same state for an unknown or already finished chain', () => {
    const start = withChain({ finishedAt: 8000 })
    expect(workflowsReducer(start, finished(9000))).toBe(start)
    expect(workflowsReducer(start, finished(9000, 'chain-zz'))).toBe(start)
  })
})

describe('workflowsReducer prRecorded', () => {
  const pr = { number: 12, url: 'https://github.com/o/r/pull/12', draft: true }
  const recorded = (runId: string, value = pr): WorkflowsEvent => ({
    type: 'workflows/prRecorded',
    payload: { runId, pr: value }
  })

  it('records the pull request on one run and keeps the other run and the attempts', () => {
    const start = fixture()
    const next = workflowsReducer(start, recorded('run-a'))
    expect(next.runs['run-a']).toEqual({ ...start.runs['run-a'], pr })
    expect(next.runs['run-b']).toBe(start.runs['run-b'])
    expect(next.attempts).toBe(start.attempts)
  })

  it('replaces a pull request when it leaves draft and returns the same state for an identical one', () => {
    const drafted = workflowsReducer(fixture(), recorded('run-a'))
    const ready = workflowsReducer(drafted, recorded('run-a', { ...pr, draft: false }))
    expect(ready.runs['run-a'].pr).toEqual({ ...pr, draft: false })
    expect(workflowsReducer(ready, recorded('run-a', { ...pr, draft: false }))).toBe(ready)
  })

  it('returns the same state for an unknown run', () => {
    const start = fixture()
    expect(workflowsReducer(start, recorded('run-zz'))).toBe(start)
  })

  it('still records the pull request of a finished run', () => {
    const next = workflowsReducer(fixture({ status: 'done', finishedAt: 5000 }), recorded('run-a'))
    expect(next.runs['run-a'].pr).toEqual(pr)
  })
})

describe('deriveChainStatus', () => {
  const ITEMS: WorkflowChainItem[] = [
    { id: 'i1', title: 'One' },
    { id: 'i2', title: 'Two' },
    { id: 'i3', title: 'Three' }
  ]
  const statusRun = (status: WorkflowRun['status']): WorkflowRun => run({ status })

  it.each<[string, Partial<WorkflowChain>, Record<string, WorkflowRun['status']>, WorkflowChainStatusResult]>([
    ['zero items', { items: [] }, {}, { status: 'done' }],
    ['every child done', { childRunIds: { i1: 'r1', i2: 'r2', i3: 'r3' } }, { r1: 'done', r2: 'done', r3: 'done' }, { status: 'done' }],
    [
      'done and skipped mix',
      { items: [ITEMS[0], { ...ITEMS[1], skipped: true }, ITEMS[2]], childRunIds: { i1: 'r1', i3: 'r3' } },
      { r1: 'done', r3: 'done' },
      { status: 'done' }
    ],
    [
      'skipped item whose child failed',
      { items: [{ ...ITEMS[0], skipped: true }, ITEMS[1], ITEMS[2]], childRunIds: { i1: 'r1', i2: 'r2', i3: 'r3' } },
      { r1: 'failed', r2: 'done', r3: 'done' },
      { status: 'done' }
    ],
    [
      'first paused in item order wins',
      { childRunIds: { i1: 'r1', i2: 'r2', i3: 'r3' } },
      { r1: 'running', r2: 'paused', r3: 'paused' },
      { status: 'paused', runId: 'r2' }
    ],
    [
      'paused wins over a failed sibling',
      { childRunIds: { i1: 'r1', i2: 'r2' } },
      { r1: 'failed', r2: 'paused' },
      { status: 'paused', runId: 'r2' }
    ],
    ['any running', { childRunIds: { i1: 'r1', i2: 'r2' } }, { r1: 'done', r2: 'running' }, { status: 'running' }],
    ['failed with nothing live', { childRunIds: { i1: 'r1', i2: 'r2' } }, { r1: 'done', r2: 'failed' }, { status: 'failed' }],
    ['cancelled with nothing live', { childRunIds: { i1: 'r1' } }, { r1: 'cancelled' }, { status: 'cancelled' }],
    ['failed wins over cancelled', { childRunIds: { i1: 'r1', i2: 'r2' } }, { r1: 'cancelled', r2: 'failed' }, { status: 'failed' }],
    ['failed with the remaining items unlinked', { childRunIds: { i1: 'r1' } }, { r1: 'failed' }, { status: 'failed' }],
    ['failed with a queued sibling', { childRunIds: { i1: 'r1', i2: 'r2' } }, { r1: 'failed', r2: 'queued' }, { status: 'queued' }],
    ['nothing linked yet', {}, {}, { status: 'queued' }],
    ['done child and unlinked items', { childRunIds: { i1: 'r1' } }, { r1: 'done' }, { status: 'queued' }],
    ['linked run evicted from runs', { childRunIds: { i1: 'r1', i2: 'r2', i3: 'r3' } }, { r1: 'done', r3: 'done' }, { status: 'queued' }],
    ['evicted run next to a failed child', { childRunIds: { i1: 'gone', i2: 'r2' } }, { r2: 'failed' }, { status: 'failed' }]
  ])('%s', (_name, overrides, statuses, expected) => {
    const runs: Record<string, WorkflowRun> = {}
    for (const [runId, status] of Object.entries(statuses)) runs[runId] = statusRun(status)
    expect(deriveChainStatus(chain({ items: ITEMS, ...overrides }), runs)).toEqual(expected)
  })
})

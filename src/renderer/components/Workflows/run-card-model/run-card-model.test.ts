import { describe, expect, it } from 'vitest'
import { activeRunIds, createRunListsSelector, formatElapsed, recentRunIds, runCardModel } from '.'
import type {
  WorkflowAttempt,
  WorkflowDefinitionSummary,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowRunStep
} from '../../../../shared/state/workflows'

const SUMMARY: WorkflowDefinitionSummary = {
  id: 'personal:ship',
  name: 'Ship it',
  scope: 'personal',
  path: '/d/ship.yaml',
  hash: 'h1',
  stepIds: ['plan', 'build', 'test'],
  issues: []
}

function step(status: WorkflowRunStep['status'], extra: Partial<WorkflowRunStep> = {}): WorkflowRunStep {
  return { status, attemptIds: [], ...extra }
}

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    defId: SUMMARY.id,
    defHash: 'h1',
    worktreePath: '/repos/app/feature-x',
    status: 'running',
    startedAt: 1_000,
    steps: {
      plan: step('done', { kind: 'shell' }),
      build: step('running', { kind: 'agent', agent: 'codex' }),
      test: step('pending', { kind: 'agent', agent: 'claude' })
    },
    ...overrides
  }
}

function attempt(costUsd?: number): WorkflowAttempt {
  return {
    runId: 'r1',
    stepId: 'build',
    n: 1,
    status: 'done',
    summaryPreview: '',
    startedAt: 1_000,
    ...(costUsd === undefined ? {} : { costUsd })
  }
}

describe('runCardModel current step and agent', () => {
  it.each<[string, Partial<WorkflowRun>, string | null, string | null]>([
    ['cursor on an agent step names its agent', { cursorStepId: 'build' }, 'build', 'Codex'],
    [
      'cursor on a running shell step with no running agent names the shell',
      {
        cursorStepId: 'plan',
        steps: { plan: step('running', { kind: 'shell' }), build: step('pending', { kind: 'agent', agent: 'codex' }), test: step('pending') }
      },
      'plan',
      'Shell'
    ],
    [
      'parallel branches name the first running agent step, not the cursor',
      {
        cursorStepId: 'plan',
        steps: {
          plan: step('running', { kind: 'shell' }),
          build: step('queued', { kind: 'agent', agent: 'codex' }),
          test: step('running', { kind: 'agent', agent: 'claude' })
        }
      },
      'test',
      'Claude Code'
    ],
    [
      'two running agent branches name the first in definition order',
      {
        cursorStepId: 'build',
        steps: {
          plan: step('done', { kind: 'shell' }),
          build: step('running', { kind: 'agent', agent: 'codex' }),
          test: step('running', { kind: 'agent', agent: 'claude' })
        }
      },
      'build',
      'Codex'
    ],
    [
      'a paused run keeps its cursor step while a sibling agent runs',
      {
        status: 'paused',
        pausedReason: 'step-failed',
        cursorStepId: 'build',
        steps: {
          plan: step('done', { kind: 'shell' }),
          build: step('failed', { kind: 'agent', agent: 'codex' }),
          test: step('running', { kind: 'agent', agent: 'claude' })
        }
      },
      'build',
      'Codex'
    ],
    ['no cursor falls back to the first unfinished step', {}, 'build', 'Codex'],
    [
      'no cursor and every step finished has no current step',
      { status: 'done', steps: { plan: step('done', { kind: 'shell' }), build: step('skipped'), test: step('done') } },
      null,
      null
    ],
    [
      'an agent step on an old server without kind facts has no agent',
      { cursorStepId: 'build', steps: { plan: step('done'), build: step('running'), test: step('pending') } },
      'build',
      null
    ],
    ['a cursor outside the run steps falls back to the step order', { cursorStepId: 'gone' }, 'build', 'Codex']
  ])('%s', (_name, overrides, stepId, agent) => {
    const model = runCardModel(run(overrides), [], SUMMARY, 5_000)
    expect(model.stepId).toBe(stepId)
    expect(model.agent).toBe(agent)
  })

  it('uses the workflow name from the summary and the defId without one', () => {
    expect(runCardModel(run(), [], SUMMARY, 1_000).name).toBe('Ship it')
    expect(runCardModel(run(), [], null, 1_000).name).toBe('personal:ship')
  })

  it('names the worktree by its last path segment', () => {
    expect(runCardModel(run(), [], SUMMARY, 1_000).worktreeName).toBe('feature-x')
  })
})

describe('runCardModel status', () => {
  it.each<[WorkflowRunStatus, Partial<WorkflowRun>, string]>([
    ['queued', {}, 'Queued'],
    ['running', {}, 'Running'],
    ['paused', { pausedReason: 'needs-input' }, 'Paused · Needs input'],
    ['done', {}, 'Done'],
    ['failed', {}, 'Failed'],
    ['cancelled', {}, 'Cancelled']
  ])('labels a %s run', (status, overrides, label) => {
    expect(runCardModel(run({ status, ...overrides }), [], SUMMARY, 1_000).status).toBe(label)
  })
})

describe('runCardModel elapsed', () => {
  it.each<[string, Partial<WorkflowRun>, number, string]>([
    ['active run under a minute counts to now', {}, 1_000 + 42_000, '42s'],
    ['active run under an hour shows minutes and seconds', {}, 1_000 + 3 * 60_000 + 5_000, '3m 05s'],
    ['active run over an hour shows hours and minutes', {}, 1_000 + 2 * 3_600_000 + 7 * 60_000, '2h 07m'],
    ['finished run stops at finishedAt', { status: 'done', finishedAt: 1_000 + 90_000 }, 1_000_000, '1m 30s'],
    ['a clock behind startedAt clamps to zero', {}, 0, '0s']
  ])('%s', (_name, overrides, now, elapsed) => {
    expect(runCardModel(run(overrides), [], SUMMARY, now).elapsed).toBe(elapsed)
  })

  it('formats sub-second durations as zero seconds', () => {
    expect(formatElapsed(999)).toBe('0s')
  })
})

describe('runCardModel cost', () => {
  it.each<[string, Partial<WorkflowRun>, WorkflowAttempt[], string]>([
    ['no cost anywhere (e.g. opencode) shows a dash', {}, [attempt(), attempt()], '—'],
    ['no attempts shows a dash', {}, [], '—'],
    ['the run total wins over attempt costs', { costUsd: 1.5 }, [attempt(0.2)], '$1.50'],
    ['an active run sums the attempts that report cost', {}, [attempt(0.25), attempt(), attempt(0.5)], '$0.75'],
    ['a zero cost is a value, not a dash', {}, [attempt(0)], '$0.00'],
    ['a cost under a cent shows <$0.01', {}, [attempt(0.004)], '<$0.01']
  ])('%s', (_name, overrides, attempts, cost) => {
    expect(runCardModel(run(overrides), attempts, SUMMARY, 1_000).cost).toBe(cost)
  })
})

function runs(entries: Array<[string, WorkflowRunStatus, number, number?]>): Record<string, WorkflowRun> {
  return Object.fromEntries(
    entries.map(([id, status, startedAt, finishedAt]) => [
      id,
      run({ status, startedAt, ...(finishedAt === undefined ? {} : { finishedAt }) })
    ])
  )
}

describe('recentRunIds', () => {
  it.each<[string, Array<[string, WorkflowRunStatus, number, number?]>, string[]]>([
    [
      'orders finished runs newest finish first',
      [
        ['a', 'done', 1, 10],
        ['b', 'cancelled', 2, 30],
        ['c', 'failed', 3, 20]
      ],
      ['b', 'c', 'a']
    ],
    [
      'leaves out live runs',
      [
        ['a', 'running', 1],
        ['b', 'paused', 2],
        ['c', 'queued', 3],
        ['d', 'done', 4, 5]
      ],
      ['d']
    ],
    [
      'falls back to startedAt when finishedAt is missing',
      [
        ['a', 'done', 50],
        ['b', 'done', 1, 40]
      ],
      ['a', 'b']
    ],
    [
      'breaks ties by run id',
      [
        ['b', 'done', 1, 10],
        ['a', 'done', 1, 10]
      ],
      ['a', 'b']
    ]
  ])('%s', (_name, entries, expected) => {
    expect(recentRunIds(runs(entries))).toEqual(expected)
  })
})

describe('activeRunIds', () => {
  it('lists queued, running and paused runs newest start first', () => {
    const all = runs([
      ['a', 'running', 10],
      ['b', 'paused', 30],
      ['c', 'queued', 20],
      ['d', 'done', 40, 50]
    ])
    expect(activeRunIds(all)).toEqual(['b', 'c', 'a'])
  })
})

describe('createRunListsSelector', () => {
  it('returns the same lists while the ids do not change', () => {
    const select = createRunListsSelector()
    const first = runs([
      ['a', 'running', 10],
      ['d', 'done', 40, 50]
    ])
    const lists = select(first)
    const patched = { ...first, a: { ...first.a, cursorStepId: 'test' } }
    expect(select(patched)).toBe(lists)
  })

  it('returns new lists when a run moves from active to recent', () => {
    const select = createRunListsSelector()
    const first = runs([['a', 'running', 10]])
    const lists = select(first)
    const next = select({ ...first, a: { ...first.a, status: 'done', finishedAt: 20 } })
    expect(next).not.toBe(lists)
    expect(next).toEqual({ active: [], recent: ['a'] })
  })
})

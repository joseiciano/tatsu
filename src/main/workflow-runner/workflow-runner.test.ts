import { describe, it, expect, vi } from 'vitest'
import { Store } from '../store'
import { WorkflowRunner, type StepAttempt, type StepResult, type WorkflowRunnerDeps } from '.'
import { FakeStepDriver, type FakeStartBehavior } from './fake-step-driver'
import { initialState, type StateEvent } from '../../shared/state'
import type {
  WorkflowAttemptStatus,
  WorkflowDefinitionDetail,
  WorkflowStepStatus
} from '../../shared/state/workflows'
import { validateWorkflowDefinition } from '../../shared/workflow-def'

vi.mock('../perf-log', () => ({
  perfLog: vi.fn(),
  getPerfLogFilePath: vi.fn(() => '/tmp/perf.log')
}))

const PROMPT_SECRET = 'PROMPT-SECRET-zebra-42'
const SUMMARY_SECRET = 'SUMMARY-SECRET-okapi-17'
const INPUT_SECRET = 'INPUT-SECRET-narwhal-9'

const SOURCES = {
  'two-agent': `name: two-agent
inputs:
  task: { type: text }
steps:
  - id: plan
    agent: claude
    prompt: "${PROMPT_SECRET} plan {{inputs.task}}"
  - id: build
    agent: claude
    prompt: "${PROMPT_SECRET} build {{steps.plan.summary}}"
`,
  'one-agent': `name: one-agent
steps:
  - id: plan
    agent: claude
    prompt: "${PROMPT_SECRET} plan"
`,
  'one-shell': `name: one-shell
steps:
  - id: test
    kind: shell
    run: "echo ${PROMPT_SECRET}"
`,
  broken: `name: broken
steps:
  - id: plan
    agent: claude
`
} as const

type DefSlug = keyof typeof SOURCES

function detail(slug: DefSlug): WorkflowDefinitionDetail {
  const source = SOURCES[slug]
  const result = validateWorkflowDefinition(source)
  return {
    ...result,
    source,
    summary: {
      id: `personal:${slug}`,
      name: slug,
      scope: 'personal',
      path: `/defs/${slug}.yaml`,
      hash: `hash-${slug}`,
      stepIds: result.parsed?.steps.map((step) => step.id) ?? [],
      issues: []
    }
  }
}

interface SetupOptions {
  labs?: boolean
  cap?: number
  agentScript?: (attempt: StepAttempt) => FakeStartBehavior
  shellScript?: (attempt: StepAttempt) => FakeStartBehavior
}

function setup({ labs = true, cap = 4, agentScript, shellScript }: SetupOptions = {}) {
  const store = new Store({
    ...initialState,
    settings: {
      ...initialState.settings,
      labs: { ...initialState.settings.labs, workflows: labs },
      workflows: { ...initialState.settings.workflows, maxConcurrentAgents: cap }
    }
  })
  const loader: WorkflowRunnerDeps['loader'] = {
    getDefinition: (id) => {
      const slug = typeof id === 'string' ? id.replace(/^personal:/, '') : ''
      return slug in SOURCES ? detail(slug as DefSlug) : null
    }
  }
  const agent = new FakeStepDriver('agent', agentScript, `start failed: ${PROMPT_SECRET}`)
  const shell = new FakeStepDriver('shell', shellScript, `start failed: ${PROMPT_SECRET}`)
  const logs: string[] = []
  const logData: Array<Record<string, string>> = []
  const persisted: string[] = []
  let ids = 0
  let clock = 1000
  const runner = new WorkflowRunner({
    store,
    loader,
    drivers: { agent, shell },
    now: () => ++clock,
    newId: () => `id-${++ids}`,
    log: (category, message, data) => {
      logs.push(`[${category}] ${message} ${JSON.stringify(data ?? {})}`)
      logData.push(data ?? {})
    },
    persist: (run) => persisted.push(run.runId)
  })
  const events: StateEvent[] = []
  store.subscribe((event) => events.push(event))
  const wf = () => store.getSnapshot().state.workflows

  function startRun(slug: DefSlug, worktreePath = `/wt/${slug}`): string {
    const result = runner.start({
      defId: `personal:${slug}`,
      worktreePath,
      inputs: { task: INPUT_SECRET }
    })
    if (!result.ok) throw new Error(`start refused: ${result.reason}`)
    return result.runId
  }

  function attemptOf(runId: string, stepId: string): string {
    const attemptIds = wf().runs[runId].steps[stepId].attemptIds
    const attemptId = attemptIds[attemptIds.length - 1]
    if (attemptId === undefined) throw new Error(`no attempt for ${runId}/${stepId}`)
    return attemptId
  }

  function stepStatus(runId: string, stepId: string): WorkflowStepStatus {
    return wf().runs[runId].steps[stepId].status
  }

  function eventsSince(fn: () => void): string[] {
    const from = events.length
    fn()
    return events.slice(from).map((event) => event.type.replace('workflows/', ''))
  }

  return {
    store,
    runner,
    agent,
    shell,
    logs,
    logData,
    persisted,
    events,
    wf,
    startRun,
    attemptOf,
    stepStatus,
    eventsSince
  }
}

type Ctx = ReturnType<typeof setup>

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const done = (summary = 'ok'): StepResult => ({ status: 'done', summary, completedBy: 'tool' })
const failed = (summary = 'nope'): StepResult => ({ status: 'failed', summary, completedBy: 'tool' })

interface Scenario {
  name: string
  act: (ctx: Ctx, runId: string) => Promise<void>
  run: { status: string; pausedReason?: string }
  steps: Record<string, WorkflowStepStatus>
  attempts: Record<string, Array<{ status: WorkflowAttemptStatus; n: number; completedBy?: string }>>
}

const scenarios: Scenario[] = [
  {
    name: 'a two-step run completes to done',
    act: async (ctx, runId) => {
      ctx.runner.complete(ctx.attemptOf(runId, 'plan'), done())
      await flush()
      ctx.runner.complete(ctx.attemptOf(runId, 'build'), done())
    },
    run: { status: 'done' },
    steps: { plan: 'done', build: 'done' },
    attempts: {
      plan: [{ status: 'done', n: 1, completedBy: 'tool' }],
      build: [{ status: 'done', n: 1, completedBy: 'tool' }]
    }
  },
  {
    name: 'a failed step pauses, retry runs attempt 2 and the run reaches done',
    act: async (ctx, runId) => {
      ctx.runner.complete(ctx.attemptOf(runId, 'plan'), failed())
      expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'step-failed' })
      expect(ctx.runner.retry(runId)).toBe(true)
      await flush()
      ctx.runner.complete(ctx.attemptOf(runId, 'plan'), done())
      await flush()
      ctx.runner.complete(ctx.attemptOf(runId, 'build'), done())
    },
    run: { status: 'done' },
    steps: { plan: 'done', build: 'done' },
    attempts: {
      plan: [
        { status: 'failed', n: 1, completedBy: 'tool' },
        { status: 'done', n: 2, completedBy: 'tool' }
      ],
      build: [{ status: 'done', n: 1 }]
    }
  },
  {
    name: 'skip marks the failed step skipped and advances',
    act: async (ctx, runId) => {
      ctx.runner.complete(ctx.attemptOf(runId, 'plan'), failed())
      expect(ctx.runner.skip(runId)).toBe(true)
    },
    run: { status: 'running' },
    steps: { plan: 'skipped', build: 'running' },
    attempts: { plan: [{ status: 'failed', n: 1 }], build: [{ status: 'running', n: 1 }] }
  },
  {
    name: 'cancelStep pauses step-failed with the step cancelled',
    act: async (ctx, runId) => {
      const execution = ctx.agent.executionFor(ctx.attemptOf(runId, 'plan'))
      expect(ctx.runner.cancelStep(runId)).toBe(true)
      expect(ctx.agent.cancelled).toEqual([execution])
    },
    run: { status: 'paused', pausedReason: 'step-failed' },
    steps: { plan: 'cancelled', build: 'pending' },
    attempts: { plan: [{ status: 'cancelled', n: 1 }], build: [] }
  },
  {
    name: 'cancelRun makes the run terminal and drops late step events',
    act: async (ctx, runId) => {
      const attemptId = ctx.attemptOf(runId, 'plan')
      const execution = ctx.agent.executionFor(attemptId)
      expect(ctx.runner.cancelRun(runId)).toBe(true)
      expect(ctx.agent.cancelled).toEqual([execution])
      const late = ctx.eventsSince(() => {
        expect(ctx.runner.complete(attemptId, done())).toBe(false)
        ctx.agent.emit({ type: 'exited', executionId: execution, code: 0 })
        ctx.agent.emit({ type: 'turnEnded', executionId: execution, lastMessage: 'late' })
        expect(ctx.runner.skip(runId)).toBe(false)
        expect(ctx.runner.retry(runId)).toBe(false)
      })
      expect(late).toEqual([])
      ctx.store.dispatch({
        type: 'workflows/stepStatusChanged',
        payload: { runId, stepId: 'build', status: 'running' }
      })
    },
    run: { status: 'cancelled' },
    steps: { plan: 'cancelled', build: 'pending' },
    attempts: { plan: [{ status: 'cancelled', n: 1 }], build: [] }
  },
  {
    name: 'markDone ends the running attempt as done by the user and advances',
    act: async (ctx, runId) => {
      const execution = ctx.agent.executionFor(ctx.attemptOf(runId, 'plan'))
      expect(ctx.runner.markDone(runId)).toBe(true)
      expect(ctx.agent.cancelled).toEqual([execution])
    },
    run: { status: 'running' },
    steps: { plan: 'done', build: 'running' },
    attempts: {
      plan: [{ status: 'done', n: 1, completedBy: 'user' }],
      build: [{ status: 'running', n: 1 }]
    }
  },
  {
    name: 'markDone on a paused failed step marks it done without re-ending the attempt',
    act: async (ctx, runId) => {
      ctx.runner.complete(ctx.attemptOf(runId, 'plan'), failed())
      expect(ctx.runner.markDone(runId)).toBe(true)
    },
    run: { status: 'running' },
    steps: { plan: 'done', build: 'running' },
    attempts: {
      plan: [{ status: 'failed', n: 1, completedBy: 'tool' }],
      build: [{ status: 'running', n: 1 }]
    }
  }
]

describe('WorkflowRunner scenarios', () => {
  it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))(
    '%s',
    async (_name, scenario) => {
      const ctx = setup()
      const runId = ctx.startRun('two-agent')
      await flush()
      await scenario.act(ctx, runId)
      await flush()
      const run = ctx.wf().runs[runId]
      expect(run.status).toBe(scenario.run.status)
      if (scenario.run.pausedReason) expect(run.pausedReason).toBe(scenario.run.pausedReason)
      else expect(run).not.toHaveProperty('pausedReason')
      for (const [stepId, status] of Object.entries(scenario.steps)) {
        expect(run.steps[stepId].status).toBe(status)
      }
      for (const [stepId, expected] of Object.entries(scenario.attempts)) {
        const actual = run.steps[stepId].attemptIds.map((id) => ctx.wf().attempts[id])
        expect(actual).toHaveLength(expected.length)
        expected.forEach((want, i) => expect(actual[i]).toMatchObject(want))
      }
    }
  )
})

describe('WorkflowRunner.start', () => {
  it('snapshots the definition hash and starts the first step with the inputs', async () => {
    const ctx = setup()
    const runId = ctx.startRun('two-agent', '/wt/a')
    await flush()
    expect(ctx.wf().runs[runId]).toMatchObject({
      defId: 'personal:two-agent',
      defHash: 'hash-two-agent',
      worktreePath: '/wt/a',
      status: 'running',
      steps: { plan: { status: 'running' }, build: { status: 'pending', attemptIds: [] } }
    })
    expect(ctx.agent.started).toHaveLength(1)
    expect(ctx.agent.started[0]).toMatchObject({
      runId,
      stepId: 'plan',
      n: 1,
      worktreePath: '/wt/a',
      inputs: { task: INPUT_SECRET },
      step: { id: 'plan', kind: 'agent' }
    })
    expect(ctx.persisted).toContain(runId)
  })

  it.each([
    ['labs-off', { labs: false }, 'one-agent'],
    ['unknown-definition', {}, 'missing'],
    ['invalid-definition', {}, 'broken']
  ] as const)('refuses with %s and dispatches nothing', (reason, options, slug) => {
    const ctx = setup(options)
    const types = ctx.eventsSince(() => {
      expect(
        ctx.runner.start({ defId: `personal:${slug}`, worktreePath: '/wt/a', inputs: {} })
      ).toEqual({ ok: false, reason })
    })
    expect(types).toEqual([])
    expect(ctx.agent.started).toEqual([])
  })

  it('refuses a worktree that already has a non-terminal run', () => {
    const ctx = setup()
    ctx.startRun('one-agent', '/wt/a')
    const types = ctx.eventsSince(() => {
      expect(
        ctx.runner.start({ defId: 'personal:one-shell', worktreePath: '/wt/a', inputs: {} })
      ).toEqual({ ok: false, reason: 'worktree-busy' })
    })
    expect(types).toEqual([])
  })

  it('refuses a worktree with a paused run and accepts it once that run is terminal', async () => {
    const ctx = setup()
    const runId = ctx.startRun('one-agent', '/wt/a')
    ctx.runner.complete(ctx.attemptOf(runId, 'plan'), failed())
    expect(ctx.runner.start({ defId: 'personal:one-agent', worktreePath: '/wt/a', inputs: {} })).toEqual({
      ok: false,
      reason: 'worktree-busy'
    })
    ctx.runner.cancelRun(runId)
    expect(
      ctx.runner.start({ defId: 'personal:one-agent', worktreePath: '/wt/a', inputs: {} }).ok
    ).toBe(true)
  })
})

describe('WorkflowRunner dispatch order and dedup', () => {
  it('dispatches attemptEnded, stepStatusChanged, runFinished at the end of a run', () => {
    const ctx = setup()
    const runId = ctx.startRun('one-agent')
    const types = ctx.eventsSince(() => ctx.runner.complete(ctx.attemptOf(runId, 'plan'), done()))
    expect(types).toEqual(['attemptEnded', 'stepStatusChanged', 'runFinished'])
  })

  it('dispatches attemptEnded, stepStatusChanged, runCancelled on cancelRun', () => {
    const ctx = setup()
    const runId = ctx.startRun('one-agent')
    expect(ctx.eventsSince(() => ctx.runner.cancelRun(runId))).toEqual([
      'attemptEnded',
      'stepStatusChanged',
      'runCancelled'
    ])
  })

  it('cancelRun on a queued step cancels the step before the run', () => {
    const ctx = setup({ cap: 1 })
    ctx.startRun('one-agent', '/wt/a')
    const queuedRun = ctx.startRun('one-agent', '/wt/b')
    expect(ctx.stepStatus(queuedRun, 'plan')).toBe('queued')
    expect(ctx.eventsSince(() => ctx.runner.cancelRun(queuedRun))).toEqual([
      'stepStatusChanged',
      'runCancelled'
    ])
    expect(ctx.stepStatus(queuedRun, 'plan')).toBe('cancelled')
  })

  it.each([
    ['retry', (ctx: Ctx, runId: string) => ctx.runner.retry(runId)],
    ['skip', (ctx: Ctx, runId: string) => ctx.runner.skip(runId)],
    ['markDone', (ctx: Ctx, runId: string) => ctx.runner.markDone(runId)]
  ] as const)('%s from a paused run dispatches runResumed first', (_name, action) => {
    const ctx = setup()
    const runId = ctx.startRun('two-agent')
    ctx.runner.complete(ctx.attemptOf(runId, 'plan'), failed())
    const types = ctx.eventsSince(() => expect(action(ctx, runId)).toBe(true))
    expect(types[0]).toBe('runResumed')
    expect(types.length).toBeGreaterThan(1)
  })

  it('ignores a second completion of the same attempt without dispatching', () => {
    const ctx = setup()
    const runId = ctx.startRun('two-agent')
    const attemptId = ctx.attemptOf(runId, 'plan')
    ctx.runner.complete(attemptId, failed())
    expect(ctx.eventsSince(() => expect(ctx.runner.complete(attemptId, done())).toBe(false))).toEqual([])
  })

  it('needs-input keeps the attempt running, pauses once, and a later done resumes', async () => {
    const ctx = setup()
    const runId = ctx.startRun('two-agent')
    await flush()
    const attemptId = ctx.attemptOf(runId, 'plan')
    const needsInput: StepResult = { status: 'needs-input', summary: '', completedBy: 'fallback' }
    expect(ctx.eventsSince(() => ctx.runner.complete(attemptId, needsInput))).toEqual(['runPaused'])
    expect(ctx.wf().runs[runId].pausedReason).toBe('needs-input')
    expect(ctx.wf().attempts[attemptId].status).toBe('running')
    expect(ctx.eventsSince(() => ctx.runner.complete(attemptId, needsInput))).toEqual([])
    expect(ctx.eventsSince(() => ctx.runner.complete(attemptId, done()))).toEqual([
      'runResumed',
      'attemptEnded',
      'stepStatusChanged',
      'stepStarted',
      'attemptStarted'
    ])
  })

  it('retry from needs-input cancels the live attempt and starts attempt 2', async () => {
    const ctx = setup()
    const runId = ctx.startRun('two-agent')
    await flush()
    const first = ctx.attemptOf(runId, 'plan')
    const execution = ctx.agent.executionFor(first)
    ctx.runner.complete(first, { status: 'needs-input', summary: '', completedBy: 'fallback' })
    const types = ctx.eventsSince(() => expect(ctx.runner.retry(runId)).toBe(true))
    expect(types).toEqual(['runResumed', 'attemptEnded', 'attemptStarted'])
    expect(ctx.agent.cancelled).toEqual([execution])
    expect(ctx.wf().attempts[first].status).toBe('cancelled')
    const second = ctx.attemptOf(runId, 'plan')
    expect(second).not.toBe(first)
    expect(ctx.wf().attempts[second]).toMatchObject({ status: 'running', n: 2 })
  })

  it('drops driver events for execution ids it does not map', async () => {
    const ctx = setup()
    ctx.startRun('one-agent')
    await flush()
    expect(
      ctx.eventsSince(() => {
        ctx.agent.emit({ type: 'exited', executionId: 'someone-else', code: 1 })
        ctx.agent.emit({ type: 'turnEnded', executionId: 'someone-else' })
      })
    ).toEqual([])
  })

  it('cancels an execution whose start resolves after the run was cancelled', async () => {
    const ctx = setup({ agentScript: () => 'defer' })
    const runId = ctx.startRun('one-agent')
    await flush()
    const attemptId = ctx.attemptOf(runId, 'plan')
    ctx.runner.cancelRun(runId)
    expect(ctx.agent.cancelled).toEqual([])
    ctx.agent.resolveDeferred(attemptId)
    await flush()
    const execution = ctx.agent.executionFor(attemptId)
    expect(ctx.agent.cancelled).toEqual([execution])
    expect(
      ctx.eventsSince(() => ctx.agent.emit({ type: 'exited', executionId: execution, code: 0 }))
    ).toEqual([])
  })
})

describe('WorkflowRunner driver exits', () => {
  it.each([
    [0, 'done', 'done'],
    [1, 'failed', 'paused']
  ] as const)('shell exit %i ends the attempt %s', async (code, attemptStatus, runStatus) => {
    const ctx = setup()
    const runId = ctx.startRun('one-shell')
    await flush()
    const attemptId = ctx.attemptOf(runId, 'test')
    ctx.shell.emit({ type: 'exited', executionId: ctx.shell.executionFor(attemptId), code })
    expect(ctx.wf().attempts[attemptId]).toMatchObject({ status: attemptStatus, completedBy: 'exit' })
    expect(ctx.wf().runs[runId].status).toBe(runStatus)
  })

  it('an agent exit without completion fails the step', async () => {
    const ctx = setup()
    const runId = ctx.startRun('one-agent')
    await flush()
    const attemptId = ctx.attemptOf(runId, 'plan')
    ctx.agent.emit({ type: 'exited', executionId: ctx.agent.executionFor(attemptId), code: 0 })
    expect(ctx.wf().attempts[attemptId].status).toBe('failed')
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'step-failed' })
  })

  it.each(['throw', 'reject'] as const)(
    'a driver start that %ss fails the attempt and pauses step-failed',
    async (behavior) => {
      const ctx = setup({ agentScript: () => behavior })
      const runId = ctx.startRun('one-agent')
      await flush()
      const attemptId = ctx.attemptOf(runId, 'plan')
      expect(ctx.wf().attempts[attemptId].status).toBe('failed')
      expect(ctx.stepStatus(runId, 'plan')).toBe('failed')
      expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'step-failed' })
    }
  )
})

describe('WorkflowRunner concurrency cap', () => {
  it('starts agent steps of two runs one at a time in FIFO order', async () => {
    const ctx = setup({ cap: 1 })
    const runA = ctx.startRun('two-agent', '/wt/a')
    const runB = ctx.startRun('one-agent', '/wt/b')
    await flush()
    expect(ctx.stepStatus(runA, 'plan')).toBe('running')
    expect(ctx.stepStatus(runB, 'plan')).toBe('queued')
    expect(ctx.wf().runs[runB].steps.plan.attemptIds).toEqual([])

    ctx.runner.complete(ctx.attemptOf(runA, 'plan'), done())
    await flush()
    expect(ctx.stepStatus(runB, 'plan')).toBe('running')
    expect(ctx.stepStatus(runA, 'build')).toBe('queued')
    expect(ctx.agent.started.map((a) => `${a.runId}/${a.stepId}`)).toEqual([
      `${runA}/plan`,
      `${runB}/plan`
    ])

    ctx.runner.complete(ctx.attemptOf(runB, 'plan'), done())
    await flush()
    expect(ctx.stepStatus(runA, 'build')).toBe('running')
    expect(ctx.wf().runs[runB].status).toBe('done')
  })

  it('starts a shell step while an agent holds the only slot', async () => {
    const ctx = setup({ cap: 1 })
    const runA = ctx.startRun('one-agent', '/wt/a')
    const runB = ctx.startRun('one-shell', '/wt/b')
    await flush()
    expect(ctx.stepStatus(runA, 'plan')).toBe('running')
    expect(ctx.stepStatus(runB, 'test')).toBe('running')
    expect(ctx.shell.started).toHaveLength(1)
  })

  it('reads the cap from settings at each scheduling point', async () => {
    const ctx = setup({ cap: 1 })
    ctx.startRun('one-agent', '/wt/a')
    const runB = ctx.startRun('one-agent', '/wt/b')
    expect(ctx.stepStatus(runB, 'plan')).toBe('queued')
    ctx.store.dispatch({ type: 'settings/workflowSettingsChanged', payload: { maxConcurrentAgents: 2 } })
    const runC = ctx.startRun('one-agent', '/wt/c')
    expect(ctx.stepStatus(runB, 'plan')).toBe('running')
    expect(ctx.stepStatus(runC, 'plan')).toBe('queued')
  })

  const releases: Array<[string, (ctx: Ctx, runId: string) => void, SetupOptions?]> = [
    ['complete done', (ctx, runId) => ctx.runner.complete(ctx.attemptOf(runId, 'plan'), done())],
    ['complete failed', (ctx, runId) => ctx.runner.complete(ctx.attemptOf(runId, 'plan'), failed())],
    ['cancelStep', (ctx, runId) => ctx.runner.cancelStep(runId)],
    ['cancelRun', (ctx, runId) => ctx.runner.cancelRun(runId)],
    ['skip', (ctx, runId) => ctx.runner.skip(runId)],
    ['markDone', (ctx, runId) => ctx.runner.markDone(runId)],
    [
      'cancelRun from needs-input',
      (ctx, runId) => {
        ctx.runner.complete(ctx.attemptOf(runId, 'plan'), {
          status: 'needs-input',
          summary: '',
          completedBy: 'fallback'
        })
        ctx.runner.cancelRun(runId)
      }
    ],
    [
      'agent exit',
      (ctx, runId) =>
        ctx.agent.emit({
          type: 'exited',
          executionId: ctx.agent.executionFor(ctx.attemptOf(runId, 'plan')),
          code: 1
        })
    ],
    ['driver start rejecting', () => {}, { agentScript: (a) => (a.worktreePath === '/wt/a' ? 'reject' : 'ok') }],
    ['driver start throwing', () => {}, { agentScript: (a) => (a.worktreePath === '/wt/a' ? 'throw' : 'ok') }]
  ]

  it.each(releases)('%s releases the agent slot to the queued run', async (_name, act, options) => {
    const ctx = setup({ cap: 1, ...options })
    const runA = ctx.startRun('one-agent', '/wt/a')
    const runB = ctx.startRun('one-agent', '/wt/b')
    await flush()
    act(ctx, runA)
    await flush()
    expect(ctx.stepStatus(runB, 'plan')).toBe('running')
    expect(ctx.agent.started.map((a) => a.runId)).toEqual([runA, runB])
  })
})

describe('WorkflowRunner logging', () => {
  it('logs every transition with ids only and never prompt, input or summary text', async () => {
    const ctx = setup({
      cap: 1,
      agentScript: (a) => (a.stepId === 'build' && a.n === 1 ? 'reject' : 'ok')
    })
    const runA = ctx.startRun('two-agent', '/wt/a')
    const runQ = ctx.startRun('one-agent', '/wt/q')
    ctx.runner.cancelRun(runQ)
    await flush()
    ctx.runner.complete(ctx.attemptOf(runA, 'plan'), failed(SUMMARY_SECRET))
    ctx.runner.retry(runA)
    await flush()
    ctx.runner.complete(ctx.attemptOf(runA, 'plan'), {
      status: 'needs-input',
      summary: SUMMARY_SECRET,
      completedBy: 'fallback'
    })
    ctx.runner.complete(ctx.attemptOf(runA, 'plan'), {
      ...done(SUMMARY_SECRET),
      data: { note: SUMMARY_SECRET }
    })
    await flush()
    ctx.runner.retry(runA)
    await flush()
    ctx.runner.markDone(runA)
    const runB = ctx.startRun('one-shell', '/wt/b')
    await flush()
    ctx.runner.cancelStep(runB)
    ctx.runner.skip(runB)
    const runC = ctx.startRun('one-agent', '/wt/c')
    ctx.runner.cancelRun(runC)
    ctx.runner.start({ defId: 'personal:broken', worktreePath: '/wt/d', inputs: {} })
    await flush()

    const expectedLines = [
      'run started',
      'step running',
      'attempt started',
      'completion received failed',
      'attempt ended failed',
      'step failed',
      'run paused step-failed',
      'run resumed',
      'completion received needs-input',
      'run paused needs-input',
      'completion received done',
      'attempt ended done',
      'step done',
      'attempt start failed',
      'step marked done',
      'run finished done',
      'attempt ended cancelled',
      'step cancelled',
      'step skipped',
      'run cancelled',
      'run refused invalid-definition'
    ]
    for (const line of expectedLines) {
      expect(ctx.logs.some((l) => l.includes(`[workflow] ${line} `))).toBe(true)
    }
    for (const line of ctx.logs) {
      expect(line).toMatch(/^\[workflow\] /)
      for (const secret of [PROMPT_SECRET, SUMMARY_SECRET, INPUT_SECRET, '/wt/']) {
        expect(line).not.toContain(secret)
      }
    }
    for (const data of ctx.logData) {
      for (const key of Object.keys(data)) expect(['runId', 'stepId', 'attemptId']).toContain(key)
    }
    expect(ctx.logs).toContain(`[workflow] step queued {"runId":"${runQ}","stepId":"plan"}`)
    const attemptLine = ctx.logs.find((l) => l.includes('attempt started'))
    expect(attemptLine).toContain(`"runId":"${runA}"`)
    expect(attemptLine).toContain('"stepId":"plan"')
    expect(attemptLine).toMatch(/"attemptId":"id-\d+"/)
  })
})

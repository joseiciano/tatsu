import { describe, it, expect, vi } from 'vitest'
import { Store } from '../store'
import {
  WorkflowRunner,
  createClaudeStepDriver,
  createShellStepDriver,
  type ClaudeStopEvent,
  type RunArtifacts,
  type StepAttempt,
  type StepDriver,
  type StepResult,
  type WorkflowRunnerDeps,
  type WorkflowRunRecord
} from '.'
import { currentStepId, FakeStepDriver, worktreeFixture, type FakeStartBehavior } from './fake-step-driver'
import { initialState, type StateEvent } from '../../shared/state'
import type { PtyStatus, TerminalTab } from '../../shared/state/terminals'
import type { StepSpawnExtras } from '../agent-spawn'
import type { TrustStatus } from '../folder-trust'
import type {
  WorkflowAttemptStatus,
  WorkflowDefinitionDetail,
  WorkflowRun,
  WorkflowStepStatus
} from '../../shared/state/workflows'
import { STEP_SUMMARY_MAX_CHARS, renderTemplate, validateWorkflowDefinition } from '../../shared/workflow-def'

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
  'shell-big': `name: shell-big
inputs:
  a: { type: text }
  b: { type: text }
  c: { type: text }
  d: { type: text }
  e: { type: text }
  f: { type: text }
  g: { type: text }
  h: { type: text }
  i: { type: text }
steps:
  - id: test
    kind: shell
    run: "printf '%s' {{inputs.a}} {{inputs.b}} {{inputs.c}} {{inputs.d}} {{inputs.e}} {{inputs.f}} {{inputs.g}} {{inputs.h}} {{inputs.i}}"
`,
  'shell-input': `name: shell-input
inputs:
  task: { type: text }
steps:
  - id: test
    kind: shell
    run: "printf '%s' {{inputs.task}}"
`,
  handoff: `name: handoff
steps:
  - id: one
    agent: claude
    prompt: "go"
  - id: two
    agent: claude
    prompt: "context {{run.contextPath}} prior {{steps.one.summary}} status {{steps.one.status}}"
`,
  reviewed: `name: reviewed
steps:
  - id: review
    agent: claude
    prompt: "review"
    output:
      verdict: { enum: [pass, fail] }
      required: [verdict]
`,
  'review-then-act': `name: review-then-act
steps:
  - id: review
    agent: claude
    prompt: "review"
    output:
      verdict: { enum: [pass, fail] }
      notes: { type: array, items: { type: string } }
      required: [verdict]
  - id: act
    agent: claude
    prompt: "act on {{steps.review.data.verdict}}"
`,
  'shell-then-agent': `name: shell-then-agent
steps:
  - id: test
    kind: shell
    run: "true"
  - id: fix
    agent: claude
    prompt: "fix"
`,
  'full-agent': `name: full-agent
steps:
  - id: test
    kind: shell
    run: "true"
  - id: fix
    agent: claude
    permissions: full
    prompt: "fix"
`,
  'full-default': `name: full-default
defaults:
  permissions: full
steps:
  - id: fix
    agent: claude
    prompt: "fix"
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
  artifacts?: RunArtifacts
  runs?: Record<string, WorkflowRun>
  shellDriver?: StepDriver
  agentDriver?: (store: Store) => StepDriver
  worktrees?: string[]
}

const WORKTREES = [
  ...Object.keys(SOURCES).map((slug) => `/wt/${slug}`),
  ...['a', 'b', 'c', 'd', 'q', 'x', 'big', 'blocker', 'new'].map((name) => `/wt/${name}`)
]


function setup({
  labs = true,
  cap = 4,
  agentScript,
  shellScript,
  artifacts,
  runs = {},
  shellDriver,
  agentDriver,
  worktrees = WORKTREES
}: SetupOptions = {}) {
  const store = new Store({
    ...initialState,
    hooks: { ...initialState.hooks, consent: 'accepted' },
    worktrees: { ...initialState.worktrees, list: worktrees.map(worktreeFixture) },
    workflows: { ...initialState.workflows, runs },
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
  const records: WorkflowRunRecord[] = []
  let ids = 0
  let clock = 1000
  const runner = new WorkflowRunner({
    store,
    loader,
    drivers: { agent: agentDriver?.(store) ?? agent, shell: shellDriver ?? shell },
    now: () => ++clock,
    newId: () => `id-${++ids}`,
    log: (category, message, data) => {
      logs.push(`[${category}] ${message} ${JSON.stringify(data ?? {})}`)
      logData.push(data ?? {})
    },
    persist: (run) => {
      persisted.push(run.runId)
      records.push(structuredClone(run))
    },
    artifacts
  })
  runner.reconcile([])
  const events: StateEvent[] = []
  store.subscribe((event) => events.push(event))
  const wf = () => store.getSnapshot().state.workflows

  function startRun(slug: DefSlug, worktreePath = `/wt/${slug}`): string {
    const declared = detail(slug).definition?.inputs ?? {}
    const result = runner.start({
      defId: `personal:${slug}`,
      worktreePath,
      inputs: Object.hasOwn(declared, 'task') ? { task: INPUT_SECRET } : {}
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
    records,
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

const markDoneFor = (ctx: Ctx, runId: string, request = { summary: '', fields: {} }) =>
  ctx.runner.markDone(runId, currentStepId(ctx.runner, runId), request)

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
      expect(ctx.runner.retryStep(runId, currentStepId(ctx.runner, runId))).toEqual({ ok: true })
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
      expect(ctx.runner.skipStep(runId, currentStepId(ctx.runner, runId))).toEqual({ ok: true })
    },
    run: { status: 'running' },
    steps: { plan: 'skipped', build: 'running' },
    attempts: { plan: [{ status: 'failed', n: 1 }], build: [{ status: 'running', n: 1 }] }
  },
  {
    name: 'cancelStep pauses step-failed with the step cancelled',
    act: async (ctx, runId) => {
      const execution = ctx.agent.executionFor(ctx.attemptOf(runId, 'plan'))
      expect(ctx.runner.cancelStep(runId, currentStepId(ctx.runner, runId))).toEqual({ ok: true })
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
      expect(ctx.runner.cancelRun(runId)).toEqual({ ok: true })
      expect(ctx.agent.cancelled).toEqual([execution])
      const late = ctx.eventsSince(() => {
        expect(ctx.runner.complete(attemptId, done())).toBe(false)
        ctx.agent.emit({ type: 'exited', executionId: execution, code: 0 })
        ctx.agent.emit({ type: 'turnEnded', executionId: execution, lastMessage: 'late' })
        expect(ctx.runner.skipStep(runId, currentStepId(ctx.runner, runId))).toMatchObject({ ok: false })
        expect(ctx.runner.retryStep(runId, currentStepId(ctx.runner, runId))).toMatchObject({ ok: false })
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
      expect(markDoneFor(ctx, runId)).toEqual({ ok: true })
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
    name: 'markDone on a paused failed step keeps the failed attempt and records a user attempt',
    act: async (ctx, runId) => {
      ctx.runner.complete(ctx.attemptOf(runId, 'plan'), failed())
      expect(markDoneFor(ctx, runId)).toEqual({ ok: true })
    },
    run: { status: 'running' },
    steps: { plan: 'done', build: 'running' },
    attempts: {
      plan: [
        { status: 'failed', n: 1, completedBy: 'tool' },
        { status: 'done', n: 2, completedBy: 'user' }
      ],
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
    ['retry', (ctx: Ctx, runId: string) => ctx.runner.retryStep(runId, currentStepId(ctx.runner, runId))],
    ['skip', (ctx: Ctx, runId: string) => ctx.runner.skipStep(runId, currentStepId(ctx.runner, runId))],
    ['markDone', (ctx: Ctx, runId: string) => markDoneFor(ctx, runId)]
  ] as const)('%s from a paused run dispatches runResumed first', (_name, action) => {
    const ctx = setup()
    const runId = ctx.startRun('two-agent')
    ctx.runner.complete(ctx.attemptOf(runId, 'plan'), failed())
    const types = ctx.eventsSince(() => expect(action(ctx, runId)).toEqual({ ok: true }))
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
    const types = ctx.eventsSince(() => expect(ctx.runner.retryStep(runId, currentStepId(ctx.runner, runId))).toEqual({ ok: true }))
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
      expect(ctx.wf().attempts[attemptId].summaryPreview).toBe('')
      expect(ctx.records.at(-1)?.attempts[0].result).toBeUndefined()
    }
  )
})

function exitingPty(code: number, history: string, signal?: number) {
  const tabs: Array<{ tab: TerminalTab; command?: string; env?: Record<string, string> }> = []
  const listeners = new Set<(id: string, exitCode: number, signal?: number) => void>()
  const alive = new Set<string>()
  let ids = 0
  const driver = createShellStepDriver({
    addTab: (_worktreePath, tab, spawn) => {
      tabs.push({ tab, command: spawn.command, env: spawn.env })
      alive.add(tab.id)
      setTimeout(() => {
        alive.delete(tab.id)
        for (const listener of [...listeners]) listener(tab.id, code, signal)
      }, 0)
    },
    hasTerminal: (id) => alive.has(id),
    getHistory: () => history,
    onExit: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    kill: () => {},
    newTabId: () => `shell-tab-${++ids}`
  })
  return { driver, tabs }
}

describe('WorkflowRunner with the shell driver', () => {
  it.each([
    [0, 'done', 'done', undefined],
    [1, 'failed', 'paused', 'step-failed']
  ] as const)('exit %i ends the attempt %s with the PTY summary', async (code, attemptStatus, runStatus, reason) => {
    const history = Array.from({ length: 60 }, (_, i) => `\u001b[2Kline ${i}\r\n`).join('')
    const pty = exitingPty(code, history)
    const ctx = setup({ shellDriver: pty.driver })
    const runId = ctx.startRun('shell-input')
    await flush()
    await flush()
    const attemptId = ctx.attemptOf(runId, 'test')
    expect(pty.tabs).toHaveLength(1)
    expect(pty.tabs[0].tab).toMatchObject({
      label: '⚙ test · shell',
      workflow: { runId, stepId: 'test', attemptId }
    })
    expect(pty.tabs[0].command).toBe(`printf '%s' "\${HARNESS_WF_0}"`)
    expect(pty.tabs[0].env).toEqual({ HARNESS_WF_0: INPUT_SECRET })
    const expected = Array.from({ length: 50 }, (_, i) => `line ${i + 10}`).join('\n')
    const result = ctx.records.at(-1)?.attempts[0].result
    expect(result).toEqual({
      status: attemptStatus,
      summary: expected,
      completedBy: 'exit',
      exitCode: code
    })
    expect(ctx.wf().attempts[attemptId].status).toBe(attemptStatus)
    expect(ctx.wf().runs[runId]).toMatchObject({ status: runStatus, ...(reason ? { pausedReason: reason } : {}) })
    expect(ctx.logs.join('\n')).not.toContain(INPUT_SECRET)
  })

  it('fails the step when the PTY dies from a signal', async () => {
    const pty = exitingPty(0, 'partial\r\n', 9)
    const ctx = setup({ shellDriver: pty.driver })
    const runId = ctx.startRun('shell-input')
    await flush()
    await flush()
    expect(ctx.records.at(-1)?.attempts[0].result).toEqual({ status: 'failed', summary: 'partial', completedBy: 'exit' })
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'step-failed' })
  })

  it('fails an oversize value before opening a tab, with a value-free summary', async () => {
    const pty = exitingPty(0, '')
    const ctx = setup({ shellDriver: pty.driver })
    const big = `${INPUT_SECRET} `.repeat(2800)
    const inputs = Object.fromEntries([...'abcdefghi'].map((name) => [name, big]))
    const started = ctx.runner.start({ defId: 'personal:shell-big', worktreePath: '/wt/big', inputs })
    if (!started.ok) throw new Error(started.reason)
    await flush()
    const attemptId = ctx.attemptOf(started.runId, 'test')
    expect(pty.tabs).toEqual([])
    expect(ctx.wf().attempts[attemptId]).toMatchObject({ status: 'failed', summaryPreview: 'interpolated value too large' })
    expect(ctx.records.at(-1)?.attempts[0].result).toEqual({
      status: 'failed',
      summary: 'interpolated value too large',
      completedBy: 'exit'
    })
    expect(ctx.wf().runs[started.runId]).toMatchObject({ status: 'paused', pausedReason: 'step-failed' })
  })
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
    ['cancelStep', (ctx, runId) => ctx.runner.cancelStep(runId, currentStepId(ctx.runner, runId))],
    ['cancelRun', (ctx, runId) => ctx.runner.cancelRun(runId)],
    ['skip', (ctx, runId) => ctx.runner.skipStep(runId, currentStepId(ctx.runner, runId))],
    ['markDone', (ctx, runId) => markDoneFor(ctx, runId)],
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
    ctx.runner.retryStep(runA, currentStepId(ctx.runner, runA))
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
    ctx.runner.retryStep(runA, currentStepId(ctx.runner, runA))
    await flush()
    markDoneFor(ctx, runA)
    const runB = ctx.startRun('one-shell', '/wt/b')
    await flush()
    ctx.runner.cancelStep(runB, currentStepId(ctx.runner, runB))
    ctx.runner.skipStep(runB, currentStepId(ctx.runner, runB))
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

describe('WorkflowRunner run records', () => {
  const lastRecord = (ctx: Ctx, runId: string): WorkflowRunRecord => {
    const record = ctx.records.filter((r) => r.runId === runId).at(-1)
    if (!record) throw new Error(`no record for ${runId}`)
    return record
  }

  it('persists a versioned record with the definition, inputs, full results and metrics', async () => {
    const ctx = setup()
    const runId = ctx.startRun('two-agent', '/wt/a')
    await flush()
    const plan = ctx.attemptOf(runId, 'plan')
    ctx.runner.complete(plan, failed('first try'))
    ctx.runner.retryStep(runId, currentStepId(ctx.runner, runId))
    await flush()
    const planRetry = ctx.attemptOf(runId, 'plan')
    ctx.runner.complete(planRetry, { ...done('plan ok'), data: { files: 3 }, costUsd: 0.5 })
    await flush()
    ctx.runner.complete(ctx.attemptOf(runId, 'build'), done('build ok'))

    const record = lastRecord(ctx, runId)
    expect(record).toMatchObject({
      version: 1,
      runId,
      defId: 'personal:two-agent',
      defHash: 'hash-two-agent',
      inputs: { task: INPUT_SECRET },
      worktreePath: '/wt/a',
      contextPath: `/wt/a/.harness/runs/${runId}/context.md`,
      status: 'done'
    })
    expect(record.definition.steps.map((step) => step.id)).toEqual(['plan', 'build'])
    expect(record.steps).toEqual({ plan: 'done', build: 'done' })
    expect(record.finishedAt).toBeGreaterThan(record.startedAt)
    expect(record.attempts.map((a) => [a.stepId, a.n, a.status])).toEqual([
      ['plan', 1, 'failed'],
      ['plan', 2, 'done'],
      ['build', 1, 'done']
    ])
    const [first, second, build] = record.attempts
    expect(first.result).toEqual(failed('first try'))
    expect(first.metrics.pauses).toEqual([{ reason: 'step-failed', at: expect.any(Number) }])
    expect(second.result).toEqual({ ...done('plan ok'), data: { files: 3 }, costUsd: 0.5 })
    expect(second.metrics).toEqual({
      completedBy: 'tool',
      continuations: 0,
      pauses: [],
      wallMs: (second.endedAt ?? 0) - second.startedAt,
      costUsd: 0.5
    })
    expect(build.metrics.costUsd).toBeUndefined()
    expect(record.timeToFirstDoneMs).toBe((second.endedAt ?? 0) - record.startedAt)
  })

  it('persists the current state after every transition', async () => {
    const ctx = setup()
    const runId = ctx.startRun('one-agent', '/wt/a')
    await flush()
    const early = lastRecord(ctx, runId)
    ctx.runner.complete(ctx.attemptOf(runId, 'plan'), done())
    expect(early.attempts[0].status).toBe('running')
    expect(lastRecord(ctx, runId).attempts[0].status).toBe('done')
  })

  it('does not mutate the result object the caller passed to complete', async () => {
    const ctx = setup()
    const runId = ctx.startRun('one-agent', '/wt/a')
    await flush()
    const result = Object.freeze(done('frozen'))
    expect(ctx.runner.complete(ctx.attemptOf(runId, 'plan'), result)).toBe(true)
    expect(lastRecord(ctx, runId).attempts[0].result).toEqual(result)
  })

  it('records a needs-input pause on the live attempt', async () => {
    const ctx = setup()
    const runId = ctx.startRun('one-agent', '/wt/a')
    await flush()
    ctx.runner.complete(ctx.attemptOf(runId, 'plan'), { status: 'needs-input', summary: '?', completedBy: 'fallback' })
    expect(lastRecord(ctx, runId).attempts[0]).toMatchObject({
      status: 'running',
      metrics: { pauses: [{ reason: 'needs-input' }] }
    })
  })

  it('does not attribute a pause to an earlier step attempt when a queued step is cancelled', async () => {
    const ctx = setup({ cap: 1 })
    const runId = ctx.startRun('two-agent', '/wt/a')
    const blocker = ctx.startRun('one-agent', '/wt/blocker')
    await flush()
    ctx.runner.complete(ctx.attemptOf(runId, 'plan'), done())
    expect(ctx.stepStatus(blocker, 'plan')).toBe('running')
    expect(ctx.stepStatus(runId, 'build')).toBe('queued')
    expect(ctx.runner.cancelStep(runId, currentStepId(ctx.runner, runId))).toEqual({ ok: true })

    const record = lastRecord(ctx, runId)
    expect(record.steps).toEqual({ plan: 'done', build: 'cancelled' })
    expect(record.pausedReason).toBe('step-failed')
    expect(record.attempts.map((a) => [a.stepId, a.metrics.pauses])).toEqual([['plan', []]])
  })

  it('renders a later step prompt from the full summary of an earlier step, not the preview', async () => {
    const ctx = setup()
    const runId = ctx.startRun('handoff', '/wt/a')
    await flush()
    const summary = `${'x'.repeat(5 * 1024 - 4)}-END`
    ctx.runner.complete(ctx.attemptOf(runId, 'one'), done(summary))
    await flush()

    expect(ctx.wf().attempts[ctx.attemptOf(runId, 'one')].summaryPreview).toHaveLength(200)
    const two = ctx.agent.started[1]
    expect(two.stepId).toBe('two')
    expect(two.scope).toEqual({
      inputs: {},
      steps: { one: { status: 'done', summary } },
      run: { id: runId, worktree: '/wt/a', contextPath: `/wt/a/.harness/runs/${runId}/context.md` }
    })
    if (two.step.kind !== 'agent') throw new Error('expected an agent step')
    const rendered = renderTemplate(two.step.prompt, two.scope)
    expect(rendered.missing).toEqual([])
    expect(rendered.text).toBe(
      `context /wt/a/.harness/runs/${runId}/context.md prior ${summary} status done`
    )
  })
})

describe('WorkflowRunner recent-run eviction', () => {
  function finished(count: number): Record<string, WorkflowRun> {
    const runs: Record<string, WorkflowRun> = {}
    for (let i = 0; i < count; i++) {
      runs[`old-${i}`] = {
        defId: 'personal:one-agent',
        defHash: 'h',
        worktreePath: `/wt/old-${i}`,
        status: 'done',
        startedAt: 10 + i,
        finishedAt: 100 + i,
        steps: {}
      }
    }
    return runs
  }

  it.each([
    ['finishing', (ctx: Ctx, runId: string) => ctx.runner.complete(ctx.attemptOf(runId, 'plan'), done())],
    ['cancelling', (ctx: Ctx, runId: string) => ctx.runner.cancelRun(runId)]
  ])('%s a 51st run evicts the oldest finished run in one event', async (_name, end) => {
    const ctx = setup({ runs: finished(50) })
    const runId = ctx.startRun('one-agent', '/wt/new')
    await flush()
    const types = ctx.eventsSince(() => end(ctx, runId))
    expect(types.slice(-1)).toEqual(['runsEvicted'])
    expect(ctx.events.at(-1)).toEqual({ type: 'workflows/runsEvicted', payload: { runIds: ['old-0'] } })
    expect(Object.keys(ctx.wf().runs)).toHaveLength(50)
    expect(ctx.wf().runs['old-0']).toBeUndefined()
    expect(ctx.wf().runs[runId]).toBeDefined()
  })

  it('does not evict while 50 or fewer runs are finished', async () => {
    const ctx = setup({ runs: finished(49) })
    const runId = ctx.startRun('one-agent', '/wt/new')
    await flush()
    const types = ctx.eventsSince(() => ctx.runner.complete(ctx.attemptOf(runId, 'plan'), done()))
    expect(types).not.toContain('runsEvicted')
    expect(Object.keys(ctx.wf().runs)).toHaveLength(50)
  })
})

describe('WorkflowRunner step tool seam', () => {
  it('describes the live agent step of an execution', async () => {
    const ctx = setup()
    const runId = ctx.startRun('reviewed')
    await flush()
    const attemptId = ctx.attemptOf(runId, 'review')
    expect(ctx.runner.stepForExecution(ctx.agent.executionFor(attemptId))).toEqual({
      attemptId,
      stepId: 'review',
      output: { fields: { verdict: { enum: ['pass', 'fail'] } }, required: ['verdict'] },
      ended: false
    })
  })

  it('returns null for unknown executions, shell steps and while labs is off', async () => {
    const ctx = setup()
    const shellRun = ctx.startRun('one-shell')
    const agentRun = ctx.startRun('one-agent')
    await flush()
    expect(ctx.runner.stepForExecution('nobody')).toBeNull()
    expect(ctx.runner.stepForExecution(ctx.shell.executionFor(ctx.attemptOf(shellRun, 'test')))).toBeNull()
    const execution = ctx.agent.executionFor(ctx.attemptOf(agentRun, 'plan'))
    ctx.store.dispatch({ type: 'settings/labsChanged', payload: { workflows: false } })
    expect(ctx.runner.stepForExecution(execution)).toBeNull()
    expect(ctx.runner.completeExecution(execution, { status: 'done', summary: '' })).toEqual({
      ok: false,
      reason: 'not-a-step'
    })
    expect(ctx.wf().attempts[ctx.attemptOf(agentRun, 'plan')].status).toBe('running')
  })

  it('completes the attempt with completedBy tool and the validated data', async () => {
    const ctx = setup()
    const runId = ctx.startRun('reviewed')
    await flush()
    const attemptId = ctx.attemptOf(runId, 'review')
    const execution = ctx.agent.executionFor(attemptId)
    expect(
      ctx.runner.completeExecution(execution, { status: 'done', summary: 'looks good', data: { verdict: 'pass' } })
    ).toEqual({ ok: true })
    expect(ctx.wf().attempts[attemptId]).toMatchObject({ status: 'done', completedBy: 'tool' })
    const attempt = ctx.records.at(-1)?.attempts.find((record) => record.attemptId === attemptId)
    expect(attempt?.result).toEqual({
      status: 'done',
      summary: 'looks good',
      data: { verdict: 'pass' },
      completedBy: 'tool'
    })
  })

  it('reports an ended execution as already completed', async () => {
    const ctx = setup()
    const runId = ctx.startRun('two-agent')
    await flush()
    const attemptId = ctx.attemptOf(runId, 'plan')
    const execution = ctx.agent.executionFor(attemptId)
    ctx.runner.completeExecution(execution, { status: 'done', summary: '' })
    expect(ctx.runner.stepForExecution(execution)).toEqual({ attemptId, stepId: 'plan', ended: true })
    expect(
      ctx.eventsSince(() =>
        expect(ctx.runner.completeExecution(execution, { status: 'failed', summary: '' })).toEqual({
          ok: false,
          reason: 'already-completed'
        })
      )
    ).toEqual([])
  })

  it('a needs-input completion keeps the execution live so a later completion resumes', async () => {
    const ctx = setup()
    const runId = ctx.startRun('one-agent')
    await flush()
    const attemptId = ctx.attemptOf(runId, 'plan')
    const execution = ctx.agent.executionFor(attemptId)
    expect(ctx.runner.completeExecution(execution, { status: 'needs-input', summary: 'which?' })).toEqual({ ok: true })
    expect(ctx.runner.stepForExecution(execution)?.ended).toBe(false)
    expect(ctx.runner.completeExecution(execution, { status: 'done', summary: 'ok' })).toEqual({ ok: true })
    expect(ctx.wf().runs[runId].status).toBe('done')
  })
})

function claudeHarness() {
  const tabs: Array<{ tab: TerminalTab; spawn: StepSpawnExtras; markerPresent: boolean; registered: boolean }> = []
  const markers = new Set<string>()
  const killed: string[] = []
  const exitListeners = new Set<(id: string, code: number, signal?: number) => void>()
  const stopListeners = new Set<(event: ClaudeStopEvent) => void>()
  const promptListeners = new Set<(event: { terminalId: string }) => void>()
  const alive = new Set<string>()
  const state: { trust: TrustStatus; store?: Store; runner?: WorkflowRunner } = { trust: 'trusted' }
  let ids = 0
  const factory = (store: Store): StepDriver => {
    state.store = store
    store.dispatch({ type: 'hooks/consentChanged', payload: 'accepted' })
    return createClaudeStepDriver({
      addTab: (_worktreePath, tab, spawn) => {
        tabs.push({
          tab,
          spawn,
          markerPresent: markers.has(tab.id),
          registered: state.runner?.stepForExecution(tab.id) != null
        })
        alive.add(tab.id)
      },
      hasTerminal: (id) => alive.has(id),
      onExit: (listener) => {
        exitListeners.add(listener)
        return () => exitListeners.delete(listener)
      },
      kill: (id) => {
        killed.push(id)
      },
      onStopEvent: (listener) => {
        stopListeners.add(listener)
        return () => stopListeners.delete(listener)
      },
      onPromptSubmit: (listener) => {
        promptListeners.add(listener)
        return () => promptListeners.delete(listener)
      },
      store,
      checkFolderTrust: async () => ({ status: state.trust }),
      writeMarker: (id) => {
        markers.add(id)
      },
      removeMarker: (id) => {
        markers.delete(id)
      },
      writePromptFile: async () => {},
      newTabId: () => `claude-tab-${++ids}`,
      newSessionId: () => `00000000-0000-4000-8000-00000000000${ids}`,
      log: () => {}
    })
  }
  return {
    factory,
    tabs,
    markers,
    killed,
    state,
    attach(runner: WorkflowRunner) {
      state.runner = runner
    },
    setConsent(consent: 'pending' | 'accepted') {
      state.store?.dispatch({ type: 'hooks/consentChanged', payload: consent })
    },
    status(id: string, status: PtyStatus) {
      state.store?.dispatch({ type: 'terminals/statusChanged', payload: { id, status, pendingTool: null } })
    },
    stop(terminalId: string, lastAssistantMessage: string | null, continued?: boolean) {
      for (const listener of [...stopListeners]) listener({ terminalId, lastAssistantMessage, continued })
    },
    promptSubmit(terminalId: string) {
      for (const listener of [...promptListeners]) listener({ terminalId })
    },
    exit(id: string, code: number, signal?: number) {
      alive.delete(id)
      for (const listener of [...exitListeners]) listener(id, code, signal)
    }
  }
}

async function claudeRun(slug: DefSlug, configure: (claude: ReturnType<typeof claudeHarness>) => void = () => {}) {
  const claude = claudeHarness()
  const ctx = setup({ agentDriver: claude.factory })
  claude.attach(ctx.runner)
  configure(claude)
  const runId = ctx.startRun(slug)
  await flush()
  await flush()
  return { ctx, claude, runId }
}

describe('WorkflowRunner with the Claude driver', () => {
  it('registers the tab id and session before spawning and removes the marker when the attempt ends', async () => {
    const { ctx, claude, runId } = await claudeRun('one-agent')
    const attemptId = ctx.attemptOf(runId, 'plan')
    expect(claude.tabs).toHaveLength(1)
    const { tab, spawn, markerPresent, registered } = claude.tabs[0]
    expect(registered).toBe(true)
    expect(markerPresent).toBe(true)
    expect(spawn).toMatchObject({ permissionLevel: 'edit', bashAllow: [], initialPrompt: `${PROMPT_SECRET} plan` })
    expect(ctx.records.at(-1)?.attempts[0]).toMatchObject({ executionId: tab.id, sessionId: spawn.sessionId })
    expect(ctx.runner.completeExecution(tab.id, { status: 'done', summary: 'ok' })).toEqual({ ok: true })
    expect(claude.markers.size).toBe(0)
    expect(claude.killed).toEqual([])
    expect(ctx.wf().attempts[attemptId]).toMatchObject({ status: 'done', completedBy: 'tool' })
  })

  it.each([
    ['cancelRun', (ctx: Ctx, runId: string) => ctx.runner.cancelRun(runId)],
    ['markDone', (ctx: Ctx, runId: string) => markDoneFor(ctx, runId)]
  ] as const)('kills the tab and removes the marker on %s', async (_name, act) => {
    const { ctx, claude, runId } = await claudeRun('one-agent')
    act(ctx, runId)
    expect(claude.killed).toEqual([claude.tabs[0].tab.id])
    expect(claude.markers.size).toBe(0)
  })

  it('pauses trust with no tab, and retry spawns once the folder is trusted', async () => {
    const { ctx, claude, runId } = await claudeRun('one-agent', (c) => {
      c.state.trust = 'untrusted'
    })
    expect(claude.tabs).toEqual([])
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'trust' })
    expect(ctx.records.at(-1)?.attempts[0].metrics.pauses.map((pause) => pause.reason)).toEqual(['trust'])
    claude.state.trust = 'trusted'
    expect(ctx.runner.retryStep(runId, currentStepId(ctx.runner, runId))).toEqual({ ok: true })
    await flush()
    await flush()
    expect(claude.tabs).toHaveLength(1)
    expect(ctx.wf().attempts[ctx.attemptOf(runId, 'plan')]).toMatchObject({ status: 'running', n: 2 })
    expect(ctx.wf().runs[runId].status).toBe('running')
  })

  it('pauses for hooks consent with no tab, and retry spawns once consent is accepted', async () => {
    const claude = claudeHarness()
    const ctx = setup({ agentDriver: claude.factory })
    claude.attach(ctx.runner)
    const runId = ctx.startRun('one-agent')
    claude.setConsent('pending')
    await flush()
    await flush()
    expect(claude.tabs).toEqual([])
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'needs-input' })
    expect(ctx.records.at(-1)?.attempts[0].result?.summary).toBe('hooks consent required')
    claude.setConsent('accepted')
    expect(ctx.runner.retryStep(runId, currentStepId(ctx.runner, runId))).toEqual({ ok: true })
    await flush()
    await flush()
    expect(claude.tabs).toHaveLength(1)
  })

  it('pauses needs-approval once for three identical status events and resumes on completion', async () => {
    const { ctx, claude, runId } = await claudeRun('one-agent')
    const id = claude.tabs[0].tab.id
    const types = ctx.eventsSince(() => {
      claude.status(id, 'needs-approval')
      claude.status(id, 'needs-approval')
      claude.status(id, 'needs-approval')
    })
    expect(types.filter((type) => type === 'runPaused')).toHaveLength(1)
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'needs-approval' })
    expect(ctx.records.at(-1)?.attempts[0].metrics.pauses.map((pause) => pause.reason)).toEqual(['needs-approval'])
    expect(ctx.runner.completeExecution(id, { status: 'done', summary: 'ok' })).toEqual({ ok: true })
    expect(ctx.wf().runs[runId].status).toBe('done')
  })

  it('completes as fallback with the last message when the step has no required outputs', async () => {
    const { ctx, claude, runId } = await claudeRun('one-agent')
    claude.stop(claude.tabs[0].tab.id, 'final words')
    expect(ctx.records.at(-1)?.attempts[0].result).toEqual({
      status: 'done',
      summary: 'final words',
      completedBy: 'fallback'
    })
    expect(ctx.wf().runs[runId].status).toBe('done')
    expect(claude.markers.size).toBe(0)
  })

  it.each([
    ['plain text', 'x'.repeat(STEP_SUMMARY_MAX_CHARS + 500), 'x'.repeat(STEP_SUMMARY_MAX_CHARS)],
    [
      'a surrogate pair across the limit',
      `${'x'.repeat(STEP_SUMMARY_MAX_CHARS - 1)}😀tail`,
      'x'.repeat(STEP_SUMMARY_MAX_CHARS - 1)
    ]
  ])('caps an oversized fallback summary with %s', async (_name, message, expected) => {
    const { ctx, claude } = await claudeRun('one-agent')
    claude.stop(claude.tabs[0].tab.id, message)
    expect(ctx.records.at(-1)?.attempts[0].result?.summary).toBe(expected)
  })

  it('pauses needs-input once when a step with required outputs ends its turn, and a later completion resumes', async () => {
    const { ctx, claude, runId } = await claudeRun('reviewed')
    const id = claude.tabs[0].tab.id
    expect(ctx.eventsSince(() => claude.stop(id, 'done?'))).toEqual(['runPaused'])
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'needs-input' })
    expect(ctx.eventsSince(() => claude.stop(id, 'still done?'))).toEqual([])
    expect(ctx.records.at(-1)?.attempts[0].metrics.pauses).toHaveLength(1)
    expect(ctx.runner.completeExecution(id, { status: 'done', summary: 'ok', data: { verdict: 'pass' } })).toEqual({
      ok: true
    })
    expect(ctx.wf().runs[runId].status).toBe('done')
  })

  it('does not let a Stop override a needs-input completion from the tool', async () => {
    const { ctx, claude, runId } = await claudeRun('one-agent')
    const id = claude.tabs[0].tab.id
    ctx.runner.completeExecution(id, { status: 'needs-input', summary: 'which branch?' })
    expect(ctx.eventsSince(() => claude.stop(id, 'waiting'))).toEqual([])
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'needs-input' })
  })

  it('keeps waiting for the tool after a needs-input completion even if an approval pause came in between', async () => {
    const { ctx, claude, runId } = await claudeRun('one-agent')
    const id = claude.tabs[0].tab.id
    ctx.runner.completeExecution(id, { status: 'needs-input', summary: 'which branch?' })
    claude.status(id, 'needs-approval')
    expect(ctx.eventsSince(() => claude.stop(id, 'waiting'))).toEqual([])
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'needs-approval' })
  })

  it('ignores a Stop that arrives after complete_step', async () => {
    const { ctx, claude, runId } = await claudeRun('one-agent')
    const id = claude.tabs[0].tab.id
    ctx.runner.completeExecution(id, { status: 'done', summary: 'from tool' })
    expect(ctx.eventsSince(() => claude.stop(id, 'from stop'))).toEqual([])
    expect(ctx.records.at(-1)?.attempts[0].result).toMatchObject({ summary: 'from tool', completedBy: 'tool' })
    expect(ctx.wf().runs[runId].status).toBe('done')
  })

  it('fails the step on an exit without completion', async () => {
    const { ctx, claude, runId } = await claudeRun('one-agent')
    claude.exit(claude.tabs[0].tab.id, 3)
    expect(ctx.records.at(-1)?.attempts[0].result).toEqual({
      status: 'failed',
      summary: '',
      completedBy: 'exit',
      exitCode: 3
    })
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'step-failed' })
    expect(claude.markers.size).toBe(0)
  })

  it('keeps the shell summary when the Claude driver also forwards the shell tab exit', async () => {
    const claude = claudeHarness()
    const pty = exitingPty(0, 'shell output\r\n')
    const ctx = setup({ agentDriver: claude.factory, shellDriver: pty.driver })
    const runId = ctx.startRun('one-shell')
    await flush()
    expect(pty.tabs).toHaveLength(1)
    claude.exit(pty.tabs[0].tab.id, 0)
    await flush()
    expect(ctx.records.at(-1)?.attempts[0].result).toMatchObject({ status: 'done', summary: 'shell output' })
    expect(ctx.wf().runs[runId].status).toBe('done')
  })
})

describe('WorkflowRunner driver release', () => {
  it.each([
    ['a completion', (ctx: Ctx, attemptId: string) => ctx.runner.complete(attemptId, done())],
    [
      'an exit',
      (ctx: Ctx, attemptId: string) =>
        ctx.agent.emit({ type: 'exited', executionId: ctx.agent.executionFor(attemptId), code: 1 })
    ],
    ['cancelRun', (ctx: Ctx, attemptId: string) => ctx.runner.cancelRun(ctx.runner.runIdForAttempt(attemptId) ?? '')],
    ['markDone', (ctx: Ctx, attemptId: string) => markDoneFor(ctx, ctx.runner.runIdForAttempt(attemptId) ?? '')]
  ] as const)('releases the execution when the attempt ends by %s', async (_name, act) => {
    const ctx = setup()
    const runId = ctx.startRun('one-agent')
    await flush()
    const attemptId = ctx.attemptOf(runId, 'plan')
    const execution = ctx.agent.executionFor(attemptId)
    act(ctx, attemptId)
    expect(ctx.agent.released).toEqual([execution])
  })

  it('maps an execution bound before start resolves so its early events count', async () => {
    const ctx = setup({ agentScript: () => 'defer' })
    const runId = ctx.startRun('one-agent')
    await flush()
    const attemptId = ctx.attemptOf(runId, 'plan')
    const attempt = ctx.agent.started[0]
    expect(attempt.bind({ executionId: 'agent-exec-1', sessionId: 'session-1' })).toBe(true)
    ctx.agent.emit({ type: 'exited', executionId: 'agent-exec-1', code: 1 })
    expect(ctx.wf().attempts[attemptId].status).toBe('failed')
    expect(ctx.records.at(-1)?.attempts[0]).toMatchObject({ executionId: 'agent-exec-1', sessionId: 'session-1' })
    ctx.agent.resolveDeferred(attemptId)
    await flush()
    expect(ctx.agent.cancelled).toEqual(['agent-exec-1'])
  })

  it('refuses to bind an attempt that already ended', async () => {
    const ctx = setup({ agentScript: () => 'defer' })
    const runId = ctx.startRun('one-agent')
    await flush()
    const attempt = ctx.agent.started[0]
    ctx.runner.cancelRun(runId)
    expect(attempt.bind({ executionId: 'late' })).toBe(false)
    expect(ctx.runner.stepForExecution('late')).toBeNull()
  })
})

describe('WorkflowRunner Stop-hook continuation', () => {
  it('blocks the first Stop of a turn, ignores that Stop, then falls back on the next turn end', async () => {
    const { ctx, claude, runId } = await claudeRun('one-agent')
    const id = claude.tabs[0].tab.id
    const attemptId = ctx.attemptOf(runId, 'plan')
    expect(ctx.runner.stopCheck(id, false)).toBe('block')
    expect(ctx.records.at(-1)?.attempts[0].metrics.continuations).toBe(1)
    expect(ctx.eventsSince(() => claude.stop(id, 'first try', true))).toEqual([])
    expect(ctx.wf().attempts[attemptId].status).toBe('running')
    expect(ctx.runner.stopCheck(id, true)).toBe('none')
    claude.stop(id, 'second try')
    expect(ctx.records.at(-1)?.attempts[0]).toMatchObject({
      status: 'done',
      result: { status: 'done', summary: 'second try', completedBy: 'fallback' },
      metrics: { continuations: 1 }
    })
  })

  it('continues at most once per turn even when stop_hook_active is false', async () => {
    const { ctx, claude } = await claudeRun('one-agent')
    const id = claude.tabs[0].tab.id
    expect(ctx.runner.stopCheck(id, false)).toBe('block')
    expect(ctx.runner.stopCheck(id, false)).toBe('none')
    expect(ctx.records.at(-1)?.attempts[0].metrics.continuations).toBe(1)
  })

  it('never blocks when the hook payload says a stop hook is already active', async () => {
    const { ctx, claude } = await claudeRun('one-agent')
    expect(ctx.runner.stopCheck(claude.tabs[0].tab.id, true)).toBe('none')
    expect(ctx.records.at(-1)?.attempts[0].metrics.continuations).toBe(0)
  })

  it('lets a UserPromptSubmit reset the per-turn counter so the next turn can be continued again', async () => {
    const { ctx, claude, runId } = await claudeRun('reviewed')
    const id = claude.tabs[0].tab.id
    expect(ctx.runner.stopCheck(id, false)).toBe('block')
    claude.stop(id, 'nudged', true)
    claude.promptSubmit(id)
    expect(ctx.runner.stopCheck(id, false)).toBe('block')
    expect(ctx.records.at(-1)?.attempts[0].metrics.continuations).toBe(2)
    expect(ctx.wf().runs[runId].status).toBe('running')
  })

  it('answers none to a late stop-check after the attempt ended by fallback', async () => {
    const { ctx, claude } = await claudeRun('one-agent')
    const id = claude.tabs[0].tab.id
    claude.stop(id, 'done')
    expect(ctx.runner.stopCheck(id, false)).toBe('none')
  })

  it('answers none while labs is off', async () => {
    const { ctx, claude } = await claudeRun('one-agent')
    ctx.store.dispatch({ type: 'settings/labsChanged', payload: { workflows: false } })
    expect(ctx.runner.stopCheck(claude.tabs[0].tab.id, false)).toBe('none')
  })

  it('answers none for unknown terminals', async () => {
    const { ctx } = await claudeRun('one-agent')
    expect(ctx.runner.stopCheck('user-tab', false)).toBe('none')
  })

  it('does not nudge an agent that asked for input', async () => {
    const { ctx, claude } = await claudeRun('one-agent')
    const id = claude.tabs[0].tab.id
    ctx.runner.completeExecution(id, { status: 'needs-input', summary: 'which branch?' })
    expect(ctx.runner.stopCheck(id, false)).toBe('none')
  })

  it('falls back when the block never reached Claude and its Stop is not marked continued', async () => {
    const { ctx, claude, runId } = await claudeRun('one-agent')
    const id = claude.tabs[0].tab.id
    expect(ctx.runner.stopCheck(id, false)).toBe('block')
    claude.stop(id, 'curl timed out')
    expect(ctx.wf().runs[runId].status).toBe('done')
    expect(ctx.records.at(-1)?.attempts[0].result).toMatchObject({ summary: 'curl timed out', completedBy: 'fallback' })
    expect(ctx.logs.some((line) => line.includes('continuation not delivered'))).toBe(true)
  })

  it('resumes a needs-approval pause when the agent reaches a blocked Stop or a new prompt', async () => {
    const { ctx, claude, runId } = await claudeRun('one-agent')
    const id = claude.tabs[0].tab.id
    claude.status(id, 'needs-approval')
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'needs-approval' })
    expect(ctx.runner.stopCheck(id, false)).toBe('block')
    expect(ctx.wf().runs[runId].status).toBe('running')
    claude.status(id, 'processing')
    claude.status(id, 'needs-approval')
    expect(ctx.wf().runs[runId].pausedReason).toBe('needs-approval')
    claude.promptSubmit(id)
    expect(ctx.wf().runs[runId].status).toBe('running')
  })

  it('logs one workflow line per continuation with ids only', async () => {
    const { ctx, claude, runId } = await claudeRun('one-agent')
    const id = claude.tabs[0].tab.id
    ctx.runner.stopCheck(id, false)
    const lines = ctx.logs.filter((line) => line.includes('step continued'))
    expect(lines).toEqual([
      `[workflow] step continued 1 ${JSON.stringify({ runId, stepId: 'plan', attemptId: ctx.attemptOf(runId, 'plan') })}`
    ])
  })

  it('lists the live executions so boot pruning can keep their configs and markers', async () => {
    const { ctx, claude } = await claudeRun('one-agent')
    expect(ctx.runner.liveExecutionIds()).toEqual([claude.tabs[0].tab.id])
  })
})

describe('WorkflowRunner start refusals', () => {
  const start = (ctx: Ctx, slug: DefSlug, worktreePath: string, inputs: Record<string, string>) =>
    ctx.runner.start({ defId: `personal:${slug}`, worktreePath, inputs })

  it('refuses a worktree that is not in the worktree list', () => {
    const ctx = setup()
    expect(start(ctx, 'one-shell', '/elsewhere', {})).toEqual({ ok: false, reason: 'unknown-worktree' })
    expect(start(ctx, 'one-shell', '/wt/a/', {})).toEqual({ ok: false, reason: 'unknown-worktree' })
    expect(ctx.shell.started).toEqual([])
  })

  it.each([
    ['an undeclared key', { task: 'x', extra: 'y' }],
    ['a prototype key', JSON.parse('{"task":"x","__proto__":"y"}') as Record<string, string>],
    ['a non-string value', { task: 7 as unknown as string }],
    ['an oversize value', { task: 'x'.repeat(64 * 1024 + 1) }],
    ['too many keys', Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, 'v']))]
  ])('refuses inputs with %s', (_name, inputs) => {
    const ctx = setup()
    expect(start(ctx, 'shell-input', '/wt/a', inputs)).toEqual({ ok: false, reason: 'invalid-inputs' })
  })

  it.each([
    ['absent', {}],
    ['blank', { task: '  ' }]
  ])('refuses a declared input that is %s', (_name, inputs) => {
    const ctx = setup()
    expect(start(ctx, 'shell-input', '/wt/a', inputs)).toEqual({ ok: false, reason: 'missing-input' })
  })

  it('refuses an agent workflow until hooks consent is accepted, but not a shell-only one', () => {
    const ctx = setup()
    ctx.store.dispatch({ type: 'hooks/consentChanged', payload: 'pending' })
    expect(start(ctx, 'one-agent', '/wt/a', {})).toEqual({ ok: false, reason: 'hooks-consent' })
    expect(start(ctx, 'one-shell', '/wt/a', {}).ok).toBe(true)
  })

  it.each<DefSlug>(['full-agent', 'full-default'])('refuses %s without an explicit allowFull', (slug) => {
    const ctx = setup()
    expect(start(ctx, slug, '/wt/a', {})).toEqual({ ok: false, reason: 'full-permission-unconfirmed' })
    expect(ctx.runner.start({ defId: `personal:${slug}`, worktreePath: '/wt/a', inputs: {}, allowFull: false })).toEqual({
      ok: false,
      reason: 'full-permission-unconfirmed'
    })
    expect(Object.keys(ctx.wf().runs)).toEqual([])
  })

  it.each<[string, unknown]>([
    ['the string true', 'true'],
    ['the number 1', 1],
    ['an object', { allowFull: true }]
  ])('does not count %s as allowFull', (_name, allowFull) => {
    const ctx = setup()
    const request = { defId: 'personal:full-agent', worktreePath: '/wt/a', inputs: {}, allowFull }
    expect(ctx.runner.start(request as unknown as Parameters<typeof ctx.runner.start>[0])).toEqual({
      ok: false,
      reason: 'full-permission-unconfirmed'
    })
  })

  it('starts a full-access workflow when allowFull is true, and ignores allowFull without a full step', () => {
    const ctx = setup()
    expect(ctx.runner.start({ defId: 'personal:full-agent', worktreePath: '/wt/a', inputs: {}, allowFull: true }).ok).toBe(true)
    expect(ctx.runner.start({ defId: 'personal:one-agent', worktreePath: '/wt/b', inputs: {} }).ok).toBe(true)
  })
})

describe('WorkflowRunner step actions', () => {
  it('refuses an action for a step that is not the current one, and retry on a running run', () => {
    const ctx = setup()
    const runId = ctx.startRun('two-agent')
    expect(ctx.runner.retryStep(runId, 'plan')).toEqual({ ok: false, reason: 'not-paused' })
    expect(ctx.runner.skipStep(runId, 'build')).toEqual({ ok: false, reason: 'wrong-step' })
    expect(ctx.runner.cancelStep(runId, 'build')).toEqual({ ok: false, reason: 'wrong-step' })
    expect(ctx.runner.cancelStep('missing', 'plan')).toEqual({ ok: false, reason: 'unknown-run' })
    expect(ctx.runner.cancelRun('missing')).toEqual({ ok: false, reason: 'unknown-run' })
    expect(ctx.stepStatus(runId, 'plan')).toBe('running')
  })

  it('refuses retry while a Claude step waits for approval, without killing the agent', async () => {
    const { ctx, claude, runId } = await claudeRun('one-agent')
    claude.status(claude.tabs[0].tab.id, 'needs-approval')
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'needs-approval' })
    expect(ctx.runner.retryStep(runId, 'plan')).toEqual({ ok: false, reason: 'awaiting-approval' })
    expect(ctx.runner.resumeStep(runId, 'plan')).toEqual({ ok: false, reason: 'awaiting-approval' })
    expect(claude.killed).toEqual([])
    expect(ctx.runner.cancelStep(runId, 'plan')).toEqual({ ok: true })
    expect(ctx.runner.retryStep(runId, 'plan')).toEqual({ ok: true })
  })

  it('refuses retry from clean without run artifacts', () => {
    const ctx = setup()
    const runId = ctx.startRun('one-agent')
    ctx.runner.complete(ctx.attemptOf(runId, 'plan'), failed())
    return expect(ctx.runner.retryFromClean(runId, 'plan')).resolves.toEqual({ ok: false, reason: 'no-snapshot' })
  })

  it('keeps the run paused and logs when the restore fails', async () => {
    const artifacts: RunArtifacts = {
      prepare: async () => {},
      snapshot: async ({ n }) => ({ commit: String(n).repeat(40), ref: `refs/test/${n}` }),
      appendContext: async () => {},
      restore: async () => {
        throw new Error(`restore failed ${PROMPT_SECRET}`)
      }
    }
    const ctx = setup({ artifacts })
    const runId = ctx.startRun('one-agent')
    await flush()
    ctx.runner.complete(ctx.attemptOf(runId, 'plan'), failed())
    expect(await ctx.runner.retryFromClean(runId, 'plan')).toEqual({ ok: false, reason: 'restore-failed' })
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'step-failed' })
    expect(ctx.agent.started).toHaveLength(1)
    expect(ctx.logs.some((line) => line.includes('step action refused restore-failed'))).toBe(true)
    expect(ctx.logs.join('\n')).not.toContain(PROMPT_SECRET)
    expect(ctx.runner.retryStep(runId, 'plan')).toEqual({ ok: true })
  })

  it('launches a queued agent step when reschedule runs after the cap is raised', async () => {
    const ctx = setup({ cap: 1 })
    const runA = ctx.startRun('one-agent', '/wt/a')
    const runB = ctx.startRun('one-agent', '/wt/b')
    await flush()
    expect(ctx.stepStatus(runB, 'plan')).toBe('queued')
    ctx.runner.reschedule()
    expect(ctx.stepStatus(runB, 'plan')).toBe('queued')
    ctx.store.dispatch({ type: 'settings/workflowSettingsChanged', payload: { maxConcurrentAgents: 2 } })
    ctx.runner.reschedule()
    await flush()
    expect(ctx.stepStatus(runA, 'plan')).toBe('running')
    expect(ctx.stepStatus(runB, 'plan')).toBe('running')
    expect(ctx.agent.started.map((attempt) => attempt.runId)).toEqual([runA, runB])
    expect(ctx.records.filter((record) => record.runId === runB).at(-1)?.steps.plan).toBe('running')
  })
})

describe('WorkflowRunner markDone', () => {
  it('refuses invalid, undeclared and status fields without touching the step', () => {
    const ctx = setup()
    const runId = ctx.startRun('review-then-act')
    ctx.runner.complete(ctx.attemptOf(runId, 'review'), failed())
    const refusals = [
      { summary: 's', fields: { verdict: 'maybe' } },
      { summary: 's', fields: {} },
      { summary: 's', fields: { verdict: 'pass', status: 'failed' } },
      { summary: 's', fields: { verdict: 'pass', [PROMPT_SECRET]: 1 } }
    ].map((request) => ctx.runner.markDone(runId, 'review', request))
    expect(refusals).toEqual([
      { ok: false, reason: 'invalid-output', errors: [{ field: 'verdict', message: 'Expected one of: "pass", "fail"' }] },
      { ok: false, reason: 'invalid-output', errors: [{ field: 'verdict', message: 'Required' }] },
      { ok: false, reason: 'invalid-output', errors: [{ field: '', message: 'Fields must be declared step outputs' }] },
      { ok: false, reason: 'invalid-output', errors: [{ field: '', message: 'Fields must be declared step outputs' }] }
    ])
    expect(ctx.stepStatus(runId, 'review')).toBe('failed')
    expect(ctx.wf().runs[runId].status).toBe('paused')
  })

  it('completes a paused failed step as the user and hands its summary and data to the next step', async () => {
    const ctx = setup()
    const runId = ctx.startRun('review-then-act')
    ctx.runner.complete(ctx.attemptOf(runId, 'review'), failed('tool failed'))
    const summary = `${'s'.repeat(STEP_SUMMARY_MAX_CHARS)}-CUT`
    expect(
      ctx.runner.markDone(runId, 'review', { summary, fields: { verdict: 'pass', notes: ['looks fine'] } })
    ).toEqual({ ok: true })
    await flush()

    const reviewAttempts = ctx.wf().runs[runId].steps.review.attemptIds.map((id) => ctx.wf().attempts[id])
    expect(reviewAttempts).toMatchObject([
      { status: 'failed', n: 1, completedBy: 'tool' },
      { status: 'done', n: 2, completedBy: 'user' }
    ])
    const act = ctx.agent.started.find((attempt) => attempt.stepId === 'act')
    expect(act?.scope.steps?.review).toEqual({
      status: 'done',
      summary: summary.slice(0, STEP_SUMMARY_MAX_CHARS),
      data: { verdict: 'pass', notes: ['looks fine'] }
    })
    if (act?.step.kind !== 'agent') throw new Error('expected an agent step')
    expect(renderTemplate(act.step.prompt, act.scope).text).toBe('act on pass')
    const stored = ctx.records.at(-1)?.attempts.find((attempt) => attempt.stepId === 'review' && attempt.n === 2)
    expect(stored?.result).toEqual({
      status: 'done',
      summary: summary.slice(0, STEP_SUMMARY_MAX_CHARS),
      completedBy: 'user',
      data: { verdict: 'pass', notes: ['looks fine'] }
    })
  })

  it('completes a live attempt with the user result', async () => {
    const ctx = setup()
    const runId = ctx.startRun('review-then-act')
    await flush()
    const attemptId = ctx.attemptOf(runId, 'review')
    expect(ctx.runner.markDone(runId, 'review', { summary: 'by hand', fields: { verdict: 'fail' } })).toEqual({
      ok: true
    })
    expect(ctx.records.at(-1)?.attempts.find((attempt) => attempt.attemptId === attemptId)?.result).toEqual({
      status: 'done',
      summary: 'by hand',
      completedBy: 'user',
      data: { verdict: 'fail' }
    })
    expect(ctx.wf().runs[runId].steps.review.attemptIds).toEqual([attemptId])
  })

  it('accepts only a summary for a shell step', () => {
    const ctx = setup()
    const runId = ctx.startRun('shell-then-agent')
    ctx.runner.complete(ctx.attemptOf(runId, 'test'), failed())
    expect(ctx.runner.markDone(runId, 'test', { summary: 's', fields: { verdict: 'pass' } })).toMatchObject({
      ok: false,
      reason: 'invalid-output'
    })
    expect(ctx.runner.markDone(runId, 'test', { summary: 'fixed by hand', fields: {} })).toEqual({ ok: true })
    expect(ctx.stepStatus(runId, 'test')).toBe('done')
  })
})

describe('WorkflowRunner restore in flight', () => {
  it('refuses cancelRun while a clean restore runs, then the retry proceeds', async () => {
    let finishRestore = (): void => {}
    const artifacts: RunArtifacts = {
      prepare: async () => {},
      snapshot: async ({ n }) => ({ commit: String(n).repeat(40), ref: `refs/test/${n}` }),
      appendContext: async () => {},
      restore: () =>
        new Promise<void>((resolve) => {
          finishRestore = resolve
        })
    }
    const ctx = setup({ artifacts })
    const runId = ctx.startRun('one-shell')
    await flush()
    ctx.runner.complete(ctx.attemptOf(runId, 'test'), failed())

    const pending = ctx.runner.retryFromClean(runId, 'test')
    await flush()
    expect(ctx.runner.cancelRun(runId)).toEqual({ ok: false, reason: 'busy' })
    expect(ctx.runner.start({ defId: 'personal:one-shell', worktreePath: '/wt/one-shell', inputs: {} })).toEqual({
      ok: false,
      reason: 'worktree-busy'
    })
    finishRestore()
    expect(await pending).toEqual({ ok: true })
    await flush()
    expect(ctx.shell.started.map((attempt) => attempt.n)).toEqual([1, 2])
    expect(ctx.wf().runs[runId].status).toBe('running')
  })
})

describe('WorkflowRunner before boot reconcile', () => {
  function unready(runs: Record<string, WorkflowRun> = {}) {
    const store = new Store({
      ...initialState,
      hooks: { ...initialState.hooks, consent: 'accepted' },
      worktrees: { ...initialState.worktrees, list: WORKTREES.map(worktreeFixture) },
      workflows: { ...initialState.workflows, runs },
      settings: { ...initialState.settings, labs: { ...initialState.settings.labs, workflows: true } }
    })
    const agent = new FakeStepDriver('agent')
    const runner = new WorkflowRunner({
      store,
      loader: { getDefinition: (id) => (id === 'personal:one-agent' ? detail('one-agent') : null) },
      drivers: { agent, shell: new FakeStepDriver('shell') },
      now: () => 1,
      newId: () => 'run-new',
      log: () => {}
    })
    return { runner, agent }
  }
  const request = { defId: 'personal:one-agent', worktreePath: '/wt/a', inputs: {} }

  it('refuses start until reconcile ran, then accepts it', async () => {
    const { runner, agent } = unready()
    expect(runner.start(request)).toEqual({ ok: false, reason: 'starting' })
    runner.reconcile([])
    expect(runner.start(request)).toEqual({ ok: true, runId: 'run-new' })
    await flush()
    expect(agent.started).toHaveLength(1)
  })

  it('becomes ready even when reconcile throws on a malformed record', async () => {
    const { runner, agent } = unready()
    const malformed = {
      version: 1,
      runId: 'run-bad',
      status: 'running',
      worktreePath: '/wt/b',
      attempts: null
    } as unknown as WorkflowRunRecord
    expect(() => runner.reconcile([malformed])).toThrow()
    expect(runner.start(request)).toEqual({ ok: true, runId: 'run-new' })
    await flush()
    expect(agent.started).toHaveLength(1)
  })

  it('refuses start on a worktree whose hydrated run is not reconciled yet', () => {
    const { runner } = unready({
      'run-old': {
        defId: 'personal:one-agent',
        defHash: 'h',
        worktreePath: '/wt/a',
        status: 'running',
        startedAt: 1,
        steps: { plan: { status: 'pending', attemptIds: [] } }
      }
    })
    expect(runner.start(request)).toMatchObject({ ok: false })
    runner.reconcile([])
    expect(runner.start(request)).toEqual({ ok: false, reason: 'worktree-busy' })
  })
})

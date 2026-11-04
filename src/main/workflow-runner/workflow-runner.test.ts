import { describe, it, expect, vi } from 'vitest'
import { Store } from '../store'
import {
  WorkflowRunner,
  createClaudeStepDriver,
  createShellStepDriver,
  StepStartError,
  type AgentStopEvent,
  type RunArtifacts,
  type StepAttempt,
  type StepDriver,
  type StepResult,
  type WorkflowRunnerDeps,
  type WorkflowRunRecord
} from '.'
import { currentStepId, fakeTimers, FakeStepDriver, worktreeFixture, type FakeStartBehavior } from './fake-step-driver'
import { initialState, type StateEvent } from '../../shared/state'
import { emptyBreakdown, type SessionUsage } from '../../shared/state/costs'
import { CostTracker } from '../cost-tracker'
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
  'one-opencode': `name: one-opencode
steps:
  - id: plan
    agent: opencode
    model: fake/opencode-model
    permissions: read-only
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
  diamond: `name: diamond
steps:
  - id: plan
    agent: claude
    prompt: "plan"
  - id: left
    agent: claude
    needs: [plan]
    permissions: read-only
    prompt: "left {{steps.plan.summary}}"
  - id: right
    agent: claude
    needs: [plan]
    permissions: read-only
    prompt: "right {{steps.plan.summary}}"
  - id: join
    kind: shell
    needs: [left, right]
    run: "echo {{steps.left.summary}} {{steps.right.summary}}"
`,
  'shell-branch': `name: shell-branch
steps:
  - id: plan
    agent: claude
    prompt: "plan"
  - id: review
    agent: claude
    needs: [plan]
    permissions: read-only
    prompt: "review"
  - id: lint
    kind: shell
    needs: [plan]
    parallel_safe: true
    run: "true"
`,
  triple: `name: triple
steps:
  - id: plan
    agent: claude
    prompt: "plan"
  - id: a
    agent: claude
    needs: [plan]
    permissions: read-only
    prompt: "a"
  - id: b
    agent: claude
    needs: [plan]
    permissions: read-only
    prompt: "b"
  - id: c
    agent: claude
    needs: [plan]
    permissions: read-only
    prompt: "c"
`,
  gated: `name: gated
steps:
  - id: plan
    agent: claude
    prompt: "${PROMPT_SECRET} plan"
    gate: approve
  - id: test
    kind: shell
    run: "true"
`,
  'gated-shell': `name: gated-shell
steps:
  - id: test
    kind: shell
    run: "true"
    gate: approve
  - id: fix
    agent: claude
    prompt: "fix"
`,
  'loop-diamond': `name: loop-diamond
steps:
  - id: plan
    agent: claude
    prompt: "plan"
  - id: left
    agent: claude
    needs: [plan]
    permissions: read-only
    prompt: "left"
  - id: right
    agent: claude
    needs: [plan]
    permissions: read-only
    prompt: "right"
  - id: side
    agent: claude
    needs: [plan]
    permissions: read-only
    prompt: "side"
  - id: review
    agent: claude
    needs: [left, right]
    permissions: read-only
    prompt: "review"
    output:
      verdict: { enum: [pass, fail] }
    loop: { back_to: plan, until: { field: verdict, equals: pass }, max: 3 }
`,
  'loop-prompts': `name: loop-prompts
steps:
  - id: build
    agent: claude
    prompt: "build"
  - id: test
    kind: shell
    run: "true"
  - id: note
    agent: claude
    permissions: read-only
    prompt: "note"
    on_loop: "${PROMPT_SECRET} again after {{steps.review.summary}} with {{steps.build.summary}}"
  - id: review
    agent: claude
    permissions: read-only
    prompt: "review"
    output:
      verdict: { enum: [pass, fail] }
    loop: { back_to: build, until: { field: verdict, equals: pass }, max: 3 }
`,
  'loop-fresh': `name: loop-fresh
steps:
  - id: build
    agent: claude
    prompt: "build"
  - id: review
    agent: claude
    permissions: read-only
    prompt: "review"
    output:
      verdict: { enum: [pass, fail] }
    loop: { back_to: build, until: { field: verdict, equals: pass }, max: 3, fresh: true }
`,
  'loop-cap': `name: loop-cap
steps:
  - id: build
    agent: claude
    prompt: "build"
  - id: review
    agent: claude
    permissions: read-only
    prompt: "review"
    output:
      verdict: { enum: [pass, fail] }
    loop: { back_to: build, until: { field: verdict, equals: pass }, max: 2 }
  - id: after
    kind: shell
    run: "true"
`,
  'loop-gated': `name: loop-gated
steps:
  - id: build
    agent: claude
    prompt: "build"
  - id: review
    agent: claude
    permissions: read-only
    prompt: "review"
    gate: approve
    output:
      verdict: { enum: [pass, fail] }
    loop: { back_to: build, until: { field: verdict, equals: pass }, max: 3 }
  - id: after
    kind: shell
    run: "true"
`,
  'when-verdict': `name: when-verdict
steps:
  - id: review
    agent: claude
    permissions: read-only
    prompt: "review"
    output:
      verdict: { enum: [pass, fail] }
  - id: fix
    agent: claude
    prompt: "fix"
    when: { field: verdict, equals: fail }
  - id: join
    kind: shell
    run: "echo [{{steps.fix.summary}}]"
`,
  'when-exit': `name: when-exit
steps:
  - id: test
    kind: shell
    run: "true"
  - id: fix
    agent: claude
    prompt: "fix"
    when: { exit: 1 }
`,
  'when-loop': `name: when-loop
steps:
  - id: build
    agent: claude
    prompt: "build"
  - id: check
    agent: claude
    permissions: read-only
    prompt: "check"
    output:
      verdict: { enum: [pass, fail] }
  - id: fix
    agent: claude
    prompt: "fix"
    when: { field: verdict, equals: fail }
  - id: review
    agent: claude
    permissions: read-only
    prompt: "review"
    output:
      ok: { enum: [yes, no] }
    loop: { back_to: build, until: { field: ok, equals: "yes" }, max: 3 }
`,
  'when-chain': `name: when-chain
steps:
  - id: a
    agent: claude
    permissions: read-only
    prompt: "a"
    output:
      verdict: { enum: [pass, fail] }
  - id: b
    agent: claude
    permissions: read-only
    prompt: "b"
    when: { field: verdict, equals: fail }
  - id: c
    agent: claude
    prompt: "c"
    when: { field: x, not: y }
`,
  timed: `name: timed
steps:
  - id: plan
    agent: claude
    prompt: "plan"
    timeout: 600
  - id: test
    kind: shell
    run: "true"
`,
  'timed-long': `name: timed-long
steps:
  - id: plan
    agent: claude
    prompt: "plan"
    timeout: 2500000
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
  deps?: Partial<WorkflowRunnerDeps>
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
  worktrees = WORKTREES,
  deps
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
    artifacts,
    ...deps
  })
  runner.reconcile([])
  const events: StateEvent[] = []
  store.subscribe((event) => events.push(event))
  const wf = () => store.getSnapshot().state.workflows

  async function startRun(slug: DefSlug, worktreePath = `/wt/${slug}`): Promise<string> {
    const declared = detail(slug).definition?.inputs ?? {}
    const result = await runner.start({
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

  async function eventsSinceAsync(fn: () => Promise<void>): Promise<string[]> {
    const from = events.length
    await fn()
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
    eventsSince,
    eventsSinceAsync
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
      const runId = await ctx.startRun('two-agent')
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
    const runId = await ctx.startRun('two-agent', '/wt/a')
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
  ] as const)('refuses with %s and dispatches nothing', async (reason, options, slug) => {
    const ctx = setup(options)
    const types = await ctx.eventsSinceAsync(async () => {
      expect(
        await ctx.runner.start({ defId: `personal:${slug}`, worktreePath: '/wt/a', inputs: {} })
      ).toEqual({ ok: false, reason })
    })
    expect(types).toEqual([])
    expect(ctx.agent.started).toEqual([])
  })

  it('refuses a worktree that already has a non-terminal run', async () => {
    const ctx = setup()
    await ctx.startRun('one-agent', '/wt/a')
    const types = await ctx.eventsSinceAsync(async () => {
      expect(
        await ctx.runner.start({ defId: 'personal:one-shell', worktreePath: '/wt/a', inputs: {} })
      ).toEqual({ ok: false, reason: 'worktree-busy' })
    })
    expect(types).toEqual([])
  })

  it('refuses a worktree with a paused run and accepts it once that run is terminal', async () => {
    const ctx = setup()
    const runId = await ctx.startRun('one-agent', '/wt/a')
    ctx.runner.complete(ctx.attemptOf(runId, 'plan'), failed())
    expect(await ctx.runner.start({ defId: 'personal:one-agent', worktreePath: '/wt/a', inputs: {} })).toEqual({
      ok: false,
      reason: 'worktree-busy'
    })
    ctx.runner.cancelRun(runId)
    expect(
      (await ctx.runner.start({ defId: 'personal:one-agent', worktreePath: '/wt/a', inputs: {} })).ok
    ).toBe(true)
  })
})

describe('WorkflowRunner dispatch order and dedup', () => {
  it('dispatches attemptEnded, stepStatusChanged, runFinished at the end of a run', async () => {
    const ctx = setup()
    const runId = await ctx.startRun('one-agent')
    const types = ctx.eventsSince(() => ctx.runner.complete(ctx.attemptOf(runId, 'plan'), done()))
    expect(types).toEqual(['attemptEnded', 'stepStatusChanged', 'runFinished'])
  })

  it('dispatches attemptEnded, stepStatusChanged, runCancelled on cancelRun', async () => {
    const ctx = setup()
    const runId = await ctx.startRun('one-agent')
    expect(ctx.eventsSince(() => ctx.runner.cancelRun(runId))).toEqual([
      'attemptEnded',
      'stepStatusChanged',
      'runCancelled'
    ])
  })

  it('cancelRun on a queued step cancels the step before the run', async () => {
    const ctx = setup({ cap: 1 })
    await ctx.startRun('one-agent', '/wt/a')
    const queuedRun = await ctx.startRun('one-agent', '/wt/b')
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
  ] as const)('%s from a paused run dispatches runResumed first', async (_name, action) => {
    const ctx = setup()
    const runId = await ctx.startRun('two-agent')
    ctx.runner.complete(ctx.attemptOf(runId, 'plan'), failed())
    const types = ctx.eventsSince(() => expect(action(ctx, runId)).toEqual({ ok: true }))
    expect(types[0]).toBe('runResumed')
    expect(types.length).toBeGreaterThan(1)
  })

  it('ignores a second completion of the same attempt without dispatching', async () => {
    const ctx = setup()
    const runId = await ctx.startRun('two-agent')
    const attemptId = ctx.attemptOf(runId, 'plan')
    ctx.runner.complete(attemptId, failed())
    expect(ctx.eventsSince(() => expect(ctx.runner.complete(attemptId, done())).toBe(false))).toEqual([])
  })

  it('needs-input keeps the attempt running, pauses once, and a later done resumes', async () => {
    const ctx = setup()
    const runId = await ctx.startRun('two-agent')
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
      'cursorChanged',
      'stepStarted',
      'attemptStarted'
    ])
  })

  it('retry from needs-input cancels the live attempt and starts attempt 2', async () => {
    const ctx = setup()
    const runId = await ctx.startRun('two-agent')
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
    await ctx.startRun('one-agent')
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
    const runId = await ctx.startRun('one-agent')
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
    const runId = await ctx.startRun('one-shell')
    await flush()
    const attemptId = ctx.attemptOf(runId, 'test')
    ctx.shell.emit({ type: 'exited', executionId: ctx.shell.executionFor(attemptId), code })
    expect(ctx.wf().attempts[attemptId]).toMatchObject({ status: attemptStatus, completedBy: 'exit' })
    expect(ctx.wf().runs[runId].status).toBe(runStatus)
  })

  it('an agent exit without completion fails the step', async () => {
    const ctx = setup()
    const runId = await ctx.startRun('one-agent')
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
      const runId = await ctx.startRun('one-agent')
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

describe('WorkflowRunner.swapStep refusals', () => {
  it('refuses a failed shell step as not an agent step', async () => {
    const ctx = setup()
    const runId = await ctx.startRun('one-shell')
    await flush()
    const attemptId = ctx.attemptOf(runId, 'test')
    ctx.shell.emit({ type: 'exited', executionId: ctx.shell.executionFor(attemptId), code: 1 })
    expect(ctx.runner.swapStep(runId, 'test', { agent: 'codex' })).toEqual({ ok: false, reason: 'not-agent-step' })
  })

  it('refuses while the agent attempt is still live in a needs-input pause', async () => {
    const ctx = setup()
    const runId = await ctx.startRun('one-agent')
    await flush()
    ctx.runner.complete(ctx.attemptOf(runId, 'plan'), { status: 'needs-input', summary: 'q', completedBy: 'tool' })
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'needs-input' })
    expect(ctx.runner.swapStep(runId, 'plan', { agent: 'codex' })).toEqual({ ok: false, reason: 'live-attempt' })
    expect(ctx.logs.some((line) => line.includes(PROMPT_SECRET))).toBe(false)
  })

  it('logs the swap with the agent and no prompt text', async () => {
    const ctx = setup()
    const runId = await ctx.startRun('one-agent')
    await flush()
    ctx.runner.complete(ctx.attemptOf(runId, 'plan'), failed())
    expect(ctx.runner.swapStep(runId, 'plan', { agent: 'opencode', model: 'm/x' })).toEqual({ ok: true })
    expect(ctx.logs.some((line) => line.includes('step swapped') && line.includes('"agent":"opencode"'))).toBe(true)
    expect(ctx.logs.some((line) => line.includes(PROMPT_SECRET))).toBe(false)
  })
})

describe('WorkflowRunner with the shell driver', () => {
  it.each([
    [0, 'done', 'done', undefined],
    [1, 'failed', 'paused', 'step-failed']
  ] as const)('exit %i ends the attempt %s with the PTY summary', async (code, attemptStatus, runStatus, reason) => {
    const history = Array.from({ length: 60 }, (_, i) => `\u001b[2Kline ${i}\r\n`).join('')
    const pty = exitingPty(code, history)
    const ctx = setup({ shellDriver: pty.driver })
    const runId = await ctx.startRun('shell-input')
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
    const runId = await ctx.startRun('shell-input')
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
    const started = await ctx.runner.start({ defId: 'personal:shell-big', worktreePath: '/wt/big', inputs })
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
    const runA = await ctx.startRun('two-agent', '/wt/a')
    const runB = await ctx.startRun('one-agent', '/wt/b')
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
    const runA = await ctx.startRun('one-agent', '/wt/a')
    const runB = await ctx.startRun('one-shell', '/wt/b')
    await flush()
    expect(ctx.stepStatus(runA, 'plan')).toBe('running')
    expect(ctx.stepStatus(runB, 'test')).toBe('running')
    expect(ctx.shell.started).toHaveLength(1)
  })

  it('reads the cap from settings at each scheduling point', async () => {
    const ctx = setup({ cap: 1 })
    await ctx.startRun('one-agent', '/wt/a')
    const runB = await ctx.startRun('one-agent', '/wt/b')
    expect(ctx.stepStatus(runB, 'plan')).toBe('queued')
    ctx.store.dispatch({ type: 'settings/workflowSettingsChanged', payload: { maxConcurrentAgents: 2 } })
    const runC = await ctx.startRun('one-agent', '/wt/c')
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
    const runA = await ctx.startRun('one-agent', '/wt/a')
    const runB = await ctx.startRun('one-agent', '/wt/b')
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
    const runA = await ctx.startRun('two-agent', '/wt/a')
    const runQ = await ctx.startRun('one-agent', '/wt/q')
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
    const runB = await ctx.startRun('one-shell', '/wt/b')
    await flush()
    ctx.runner.cancelStep(runB, currentStepId(ctx.runner, runB))
    ctx.runner.skipStep(runB, currentStepId(ctx.runner, runB))
    const runC = await ctx.startRun('one-agent', '/wt/c')
    ctx.runner.cancelRun(runC)
    await ctx.runner.start({ defId: 'personal:broken', worktreePath: '/wt/d', inputs: {} })
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
    const runId = await ctx.startRun('two-agent', '/wt/a')
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
    const runId = await ctx.startRun('one-agent', '/wt/a')
    await flush()
    const early = lastRecord(ctx, runId)
    ctx.runner.complete(ctx.attemptOf(runId, 'plan'), done())
    expect(early.attempts[0].status).toBe('running')
    expect(lastRecord(ctx, runId).attempts[0].status).toBe('done')
  })

  it('does not mutate the result object the caller passed to complete', async () => {
    const ctx = setup()
    const runId = await ctx.startRun('one-agent', '/wt/a')
    await flush()
    const result = Object.freeze(done('frozen'))
    expect(ctx.runner.complete(ctx.attemptOf(runId, 'plan'), result)).toBe(true)
    expect(lastRecord(ctx, runId).attempts[0].result).toEqual(result)
  })

  it('records a needs-input pause on the live attempt', async () => {
    const ctx = setup()
    const runId = await ctx.startRun('one-agent', '/wt/a')
    await flush()
    ctx.runner.complete(ctx.attemptOf(runId, 'plan'), { status: 'needs-input', summary: '?', completedBy: 'fallback' })
    expect(lastRecord(ctx, runId).attempts[0]).toMatchObject({
      status: 'running',
      metrics: { pauses: [{ reason: 'needs-input' }] }
    })
  })

  it('does not attribute a pause to an earlier step attempt when a queued step is cancelled', async () => {
    const ctx = setup({ cap: 1 })
    const runId = await ctx.startRun('two-agent', '/wt/a')
    const blocker = await ctx.startRun('one-agent', '/wt/blocker')
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
    const runId = await ctx.startRun('handoff', '/wt/a')
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
    const runId = await ctx.startRun('one-agent', '/wt/new')
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
    const runId = await ctx.startRun('one-agent', '/wt/new')
    await flush()
    const types = ctx.eventsSince(() => ctx.runner.complete(ctx.attemptOf(runId, 'plan'), done()))
    expect(types).not.toContain('runsEvicted')
    expect(Object.keys(ctx.wf().runs)).toHaveLength(50)
  })
})

describe('WorkflowRunner step tool seam', () => {
  it('describes the live agent step of an execution', async () => {
    const ctx = setup()
    const runId = await ctx.startRun('reviewed')
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
    const shellRun = await ctx.startRun('one-shell')
    const agentRun = await ctx.startRun('one-agent')
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
    const runId = await ctx.startRun('reviewed')
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
    const runId = await ctx.startRun('two-agent')
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
    const runId = await ctx.startRun('one-agent')
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
  const stopListeners = new Set<(event: AgentStopEvent) => void>()
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
      write: () => {},
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
  const runId = await ctx.startRun(slug)
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
    const started = ctx.startRun('one-agent')
    claude.setConsent('pending')
    const runId = await started
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
    const runId = await ctx.startRun('one-shell')
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
    const runId = await ctx.startRun('one-agent')
    await flush()
    const attemptId = ctx.attemptOf(runId, 'plan')
    const execution = ctx.agent.executionFor(attemptId)
    act(ctx, attemptId)
    expect(ctx.agent.released).toEqual([execution])
  })

  it('maps an execution bound before start resolves so its early events count', async () => {
    const ctx = setup({ agentScript: () => 'defer' })
    const runId = await ctx.startRun('one-agent')
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
    const runId = await ctx.startRun('one-agent')
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
  const start = async (ctx: Ctx, slug: DefSlug, worktreePath: string, inputs: Record<string, string>) =>
    await ctx.runner.start({ defId: `personal:${slug}`, worktreePath, inputs })

  it('refuses a worktree that is not in the worktree list', async () => {
    const ctx = setup()
    expect(await start(ctx, 'one-shell', '/elsewhere', {})).toEqual({ ok: false, reason: 'unknown-worktree' })
    expect(await start(ctx, 'one-shell', '/wt/a/', {})).toEqual({ ok: false, reason: 'unknown-worktree' })
    expect(ctx.shell.started).toEqual([])
  })

  it.each([
    ['an undeclared key', { task: 'x', extra: 'y' }],
    ['a prototype key', JSON.parse('{"task":"x","__proto__":"y"}') as Record<string, string>],
    ['a non-string value', { task: 7 as unknown as string }],
    ['an oversize value', { task: 'x'.repeat(64 * 1024 + 1) }],
    ['too many keys', Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, 'v']))]
  ])('refuses inputs with %s', async (_name, inputs) => {
    const ctx = setup()
    expect(await start(ctx, 'shell-input', '/wt/a', inputs)).toEqual({ ok: false, reason: 'invalid-inputs' })
  })

  it.each([
    ['absent', {}],
    ['blank', { task: '  ' }]
  ])('refuses a declared input that is %s', async (_name, inputs) => {
    const ctx = setup()
    expect(await start(ctx, 'shell-input', '/wt/a', inputs)).toEqual({ ok: false, reason: 'missing-input' })
  })

  it('refuses an agent workflow until hooks consent is accepted, but not a shell-only one', async () => {
    const ctx = setup()
    ctx.store.dispatch({ type: 'hooks/consentChanged', payload: 'pending' })
    expect(await start(ctx, 'one-agent', '/wt/a', {})).toEqual({ ok: false, reason: 'hooks-consent' })
    expect((await start(ctx, 'one-shell', '/wt/a', {})).ok).toBe(true)
  })

  it.each<DefSlug>(['full-agent', 'full-default'])('refuses %s without an explicit allowFull', async (slug) => {
    const ctx = setup()
    expect(await start(ctx, slug, '/wt/a', {})).toEqual({ ok: false, reason: 'full-permission-unconfirmed' })
    expect(await ctx.runner.start({ defId: `personal:${slug}`, worktreePath: '/wt/a', inputs: {}, allowFull: false })).toEqual({
      ok: false,
      reason: 'full-permission-unconfirmed'
    })
    expect(Object.keys(ctx.wf().runs)).toEqual([])
  })

  it.each<[string, unknown]>([
    ['the string true', 'true'],
    ['the number 1', 1],
    ['an object', { allowFull: true }]
  ])('does not count %s as allowFull', async (_name, allowFull) => {
    const ctx = setup()
    const request = { defId: 'personal:full-agent', worktreePath: '/wt/a', inputs: {}, allowFull }
    expect(await ctx.runner.start(request as unknown as Parameters<typeof ctx.runner.start>[0])).toEqual({
      ok: false,
      reason: 'full-permission-unconfirmed'
    })
  })

  it('starts a full-access workflow when allowFull is true, and ignores allowFull without a full step', async () => {
    const ctx = setup()
    expect((await ctx.runner.start({ defId: 'personal:full-agent', worktreePath: '/wt/a', inputs: {}, allowFull: true })).ok).toBe(true)
    expect((await ctx.runner.start({ defId: 'personal:one-agent', worktreePath: '/wt/b', inputs: {} })).ok).toBe(true)
  })
})

describe('WorkflowRunner needs graph', () => {
  const statuses = (ctx: Ctx, runId: string) =>
    Object.fromEntries(['plan', 'left', 'right', 'join'].map((id) => [id, ctx.stepStatus(runId, id)]))

  it('runs plan, then both read-only branches together, then the join', async () => {
    const ctx = setup()
    const runId = await ctx.startRun('diamond')
    await flush()
    expect(statuses(ctx, runId)).toEqual({ plan: 'running', left: 'pending', right: 'pending', join: 'pending' })
    ctx.runner.complete(ctx.attemptOf(runId, 'plan'), done('the plan'))
    await flush()
    expect(statuses(ctx, runId)).toEqual({ plan: 'done', left: 'running', right: 'running', join: 'pending' })
    ctx.runner.complete(ctx.attemptOf(runId, 'left'), done('L'))
    await flush()
    expect(statuses(ctx, runId)).toEqual({ plan: 'done', left: 'done', right: 'running', join: 'pending' })
    ctx.runner.complete(ctx.attemptOf(runId, 'right'), done('R'))
    await flush()
    expect(statuses(ctx, runId)).toEqual({ plan: 'done', left: 'done', right: 'done', join: 'running' })
    expect(ctx.shell.started.map((attempt) => attempt.stepId)).toEqual(['join'])
    ctx.runner.complete(ctx.attemptOf(runId, 'join'), done())
    await flush()
    expect(ctx.wf().runs[runId].status).toBe('done')
    expect(ctx.agent.started.map((attempt) => attempt.stepId)).toEqual(['plan', 'left', 'right'])
  })

  it('lets a skipped branch satisfy the join', async () => {
    const ctx = setup()
    const runId = await ctx.startRun('diamond')
    await flush()
    ctx.runner.complete(ctx.attemptOf(runId, 'plan'), done())
    await flush()
    ctx.runner.complete(ctx.attemptOf(runId, 'left'), failed())
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'step-failed' })
    expect(ctx.runner.skipStep(runId, 'left')).toEqual({ ok: true })
    await flush()
    expect(statuses(ctx, runId)).toEqual({ plan: 'done', left: 'skipped', right: 'running', join: 'pending' })
    ctx.runner.complete(ctx.attemptOf(runId, 'right'), done('R'))
    await flush()
    expect(ctx.stepStatus(runId, 'join')).toBe('running')
    const [join] = ctx.shell.started
    expect(join.step.kind === 'shell' && renderTemplate(join.step.run, join.scope)).toEqual({ text: 'echo  R', missing: ['steps.left.summary'] })
    expect(join.scope.steps?.left).toEqual({ status: 'skipped' })
    ctx.runner.complete(ctx.attemptOf(runId, 'join'), done())
    await flush()
    expect(ctx.wf().runs[runId].status).toBe('done')
  })

  it('refuses to start a definition whose effective steps let a writer run beside another step', async () => {
    const valid = detail('diamond')
    const steps = valid.definition?.steps.map((step) => (step.id === 'right' && step.kind === 'agent' ? { ...step, permissions: 'edit' as const } : step))
    const forged: WorkflowDefinitionDetail = { ...valid, definition: valid.definition && steps && { ...valid.definition, steps } }
    const ctx = setup({ deps: { loader: { getDefinition: () => forged } } })
    expect(await ctx.runner.start({ defId: 'personal:diamond', worktreePath: '/wt/diamond', inputs: {} })).toEqual({
      ok: false,
      reason: 'parallel-writer'
    })
    expect(Object.keys(ctx.wf().runs)).toEqual([])
    expect(ctx.agent.started).toEqual([])
  })
})

describe('WorkflowRunner parallel steps', () => {
  const setCap = (ctx: Ctx, cap: number) =>
    ctx.store.dispatch({ type: 'settings/workflowSettingsChanged', payload: { maxConcurrentAgents: cap } })

  const snapshotArtifacts = (restore: RunArtifacts['restore'] = async () => {}): RunArtifacts => ({
    prepare: async () => {},
    snapshot: async ({ n }) => ({ commit: String(n).repeat(40), ref: `refs/test/${n}` }),
    appendContext: async () => {},
    restore
  })

  async function afterPlan(slug: DefSlug, options: SetupOptions = {}) {
    const ctx = setup(options)
    const runId = await ctx.startRun(slug)
    await flush()
    ctx.runner.complete(ctx.attemptOf(runId, 'plan'), done('the plan'))
    await flush()
    return { ctx, runId }
  }

  it('queues the second read-only branch behind the cap and starts it when the first ends', async () => {
    const { ctx, runId } = await afterPlan('diamond', { cap: 1 })
    expect([ctx.stepStatus(runId, 'left'), ctx.stepStatus(runId, 'right')]).toEqual(['running', 'queued'])
    expect(ctx.wf().runs[runId].steps.right.attemptIds).toEqual([])
    ctx.runner.complete(ctx.attemptOf(runId, 'left'), done('L'))
    await flush()
    expect([ctx.stepStatus(runId, 'right'), ctx.stepStatus(runId, 'join')]).toEqual(['running', 'pending'])
    ctx.runner.complete(ctx.attemptOf(runId, 'right'), done('R'))
    await flush()
    expect(ctx.stepStatus(runId, 'join')).toBe('running')
    expect(ctx.agent.started.map((attempt) => attempt.stepId)).toEqual(['plan', 'left', 'right'])
  })

  it('runs a parallel_safe shell branch beside an agent branch that holds the only slot', async () => {
    const { ctx, runId } = await afterPlan('shell-branch', { cap: 1 })
    expect([ctx.stepStatus(runId, 'review'), ctx.stepStatus(runId, 'lint')]).toEqual(['running', 'running'])
    expect(ctx.shell.started.map((attempt) => attempt.stepId)).toEqual(['lint'])
  })

  it('lets a running sibling finish after a branch fails, and starts nothing new until the run resumes', async () => {
    const { ctx, runId } = await afterPlan('diamond')
    ctx.runner.complete(ctx.attemptOf(runId, 'left'), failed())
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'step-failed' })
    expect(ctx.stepStatus(runId, 'right')).toBe('running')
    ctx.runner.complete(ctx.attemptOf(runId, 'right'), done('R'))
    await flush()
    expect([ctx.stepStatus(runId, 'right'), ctx.stepStatus(runId, 'join')]).toEqual(['done', 'pending'])
    expect(ctx.shell.started).toEqual([])
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'step-failed' })
    expect(ctx.runner.skipStep(runId, 'left')).toEqual({ ok: true })
    expect(ctx.stepStatus(runId, 'join')).toBe('running')
  })

  it('keeps a queued sibling queued while another branch has paused the run', async () => {
    const { ctx, runId } = await afterPlan('diamond', { cap: 1 })
    ctx.runner.complete(ctx.attemptOf(runId, 'left'), failed())
    await flush()
    expect(ctx.stepStatus(runId, 'right')).toBe('queued')
    expect(ctx.agent.started.map((attempt) => attempt.stepId)).toEqual(['plan', 'left'])
    expect(ctx.runner.skipStep(runId, 'left')).toEqual({ ok: true })
    await flush()
    expect(ctx.stepStatus(runId, 'right')).toBe('running')
  })

  it('starts ready siblings held by a pause once a retry clears it', async () => {
    const { ctx, runId } = await afterPlan('triple', { cap: 2 })
    expect(['a', 'b', 'c'].map((id) => ctx.stepStatus(runId, id))).toEqual(['running', 'running', 'queued'])
    ctx.runner.complete(ctx.attemptOf(runId, 'a'), failed())
    ctx.runner.complete(ctx.attemptOf(runId, 'b'), done())
    await flush()
    expect(ctx.stepStatus(runId, 'c')).toBe('queued')
    expect(ctx.runner.retryStep(runId, 'a')).toEqual({ ok: true })
    await flush()
    expect(['a', 'b', 'c'].map((id) => ctx.stepStatus(runId, id))).toEqual(['running', 'done', 'running'])
  })

  it('starts a queued sibling when a needs-approval pause clears', async () => {
    const { ctx, runId } = await afterPlan('triple', { cap: 2 })
    const execution = ctx.agent.executionFor(ctx.attemptOf(runId, 'a'))
    ctx.agent.emit({ type: 'needsApproval', executionId: execution })
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'needs-approval' })
    ctx.runner.complete(ctx.attemptOf(runId, 'b'), done())
    await flush()
    expect(ctx.stepStatus(runId, 'c')).toBe('queued')
    ctx.agent.emit({ type: 'promptSubmitted', executionId: execution })
    await flush()
    expect(ctx.wf().runs[runId].status).toBe('running')
    expect(ctx.stepStatus(runId, 'c')).toBe('running')
  })

  it('launches a queued retry target past a sibling pause once a slot frees', async () => {
    const { ctx, runId } = await afterPlan('diamond')
    ctx.runner.complete(ctx.attemptOf(runId, 'left'), failed())
    ctx.runner.complete(ctx.attemptOf(runId, 'right'), failed())
    const other = await ctx.startRun('one-agent', '/wt/b')
    await flush()
    setCap(ctx, 1)
    expect(ctx.runner.retryStep(runId, 'left')).toEqual({ ok: true })
    expect(ctx.stepStatus(runId, 'left')).toBe('queued')
    ctx.runner.complete(ctx.attemptOf(other, 'plan'), done())
    await flush()
    expect(ctx.stepStatus(runId, 'left')).toBe('running')
    expect(ctx.stepStatus(runId, 'right')).toBe('failed')
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'step-failed' })
  })

  it('refuses retry from clean while a sibling attempt is live', async () => {
    const { ctx, runId } = await afterPlan('diamond', { artifacts: snapshotArtifacts() })
    ctx.runner.complete(ctx.attemptOf(runId, 'left'), failed())
    await flush()
    expect(await ctx.runner.retryFromClean(runId, 'left')).toEqual({ ok: false, reason: 'live-attempt' })
    expect(ctx.logs.some((line) => line.includes('step restored to base snapshot'))).toBe(false)
    ctx.runner.complete(ctx.attemptOf(runId, 'right'), done())
    await flush()
    expect(await ctx.runner.retryFromClean(runId, 'left')).toEqual({ ok: true })
    expect(ctx.stepStatus(runId, 'left')).toBe('running')
  })

  it('keeps a queued continuation of the run queued while a clean restore rewrites the tree', async () => {
    let finishRestore = (): void => {}
    const restore = () =>
      new Promise<void>((resolve) => {
        finishRestore = resolve
      })
    const { ctx, runId } = await afterPlan('diamond', { artifacts: snapshotArtifacts(restore) })
    ctx.runner.complete(ctx.attemptOf(runId, 'right'), done('R'))
    ctx.runner.complete(ctx.attemptOf(runId, 'left'), failed())
    const other = await ctx.startRun('one-agent', '/wt/b')
    await flush()
    setCap(ctx, 1)
    expect(ctx.runner.continueStep(runId, 'right', 'again')).toEqual({ ok: true })
    expect(ctx.stepStatus(runId, 'right')).toBe('queued')
    const pending = ctx.runner.retryFromClean(runId, 'left')
    await flush()
    ctx.runner.complete(ctx.attemptOf(other, 'plan'), done())
    await flush()
    expect(ctx.stepStatus(runId, 'right')).toBe('queued')
    finishRestore()
    expect(await pending).toEqual({ ok: true })
    await flush()
    expect([ctx.stepStatus(runId, 'right'), ctx.stepStatus(runId, 'left')]).toEqual(['running', 'queued'])
  })

  it('serializes the base snapshots of concurrent attempts and chains their parents', async () => {
    let inFlight = 0
    let maxInFlight = 0
    let made = 0
    const calls: Array<{ stepId: string; parent: string | undefined; commit: string }> = []
    const artifacts: RunArtifacts = {
      ...snapshotArtifacts(),
      snapshot: async ({ stepId, parent }) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await flush()
        const commit = String(++made).repeat(40)
        calls.push({ stepId, parent, commit })
        inFlight -= 1
        return { commit, ref: `refs/test/${made}` }
      }
    }
    const { ctx, runId } = await afterPlan('triple', { artifacts })
    for (let i = 0; i < 20; i++) await flush()
    expect(['a', 'b', 'c'].map((id) => ctx.stepStatus(runId, id))).toEqual(['running', 'running', 'running'])
    expect(maxInFlight).toBe(1)
    expect(calls.map((call) => call.stepId)).toEqual(['plan', 'plan', 'a', 'b', 'c'])
    calls.slice(1).forEach((call, i) => expect(call.parent).toBe(calls[i].commit))
    expect(ctx.agent.started.map((attempt) => attempt.stepId)).toEqual(['plan', 'a', 'b', 'c'])
  })

  it('holds a writer re-entered by a loop until a live sibling outside the span ends', async () => {
    const ctx = setup()
    const runId = await ctx.startRun('loop-diamond')
    await flush()
    const finish = async (stepId: string, result: StepResult = done(`${stepId}-out`)) => {
      ctx.runner.complete(ctx.attemptOf(runId, stepId), result)
      await flush()
    }
    await finish('plan')
    expect(['left', 'right', 'side'].map((id) => ctx.stepStatus(runId, id))).toEqual(['running', 'running', 'running'])
    await finish('left')
    await finish('right')
    await finish('review', { ...done('review-fail'), data: { verdict: 'fail' } })
    expect([ctx.stepStatus(runId, 'plan'), ctx.stepStatus(runId, 'side')]).toEqual(['pending', 'running'])
    await finish('side')
    expect(ctx.stepStatus(runId, 'plan')).toBe('running')
  })
})

describe('WorkflowRunner step actions', () => {
  it('refuses an action for a step that is not the current one, and retry on a running run', async () => {
    const ctx = setup()
    const runId = await ctx.startRun('two-agent')
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

  it('refuses retry from clean without run artifacts', async () => {
    const ctx = setup()
    const runId = await ctx.startRun('one-agent')
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
    const runId = await ctx.startRun('one-agent')
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
    const runA = await ctx.startRun('one-agent', '/wt/a')
    const runB = await ctx.startRun('one-agent', '/wt/b')
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
  it('refuses invalid, undeclared and status fields without touching the step', async () => {
    const ctx = setup()
    const runId = await ctx.startRun('review-then-act')
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
    const runId = await ctx.startRun('review-then-act')
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
    const runId = await ctx.startRun('review-then-act')
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

  it('accepts only a summary for a shell step', async () => {
    const ctx = setup()
    const runId = await ctx.startRun('shell-then-agent')
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
    const runId = await ctx.startRun('one-shell')
    await flush()
    ctx.runner.complete(ctx.attemptOf(runId, 'test'), failed())

    const pending = ctx.runner.retryFromClean(runId, 'test')
    await flush()
    expect(ctx.runner.cancelRun(runId)).toEqual({ ok: false, reason: 'busy' })
    expect(await ctx.runner.start({ defId: 'personal:one-shell', worktreePath: '/wt/one-shell', inputs: {} })).toEqual({
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
    expect(await runner.start(request)).toEqual({ ok: false, reason: 'starting' })
    runner.reconcile([])
    expect(await runner.start(request)).toEqual({ ok: true, runId: 'run-new' })
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
    expect(await runner.start(request)).toEqual({ ok: true, runId: 'run-new' })
    await flush()
    expect(agent.started).toHaveLength(1)
  })

  it('refuses start on a worktree whose hydrated run is not reconciled yet', async () => {
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
    expect(await runner.start(request)).toMatchObject({ ok: false })
    runner.reconcile([])
    expect(await runner.start(request)).toEqual({ ok: false, reason: 'worktree-busy' })
  })
})

describe('WorkflowRunner slice step facts and cursor', () => {
  it('starts the run with each step kind and agent and the first step as cursor', async () => {
    const ctx = setup()
    const runId = await ctx.startRun('shell-then-agent')
    const run = ctx.wf().runs[runId]
    expect(run.cursorStepId).toBe('test')
    expect(run.steps.test).toMatchObject({ kind: 'shell' })
    expect('agent' in run.steps.test).toBe(false)
    expect(run.steps.fix).toMatchObject({ kind: 'agent', agent: 'claude' })
  })

  it('moves the cursor when a step is skipped even if the next step is held with labs off', async () => {
    const ctx = setup()
    const runId = await ctx.startRun('two-agent')
    await flush()
    ctx.store.dispatch({ type: 'settings/labsChanged', payload: { workflows: false } })
    const types = ctx.eventsSince(() => expect(ctx.runner.skipStep(runId, 'plan')).toEqual({ ok: true }))
    expect(types).toContain('cursorChanged')
    expect(ctx.wf().runs[runId]).toMatchObject({ cursorStepId: 'build', status: 'paused', pausedReason: 'interrupted' })
    expect(ctx.stepStatus(runId, 'build')).toBe('pending')
  })

  it('moves the cursor on completion and dispatches no cursor change past the last step', async () => {
    const ctx = setup()
    const runId = await ctx.startRun('two-agent')
    await flush()
    ctx.runner.complete(ctx.attemptOf(runId, 'plan'), done())
    expect(ctx.wf().runs[runId].cursorStepId).toBe('build')
    await flush()
    const types = ctx.eventsSince(() => ctx.runner.complete(ctx.attemptOf(runId, 'build'), done()))
    expect(types).not.toContain('cursorChanged')
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'done', cursorStepId: 'build' })
  })
})

describe('WorkflowRunner attemptSessionRecorded', () => {
  it('dispatches once for a Claude attempt after the session id is persisted', async () => {
    const claude = claudeHarness()
    const ctx = setup({ agentDriver: claude.factory })
    claude.attach(ctx.runner)
    const persistedAtDispatch: Array<string | undefined> = []
    ctx.store.subscribe((event) => {
      if (event.type === 'workflows/attemptSessionRecorded') {
        persistedAtDispatch.push(ctx.records.at(-1)?.attempts.at(-1)?.sessionId)
      }
    })
    const runId = await ctx.startRun('one-agent')
    await flush()
    await flush()
    const attemptId = ctx.attemptOf(runId, 'plan')
    const recorded = ctx.events.filter((event) => event.type === 'workflows/attemptSessionRecorded')
    expect(recorded).toEqual([{ type: 'workflows/attemptSessionRecorded', payload: { attemptId } }])
    expect(persistedAtDispatch).toEqual([claude.tabs[0].spawn.sessionId])
    expect(ctx.wf().attempts[attemptId].resumable).toBe(true)
  })

  it('does not dispatch for an execution bound without a session', async () => {
    const ctx = setup()
    const runId = await ctx.startRun('one-shell')
    await flush()
    expect(ctx.events.some((event) => event.type === 'workflows/attemptSessionRecorded')).toBe(false)
    expect('resumable' in ctx.wf().attempts[ctx.attemptOf(runId, 'test')]).toBe(false)
  })
})

describe('WorkflowRunner.continueStep', () => {
  const CONTINUE_SECRET = 'CONTINUE-SECRET-ibis-3'
  const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e'

  function snapshotArtifacts() {
    const pending: Array<() => void> = []
    let hold = false
    const artifacts: RunArtifacts = {
      prepare: async () => {},
      snapshot: ({ n }) => {
        const ref = { commit: String(n % 10).repeat(40), ref: `refs/test/${n}` }
        if (!hold) return Promise.resolve(ref)
        return new Promise((resolve) => pending.push(() => resolve(ref)))
      },
      appendContext: async () => {},
      restore: async () => {}
    }
    return {
      artifacts,
      hold: () => {
        hold = true
      },
      release: () => {
        hold = false
        for (const resolve of pending.splice(0)) resolve()
      }
    }
  }

  async function pausedAfterPlan(options: SetupOptions = {}, alive = true) {
    const retagged: Array<{ worktreePath: string; tabId: string; workflow: Record<string, string> }> = []
    const ctx = setup({
      ...options,
      deps: {
        hasExecution: () => alive,
        retagStepTab: (worktreePath, tabId, workflow) => {
          retagged.push({ worktreePath, tabId, workflow: { ...workflow } })
        }
      }
    })
    const runId = await ctx.startRun('two-agent')
    await flush()
    const planAttempt = ctx.attemptOf(runId, 'plan')
    const execution = ctx.agent.executionFor(planAttempt)
    ctx.runner.complete(planAttempt, done(SUMMARY_SECRET))
    await flush()
    ctx.runner.complete(ctx.attemptOf(runId, 'build'), failed())
    await flush()
    return { ctx, runId, planAttempt, execution, retagged }
  }

  it('rebinds the live execution to a new attempt that complete_step then completes', async () => {
    const { ctx, runId, planAttempt, execution, retagged } = await pausedAfterPlan()
    expect(ctx.runner.stepForExecution(execution)).toMatchObject({ attemptId: planAttempt, ended: true })

    expect(ctx.runner.continueStep(runId, 'plan', `${CONTINUE_SECRET} fix it`)).toEqual({ ok: true })
    const attemptId = ctx.attemptOf(runId, 'plan')
    expect(attemptId).not.toBe(planAttempt)
    expect(ctx.wf().attempts[attemptId]).toMatchObject({ n: 2, status: 'running' })
    expect(ctx.stepStatus(runId, 'plan')).toBe('running')
    expect(retagged).toEqual([
      { worktreePath: '/wt/two-agent', tabId: execution, workflow: { runId, stepId: 'plan', attemptId } }
    ])
    expect(ctx.runner.stepForExecution(execution)).toMatchObject({ attemptId, ended: false })
    await flush()
    expect(ctx.agent.continued).toEqual([
      { attempt: expect.objectContaining({ attemptId, n: 2, stepId: 'plan' }), executionId: execution, prompt: `${CONTINUE_SECRET} fix it` }
    ])
    expect(ctx.agent.started).toHaveLength(2)
    expect(ctx.agent.released).toContain(execution)

    expect(ctx.runner.completeExecution(execution, { status: 'done', summary: 'fixed' })).toEqual({ ok: true })
    expect(ctx.wf().attempts[attemptId]).toMatchObject({ status: 'done', completedBy: 'tool' })
    const record = ctx.records.at(-1)?.attempts.find((attempt) => attempt.attemptId === attemptId)
    expect(record).toMatchObject({ executionId: execution, n: 2, status: 'done' })
    expect(ctx.runner.completeExecution(execution, { status: 'done', summary: 'again' })).toEqual({
      ok: false,
      reason: 'already-completed'
    })
    expect(ctx.logs.join('\n')).not.toContain(CONTINUE_SECRET)
  })

  it('takes the base snapshot before the prompt is sent and the head snapshot on completion', async () => {
    const snapshots = snapshotArtifacts()
    const { ctx, runId, execution } = await pausedAfterPlan({ artifacts: snapshots.artifacts })
    snapshots.hold()
    ctx.runner.continueStep(runId, 'plan', 'again')
    await flush()
    expect(ctx.agent.continued).toEqual([])
    snapshots.release()
    await vi.waitFor(() => expect(ctx.agent.continued).toHaveLength(1))
    const attemptId = ctx.attemptOf(runId, 'plan')
    ctx.runner.completeExecution(execution, { status: 'done', summary: 'fixed' })
    await vi.waitFor(() => {
      const record = ctx.runner.getRunRecord(runId)?.attempts.find((attempt) => attempt.attemptId === attemptId)
      expect(record?.baseSnapshot?.ref).toBe('refs/test/2')
      expect(record?.headSnapshot?.ref).toBe('refs/test/3')
    })
  })

  it('ignores stale Stop lines of the previous turn until the new turn ends', async () => {
    const { ctx, runId, execution } = await pausedAfterPlan()
    ctx.runner.continueStep(runId, 'plan', 'again')
    await flush()
    const attemptId = ctx.attemptOf(runId, 'plan')
    ctx.agent.emit({ type: 'turnEnded', executionId: execution, lastMessage: 'old', stopHookActive: true })
    ctx.agent.emit({ type: 'turnEnded', executionId: execution, lastMessage: 'old', continued: true })
    expect(ctx.wf().attempts[attemptId].status).toBe('running')

    expect(ctx.runner.stopCheck(execution, false)).toBe('block')
    ctx.agent.emit({ type: 'turnEnded', executionId: execution, lastMessage: 'old', stopHookActive: true })
    expect(ctx.wf().attempts[attemptId].status).toBe('running')
    ctx.agent.emit({ type: 'turnEnded', executionId: execution, lastMessage: 'nudged', continued: true })
    expect(ctx.wf().attempts[attemptId].status).toBe('running')
    ctx.agent.emit({ type: 'turnEnded', executionId: execution, lastMessage: 'second turn' })
    expect(ctx.records.at(-1)?.attempts.find((attempt) => attempt.attemptId === attemptId)?.result).toEqual({
      status: 'done',
      summary: 'second turn',
      completedBy: 'fallback'
    })
    expect(ctx.logs.some((line) => line.includes('stale turn end ignored'))).toBe(true)
  })

  it('completes on a new turn end that is not stale, and still honours an exit', async () => {
    const first = await pausedAfterPlan()
    first.ctx.runner.continueStep(first.runId, 'plan', 'again')
    await flush()
    first.ctx.agent.emit({ type: 'turnEnded', executionId: first.execution, lastMessage: 'turn two' })
    expect(first.ctx.wf().attempts[first.ctx.attemptOf(first.runId, 'plan')]).toMatchObject({
      status: 'done',
      completedBy: 'fallback'
    })

    const second = await pausedAfterPlan()
    second.ctx.runner.continueStep(second.runId, 'plan', 'again')
    await flush()
    second.ctx.agent.emit({ type: 'exited', executionId: second.execution, code: 1 })
    expect(second.ctx.wf().attempts[second.ctx.attemptOf(second.runId, 'plan')].status).toBe('failed')
  })

  it('fails the continued attempt when the driver cannot deliver the prompt', async () => {
    const { ctx, runId } = await pausedAfterPlan()
    ctx.agent.continueError = new StepStartError('agent is no longer running')
    ctx.runner.continueStep(runId, 'plan', 'again')
    await flush()
    expect(ctx.wf().attempts[ctx.attemptOf(runId, 'plan')]).toMatchObject({ status: 'failed', summaryPreview: 'agent is no longer running' })
    expect(ctx.stepStatus(runId, 'plan')).toBe('failed')
  })

  it('refuses finished and cancelled runs, shell steps, live or queued steps and steps with no attempt', async () => {
    const ctx = setup({ deps: { hasExecution: () => true } })
    const finished = await ctx.startRun('one-agent')
    await flush()
    ctx.runner.complete(ctx.attemptOf(finished, 'plan'), done())
    expect(ctx.runner.continueStep(finished, 'plan', 'p')).toEqual({ ok: false, reason: 'unknown-run' })

    const cancelled = await ctx.startRun('one-agent', '/wt/a')
    await flush()
    ctx.runner.cancelRun(cancelled)
    expect(ctx.runner.continueStep(cancelled, 'plan', 'p')).toEqual({ ok: false, reason: 'unknown-run' })

    const shellRun = await ctx.startRun('shell-then-agent')
    await flush()
    expect(ctx.runner.continueStep(shellRun, 'test', 'p')).toEqual({ ok: false, reason: 'not-continuable-step' })

    const live = await ctx.startRun('two-agent')
    await flush()
    expect(ctx.runner.continueStep(live, 'plan', 'p')).toEqual({ ok: false, reason: 'live-attempt' })
    expect(ctx.runner.continueStep(live, 'build', 'p')).toEqual({ ok: false, reason: 'nothing-to-continue' })
    expect(ctx.runner.continueStep(live, 'nope', 'p')).toEqual({ ok: false, reason: 'wrong-step' })
    expect(ctx.agent.continued).toEqual([])
    expect(ctx.wf().runs[finished].status).toBe('done')
    expect(ctx.wf().runs[cancelled].status).toBe('cancelled')
  })

  it('refuses while labs is off', async () => {
    const { ctx, runId } = await pausedAfterPlan()
    ctx.store.dispatch({ type: 'settings/labsChanged', payload: { workflows: false } })
    expect(ctx.runner.continueStep(runId, 'plan', 'p')).toEqual({ ok: false, reason: 'labs-off' })
  })

  it('resumes the recorded session in a new execution with the prompt when the PTY is gone', async () => {
    const ctx = setup({ deps: { hasExecution: () => false } })
    ctx.agent.sessionId = SESSION
    const runId = await ctx.startRun('two-agent')
    await flush()
    ctx.runner.complete(ctx.attemptOf(runId, 'plan'), done(SUMMARY_SECRET))
    await flush()
    ctx.runner.complete(ctx.attemptOf(runId, 'build'), failed())
    await flush()

    expect(ctx.runner.continueStep(runId, 'plan', `${CONTINUE_SECRET} fix`)).toEqual({ ok: true })
    await flush()
    expect(ctx.agent.continued).toEqual([])
    expect(ctx.agent.started.at(-1)).toMatchObject({ stepId: 'plan', n: 2, resumeSessionId: SESSION, prompt: `${CONTINUE_SECRET} fix` })
    const attemptId = ctx.attemptOf(runId, 'plan')
    expect(ctx.agent.executionFor(attemptId)).toBe('agent-exec-3')
    expect(ctx.logs.join('\n')).not.toContain(CONTINUE_SECRET)
  })

  it('does not resume a session recorded under another harness after a swap', async () => {
    const ctx = setup({ deps: { hasExecution: () => false } })
    ctx.agent.sessionId = SESSION
    const runId = await ctx.startRun('one-agent')
    await flush()
    ctx.runner.complete(ctx.attemptOf(runId, 'plan'), failed())
    ctx.agent.sessionId = undefined
    expect(ctx.runner.swapStep(runId, 'plan', { agent: 'opencode' })).toEqual({ ok: true })
    await flush()
    ctx.runner.complete(ctx.attemptOf(runId, 'plan'), failed())

    expect(ctx.runner.continueStep(runId, 'plan', 'fix')).toEqual({ ok: true })
    await flush()
    expect(ctx.agent.started.at(-1)).toMatchObject({ n: 3, step: { agent: 'opencode' } })
    expect(ctx.agent.started.at(-1)?.resumeSessionId).toBeUndefined()
  })

  it('starts a fresh session with the previous summary when the PTY is gone and no session was recorded', async () => {
    const { ctx, runId, retagged } = await pausedAfterPlan({}, false)
    ctx.runner.continueStep(runId, 'plan', `${CONTINUE_SECRET} fix`)
    await flush()
    const started = ctx.agent.started.at(-1)
    expect(started).toMatchObject({ stepId: 'plan', n: 2, prompt: `${CONTINUE_SECRET} fix\n\nPrevious result:\n${SUMMARY_SECRET}` })
    expect(started?.resumeSessionId).toBeUndefined()
    expect(retagged).toEqual([])
    expect(ctx.logs.join('\n')).not.toContain(CONTINUE_SECRET)
  })

  it('queues a fallback start behind the agent cap and launches it with the prompt once a slot frees', async () => {
    const ctx = setup({ cap: 1, deps: { hasExecution: () => false } })
    const runId = await ctx.startRun('one-agent')
    await flush()
    ctx.runner.complete(ctx.attemptOf(runId, 'plan'), failed(SUMMARY_SECRET))
    const other = await ctx.startRun('one-agent', '/wt/a')
    await flush()
    ctx.runner.continueStep(runId, 'plan', `${CONTINUE_SECRET} fix`)
    expect(ctx.stepStatus(runId, 'plan')).toBe('queued')
    const before = ctx.agent.started.length
    ctx.runner.complete(ctx.attemptOf(other, 'plan'), done())
    await flush()
    expect(ctx.agent.started).toHaveLength(before + 1)
    expect(ctx.agent.started.at(-1)).toMatchObject({
      runId,
      stepId: 'plan',
      prompt: `${CONTINUE_SECRET} fix\n\nPrevious result:\n${SUMMARY_SECRET}`
    })
    expect(ctx.runner.continueStep(runId, 'plan', 'p')).toEqual({ ok: false, reason: 'live-attempt' })
  })

  async function cappedContinue(alive: boolean) {
    const ctx = setup({ cap: 1, deps: { hasExecution: () => alive } })
    ctx.agent.sessionId = SESSION
    const runId = await ctx.startRun('one-agent')
    await flush()
    const first = ctx.attemptOf(runId, 'plan')
    const execution = ctx.agent.executionFor(first)
    ctx.runner.complete(first, failed(SUMMARY_SECRET))
    ctx.agent.sessionId = undefined
    const other = await ctx.startRun('one-agent', '/wt/a')
    await flush()
    expect(ctx.runner.continueStep(runId, 'plan', `${CONTINUE_SECRET} fix`)).toEqual({ ok: true })
    return { ctx, runId, first, execution, other }
  }

  it('queues a continuation behind the agent cap and rebinds the live PTY once a slot frees', async () => {
    const { ctx, runId, first, execution, other } = await cappedContinue(true)
    expect(ctx.stepStatus(runId, 'plan')).toBe('queued')
    expect(ctx.attemptOf(runId, 'plan')).toBe(first)
    expect(ctx.agent.continued).toEqual([])
    expect(ctx.records.at(-1)?.continuations).toEqual({ plan: { prompt: `${CONTINUE_SECRET} fix` } })

    ctx.runner.complete(ctx.attemptOf(other, 'plan'), done())
    await flush()
    expect(ctx.agent.continued).toEqual([
      expect.objectContaining({ executionId: execution, prompt: `${CONTINUE_SECRET} fix` })
    ])
    expect(ctx.wf().attempts[ctx.attemptOf(runId, 'plan')]).toMatchObject({ n: 2, status: 'running' })
    expect(ctx.runner.getRunRecord(runId)?.continuations).toBeUndefined()
    expect(ctx.logs.join('\n')).not.toContain(CONTINUE_SECRET)
  })

  it('relaunches a queued continuation after a restart with its prompt and the recorded session', async () => {
    const { ctx, runId } = await cappedContinue(true)
    const onDisk = ctx.records.filter((record) => record.runId === runId).at(-1)
    if (!onDisk) throw new Error('no record')

    const after = setup({ deps: { hasExecution: () => false } })
    after.runner.reconcile([onDisk])
    await flush()

    expect(after.agent.started).toHaveLength(1)
    expect(after.agent.started[0]).toMatchObject({ runId, stepId: 'plan', n: 2, resumeSessionId: SESSION, prompt: `${CONTINUE_SECRET} fix` })
    expect(after.runner.getRunRecord(runId)?.continuations).toBeUndefined()
    expect(after.logs.join('\n')).not.toContain(CONTINUE_SECRET)
  })

  it.each([
    ['a non-string prompt', { prompt: 42 }],
    ['a fresh flag that is not true', { prompt: 'x', fresh: 'yes' }],
    ['a non-object entry', 'x']
  ])('ignores a stored continuation with %s and runs the step template', async (_name, stored) => {
    const { ctx, runId } = await cappedContinue(true)
    const onDisk = structuredClone(ctx.records.filter((record) => record.runId === runId).at(-1))
    if (!onDisk) throw new Error('no record')
    onDisk.continuations = { plan: stored } as never

    const after = setup({ deps: { hasExecution: () => false } })
    after.runner.reconcile([onDisk])
    await flush()

    expect(after.agent.started).toHaveLength(1)
    expect(after.agent.started[0].prompt).toBeUndefined()
    expect(after.runner.getRunRecord(runId)?.continuations).toBeUndefined()
  })

  it('drops the stored continuation when the queued step is cancelled', async () => {
    const { ctx, runId } = await cappedContinue(false)
    expect(ctx.runner.cancelStep(runId, 'plan')).toEqual({ ok: true })
    expect(ctx.runner.getRunRecord(runId)?.continuations).toBeUndefined()
    expect(ctx.records.at(-1)?.continuations).toBeUndefined()
  })

  it('starts a new execution with the previous summary on fresh even when the PTY is alive', async () => {
    const { ctx, runId, execution } = await pausedAfterPlan()
    ctx.agent.sessionId = SESSION
    ctx.runner.continueStep(runId, 'plan', 'redo', { fresh: true })
    await flush()
    expect(ctx.agent.continued).toEqual([])
    const started = ctx.agent.started.at(-1)
    expect(started).toMatchObject({ n: 2, prompt: `redo\n\nPrevious result:\n${SUMMARY_SECRET}` })
    expect(started?.resumeSessionId).toBeUndefined()
    expect(ctx.agent.executionFor(ctx.attemptOf(runId, 'plan'))).not.toBe(execution)
  })
})

describe('WorkflowRunner gates', () => {
  const FEEDBACK_SECRET = 'FEEDBACK-SECRET-heron-8'

  async function gatedRun(options: SetupOptions = {}, alive = true) {
    const ctx = setup({ ...options, deps: { hasExecution: () => alive, ...options.deps } })
    const runId = await ctx.startRun('gated')
    await flush()
    const first = ctx.attemptOf(runId, 'plan')
    const execution = ctx.agent.executionFor(first)
    return { ctx, runId, first, execution }
  }

  async function atGate(options: SetupOptions = {}, alive = true) {
    const run = await gatedRun(options, alive)
    run.ctx.runner.complete(run.first, done(SUMMARY_SECRET))
    return run
  }

  it('stops a gated step at its gate on done: attempt done, step awaiting-gate, run paused gate, dependents wait', async () => {
    const { ctx, runId, first } = await gatedRun()
    const seen = ctx.eventsSince(() => ctx.runner.complete(first, done(SUMMARY_SECRET)))
    expect(seen).toEqual(['attemptEnded', 'stepStatusChanged', 'runPaused'])
    expect(ctx.wf().attempts[first]).toMatchObject({ status: 'done', completedBy: 'tool' })
    expect(ctx.stepStatus(runId, 'plan')).toBe('awaiting-gate')
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'gate', cursorStepId: 'plan' })
    await flush()
    expect(ctx.shell.started).toEqual([])
    expect(ctx.stepStatus(runId, 'test')).toBe('pending')
    expect(ctx.records.at(-1)).toMatchObject({ status: 'paused', pausedReason: 'gate', steps: { plan: 'awaiting-gate' } })
    expect(ctx.records.at(-1)?.attempts[0].metrics.pauses.map((pause) => pause.reason)).toEqual(['gate'])
  })

  it('gates a turn-end fallback completion and a shell exit 0, but not a failure', async () => {
    const fallback = await gatedRun()
    fallback.ctx.agent.emit({ type: 'turnEnded', executionId: fallback.execution, lastMessage: 'planned' })
    expect(fallback.ctx.stepStatus(fallback.runId, 'plan')).toBe('awaiting-gate')

    const ctx = setup()
    const shellRun = await ctx.startRun('gated-shell')
    await flush()
    ctx.shell.emit({ type: 'exited', executionId: ctx.shell.executionFor(ctx.attemptOf(shellRun, 'test')), code: 0 })
    expect(ctx.stepStatus(shellRun, 'test')).toBe('awaiting-gate')
    expect(ctx.wf().runs[shellRun].pausedReason).toBe('gate')

    const failing = await gatedRun()
    failing.ctx.runner.complete(failing.first, failed())
    expect(failing.ctx.stepStatus(failing.runId, 'plan')).toBe('failed')
    expect(failing.ctx.wf().runs[failing.runId].pausedReason).toBe('step-failed')
  })

  it('replaces a needs-approval pause of the same step with the gate in place', async () => {
    const { ctx, runId, first, execution } = await gatedRun()
    ctx.agent.emit({ type: 'needsApproval', executionId: execution })
    const seen = ctx.eventsSince(() => ctx.runner.complete(first, done()))
    expect(seen).not.toContain('runResumed')
    expect(ctx.wf().runs[runId].pausedReason).toBe('gate')
  })

  it('never relaunches a step awaiting its gate when other actions reschedule', async () => {
    const { ctx, runId } = await atGate()
    ctx.runner.reschedule()
    await flush()
    expect(ctx.agent.started).toHaveLength(1)
    expect(ctx.shell.started).toEqual([])
    expect(ctx.stepStatus(runId, 'plan')).toBe('awaiting-gate')
  })

  it('approve marks the step done, dispatches gateResolved, persists and starts the dependents', async () => {
    const { ctx, runId } = await atGate()
    const seen = ctx.eventsSince(() => expect(ctx.runner.approveGate(runId, 'plan')).toEqual({ ok: true }))
    expect(seen).toEqual(['cursorChanged', 'runResumed', 'gateResolved', 'stepStarted', 'attemptStarted'])
    expect(ctx.events.find((event) => event.type === 'workflows/gateResolved')?.payload).toEqual({
      runId,
      stepId: 'plan',
      decision: 'approved'
    })
    expect(ctx.stepStatus(runId, 'plan')).toBe('done')
    expect(ctx.stepStatus(runId, 'test')).toBe('running')
    expect(ctx.records.at(-1)).toMatchObject({ status: 'running', steps: { plan: 'done', test: 'running' } })
    expect(ctx.records.at(-1)?.pausedReason).toBeUndefined()
    expect(ctx.logs).toContain(`[workflow] gate approved ${JSON.stringify({ runId, stepId: 'plan' })}`)

    const again = ctx.eventsSince(() =>
      expect(ctx.runner.approveGate(runId, 'plan')).toEqual({ ok: false, reason: 'not-awaiting-gate' })
    )
    expect(again).toEqual([])
    expect(ctx.runner.requestChanges(runId, 'plan', { feedback: 'x', fresh: false })).toEqual({
      ok: false,
      reason: 'not-awaiting-gate'
    })
    await flush()
    ctx.shell.emit({ type: 'exited', executionId: ctx.shell.executionFor(ctx.attemptOf(runId, 'test')), code: 0 })
    expect(ctx.wf().runs[runId].status).toBe('done')
  })

  it('request changes continues the same execution as attempt n+1 and shows the gate again on done', async () => {
    const retagged: string[] = []
    const { ctx, runId, first, execution } = await atGate({
      deps: { retagStepTab: (_path, tabId, workflow) => retagged.push(`${tabId}:${workflow.attemptId}`) }
    })
    const seen = ctx.eventsSince(() =>
      expect(ctx.runner.requestChanges(runId, 'plan', { feedback: `${FEEDBACK_SECRET} tighten`, fresh: false })).toEqual({
        ok: true
      })
    )
    expect(seen).toEqual(['gateResolved', 'runResumed', 'stepStarted', 'attemptStarted'])
    const second = ctx.attemptOf(runId, 'plan')
    expect(second).not.toBe(first)
    expect(ctx.wf().attempts[second]).toMatchObject({ n: 2, status: 'running' })
    expect(ctx.stepStatus(runId, 'plan')).toBe('running')
    expect(retagged).toEqual([`${execution}:${second}`])
    await flush()
    expect(ctx.agent.continued).toEqual([
      expect.objectContaining({ executionId: execution, prompt: `${FEEDBACK_SECRET} tighten` })
    ])
    expect(ctx.runner.completeExecution(execution, { status: 'done', summary: 'tighter' })).toEqual({ ok: true })
    expect(ctx.stepStatus(runId, 'plan')).toBe('awaiting-gate')
    expect(ctx.wf().runs[runId].pausedReason).toBe('gate')
    expect(ctx.shell.started).toEqual([])
    expect(ctx.logs).toContain(`[workflow] gate changes requested ${JSON.stringify({ runId, stepId: 'plan' })}`)
    expect(ctx.logs.join('\n')).not.toContain(FEEDBACK_SECRET)
    expect(JSON.stringify(ctx.events)).not.toContain(FEEDBACK_SECRET)
  })

  it('request changes with fresh starts a new session with the feedback and the previous summary, sanitized', async () => {
    const { ctx, runId, execution } = await atGate()
    ctx.runner.requestChanges(runId, 'plan', { feedback: `redo\x1b[201~\x07 it\n`, fresh: true })
    await flush()
    expect(ctx.agent.continued).toEqual([])
    expect(ctx.agent.started.at(-1)).toMatchObject({ n: 2, prompt: `redo[201~ it\n\n\nPrevious result:\n${SUMMARY_SECRET}` })
    expect(ctx.agent.executionFor(ctx.attemptOf(runId, 'plan'))).not.toBe(execution)
  })

  it('request changes after the PTY is gone resumes the recorded session with the sanitized feedback only', async () => {
    const ctx = setup({ deps: { hasExecution: () => false } })
    ctx.agent.sessionId = '0f8fad5b-d9cb-469f-a165-70867728950e'
    const runId = await ctx.startRun('gated')
    await flush()
    ctx.runner.complete(ctx.attemptOf(runId, 'plan'), done(SUMMARY_SECRET))
    ctx.runner.requestChanges(runId, 'plan', { feedback: 'again\x9b', fresh: false })
    await flush()
    expect(ctx.agent.started.at(-1)).toMatchObject({
      n: 2,
      resumeSessionId: '0f8fad5b-d9cb-469f-a165-70867728950e',
      prompt: 'again'
    })
  })

  it.each([
    ['labs off', (ctx: Ctx) => ctx.store.dispatch({ type: 'settings/labsChanged', payload: { workflows: false } }), 'labs-off'],
    ['the step is a shell step', null, 'not-continuable-step']
  ] as const)('a refused request changes (%s) leaves the gate and its pause untouched', async (_name, arrange, reason) => {
    const ctx = setup({ deps: { hasExecution: () => true } })
    const slug = arrange ? 'gated' : 'gated-shell'
    const stepId = arrange ? 'plan' : 'test'
    const runId = await ctx.startRun(slug)
    await flush()
    const attempt = ctx.attemptOf(runId, stepId)
    if (arrange) ctx.runner.complete(attempt, done())
    else ctx.shell.emit({ type: 'exited', executionId: ctx.shell.executionFor(attempt), code: 0 })
    arrange?.(ctx)
    const persistedBefore = ctx.persisted.length
    const seen = ctx.eventsSince(() =>
      expect(ctx.runner.requestChanges(runId, stepId, { feedback: 'x', fresh: false })).toEqual({ ok: false, reason })
    )
    expect(seen).toEqual([])
    expect(ctx.persisted).toHaveLength(persistedBefore)
    expect(ctx.stepStatus(runId, stepId)).toBe('awaiting-gate')
    expect(ctx.runner.getRunRecord(runId)).toMatchObject({ status: 'paused', pausedReason: 'gate', steps: { [stepId]: 'awaiting-gate' } })
    if (!arrange) {
      expect(ctx.runner.approveGate(runId, stepId)).toEqual({ ok: true })
      await flush()
      expect(ctx.stepStatus(runId, 'fix')).toBe('running')
    }
  })

  it('refuses approve and request changes on unknown runs and steps, a step not at its gate, labs off and a runner with no runs yet', async () => {
    const { ctx, runId } = await atGate()
    const changes = { feedback: 'x', fresh: false }
    expect(ctx.runner.approveGate('nope', 'plan')).toEqual({ ok: false, reason: 'unknown-run' })
    expect(ctx.runner.approveGate(runId, 'nope')).toEqual({ ok: false, reason: 'wrong-step' })
    expect(ctx.runner.requestChanges(runId, 'nope', changes)).toEqual({ ok: false, reason: 'wrong-step' })
    expect(ctx.runner.approveGate(runId, 'test')).toEqual({ ok: false, reason: 'not-awaiting-gate' })
    ctx.store.dispatch({ type: 'settings/labsChanged', payload: { workflows: false } })
    expect(ctx.runner.approveGate(runId, 'plan')).toEqual({ ok: false, reason: 'labs-off' })
    expect(ctx.stepStatus(runId, 'plan')).toBe('awaiting-gate')

    const fresh = setup()
    const unready = new WorkflowRunner({
      store: fresh.store,
      loader: { getDefinition: () => null },
      drivers: { agent: new FakeStepDriver('agent'), shell: new FakeStepDriver('shell') },
      now: () => 1,
      newId: () => 'id',
      log: () => {}
    })
    expect(unready.approveGate('nope', 'plan')).toEqual({ ok: false, reason: 'unknown-run' })
  })

  it('markDone on a running gated step counts as the approval; on a step awaiting its gate it is refused', async () => {
    const running = await gatedRun()
    expect(running.ctx.runner.markDone(running.runId, 'plan', { summary: 'by hand', fields: {} })).toEqual({ ok: true })
    expect(running.ctx.stepStatus(running.runId, 'plan')).toBe('done')
    expect(running.ctx.events.some((event) => event.type === 'workflows/gateResolved')).toBe(false)
    await flush()
    expect(running.ctx.stepStatus(running.runId, 'test')).toBe('running')

    const { ctx, runId } = await atGate()
    expect(ctx.runner.markDone(runId, 'plan', { summary: 'by hand', fields: {} })).toEqual({
      ok: false,
      reason: 'not-completable'
    })
    expect(ctx.stepStatus(runId, 'plan')).toBe('awaiting-gate')
  })

  it('other step actions on a step awaiting its gate either refuse or clear the gate entry', async () => {
    const refusals = await atGate()
    const { runner } = refusals.ctx
    const id = refusals.runId
    expect(runner.cancelStep(id, 'plan')).toEqual({ ok: false, reason: 'nothing-to-cancel' })
    expect(runner.swapStep(id, 'plan', { model: 'm' })).toEqual({ ok: false, reason: 'not-swappable' })
    expect(runner.resumeStep(id, 'plan')).toEqual({ ok: false, reason: 'not-interrupted' })
    expect(refusals.ctx.runner.getRunRecord(id)).toMatchObject({ status: 'paused', pausedReason: 'gate' })
    expect(runner.approveGate(id, 'plan')).toEqual({ ok: true })

    const skipped = await atGate()
    expect(skipped.ctx.runner.skipStep(skipped.runId, 'plan')).toEqual({ ok: true })
    expect(skipped.ctx.stepStatus(skipped.runId, 'plan')).toBe('skipped')
    expect(skipped.ctx.wf().runs[skipped.runId].status).toBe('running')
    expect(skipped.ctx.runner.approveGate(skipped.runId, 'plan')).toEqual({ ok: false, reason: 'not-awaiting-gate' })

    const retried = await atGate()
    expect(retried.ctx.runner.retryStep(retried.runId, 'plan')).toEqual({ ok: true })
    await flush()
    expect(retried.ctx.wf().attempts[retried.ctx.attemptOf(retried.runId, 'plan')]).toMatchObject({ n: 2, status: 'running' })
    expect(retried.ctx.wf().runs[retried.runId].status).toBe('running')
    retried.ctx.runner.complete(retried.ctx.attemptOf(retried.runId, 'plan'), done())
    expect(retried.ctx.stepStatus(retried.runId, 'plan')).toBe('awaiting-gate')

    const cancelled = await atGate()
    expect(cancelled.ctx.runner.cancelRun(cancelled.runId)).toEqual({ ok: true })
    expect(cancelled.ctx.wf().runs[cancelled.runId].status).toBe('cancelled')
    expect(cancelled.ctx.runner.approveGate(cancelled.runId, 'plan')).toEqual({ ok: false, reason: 'unknown-run' })
  })

  it('launches a queued changes-requested continuation once a slot frees', async () => {
    const ctx = setup({ cap: 1, deps: { hasExecution: () => true } })
    const runId = await ctx.startRun('gated')
    await flush()
    const first = ctx.attemptOf(runId, 'plan')
    const execution = ctx.agent.executionFor(first)
    ctx.runner.complete(first, done())
    const other = await ctx.startRun('one-agent', '/wt/a')
    await flush()
    expect(ctx.runner.requestChanges(runId, 'plan', { feedback: 'fix', fresh: false })).toEqual({ ok: true })
    expect(ctx.stepStatus(runId, 'plan')).toBe('queued')
    ctx.runner.complete(ctx.attemptOf(other, 'plan'), done())
    await flush()
    expect(ctx.agent.continued).toEqual([expect.objectContaining({ executionId: execution, prompt: 'fix' })])
    expect(ctx.stepStatus(runId, 'plan')).toBe('running')
  })
})

describe('WorkflowRunner autopilot', () => {
  async function autopilotRun(slug: DefSlug, autopilot: unknown = true) {
    const ctx = setup()
    const request = { defId: `personal:${slug}`, worktreePath: `/wt/${slug}`, inputs: {}, autopilot }
    const result = await ctx.runner.start(request as unknown as Parameters<typeof ctx.runner.start>[0])
    if (!result.ok) throw new Error(`start refused: ${result.reason}`)
    await flush()
    return { ctx, runId: result.runId }
  }

  it('passes the gate on done without pausing: gateResolved autopilot, step done, dependents start', async () => {
    const { ctx, runId } = await autopilotRun('gated')
    expect(ctx.records.at(-1)?.autopilot).toBe(true)
    const first = ctx.attemptOf(runId, 'plan')
    const seen = ctx.eventsSince(() => ctx.runner.complete(first, done(SUMMARY_SECRET)))
    expect(seen).not.toContain('runPaused')
    expect(seen).not.toContain('runResumed')
    expect(seen.filter((type) => type === 'gateResolved')).toHaveLength(1)
    const stepDone = ctx.events.findIndex(
      (event) => event.type === 'workflows/stepStatusChanged' && event.payload.stepId === 'plan' && event.payload.status === 'done'
    )
    const resolved = ctx.events.findIndex((event) => event.type === 'workflows/gateResolved')
    expect(stepDone).toBeGreaterThanOrEqual(0)
    expect(stepDone).toBeLessThan(resolved)
    expect(ctx.logs).toContain(`[workflow] step done ${JSON.stringify({ runId, stepId: 'plan' })}`)
    expect(ctx.events.find((event) => event.type === 'workflows/gateResolved')?.payload).toEqual({
      runId,
      stepId: 'plan',
      decision: 'autopilot'
    })
    expect(ctx.wf().attempts[first]).toMatchObject({ status: 'done' })
    expect(ctx.stepStatus(runId, 'plan')).toBe('done')
    expect(ctx.stepStatus(runId, 'test')).toBe('running')
    expect(ctx.records.at(-1)).toMatchObject({ status: 'running', autopilot: true, steps: { plan: 'done', test: 'running' } })
    expect(ctx.records.at(-1)?.attempts[0].metrics.pauses).toEqual([])
    expect(ctx.logs).toContain(`[workflow] gate approved ${JSON.stringify({ runId, stepId: 'plan', decision: 'autopilot' })}`)
    expect(ctx.logs.some((line) => line.includes('run paused'))).toBe(false)
    expect(ctx.runner.approveGate(runId, 'plan')).toEqual({ ok: false, reason: 'not-awaiting-gate' })
    await flush()
    ctx.shell.emit({ type: 'exited', executionId: ctx.shell.executionFor(ctx.attemptOf(runId, 'test')), code: 0 })
    expect(ctx.wf().runs[runId].status).toBe('done')
    expect(ctx.events.filter((event) => event.type === 'workflows/runFinished')).toHaveLength(1)
  })

  it('passes a gated shell step on exit 0', async () => {
    const { ctx, runId } = await autopilotRun('gated-shell')
    ctx.shell.emit({ type: 'exited', executionId: ctx.shell.executionFor(ctx.attemptOf(runId, 'test')), code: 0 })
    expect(ctx.stepStatus(runId, 'test')).toBe('done')
    expect(ctx.wf().runs[runId].status).toBe('running')
    await flush()
    expect(ctx.stepStatus(runId, 'fix')).toBe('running')
  })

  it('still pauses a failed step and still stops at a gate a needs-approval pause held', async () => {
    const failing = await autopilotRun('gated')
    failing.ctx.runner.complete(failing.ctx.attemptOf(failing.runId, 'plan'), failed())
    expect(failing.ctx.wf().runs[failing.runId].pausedReason).toBe('step-failed')

    const held = await autopilotRun('gated')
    const first = held.ctx.attemptOf(held.runId, 'plan')
    held.ctx.agent.emit({ type: 'needsApproval', executionId: held.ctx.agent.executionFor(first) })
    expect(held.ctx.wf().runs[held.runId].pausedReason).toBe('needs-approval')
    const seen = held.ctx.eventsSince(() => held.ctx.runner.complete(first, done()))
    expect(seen).toContain('runResumed')
    expect(seen).toContain('gateResolved')
    expect(held.ctx.stepStatus(held.runId, 'plan')).toBe('done')
    expect(held.ctx.wf().runs[held.runId].status).toBe('running')
  })

  it.each<[string, unknown]>([
    ['false', false],
    ['the string true', 'true'],
    ['the number 1', 1]
  ])('stops at the gate when autopilot is %s', async (_name, autopilot) => {
    const { ctx, runId } = await autopilotRun('gated', autopilot)
    expect(ctx.records.at(-1)?.autopilot).toBeUndefined()
    ctx.runner.complete(ctx.attemptOf(runId, 'plan'), done())
    expect(ctx.stepStatus(runId, 'plan')).toBe('awaiting-gate')
    expect(ctx.wf().runs[runId].pausedReason).toBe('gate')
  })

  it('never grants full permissions: a full workflow on autopilot still needs allowFull', async () => {
    const ctx = setup()
    const request = { defId: 'personal:full-agent', worktreePath: '/wt/a', inputs: {}, autopilot: true }
    expect(await ctx.runner.start(request)).toEqual({ ok: false, reason: 'full-permission-unconfirmed' })
    expect(Object.keys(ctx.wf().runs)).toEqual([])
    expect((await ctx.runner.start({ ...request, allowFull: true })).ok).toBe(true)
  })
})

describe('WorkflowRunner loops', () => {
  const verdict = (value: string | undefined, summary = `review-${value ?? 'none'}`): StepResult => ({
    ...done(summary),
    ...(value === undefined ? {} : { data: { verdict: value } })
  })

  async function loopRun(slug: DefSlug, alive = true) {
    const ctx = setup({ deps: { hasExecution: () => alive } })
    const runId = await ctx.startRun(slug)
    await flush()
    const finish = async (stepId: string, result: StepResult = done(`${stepId}-out`)) => {
      expect(ctx.runner.complete(ctx.attemptOf(runId, stepId), result)).toBe(true)
      await flush()
    }
    const exitShell = async (stepId: string) => {
      ctx.shell.emit({ type: 'exited', executionId: ctx.shell.executionFor(ctx.attemptOf(runId, stepId)), code: 0 })
      await flush()
    }
    const attempts = (stepId: string) => ctx.wf().runs[runId].steps[stepId].attemptIds.length
    return { ctx, runId, finish, exitShell, attempts }
  }

  it('re-runs exactly the loop span over a diamond, continuing each agent step on its own terminal', async () => {
    const { ctx, runId, finish, attempts } = await loopRun('loop-diamond')
    for (const stepId of ['plan', 'left', 'right', 'side']) await finish(stepId)
    const executions = Object.fromEntries(['plan', 'left', 'right', 'review'].map((id) => [id, ctx.agent.executionFor(ctx.attemptOf(runId, id))]))
    await finish('review', verdict('fail'))
    expect(ctx.stepStatus(runId, 'side')).toBe('done')
    expect(ctx.stepStatus(runId, 'plan')).toBe('running')
    expect(ctx.wf().runs[runId].status).toBe('running')
    for (const stepId of ['plan', 'left', 'right']) await finish(stepId)
    await finish('review', verdict('pass'))
    expect(ctx.wf().runs[runId].status).toBe('done')
    expect(Object.fromEntries(['plan', 'left', 'right', 'side', 'review'].map((id) => [id, attempts(id)]))).toEqual({
      plan: 2,
      left: 2,
      right: 2,
      side: 1,
      review: 2
    })
    expect(ctx.agent.continued.map((entry) => [entry.attempt.stepId, entry.executionId])).toEqual(
      ['plan', 'left', 'right', 'review'].map((id) => [id, executions[id]])
    )
    expect(ctx.logs).toContain(`[workflow] loop back ${JSON.stringify({ runId, stepId: 'review', backTo: 'plan' })}`)
  })

  it('continues with the rendered on_loop prompt or the default feedback prompt, and relaunches shell steps from scratch', async () => {
    const { ctx, runId, finish, exitShell } = await loopRun('loop-prompts')
    await finish('build', done('built-1'))
    await exitShell('test')
    await finish('note', done('noted-1'))
    await finish('review', verdict('fail', 'review-1'))
    await finish('build', done('built-2'))
    expect(ctx.shell.started.map((attempt) => attempt.stepId)).toEqual(['test', 'test'])
    expect(ctx.shell.started[1].prompt).toBeUndefined()
    await exitShell('test')
    await finish('note', done('noted-2'))
    await finish('review', verdict('pass', 'review-2'))
    expect(ctx.agent.continued.map((entry) => [entry.attempt.stepId, entry.prompt])).toEqual([
      ['build', 'Your previous result was:\nbuilt-1\n\nAddress this feedback from review:\nreview-1'],
      ['note', `${PROMPT_SECRET} again after review-1 with built-2`],
      ['review', 'Your previous result was:\nreview-1\n\nAddress this feedback from review:\nreview-1']
    ])
    expect(ctx.wf().runs[runId].status).toBe('done')
    expect(ctx.logs.join('\n')).not.toContain(PROMPT_SECRET)
    expect(JSON.stringify(ctx.events)).not.toContain(PROMPT_SECRET)
  })

  it('starts fresh sessions for every agent step in the span when the loop says fresh', async () => {
    const { ctx, runId, finish } = await loopRun('loop-fresh')
    await finish('build', done('built-1'))
    const firstExecutions = ['build', 'review'].map((id) => ctx.agent.executionFor(ctx.attemptOf(runId, id)))
    await finish('review', verdict('fail', 'review-1'))
    await finish('build', done('built-2'))
    expect(ctx.agent.continued).toEqual([])
    const relaunched = ctx.agent.started.slice(2)
    expect(relaunched.map((attempt) => [attempt.stepId, attempt.n, attempt.prompt])).toEqual([
      ['build', 2, 'Your previous result was:\nbuilt-1\n\nAddress this feedback from review:\nreview-1\n\nPrevious result:\nbuilt-1'],
      ['review', 2, 'Your previous result was:\nreview-1\n\nAddress this feedback from review:\nreview-1\n\nPrevious result:\nreview-1']
    ])
    expect(['build', 'review'].map((id) => ctx.agent.executionFor(ctx.attemptOf(runId, id)))).not.toContain(firstExecutions[0])
    expect(ctx.agent.executionFor(ctx.attemptOf(runId, 'review'))).not.toBe(firstExecutions[1])
  })

  it.each([
    ['a failing verdict', 'fail'],
    ['a missing until field', undefined]
  ])('pauses loop-cap after max passes on %s, keeping the looping step done', async (_name, value) => {
    const { ctx, runId, finish, attempts } = await loopRun('loop-cap')
    await finish('build')
    await finish('review', verdict(value))
    expect(ctx.stepStatus(runId, 'build')).toBe('running')
    await finish('build')
    const seen = ctx.eventsSince(() => ctx.runner.complete(ctx.attemptOf(runId, 'review'), verdict(value)))
    expect(seen).toEqual(['attemptEnded', 'stepStatusChanged', 'runPaused'])
    await flush()
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'loop-cap', cursorStepId: 'review' })
    expect(ctx.stepStatus(runId, 'review')).toBe('done')
    expect(ctx.stepStatus(runId, 'after')).toBe('pending')
    expect(ctx.shell.started).toEqual([])
    expect([attempts('build'), attempts('review')]).toEqual([2, 2])
    expect(ctx.records.at(-1)).toMatchObject({ status: 'paused', pausedReason: 'loop-cap', steps: { review: 'done' } })
    expect(ctx.logs).toContain(`[workflow] loop cap reached ${JSON.stringify({ runId, stepId: 'review' })}`)
  })

  async function atLoopCap() {
    const run = await loopRun('loop-cap')
    await run.finish('build', done('built-1'))
    await run.finish('review', verdict('fail', 'review-1'))
    await run.finish('build', done('built-2'))
    await run.finish('review', verdict('fail', 'review-2'))
    expect(run.ctx.wf().runs[run.runId].pausedReason).toBe('loop-cap')
    return run
  }

  it('loops again from the cap: one more pass over the span, then pauses loop-cap again while until stays unmet', async () => {
    const { ctx, runId, finish, attempts } = await atLoopCap()
    const seen = ctx.eventsSince(() => expect(ctx.runner.resolveLoopCap(runId, 'review', 'again')).toEqual({ ok: true }))
    expect(seen.slice(0, 4)).toEqual(['stepStatusChanged', 'stepStatusChanged', 'cursorChanged', 'runResumed'])
    expect(seen.filter((type) => type === 'cursorChanged')).toHaveLength(1)
    expect(ctx.stepStatus(runId, 'build')).toBe('running')
    expect(ctx.stepStatus(runId, 'review')).toBe('pending')
    expect(ctx.wf().runs[runId].status).toBe('running')
    expect(ctx.records.at(-1)).toMatchObject({ status: 'running', steps: { build: 'running', review: 'pending' } })
    expect(ctx.logs).toContain(`[workflow] loop cap again ${JSON.stringify({ runId, stepId: 'review' })}`)
    await flush()
    expect(ctx.agent.continued.at(-1)?.attempt.stepId).toBe('build')
    expect(ctx.agent.continued.at(-1)?.prompt).toBe('Your previous result was:\nbuilt-2\n\nAddress this feedback from review:\nreview-2')
    await finish('build', done('built-3'))
    await finish('review', verdict('fail', 'review-3'))
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'loop-cap', cursorStepId: 'review' })
    expect([attempts('build'), attempts('review')]).toEqual([3, 3])
    expect(ctx.stepStatus(runId, 'after')).toBe('pending')
    expect(ctx.shell.started).toEqual([])
  })

  it('loops again from the cap and finishes the run once the extra pass meets until', async () => {
    const { ctx, runId, finish, exitShell } = await atLoopCap()
    expect(ctx.runner.resolveLoopCap(runId, 'review', 'again')).toEqual({ ok: true })
    await flush()
    await finish('build')
    await finish('review', verdict('pass'))
    expect(ctx.stepStatus(runId, 'review')).toBe('done')
    expect(ctx.stepStatus(runId, 'after')).toBe('running')
    await exitShell('after')
    expect(ctx.wf().runs[runId].status).toBe('done')
  })

  it('continues anyway from the cap: keeps the last result and starts the dependents', async () => {
    const { ctx, runId, exitShell, attempts } = await atLoopCap()
    const seen = ctx.eventsSince(() => expect(ctx.runner.resolveLoopCap(runId, 'review', 'continue')).toEqual({ ok: true }))
    expect(seen).toEqual(['cursorChanged', 'runResumed', 'stepStarted', 'attemptStarted'])
    expect(ctx.stepStatus(runId, 'review')).toBe('done')
    expect(ctx.stepStatus(runId, 'after')).toBe('running')
    expect(ctx.records.at(-1)).toMatchObject({ status: 'running', steps: { review: 'done', after: 'running' } })
    expect(ctx.records.at(-1)?.pausedReason).toBeUndefined()
    expect(ctx.logs).toContain(`[workflow] loop cap continued ${JSON.stringify({ runId, stepId: 'review' })}`)
    await flush()
    await exitShell('after')
    expect(ctx.wf().runs[runId].status).toBe('done')
    expect([attempts('build'), attempts('review')]).toEqual([2, 2])
  })

  it('refuses to resolve a loop cap on unknown runs and steps, a run not at its cap, another step and labs off', async () => {
    const { ctx, runId, finish } = await loopRun('loop-cap')
    expect(ctx.runner.resolveLoopCap('nope', 'review', 'continue')).toEqual({ ok: false, reason: 'unknown-run' })
    expect(ctx.runner.resolveLoopCap(runId, 'review', 'again')).toEqual({ ok: false, reason: 'not-at-loop-cap' })
    await finish('build')
    await finish('review', verdict('fail'))
    await finish('build')
    ctx.runner.complete(ctx.attemptOf(runId, 'review'), failed())
    expect(ctx.wf().runs[runId].pausedReason).toBe('step-failed')
    expect(ctx.runner.resolveLoopCap(runId, 'review', 'continue')).toEqual({ ok: false, reason: 'not-at-loop-cap' })

    const capped = await atLoopCap()
    expect(capped.ctx.runner.resolveLoopCap(capped.runId, 'build', 'continue')).toEqual({ ok: false, reason: 'not-at-loop-cap' })
    expect(capped.ctx.runner.resolveLoopCap(capped.runId, 'ghost', 'continue')).toEqual({ ok: false, reason: 'wrong-step' })
    capped.ctx.store.dispatch({ type: 'settings/labsChanged', payload: { workflows: false } })
    expect(capped.ctx.runner.resolveLoopCap(capped.runId, 'review', 'again')).toEqual({ ok: false, reason: 'labs-off' })
    expect(capped.ctx.wf().runs[capped.runId]).toMatchObject({ status: 'paused', pausedReason: 'loop-cap' })
    expect(capped.ctx.logs).toContain(
      `[workflow] step action refused not-at-loop-cap ${JSON.stringify({ runId: capped.runId, stepId: 'build' })}`
    )
    expect(capped.ctx.runner.cancelRun(capped.runId)).toEqual({ ok: true })
    expect(capped.ctx.runner.resolveLoopCap(capped.runId, 'review', 'continue')).toEqual({ ok: false, reason: 'unknown-run' })
  })

  it('continues anyway past the cap of a gated looping step without stopping at its gate', async () => {
    const { ctx, runId, finish } = await loopRun('loop-gated')
    for (let pass = 0; pass < 3; pass += 1) {
      await finish('build')
      await finish('review', verdict('fail'))
    }
    expect(ctx.wf().runs[runId].pausedReason).toBe('loop-cap')
    expect(ctx.runner.resolveLoopCap(runId, 'review', 'continue')).toEqual({ ok: true })
    await flush()
    expect(ctx.stepStatus(runId, 'review')).toBe('done')
    expect(ctx.stepStatus(runId, 'after')).toBe('running')
    expect(ctx.events.some((event) => event.type === 'workflows/gateResolved')).toBe(false)
  })

  it('queues a loop continuation behind the agent cap, records it, and continues when a slot frees', async () => {
    const ctx = setup({ cap: 1, deps: { hasExecution: () => true } })
    const runId = await ctx.startRun('loop-cap')
    await flush()
    ctx.runner.complete(ctx.attemptOf(runId, 'build'), done('built-1'))
    await flush()
    const execution = ctx.agent.executionFor(ctx.attemptOf(runId, 'review'))
    const other = await ctx.startRun('one-agent')
    expect(ctx.stepStatus(other, 'plan')).toBe('queued')
    ctx.runner.complete(ctx.attemptOf(runId, 'review'), verdict('fail', 'review-1'))
    await flush()
    const prompt = 'Your previous result was:\nbuilt-1\n\nAddress this feedback from review:\nreview-1'
    expect(ctx.stepStatus(other, 'plan')).toBe('running')
    expect(ctx.stepStatus(runId, 'build')).toBe('queued')
    expect(ctx.records.filter((record) => record.runId === runId).at(-1)?.continuations).toEqual({ build: { prompt } })
    ctx.runner.complete(ctx.attemptOf(other, 'plan'), done())
    await flush()
    expect(ctx.stepStatus(runId, 'build')).toBe('running')
    expect(ctx.agent.continued.map((entry) => [entry.attempt.stepId, entry.prompt])).toEqual([['build', prompt]])
    expect(ctx.agent.continued[0].executionId).not.toBe(execution)
    expect(ctx.runner.getRunRecord(runId)?.continuations).toBeUndefined()
  })

  it('shows a gated looping step its gate only once until is met', async () => {
    const { ctx, runId, finish } = await loopRun('loop-gated')
    await finish('build')
    const failing = ctx.eventsSince(() => ctx.runner.complete(ctx.attemptOf(runId, 'review'), verdict('fail')))
    expect(failing).not.toContain('runPaused')
    expect(ctx.events.some((event) => event.type === 'workflows/stepStatusChanged' && event.payload.status === 'awaiting-gate')).toBe(false)
    expect(ctx.runner.approveGate(runId, 'review')).toEqual({ ok: false, reason: 'not-awaiting-gate' })
    await flush()
    await finish('build')
    await finish('review', verdict('pass'))
    expect(ctx.stepStatus(runId, 'review')).toBe('awaiting-gate')
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'gate' })
    expect(ctx.shell.started).toEqual([])
    expect(ctx.runner.approveGate(runId, 'review')).toEqual({ ok: true })
    await flush()
    expect(ctx.stepStatus(runId, 'after')).toBe('running')
  })
})

describe('WorkflowRunner when conditions', () => {
  const withData = (data: Record<string, string>, summary = 'out'): StepResult => ({ ...done(summary), data })

  async function whenRun(slug: DefSlug) {
    const ctx = setup({ deps: { hasExecution: () => true } })
    const runId = await ctx.startRun(slug)
    await flush()
    const finish = async (stepId: string, result: StepResult = done(`${stepId}-out`)) => {
      expect(ctx.runner.complete(ctx.attemptOf(runId, stepId), result)).toBe(true)
      await flush()
    }
    return { ctx, runId, finish }
  }

  it('skips a step whose condition on its need is false and runs the join with the skipped step rendered empty', async () => {
    const { ctx, runId, finish } = await whenRun('when-verdict')
    await finish('review', withData({ verdict: 'pass' }))
    expect(ctx.stepStatus(runId, 'fix')).toBe('skipped')
    expect(ctx.stepStatus(runId, 'join')).toBe('running')
    expect(ctx.agent.started.map((attempt) => attempt.stepId)).toEqual(['review'])
    const [join] = ctx.shell.started
    expect(join.step.kind === 'shell' && renderTemplate(join.step.run, join.scope).text).toBe('echo []')
    ctx.runner.complete(ctx.attemptOf(runId, 'join'), done())
    await flush()
    expect(ctx.wf().runs[runId].status).toBe('done')
    expect(ctx.logs).toContain(`[workflow] step skipped ${JSON.stringify({ runId, stepId: 'fix' })}`)
  })

  it('runs a step whose condition on its need is true', async () => {
    const { ctx, runId, finish } = await whenRun('when-verdict')
    await finish('review', withData({ verdict: 'fail' }))
    expect(ctx.stepStatus(runId, 'fix')).toBe('running')
    await finish('fix', done('fixed'))
    expect(ctx.stepStatus(runId, 'join')).toBe('running')
  })

  it('skips the step when its need reported no value for the field', async () => {
    const { ctx, runId, finish } = await whenRun('when-verdict')
    await finish('review', done('no data'))
    expect(ctx.stepStatus(runId, 'fix')).toBe('skipped')
    expect(ctx.stepStatus(runId, 'join')).toBe('running')
  })

  it('reads the exit code of a shell need and finishes the run when the only remaining step is skipped', async () => {
    const { ctx, runId } = await whenRun('when-exit')
    ctx.shell.emit({ type: 'exited', executionId: ctx.shell.executionFor(ctx.attemptOf(runId, 'test')), code: 0 })
    await flush()
    expect(ctx.stepStatus(runId, 'fix')).toBe('skipped')
    expect(ctx.agent.started).toEqual([])
    expect(ctx.wf().runs[runId].status).toBe('done')
  })

  it('skips a step whose need was skipped, even for a not condition', async () => {
    const { ctx, runId, finish } = await whenRun('when-chain')
    await finish('a', withData({ verdict: 'pass' }))
    expect(ctx.stepStatus(runId, 'b')).toBe('skipped')
    expect(ctx.stepStatus(runId, 'c')).toBe('skipped')
    expect(ctx.agent.started.map((attempt) => attempt.stepId)).toEqual(['a'])
    expect(ctx.wf().runs[runId].status).toBe('done')
  })

  it('re-evaluates the condition each time a loop re-enters the step', async () => {
    const { ctx, runId, finish } = await whenRun('when-loop')
    await finish('build')
    await finish('check', withData({ verdict: 'pass' }))
    expect(ctx.stepStatus(runId, 'fix')).toBe('skipped')
    await finish('review', withData({ ok: 'no' }))
    expect(ctx.stepStatus(runId, 'fix')).toBe('pending')
    await finish('build')
    await finish('check', withData({ verdict: 'fail' }))
    expect(ctx.stepStatus(runId, 'fix')).toBe('running')
    await finish('fix')
    await finish('review', withData({ ok: 'yes' }))
    expect(ctx.wf().runs[runId].status).toBe('done')
    expect(ctx.wf().runs[runId].steps.fix.attemptIds).toHaveLength(1)
  })
})

describe('WorkflowRunner step timeouts', () => {
  async function timedRun(options: SetupOptions = {}) {
    const timers = fakeTimers()
    let clock = 1000
    const advance = (ms: number): void => {
      clock += ms
    }
    const ctx = setup({
      ...options,
      deps: { setTimer: timers.setTimer, clearTimer: timers.clearTimer, now: () => ++clock, ...options.deps }
    })
    const runId = await ctx.startRun('timed')
    await flush()
    const plan = () => ctx.attemptOf(runId, 'plan')
    const attemptRecord = () => ctx.runner.getRunRecord(runId)?.attempts.find((attempt) => attempt.attemptId === plan())
    return { ctx, runId, timers, plan, attemptRecord, advance }
  }

  async function timedOut(options: SetupOptions = {}) {
    const run = await timedRun(options)
    run.advance(600_000)
    run.timers.fire()
    expect(run.ctx.wf().runs[run.runId]).toMatchObject({ status: 'paused', pausedReason: 'timeout' })
    return run
  }

  it('arms one timer for the step timeout in seconds and records its deadline on the attempt', async () => {
    const { timers, attemptRecord } = await timedRun()
    expect(timers.delays()).toEqual([600_000])
    const record = attemptRecord()
    expect(record?.timeoutAt).toBe((record?.startedAt ?? 0) + 600_000)
  })

  it('pauses the run timeout on expiry while the attempt keeps running and is never cancelled', async () => {
    const { ctx, runId, timers, plan } = await timedRun()
    const seen = ctx.eventsSince(() => timers.fire())
    expect(seen).toEqual(['runPaused'])
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'timeout', cursorStepId: 'plan' })
    expect(ctx.stepStatus(runId, 'plan')).toBe('running')
    expect(ctx.wf().attempts[plan()].status).toBe('running')
    expect(ctx.agent.cancelled).toEqual([])
    expect(ctx.records.at(-1)).toMatchObject({ status: 'paused', pausedReason: 'timeout' })
    expect(ctx.records.at(-1)?.attempts[0].metrics.pauses.map((pause) => pause.reason)).toEqual(['timeout'])
    expect(ctx.logs).toContain(`[workflow] step timed out ${JSON.stringify({ runId, stepId: 'plan', attemptId: plan() })}`)
  })

  it('keeps waiting: re-arms a full timeout with a new deadline, resumes the run, and pauses again on the next expiry', async () => {
    const { ctx, runId, timers, attemptRecord } = await timedOut()
    const before = attemptRecord()?.timeoutAt ?? 0
    const seen = ctx.eventsSince(() => expect(ctx.runner.keepWaiting(runId, 'plan')).toEqual({ ok: true }))
    expect(seen).toEqual(['runResumed'])
    expect(ctx.wf().runs[runId].status).toBe('running')
    expect(timers.delays()).toEqual([600_000])
    expect(attemptRecord()?.timeoutAt).toBeGreaterThan(before)
    expect(ctx.records.at(-1)).toMatchObject({ status: 'running' })
    expect(ctx.records.at(-1)?.attempts[0].timeoutAt).toBe(attemptRecord()?.timeoutAt)
    expect(ctx.logs).toContain(`[workflow] step keep waiting ${JSON.stringify({ runId, stepId: 'plan' })}`)
    timers.fire()
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'timeout' })
    expect(ctx.agent.cancelled).toEqual([])
  })

  it('clears the timer when the step completes before expiry', async () => {
    const { ctx, runId, timers, plan } = await timedRun()
    ctx.runner.complete(plan(), done())
    expect(timers.delays()).toEqual([])
    expect(ctx.stepStatus(runId, 'test')).toBe('running')
    expect(ctx.wf().runs[runId].status).toBe('running')
  })

  it('splits a timeout longer than one timer can hold and pauses only after the whole wait', async () => {
    const timers = fakeTimers()
    const ctx = setup({ deps: { setTimer: timers.setTimer, clearTimer: timers.clearTimer } })
    const runId = await ctx.startRun('timed-long')
    expect(timers.delays()).toEqual([2 ** 31 - 1])
    timers.fire()
    expect(timers.delays()).toEqual([2_500_000_000 - (2 ** 31 - 1)])
    expect(ctx.wf().runs[runId].status).toBe('running')
    timers.fire()
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'timeout' })
  })

  it('clears every live timer on dispose', async () => {
    const { ctx, timers } = await timedRun()
    await ctx.startRun('timed', '/wt/x')
    await flush()
    expect(timers.delays()).toEqual([600_000, 600_000])
    ctx.runner.dispose()
    expect(timers.delays()).toEqual([])
  })

  it('does not count time spent queued behind the agent cap', async () => {
    const timers = fakeTimers()
    const ctx = setup({ cap: 1, deps: { setTimer: timers.setTimer, clearTimer: timers.clearTimer } })
    const other = await ctx.startRun('one-agent')
    const runId = await ctx.startRun('timed')
    expect(ctx.stepStatus(runId, 'plan')).toBe('queued')
    expect(timers.delays()).toEqual([])
    ctx.runner.complete(ctx.attemptOf(other, 'plan'), done())
    await flush()
    expect(ctx.stepStatus(runId, 'plan')).toBe('running')
    expect(timers.delays()).toEqual([600_000])
  })

  it.each([
    [
      'the attempt completing on its own',
      (ctx: Ctx, runId: string, attemptId: string) => expect(ctx.runner.complete(attemptId, done())).toBe(true),
      { status: 'running' },
      { plan: 'done', test: 'running' }
    ],
    [
      'mark done',
      (ctx: Ctx, runId: string) => expect(ctx.runner.markDone(runId, 'plan', { summary: 'by hand', fields: {} })).toEqual({ ok: true }),
      { status: 'running' },
      { plan: 'done', test: 'running' }
    ],
    [
      'skip',
      (ctx: Ctx, runId: string) => expect(ctx.runner.skipStep(runId, 'plan')).toEqual({ ok: true }),
      { status: 'running' },
      { plan: 'skipped', test: 'running' }
    ],
    [
      'cancel step',
      (ctx: Ctx, runId: string) => expect(ctx.runner.cancelStep(runId, 'plan')).toEqual({ ok: true }),
      { status: 'paused', pausedReason: 'step-failed' },
      { plan: 'cancelled', test: 'pending' }
    ]
  ])('leaves no timeout pause or timer after %s', async (_name, act, run, steps) => {
    const { ctx, runId, timers, plan } = await timedOut()
    act(ctx, runId, plan())
    expect(timers.delays()).toEqual([])
    expect(ctx.wf().runs[runId]).toMatchObject(run)
    expect(Object.fromEntries(['plan', 'test'].map((id) => [id, ctx.stepStatus(runId, id)]))).toEqual(steps)
    expect(ctx.runner.keepWaiting(runId, 'plan')).toMatchObject({ ok: false })
  })

  it('keeps an approval pause of the same step when the timeout fires and logs the deferral', async () => {
    const { ctx, runId, timers, plan } = await timedRun()
    ctx.agent.emit({ type: 'needsApproval', executionId: ctx.agent.executionFor(plan()) })
    timers.fire()
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'needs-approval' })
    expect(ctx.runner.getRunRecord(runId)?.attempts[0].metrics.pauses.map((pause) => pause.reason)).toEqual(['needs-approval'])
    expect(ctx.logs).toContain(`[workflow] step timeout deferred needs-approval ${JSON.stringify({ runId, stepId: 'plan', attemptId: plan() })}`)
    expect(ctx.runner.keepWaiting(runId, 'plan')).toEqual({ ok: false, reason: 'not-timed-out' })
  })

  it('re-arms the passed deadline once an approval that deferred the timeout is submitted, and pauses timeout', async () => {
    const { ctx, runId, timers, plan, advance } = await timedRun()
    const execution = ctx.agent.executionFor(plan())
    ctx.agent.emit({ type: 'needsApproval', executionId: execution })
    advance(600_000)
    timers.fire()
    expect(timers.delays()).toEqual([])
    ctx.agent.emit({ type: 'promptSubmitted', executionId: execution })
    expect(timers.delays()).toEqual([0])
    timers.fire()
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'timeout' })
    expect(ctx.runner.keepWaiting(runId, 'plan')).toEqual({ ok: true })
    expect(timers.delays()).toEqual([600_000])
  })

  it('re-arms after an approval replaces the timeout pause, so keep waiting is offered again', async () => {
    const { ctx, runId, timers, plan } = await timedOut()
    const execution = ctx.agent.executionFor(plan())
    ctx.agent.emit({ type: 'needsApproval', executionId: execution })
    expect(ctx.wf().runs[runId].pausedReason).toBe('needs-approval')
    ctx.agent.emit({ type: 'promptSubmitted', executionId: execution })
    expect(timers.delays()).toEqual([0])
    timers.fire()
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'timeout' })
    expect(ctx.runner.keepWaiting(runId, 'plan')).toEqual({ ok: true })
  })

  it('keeps the original timer when an approval clears before the deadline, without a second timer', async () => {
    const { ctx, runId, timers, plan } = await timedRun()
    const execution = ctx.agent.executionFor(plan())
    ctx.agent.emit({ type: 'needsApproval', executionId: execution })
    ctx.agent.emit({ type: 'promptSubmitted', executionId: execution })
    expect(timers.delays()).toEqual([600_000])
    expect(ctx.wf().runs[runId].status).toBe('running')
  })

  it('re-arms a timeout deferred by needs-input once that pause is cleared on the live attempt', async () => {
    const { ctx, runId, timers, plan, advance } = await timedRun()
    const execution = ctx.agent.executionFor(plan())
    ctx.runner.complete(plan(), { status: 'needs-input', summary: 'which db?', completedBy: 'tool' })
    advance(600_000)
    timers.fire()
    expect(ctx.wf().runs[runId].pausedReason).toBe('needs-input')
    expect(timers.delays()).toEqual([])
    expect(ctx.logs).toContain(`[workflow] step timeout deferred needs-input ${JSON.stringify({ runId, stepId: 'plan', attemptId: plan() })}`)
    ctx.agent.emit({ type: 'needsApproval', executionId: execution })
    ctx.agent.emit({ type: 'promptSubmitted', executionId: execution })
    expect(timers.delays()).toEqual([0])
    timers.fire()
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'timeout' })
  })

  it('treats an adopted timeout too large to represent as no timeout', async () => {
    const { ctx, runId } = await timedRun({ deps: { hasExecution: () => true } })
    const saved = ctx.records.filter((record) => record.runId === runId).at(-1)
    if (!saved) throw new Error('no record')
    const huge = structuredClone(saved)
    huge.definition.steps[0] = { ...huge.definition.steps[0], timeout: 1e308 }
    delete huge.attempts[0].timeoutAt
    const timers = fakeTimers()
    const after = setup({ deps: { hasExecution: () => true, setTimer: timers.setTimer, clearTimer: timers.clearTimer } })
    after.runner.reconcile([huge])
    await flush()
    expect(after.runner.getRunRecord(runId)?.attempts[0].status).toBe('running')
    expect(timers.delays()).toEqual([])
  })

  it('refuses keep waiting on unknown runs and steps, a step that has not timed out, labs off and a cancelled run', async () => {
    const { ctx, runId, timers } = await timedRun()
    expect(ctx.runner.keepWaiting('nope', 'plan')).toEqual({ ok: false, reason: 'unknown-run' })
    expect(ctx.runner.keepWaiting(runId, 'plan')).toEqual({ ok: false, reason: 'not-timed-out' })
    timers.fire()
    expect(ctx.runner.keepWaiting(runId, 'test')).toEqual({ ok: false, reason: 'not-timed-out' })
    expect(ctx.runner.keepWaiting(runId, 'ghost')).toEqual({ ok: false, reason: 'wrong-step' })
    ctx.store.dispatch({ type: 'settings/labsChanged', payload: { workflows: false } })
    expect(ctx.runner.keepWaiting(runId, 'plan')).toEqual({ ok: false, reason: 'labs-off' })
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'timeout' })
    expect(timers.delays()).toEqual([])
    expect(ctx.logs).toContain(`[workflow] step action refused not-timed-out ${JSON.stringify({ runId, stepId: 'test' })}`)
    expect(ctx.runner.cancelRun(runId)).toEqual({ ok: true })
    expect(ctx.runner.keepWaiting(runId, 'plan')).toEqual({ ok: false, reason: 'unknown-run' })
  })
})

describe('WorkflowRunner step cost', () => {
  const COST_SESSION = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

  function sessionUsage(sessionId: string, costUsd: number): SessionUsage {
    return {
      sessionId,
      transcriptPath: `/tmp/${sessionId}.jsonl`,
      byModel: {
        'claude-sonnet-4-5': { messages: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: costUsd }
      },
      breakdown: { ...emptyBreakdown, toolResults: {} },
      currentModel: 'claude-sonnet-4-5',
      updatedAt: 0
    }
  }

  function costSetup(options: { alive?: boolean; sessionId?: string } = {}) {
    const held = new Set<string>()
    const holds: string[] = []
    const releases: string[] = []
    const ctx = setup({
      deps: {
        hasExecution: () => options.alive ?? true,
        costInterest: {
          hold: (terminalId) => {
            held.add(terminalId)
            holds.push(terminalId)
          },
          release: (terminalId) => {
            held.delete(terminalId)
            releases.push(terminalId)
          }
        }
      }
    })
    ctx.agent.sessionId = options.sessionId ?? COST_SESSION
    const usage = (terminalId: string, costUsd: number, sessionId = options.sessionId ?? COST_SESSION): void => {
      ctx.store.dispatch({ type: 'costs/usageUpdated', payload: { terminalId, usage: sessionUsage(sessionId, costUsd) } })
    }
    const costEvents = () =>
      ctx.events.filter(
        (event): event is Extract<StateEvent, { type: 'workflows/attemptCostChanged' }> =>
          event.type === 'workflows/attemptCostChanged'
      )
    const recordedCost = (runId: string, attemptId: string) =>
      ctx.records.filter((record) => record.runId === runId).at(-1)?.attempts.find((a) => a.attemptId === attemptId)
        ?.metrics.costUsd
    return { ctx, held, holds, releases, usage, costEvents, recordedCost }
  }

  it('holds cost interest for the agent terminal it binds and attributes its usage to the live attempt', async () => {
    const { ctx, held, usage, costEvents, recordedCost } = costSetup()
    const runId = await ctx.startRun('two-agent')
    await flush()
    const attemptId = ctx.attemptOf(runId, 'plan')
    const execution = ctx.agent.executionFor(attemptId)
    expect(held).toEqual(new Set([execution]))

    usage(execution, 0.12)
    expect(ctx.wf().attempts[attemptId].costUsd).toBe(0.12)
    expect(recordedCost(runId, attemptId)).toBe(0.12)
    expect(costEvents().map((event) => event.payload)).toEqual([{ attemptId, costUsd: 0.12 }])
  })

  it('does not dispatch when the attempt cost is unchanged', async () => {
    const { ctx, usage, costEvents } = costSetup()
    const runId = await ctx.startRun('two-agent')
    await flush()
    const execution = ctx.agent.executionFor(ctx.attemptOf(runId, 'plan'))
    usage(execution, 0.12)
    usage(execution, 0.12)
    expect(costEvents()).toHaveLength(1)
  })

  it('ignores usage of terminals it does not own', async () => {
    const { ctx, usage, costEvents } = costSetup()
    const runId = await ctx.startRun('two-agent')
    await flush()
    const before = ctx.wf()
    usage('someone-elses-terminal', 0.5)
    expect(costEvents()).toEqual([])
    expect(ctx.wf()).toBe(before)
  })

  it('leaves the cost unset when no usage arrives', async () => {
    const { ctx } = costSetup()
    const runId = await ctx.startRun('two-agent')
    await flush()
    const attemptId = ctx.attemptOf(runId, 'plan')
    const ended = ctx.eventsSince(() => {
      ctx.runner.completeExecution(ctx.agent.executionFor(attemptId), { status: 'done', summary: 'ok' })
    })
    expect(ended).toContain('attemptEnded')
    expect(ctx.wf().attempts[attemptId].costUsd).toBeUndefined()
    expect(ctx.events.find((event) => event.type === 'workflows/attemptEnded')?.payload).not.toHaveProperty('costUsd')
  })

  it('carries the cost known at the end on attemptEnded', async () => {
    const { ctx, usage } = costSetup()
    const runId = await ctx.startRun('two-agent')
    await flush()
    const attemptId = ctx.attemptOf(runId, 'plan')
    const execution = ctx.agent.executionFor(attemptId)
    usage(execution, 0.2)
    ctx.runner.completeExecution(execution, { status: 'done', summary: 'ok' })
    const ended = ctx.events.find((event) => event.type === 'workflows/attemptEnded')
    expect(ended?.payload).toMatchObject({ attemptId, costUsd: 0.2 })
  })

  it('attributes the Stop that lands after complete_step to the ended attempt, then releases the terminal', async () => {
    const { ctx, held, releases, usage, recordedCost } = costSetup()
    const runId = await ctx.startRun('two-agent')
    await flush()
    const attemptId = ctx.attemptOf(runId, 'plan')
    const execution = ctx.agent.executionFor(attemptId)
    ctx.runner.completeExecution(execution, { status: 'done', summary: 'ok' })
    await flush()
    expect(held.has(execution)).toBe(true)

    usage(execution, 0.3)
    expect(ctx.wf().attempts[attemptId]).toMatchObject({ status: 'done', costUsd: 0.3 })
    expect(recordedCost(runId, attemptId)).toBe(0.3)
    expect(releases).toContain(execution)
    expect(held.has(execution)).toBe(false)

    usage(execution, 0.9)
    expect(ctx.wf().attempts[attemptId].costUsd).toBe(0.3)
  })

  it('captures the post-complete Stop of the last step after the run has finished', async () => {
    const { ctx, usage, recordedCost } = costSetup()
    const runId = await ctx.startRun('one-agent')
    await flush()
    const attemptId = ctx.attemptOf(runId, 'plan')
    const execution = ctx.agent.executionFor(attemptId)
    ctx.runner.completeExecution(execution, { status: 'done', summary: 'ok' })
    expect(ctx.wf().runs[runId].status).toBe('done')

    usage(execution, 0.05)
    expect(ctx.wf().attempts[attemptId].costUsd).toBe(0.05)
    expect(recordedCost(runId, attemptId)).toBe(0.05)
  })

  it('releases right away when a turn end completes the attempt', async () => {
    const { ctx, held, usage } = costSetup()
    const runId = await ctx.startRun('two-agent')
    await flush()
    const attemptId = ctx.attemptOf(runId, 'plan')
    const execution = ctx.agent.executionFor(attemptId)
    usage(execution, 0.1)
    ctx.agent.emit({ type: 'turnEnded', executionId: execution, lastMessage: 'done' })
    expect(ctx.wf().attempts[attemptId]).toMatchObject({ completedBy: 'fallback', costUsd: 0.1 })
    expect(held.has(execution)).toBe(false)

    usage(execution, 0.4)
    expect(ctx.wf().attempts[attemptId].costUsd).toBe(0.1)
  })

  it('releases right away when the attempt is cancelled or its process exits', async () => {
    const { ctx, held } = costSetup()
    const runId = await ctx.startRun('two-agent')
    await flush()
    const execution = ctx.agent.executionFor(ctx.attemptOf(runId, 'plan'))
    ctx.agent.emit({ type: 'exited', executionId: execution, code: 1 })
    expect(held.size).toBe(0)

    const other = await ctx.startRun('one-agent')
    await flush()
    expect(held.size).toBe(1)
    ctx.runner.cancelRun(other)
    expect(held.size).toBe(0)
  })

  it('charges a continued attempt only the session usage since it started', async () => {
    const { ctx, usage } = costSetup()
    const runId = await ctx.startRun('two-agent')
    await flush()
    const planAttempt = ctx.attemptOf(runId, 'plan')
    const execution = ctx.agent.executionFor(planAttempt)
    usage(execution, 0.1)
    ctx.runner.completeExecution(execution, { status: 'done', summary: 'ok' })
    usage(execution, 0.3)
    await flush()
    ctx.runner.complete(ctx.attemptOf(runId, 'build'), failed())
    await flush()

    expect(ctx.runner.continueStep(runId, 'plan', 'fix it')).toEqual({ ok: true })
    await flush()
    const continued = ctx.attemptOf(runId, 'plan')
    expect(continued).not.toBe(planAttempt)
    usage(execution, 0.5)
    expect(ctx.wf().attempts[continued].costUsd).toBeCloseTo(0.2)
    expect(ctx.wf().attempts[planAttempt].costUsd).toBe(0.3)
  })

  it('charges a resumed attempt in a new terminal only the session usage since it started', async () => {
    const { ctx, usage, held } = costSetup({ alive: false })
    const runId = await ctx.startRun('two-agent')
    await flush()
    const planAttempt = ctx.attemptOf(runId, 'plan')
    const first = ctx.agent.executionFor(planAttempt)
    usage(first, 0.3)
    ctx.agent.emit({ type: 'turnEnded', executionId: first, lastMessage: 'done' })
    await flush()
    ctx.runner.complete(ctx.attemptOf(runId, 'build'), failed())
    await flush()

    expect(ctx.runner.continueStep(runId, 'plan', 'fix it')).toEqual({ ok: true })
    await flush()
    const resumed = ctx.attemptOf(runId, 'plan')
    const second = ctx.agent.executionFor(resumed)
    expect(second).not.toBe(first)
    expect(held.has(second)).toBe(true)
    usage(second, 0.45)
    expect(ctx.wf().attempts[resumed].costUsd).toBeCloseTo(0.15)
  })

  it('charges a resumed attempt after a restart only the usage beyond the recorded attempts of its session', async () => {
    const { ctx, usage } = costSetup({ alive: false })
    const runId = await ctx.startRun('two-agent')
    await flush()
    const first = ctx.agent.executionFor(ctx.attemptOf(runId, 'plan'))
    usage(first, 0.3)
    ctx.agent.emit({ type: 'turnEnded', executionId: first, lastMessage: 'done' })
    await flush()
    ctx.runner.complete(ctx.attemptOf(runId, 'build'), failed())
    await flush()
    const onDisk = ctx.records.filter((record) => record.runId === runId).at(-1)
    if (!onDisk) throw new Error('no record')

    const after = costSetup({ alive: false })
    after.ctx.runner.reconcile([onDisk])
    await flush()
    expect(after.ctx.runner.continueStep(runId, 'plan', 'fix it')).toEqual({ ok: true })
    await flush()
    const resumed = after.ctx.runner.getRunRecord(runId)?.attempts.at(-1)
    if (!resumed) throw new Error('no resumed attempt')
    after.usage(after.ctx.agent.executionFor(resumed.attemptId), 0.5)
    expect(after.recordedCost(runId, resumed.attemptId)).toBeCloseTo(0.2)
  })

  it('releases a terminal waiting for its post-complete Stop when the terminal goes away', async () => {
    const { ctx, held, usage } = costSetup()
    const runId = await ctx.startRun('two-agent')
    await flush()
    const attemptId = ctx.attemptOf(runId, 'plan')
    const execution = ctx.agent.executionFor(attemptId)
    ctx.runner.completeExecution(execution, { status: 'done', summary: 'ok' })
    expect(held.has(execution)).toBe(true)
    ctx.store.dispatch({ type: 'terminals/removed', payload: execution })
    expect(held.has(execution)).toBe(false)
    usage(execution, 0.3)
    expect(ctx.wf().attempts[attemptId].costUsd).toBeUndefined()
  })

  it('never holds an opencode step terminal, which has no transcript', async () => {
    const { ctx, holds } = costSetup()
    const runId = await ctx.startRun('one-opencode')
    await flush()
    expect(ctx.agent.executionFor(ctx.attemptOf(runId, 'plan'))).toBeDefined()
    expect(holds).toEqual([])
  })

  it('drops the step terminal usage from the costs slice once the runner stops holding it', async () => {
    let tracker: CostTracker | undefined
    const ctx = setup({
      deps: {
        hasExecution: () => true,
        costInterest: {
          hold: (terminalId) => tracker?.holdInterest(terminalId),
          release: (terminalId) => tracker?.releaseInterest(terminalId)
        }
      }
    })
    tracker = new CostTracker(ctx.store)
    ctx.agent.sessionId = COST_SESSION
    const runId = await ctx.startRun('two-agent')
    await flush()
    const attemptId = ctx.attemptOf(runId, 'plan')
    const execution = ctx.agent.executionFor(attemptId)
    ctx.runner.completeExecution(execution, { status: 'done', summary: 'ok' })
    ctx.store.dispatch({ type: 'costs/usageUpdated', payload: { terminalId: execution, usage: sessionUsage(COST_SESSION, 0.3) } })
    expect(ctx.wf().attempts[attemptId].costUsd).toBe(0.3)
    expect(ctx.store.getSnapshot().state.costs.byTerminal[execution]).toBeUndefined()
  })

  it('releases every held terminal on dispose', async () => {
    const { ctx, held } = costSetup()
    await ctx.startRun('two-agent')
    await flush()
    expect(held.size).toBe(1)
    ctx.runner.dispose()
    expect(held.size).toBe(0)
  })
})

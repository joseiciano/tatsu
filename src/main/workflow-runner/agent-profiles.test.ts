import { describe, expect, it, vi } from 'vitest'
import { Store } from '../store'
import { initialState, type StateEvent } from '../../shared/state'
import type { CodexHookTrustSummary } from '../../shared/state/hooks'
import type { TerminalTab } from '../../shared/state/terminals'
import { hydrateWorkflowRuns, type WorkflowDefinitionDetail, type WorkflowRunRecord } from '../../shared/state/workflows'
import { validateWorkflowDefinition, type WorkflowAgent } from '../../shared/workflow-def'
import type { StepSpawnExtras } from '../agent-spawn'
import * as codexAgent from '../agents/codex'
import * as opencodeAgent from '../agents/opencode'
import type { TrustStatus } from '../folder-trust'
import {
  WorkflowRunner,
  AGENT_START_SUMMARIES,
  StepStartError,
  claudeProfile,
  type InputTrustFetcher,
  type RunArtifacts,
  codexProfile,
  createAgentStepDriver,
  opencodeProfile,
  type StepDriverEvent
} from '.'
import { FakeStepDriver, worktreeFixture } from './fake-step-driver'

vi.mock('../perf-log', () => ({
  perfLog: vi.fn(),
  getPerfLogFilePath: vi.fn(() => '/tmp/perf.log')
}))

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function detail(agent: WorkflowAgent, permissions: 'edit' | 'full' = 'edit'): WorkflowDefinitionDetail {
  const source = `name: ${agent}-def
steps:
  - id: plan
    agent: claude
    permissions: ${permissions}
    model: gpt-test
    prompt: "plan"
`
  const result = validateWorkflowDefinition(source)
  if (!result.definition) throw new Error('fixture did not resolve')
  const steps = result.definition.steps.map((step) => (step.kind === 'agent' ? { ...step, agent } : step))
  return {
    ...result,
    definition: { ...result.definition, steps },
    source,
    summary: {
      id: `personal:${agent}${permissions === 'full' ? '-full' : ''}`,
      name: agent,
      scope: 'personal',
      path: `/defs/${agent}.yaml`,
      hash: `hash-${agent}`,
      stepIds: steps.map((step) => step.id),
      issues: []
    }
  }
}

const CODEX_SESSION = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const OTHER_CODEX_SESSION = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c'
const OPENCODE_SESSION = 'ses_f6ecc1676ffe3NQnC5CdfZLoop'
const OK_TRUST: CodexHookTrustSummary = { state: 'ok', reviewEvents: [] }

interface RunnerOptions {
  codexTrust?: CodexHookTrustSummary | null
  codexFolder?: TrustStatus
  records?: WorkflowRunRecord[]
  opencode?: boolean
  inputTrust?: InputTrustFetcher
  inputTrustTimeoutMs?: number
  artifacts?: RunArtifacts
}

const SHIP_STEP = `  - id: ship
    agent: claude
    permissions: full
    prompt: "ship {{inputs.ticket}}"
`

function inputDetail(type: 'issue' | 'pr', extraSteps = ''): WorkflowDefinitionDetail {
  const source = `name: ${type}-def
inputs:
  ticket: { type: ${type} }
steps:
  - id: plan
    agent: claude
    permissions: full
    prompt: "work on {{inputs.ticket}}"
${extraSteps}`
  const result = validateWorkflowDefinition(source)
  if (!result.definition) throw new Error('fixture did not resolve')
  return {
    ...result,
    definition: result.definition,
    source,
    summary: {
      id: `personal:input-${type}`,
      name: `${type}-def`,
      scope: 'personal',
      path: `/defs/${type}.yaml`,
      hash: `hash-${type}`,
      stepIds: result.definition.steps.map((step) => step.id),
      issues: []
    }
  }
}

function twoProfileRunner({
  codexTrust = OK_TRUST,
  codexFolder = 'trusted',
  records = [],
  opencode = true,
  inputTrust,
  inputTrustTimeoutMs,
  artifacts
}: RunnerOptions = {}) {
  const store = new Store({
    ...initialState,
    hooks: { ...initialState.hooks, consent: 'accepted', codexTrust },
    workflows: { ...initialState.workflows, ...hydrateWorkflowRuns(records) },
    worktrees: { ...initialState.worktrees, list: ['/wt/claude', '/wt/codex', '/wt/opencode'].map(worktreeFixture) },
    settings: { ...initialState.settings, labs: { ...initialState.settings.labs, workflows: true } }
  })
  const tabs: Array<{ tab: TerminalTab; spawn: StepSpawnExtras }> = []
  const alive = new Set<string>()
  const killed: Array<{ id: string; signal: string }> = []
  const persisted: WorkflowRunRecord[] = []
  const logs: Array<{ message: string; data?: Record<string, string> }> = []
  const exitListeners = new Set<(id: string, code: number, signal?: number) => void>()
  const promptListeners = new Set<(event: { terminalId: string }) => void>()
  const codexTrustChecks: string[] = []
  let ids = 0
  const driver = createAgentStepDriver({
    profiles: [
      claudeProfile(async () => ({ status: 'trusted' })),
      codexProfile(async (path) => {
        codexTrustChecks.push(path)
        return { status: codexFolder }
      }),
      ...(opencode ? [opencodeProfile()] : [])
    ],
    addTab: (_worktreePath, tab, spawn) => {
      tabs.push({ tab, spawn })
      alive.add(tab.id)
    },
    hasTerminal: (id) => alive.has(id),
    onExit: (listener) => {
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    },
    kill: (id, signal) => {
      killed.push({ id, signal })
    },
    onStopEvent: () => () => {},
    onPromptSubmit: (listener) => {
      promptListeners.add(listener)
      return () => promptListeners.delete(listener)
    },
    store,
    writeMarker: () => {},
    removeMarker: () => {},
    writePromptFile: async () => {},
    write: () => {},
    newTabId: () => `agent-tab-${++ids}`,
    newSessionId: () => `00000000-0000-4000-8000-00000000000${ids}`,
    log: () => {}
  })
  const driverEvents: StepDriverEvent[] = []
  driver.onEvent((event) => driverEvents.push(event))
  let next = 0
  const runner = new WorkflowRunner({
    store,
    loader: {
      getDefinition: (id: string) => {
        if (id === 'personal:input-issue') return inputDetail('issue')
        if (id === 'personal:input-pr') return inputDetail('pr')
        if (id === 'personal:input-issue-ship') return inputDetail('issue', SHIP_STEP)
        const [agent, full] = id.replace(/^personal:/, '').split('-')
        if (full !== undefined && full !== 'full') return null
        return agent === 'claude' || agent === 'codex' || agent === 'opencode'
          ? detail(agent, full === 'full' ? 'full' : 'edit')
          : null
      }
    },
    drivers: { agent: driver, shell: new FakeStepDriver('shell') },
    now: () => ++next,
    newId: () => `id-${++next}`,
    log: (_category, message, data) => logs.push({ message, ...(data === undefined ? {} : { data }) }),
    persist: (run) => persisted.push(structuredClone(run)),
    ...(inputTrust === undefined ? {} : { inputTrust }),
    ...(inputTrustTimeoutMs === undefined ? {} : { inputTrustTimeoutMs }),
    ...(artifacts === undefined ? {} : { artifacts })
  })
  runner.reconcile(records)
  const start = async (agent: WorkflowAgent): Promise<string> => {
    const result = await runner.start({ defId: `personal:${agent}`, worktreePath: `/wt/${agent}`, inputs: {} })
    if (!result.ok) throw new Error(`start refused: ${result.reason}`)
    return result.runId
  }
  const exit = (id: string, code: number): void => {
    alive.delete(id)
    for (const listener of [...exitListeners]) listener(id, code)
  }
  const discover = (terminalId: string, sessionId: string): void => {
    store.dispatch({ type: 'terminals/sessionIdDiscovered', payload: { terminalId, sessionId } })
  }
  const promptSubmit = (terminalId: string): void => {
    for (const listener of [...promptListeners]) listener({ terminalId })
  }
  const tabFor = (agent: WorkflowAgent): { tab: TerminalTab; spawn: StepSpawnExtras } => {
    const found = [...tabs].reverse().find(({ tab }) => tab.agentKind === agent)
    if (!found) throw new Error(`no ${agent} tab`)
    return found
  }
  const recorded = (): StateEvent[] => {
    const events: StateEvent[] = []
    store.subscribe((event) => {
      if (event.type === 'workflows/attemptSessionRecorded') events.push(event)
    })
    return events
  }
  const wf = () => store.getSnapshot().state.workflows
  return {
    store,
    runner,
    driver,
    tabs,
    killed,
    persisted,
    logs,
    driverEvents,
    exitListeners,
    codexTrustChecks,
    start,
    exit,
    discover,
    promptSubmit,
    tabFor,
    recorded,
    wf
  }
}

describe('agent step driver with two profiles', () => {
  it('turns one PTY exit of an owned execution into exactly one exited event and ignores an unowned exit', async () => {
    const ctx = twoProfileRunner()
    const claudeRun = await ctx.start('claude')
    const codexRun = await ctx.start('codex')
    await flush()
    expect(ctx.exitListeners.size).toBe(1)
    const claudeTab = ctx.tabs.find(({ tab }) => tab.agentKind === 'claude')
    const codexTab = ctx.tabs.find(({ tab }) => tab.agentKind === 'codex')
    expect(claudeTab?.tab.label).toBe('⚙ plan · Claude')
    expect(codexTab?.tab.label).toBe('⚙ plan · Codex')
    expect(claudeTab?.spawn.sessionId).toBeDefined()
    expect(codexTab?.spawn).not.toHaveProperty('sessionId')
    if (!codexTab) throw new Error('no codex tab')
    const codexExecution = codexTab.tab.id
    const wf = () => ctx.store.getSnapshot().state.workflows

    ctx.exit(codexExecution, 0)
    expect(ctx.driverEvents.filter((event) => event.type === 'exited')).toEqual([
      { type: 'exited', executionId: codexExecution, code: 0 }
    ])
    const codexAttempt = wf().runs[codexRun].steps.plan.attemptIds[0]
    expect(wf().attempts[codexAttempt]).toMatchObject({ status: 'failed', completedBy: 'exit' })
    expect(wf().runs[claudeRun].steps.plan.status).toBe('running')

    const storeEvents: StateEvent[] = []
    ctx.store.subscribe((event) => storeEvents.push(event))
    const before = ctx.store.getSnapshot().state.workflows
    ctx.exit('user-tab', 1)
    expect(storeEvents).toEqual([])
    expect(ctx.store.getSnapshot().state.workflows).toBe(before)
  })

  it('fails the start of an agent kind without a profile with the unsupported message and opens no tab', async () => {
    const ctx = twoProfileRunner({ opencode: false })
    const step = detail('opencode').definition?.steps[0]
    if (step?.kind !== 'agent') throw new Error('no agent step')
    const bind = vi.fn(() => true)
    const started = ctx.driver.start({
      runId: 'run-1',
      stepId: 'plan',
      attemptId: 'att-1',
      n: 1,
      worktreePath: '/wt/codex',
      inputs: {},
      step,
      scope: { inputs: {}, steps: {}, run: { id: 'run-1', worktree: '/wt/codex', contextPath: '/wt/codex/ctx.md' } },
      bind
    })
    await expect(started).rejects.toEqual(new StepStartError(AGENT_START_SUMMARIES.unsupported))
    expect(bind).not.toHaveBeenCalled()
    expect(ctx.tabs).toEqual([])
  })
})

describe('codex profile', () => {
  it('spawns a Codex tab with the step permission level and model and no preassigned session', async () => {
    const ctx = twoProfileRunner()
    await ctx.start('codex')
    await flush()
    const { tab, spawn } = ctx.tabFor('codex')
    expect(tab).toMatchObject({ type: 'agent', agentKind: 'codex', label: '⚙ plan · Codex' })
    expect(spawn).toMatchObject({ permissionLevel: 'edit', model: 'gpt-test', initialPrompt: 'plan' })
    expect(spawn).not.toHaveProperty('sessionId')
    expect(ctx.codexTrustChecks).toEqual(['/wt/codex'])
  })

  it.each<TrustStatus>(['untrusted', 'unknown'])('pauses the run for trust when the folder is %s', async (status) => {
    const ctx = twoProfileRunner({ codexFolder: status })
    const runId = await ctx.start('codex')
    await flush()
    expect(ctx.tabs).toEqual([])
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'trust' })
    const attemptId = ctx.wf().runs[runId].steps.plan.attemptIds[0]
    expect(ctx.runner.getRunRecord(runId)?.attempts.find((a) => a.attemptId === attemptId)?.result).toEqual({
      status: 'failed',
      summary: 'codex folder trust required',
      completedBy: 'exit'
    })
  })

  it('pauses needs-input without a tab when Codex hooks stop being trusted before a retry', async () => {
    const ctx = twoProfileRunner()
    const runId = await ctx.start('codex')
    await flush()
    ctx.exit(ctx.tabFor('codex').tab.id, 1)
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'step-failed' })
    ctx.store.dispatch({ type: 'hooks/codexTrustChanged', payload: { state: 'needs-review', reviewEvents: ['Stop'] } })
    expect(ctx.runner.retryStep(runId, 'plan')).toEqual({ ok: true })
    await flush()
    expect(ctx.tabs).toHaveLength(1)
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'needs-input' })
    const record = ctx.runner.getRunRecord(runId)
    expect(record?.attempts.at(-1)?.result?.summary).toBe(AGENT_START_SUMMARIES.codexHooks)
  })

  it('records a discovered session id on the attempt and dispatches attemptSessionRecorded once', async () => {
    const ctx = twoProfileRunner()
    const runId = await ctx.start('codex')
    await flush()
    const executionId = ctx.tabFor('codex').tab.id
    const recorded = ctx.recorded()
    const attemptId = ctx.wf().runs[runId].steps.plan.attemptIds[0]
    expect(ctx.runner.getRunRecord(runId)?.attempts[0].sessionId).toBeUndefined()

    ctx.discover(executionId, CODEX_SESSION)
    ctx.discover(executionId, CODEX_SESSION)

    expect(recorded).toEqual([{ type: 'workflows/attemptSessionRecorded', payload: { attemptId } }])
    expect(ctx.runner.getRunRecord(runId)?.attempts[0].sessionId).toBe(CODEX_SESSION)
    expect(ctx.persisted.at(-1)?.attempts[0].sessionId).toBe(CODEX_SESSION)
    expect(ctx.wf().attempts[attemptId].resumable).toBe(true)
  })

  it.each([
    ['a non-UUID id', 'not-a-uuid'],
    ['a shell payload', `${CODEX_SESSION}; touch /tmp/pwned`],
    ['an empty id', ''],
    ['an opencode id', OPENCODE_SESSION]
  ])('drops %s without persisting or dispatching', async (_name, sessionId) => {
    const ctx = twoProfileRunner()
    const runId = await ctx.start('codex')
    await flush()
    const recorded = ctx.recorded()
    const persistedBefore = ctx.persisted.length
    ctx.discover(ctx.tabFor('codex').tab.id, sessionId)
    expect(recorded).toEqual([])
    expect(ctx.persisted).toHaveLength(persistedBefore)
    expect(ctx.runner.getRunRecord(runId)?.attempts[0].sessionId).toBeUndefined()
  })

  it('ignores discovery for a Claude execution and for an unowned terminal', async () => {
    const ctx = twoProfileRunner()
    const runId = await ctx.start('claude')
    await flush()
    const claudeTab = ctx.tabFor('claude')
    const recorded = ctx.recorded()
    ctx.discover(claudeTab.tab.id, CODEX_SESSION)
    ctx.discover('user-tab', CODEX_SESSION)
    expect(recorded).toEqual([])
    expect(ctx.driverEvents.some((event) => event.type === 'sessionDiscovered')).toBe(false)
    expect(ctx.runner.getRunRecord(runId)?.attempts[0].sessionId).toBe(claudeTab.spawn.sessionId)
  })

  it('resumes an interrupted Codex attempt with its session and keeps one dispatch when Codex reports another id', async () => {
    const ctx = twoProfileRunner()
    const runId = await ctx.start('codex')
    await flush()
    ctx.discover(ctx.tabFor('codex').tab.id, CODEX_SESSION)
    const record = ctx.runner.getRunRecord(runId)
    if (!record) throw new Error('no record')
    record.attempts[0].status = 'running'
    ctx.runner.dispose()

    const resumed = twoProfileRunner({ records: [record] })
    expect(resumed.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'interrupted' })
    const recorded = resumed.recorded()
    expect(resumed.runner.resumeStep(runId, 'plan')).toEqual({ ok: true })
    await flush()
    const { tab, spawn } = resumed.tabFor('codex')
    expect(spawn.sessionId).toBe(CODEX_SESSION)
    const attemptId = resumed.wf().runs[runId].steps.plan.attemptIds.at(-1)
    expect(recorded).toEqual([{ type: 'workflows/attemptSessionRecorded', payload: { attemptId } }])

    resumed.discover(tab.id, CODEX_SESSION)
    resumed.discover(tab.id, OTHER_CODEX_SESSION)

    expect(recorded).toHaveLength(1)
    expect(resumed.runner.getRunRecord(runId)?.attempts.at(-1)?.sessionId).toBe(OTHER_CODEX_SESSION)
    expect(resumed.persisted.at(-1)?.attempts.at(-1)?.sessionId).toBe(OTHER_CODEX_SESSION)
  })

  it('cancels each kind with its profile signal', async () => {
    const ctx = twoProfileRunner()
    const claudeRun = await ctx.start('claude')
    const codexRun = await ctx.start('codex')
    await flush()
    expect(ctx.runner.cancelStep(claudeRun, 'plan')).toEqual({ ok: true })
    expect(ctx.runner.cancelStep(codexRun, 'plan')).toEqual({ ok: true })
    expect(ctx.killed).toEqual([
      { id: ctx.tabFor('claude').tab.id, signal: 'SIGHUP' },
      { id: ctx.tabFor('codex').tab.id, signal: 'SIGHUP' }
    ])
    ctx.driver.cancel('reattached-tab')
    expect(ctx.killed.at(-1)).toEqual({ id: 'reattached-tab', signal: 'SIGHUP' })
  })

  it('blocks a Codex Stop once per turn and again only after a new prompt', async () => {
    const ctx = twoProfileRunner()
    const runId = await ctx.start('codex')
    await flush()
    const executionId = ctx.tabFor('codex').tab.id
    expect(ctx.runner.stopCheck(executionId, false)).toBe('block')
    expect(ctx.runner.stopCheck(executionId, false)).toBe('none')
    ctx.promptSubmit(executionId)
    expect(ctx.runner.stopCheck(executionId, false)).toBe('block')
    expect(ctx.runner.getRunRecord(runId)?.attempts[0].metrics.continuations).toBe(2)
  })
})

describe('codex hooks trust at start', () => {
  it.each<[string, CodexHookTrustSummary | null]>([
    ['not computed yet', null],
    ['needing review', { state: 'needs-review', reviewEvents: ['Stop'] }],
    ['not installed', { state: 'not-installed', reviewEvents: [] }],
    ['unknown', { state: 'unknown', reviewEvents: [] }]
  ])('refuses a Codex definition while Codex hooks are %s and still starts a Claude one', async (_name, codexTrust) => {
    const ctx = twoProfileRunner({ codexTrust })
    expect(await ctx.runner.start({ defId: 'personal:codex', worktreePath: '/wt/codex', inputs: {} })).toEqual({
      ok: false,
      reason: 'codex-hooks-untrusted'
    })
    expect(Object.keys(ctx.wf().runs)).toHaveLength(0)
    await ctx.start('claude')
    await flush()
    expect(ctx.tabs.map(({ tab }) => tab.agentKind)).toEqual(['claude'])
  })
})

describe('opencode profile', () => {
  it('spawns an opencode tab with the step permission level and model, no preassigned session and no trust check', async () => {
    const ctx = twoProfileRunner({ codexFolder: 'untrusted' })
    const runId = await ctx.start('opencode')
    await flush()
    const { tab, spawn } = ctx.tabFor('opencode')
    expect(tab).toMatchObject({ type: 'agent', agentKind: 'opencode', label: '⚙ plan · opencode' })
    expect(spawn).toMatchObject({ permissionLevel: 'edit', model: 'gpt-test', initialPrompt: 'plan' })
    expect(spawn).not.toHaveProperty('sessionId')
    expect(ctx.codexTrustChecks).toEqual([])
    expect(ctx.wf().runs[runId].steps.plan.status).toBe('running')
  })

  it('starts an opencode definition while Codex hooks are untrusted', async () => {
    const ctx = twoProfileRunner({ codexTrust: null })
    await ctx.start('opencode')
    await flush()
    expect(ctx.tabs.map(({ tab }) => tab.agentKind)).toEqual(['opencode'])
  })

  it('records a discovered opencode session id on the attempt and dispatches attemptSessionRecorded once', async () => {
    const ctx = twoProfileRunner()
    const runId = await ctx.start('opencode')
    await flush()
    const executionId = ctx.tabFor('opencode').tab.id
    const recorded = ctx.recorded()
    const attemptId = ctx.wf().runs[runId].steps.plan.attemptIds[0]

    ctx.discover(executionId, OPENCODE_SESSION)
    ctx.discover(executionId, OPENCODE_SESSION)

    expect(recorded).toEqual([{ type: 'workflows/attemptSessionRecorded', payload: { attemptId } }])
    expect(ctx.runner.getRunRecord(runId)?.attempts[0].sessionId).toBe(OPENCODE_SESSION)
    expect(ctx.persisted.at(-1)?.attempts[0].sessionId).toBe(OPENCODE_SESSION)
  })

  it.each([
    ['a UUID', CODEX_SESSION],
    ['a shell payload', `${OPENCODE_SESSION}; touch /tmp/pwned`],
    ['a bare prefix', 'ses_'],
    ['a quoted id', `'${OPENCODE_SESSION}'`]
  ])('drops %s without persisting or dispatching', async (_name, sessionId) => {
    const ctx = twoProfileRunner()
    const runId = await ctx.start('opencode')
    await flush()
    const recorded = ctx.recorded()
    const persistedBefore = ctx.persisted.length
    ctx.discover(ctx.tabFor('opencode').tab.id, sessionId)
    expect(recorded).toEqual([])
    expect(ctx.persisted).toHaveLength(persistedBefore)
    expect(ctx.runner.getRunRecord(runId)?.attempts[0].sessionId).toBeUndefined()
  })

  it('blocks an opencode idle once and not again while the plugin reports the continuation as active', async () => {
    const ctx = twoProfileRunner()
    const runId = await ctx.start('opencode')
    await flush()
    const executionId = ctx.tabFor('opencode').tab.id
    expect(ctx.runner.stopCheck(executionId, false)).toBe('block')
    ctx.promptSubmit(executionId)
    expect(ctx.runner.stopCheck(executionId, true)).toBe('none')
    expect(ctx.runner.getRunRecord(runId)?.attempts[0].metrics.continuations).toBe(1)
  })

  it('cancels an opencode step with SIGHUP', async () => {
    const ctx = twoProfileRunner()
    const runId = await ctx.start('opencode')
    await flush()
    expect(ctx.runner.cancelStep(runId, 'plan')).toEqual({ ok: true })
    expect(ctx.killed).toEqual([{ id: ctx.tabFor('opencode').tab.id, signal: 'SIGHUP' }])
  })
})

describe('resume after a restart', () => {
  const RESUMABLE: Array<{ agent: 'codex' | 'opencode'; session: string; command: string; expected: string }> = [
    { agent: 'codex', session: CODEX_SESSION, command: '/scratch/codex', expected: `resume '${CODEX_SESSION}'` },
    {
      agent: 'opencode',
      session: OPENCODE_SESSION,
      command: '/scratch/opencode',
      expected: `--session '${OPENCODE_SESSION}'`
    }
  ]

  const spawnLine = (agent: 'codex' | 'opencode', command: string, spawn: StepSpawnExtras): string => {
    const opts = { ...spawn, command, cwd: `/wt/${agent}` }
    const exists = (_cwd: string, id: string, cmd: string) => id === spawn.sessionId && cmd === command
    return agent === 'codex' ? codexAgent.buildSpawnArgs(opts, exists) : opencodeAgent.buildSpawnArgs(opts, exists)
  }

  const interruptedRecord = async (agent: 'codex' | 'opencode', session?: string): Promise<WorkflowRunRecord> => {
    const ctx = twoProfileRunner()
    const runId = await ctx.start(agent)
    await flush()
    if (session) ctx.discover(ctx.tabFor(agent).tab.id, session)
    const record = ctx.runner.getRunRecord(runId)
    if (!record) throw new Error('no record')
    record.attempts[0].status = 'running'
    ctx.runner.dispose()
    return record
  }

  it.each(RESUMABLE)(
    'interrupts a dead running $agent attempt and resumes it in a new tab with its session',
    async ({ agent, session, command, expected }) => {
      const record = await interruptedRecord(agent, session)
      const resumed = twoProfileRunner({ records: [record] })
      expect(resumed.runner.getRunRecord(record.runId)?.attempts[0].status).toBe('interrupted')
      expect(resumed.wf().runs[record.runId]).toMatchObject({ status: 'paused', pausedReason: 'interrupted' })
      expect(resumed.wf().attempts[record.attempts[0].attemptId]?.resumable).toBe(true)

      expect(resumed.runner.resumeStep(record.runId, 'plan')).toEqual({ ok: true })
      await flush()

      const { spawn } = resumed.tabFor(agent)
      expect(spawn.sessionId).toBe(session)
      expect(spawnLine(agent, command, spawn)).toContain(expected)
      expect(resumed.runner.getRunRecord(record.runId)?.attempts).toHaveLength(2)
    }
  )

  it.each(RESUMABLE)('refuses to resume an interrupted $agent attempt with no session id', async ({ agent }) => {
    const record = await interruptedRecord(agent)
    expect(record.attempts[0].sessionId).toBeUndefined()
    const resumed = twoProfileRunner({ records: [record] })
    expect(resumed.runner.getRunRecord(record.runId)?.attempts[0].status).toBe('interrupted')
    expect(resumed.wf().attempts[record.attempts[0].attemptId]?.resumable).toBeUndefined()

    expect(resumed.runner.resumeStep(record.runId, 'plan')).toEqual({ ok: false, reason: 'no-session' })
    expect(resumed.tabs).toEqual([])
  })
})

describe('step harness overrides at start', () => {
  it('spawns the overridden agent and model and records the original step', async () => {
    const ctx = twoProfileRunner()
    const result = await ctx.runner.start({
      defId: 'personal:claude',
      worktreePath: '/wt/claude',
      inputs: {},
      overrides: { plan: { agent: 'codex', model: 'gpt-override' } }
    })
    if (!result.ok) throw new Error(`start refused: ${result.reason}`)
    await flush()
    expect(ctx.tabs.map(({ tab }) => tab.agentKind)).toEqual(['codex'])
    expect(ctx.tabFor('codex').spawn).toMatchObject({ permissionLevel: 'edit', model: 'gpt-override' })
    const record = ctx.runner.getRunRecord(result.runId)
    expect(record?.definition.steps[0]).toMatchObject({
      agent: 'codex',
      model: 'gpt-override',
      permissions: 'edit'
    })
    expect(record?.overriddenFrom).toEqual({ plan: { agent: 'claude', model: 'gpt-test' } })
    expect(record?.attempts[0]).toMatchObject({ agent: 'codex', model: 'gpt-override' })
    expect(ctx.wf().runs[result.runId].steps.plan.agent).toBe('codex')
  })

  it('drops the definition model when only the agent is overridden', async () => {
    const ctx = twoProfileRunner()
    const result = await ctx.runner.start({
      defId: 'personal:claude',
      worktreePath: '/wt/claude',
      inputs: {},
      overrides: { plan: { agent: 'opencode' } }
    })
    if (!result.ok) throw new Error(`start refused: ${result.reason}`)
    await flush()
    expect(ctx.tabFor('opencode').spawn).not.toHaveProperty('model')
  })

  it('runs the Codex hooks check on the overridden agent', async () => {
    const ctx = twoProfileRunner({ codexTrust: { state: 'needs-review', reviewEvents: ['Stop'] } })
    const request = { defId: 'personal:claude', worktreePath: '/wt/claude', inputs: {} }
    expect(await ctx.runner.start({ ...request, overrides: { plan: { agent: 'codex' } } })).toEqual({
      ok: false,
      reason: 'codex-hooks-untrusted'
    })
    expect((await ctx.runner.start({ ...request, overrides: { plan: { agent: 'opencode' } } })).ok).toBe(true)
  })

  it.each([
    ['an unknown step', { ship: { agent: 'codex' } }, 'invalid-overrides'],
    ['a prototype key', { constructor: { agent: 'codex' } }, 'invalid-overrides'],
    ['an unsupported agent', { plan: { agent: 'pi' } }, 'unsupported-agent'],
    ['an empty model', { plan: { model: ' ' } }, 'invalid-overrides'],
    ['an over-long model', { plan: { model: 'm'.repeat(201) } }, 'invalid-overrides']
  ])('refuses %s and starts nothing', async (_name, overrides, reason) => {
    const ctx = twoProfileRunner()
    const overridesRecord: Record<string, { agent?: string; model?: string }> = Object.fromEntries(Object.entries(overrides))
    expect(
      await ctx.runner.start({ defId: 'personal:claude', worktreePath: '/wt/claude', inputs: {}, overrides: overridesRecord })
    ).toEqual({ ok: false, reason })
    expect(Object.keys(ctx.wf().runs)).toHaveLength(0)
  })
})

describe('swapStep', () => {
  async function failedClaudeRun(ctx: ReturnType<typeof twoProfileRunner>, defId = 'personal:claude') {
    const result = await ctx.runner.start({ defId, worktreePath: '/wt/claude', inputs: {}, allowFull: true })
    if (!result.ok) throw new Error(`start refused: ${result.reason}`)
    await flush()
    ctx.exit(ctx.tabFor('claude').tab.id, 1)
    expect(ctx.wf().runs[result.runId]).toMatchObject({ status: 'paused', pausedReason: 'step-failed' })
    return result.runId
  }

  it('retries a failed step with the new agent and model, records it and keeps permissions', async () => {
    const ctx = twoProfileRunner()
    const runId = await failedClaudeRun(ctx)
    const before = ctx.runner.getRunRecord(runId)?.definition.steps[0]
    expect(ctx.runner.swapStep(runId, 'plan', { agent: 'codex', model: 'gpt-swap' })).toEqual({ ok: true })
    await flush()
    expect(ctx.tabFor('codex').spawn).toMatchObject({ permissionLevel: 'edit', model: 'gpt-swap' })
    const record = ctx.runner.getRunRecord(runId)
    const after = record?.definition.steps[0]
    if (before?.kind !== 'agent' || after?.kind !== 'agent') throw new Error('not agent steps')
    expect({ permissions: after.permissions, allow: after.allow, prompt: after.prompt }).toEqual({
      permissions: before.permissions,
      allow: before.allow,
      prompt: before.prompt
    })
    expect(after).toMatchObject({ agent: 'codex', model: 'gpt-swap' })
    expect(record?.overriddenFrom).toEqual({ plan: { agent: 'claude', model: 'gpt-test' } })
    expect(record?.attempts.map((a) => [a.n, a.agent, a.status])).toEqual([
      [1, 'claude', 'failed'],
      [2, 'codex', 'running']
    ])
    expect(ctx.wf().runs[runId]).toMatchObject({ status: 'running' })
    expect(ctx.wf().runs[runId].steps.plan).toMatchObject({ status: 'running', agent: 'codex' })
    expect(ctx.persisted.at(-1)?.definition.steps[0]).toMatchObject({ agent: 'codex' })
  })

  it('keeps the first original in overriddenFrom across two swaps', async () => {
    const ctx = twoProfileRunner()
    const runId = await failedClaudeRun(ctx)
    expect(ctx.runner.swapStep(runId, 'plan', { agent: 'opencode', model: 'm/one' })).toEqual({ ok: true })
    await flush()
    ctx.exit(ctx.tabFor('opencode').tab.id, 1)
    expect(ctx.runner.swapStep(runId, 'plan', { model: 'm/two' })).toEqual({ ok: true })
    await flush()
    expect(ctx.tabFor('opencode').spawn).toMatchObject({ model: 'm/two' })
    expect(ctx.runner.getRunRecord(runId)?.overriddenFrom).toEqual({ plan: { agent: 'claude', model: 'gpt-test' } })
  })

  it('refuses a swap to Codex while Codex hooks are untrusted and leaves the run unchanged', async () => {
    const ctx = twoProfileRunner({ codexTrust: { state: 'needs-review', reviewEvents: ['Stop'] } })
    const runId = await failedClaudeRun(ctx)
    const before = ctx.runner.getRunRecord(runId)
    expect(ctx.runner.swapStep(runId, 'plan', { agent: 'codex', model: 'gpt-swap' })).toEqual({
      ok: false,
      reason: 'codex-hooks-untrusted'
    })
    await flush()
    expect(ctx.runner.getRunRecord(runId)).toEqual(before)
    expect(ctx.tabs.map(({ tab }) => tab.agentKind)).toEqual(['claude'])
    expect(ctx.wf().runs[runId].steps.plan).toMatchObject({ status: 'failed', agent: 'claude' })
  })

  it('refuses a swap on a running step', async () => {
    const ctx = twoProfileRunner()
    const runId = await ctx.start('claude')
    await flush()
    expect(ctx.runner.swapStep(runId, 'plan', { agent: 'codex', model: 'gpt-swap' })).toEqual({
      ok: false,
      reason: 'not-paused'
    })
    expect(ctx.tabs.map(({ tab }) => tab.agentKind)).toEqual(['claude'])
  })

  it('needs the full-access confirmation again for a full step', async () => {
    const ctx = twoProfileRunner()
    const runId = await failedClaudeRun(ctx, 'personal:claude-full')
    expect(ctx.runner.swapStep(runId, 'plan', { agent: 'codex', model: 'gpt-swap' })).toEqual({
      ok: false,
      reason: 'full-permission-unconfirmed'
    })
    expect(ctx.runner.swapStep(runId, 'plan', { agent: 'codex', model: 'gpt-swap', allowFull: true })).toEqual({
      ok: true
    })
    await flush()
    expect(ctx.tabFor('codex').spawn).toMatchObject({ permissionLevel: 'full' })
  })

  it.each<[string, string, { agent?: string; model?: string }, string]>([
    ['an unsupported agent', 'plan', { agent: 'pi' }, 'unsupported-agent'],
    ['an invalid model', 'plan', { model: 'a\nb' }, 'invalid-override'],
    ['an unknown step', 'ship', { agent: 'codex' }, 'wrong-step']
  ])('refuses %s', async (_name, stepId, request, reason) => {
    const ctx = twoProfileRunner()
    const runId = await failedClaudeRun(ctx)
    expect(ctx.runner.swapStep(runId, stepId, request)).toEqual({ ok: false, reason })
  })

  it('refuses while Labs workflows are off', async () => {
    const ctx = twoProfileRunner()
    const runId = await failedClaudeRun(ctx)
    ctx.store.dispatch({ type: 'settings/labsChanged', payload: { workflows: false } })
    expect(ctx.runner.swapStep(runId, 'plan', { agent: 'codex', model: 'gpt-swap' })).toEqual({
      ok: false,
      reason: 'labs-off'
    })
  })
})

describe('untrusted issue and PR inputs', () => {
  const ISSUE_START = { defId: 'personal:input-issue', worktreePath: '/wt/claude', inputs: { ticket: '7' } }

  function trustFetcher(verdict: 'trusted' | 'untrusted') {
    return vi.fn<InputTrustFetcher>(async () => verdict)
  }

  it('caps a full step to edit in the spawned extras when the issue author is not a collaborator', async () => {
    const inputTrust = trustFetcher('untrusted')
    const ctx = twoProfileRunner({ inputTrust })
    const result = await ctx.runner.start(ISSUE_START)
    if (!result.ok) throw new Error(`start refused: ${result.reason}`)
    await flush()
    expect(inputTrust).toHaveBeenCalledWith('/wt/claude', 'issue', '7')
    expect(ctx.tabFor('claude').spawn).toMatchObject({ permissionLevel: 'edit' })
    const record = ctx.runner.getRunRecord(result.runId)
    expect(record?.inputsUntrusted).toBe(true)
    expect(record?.definition.steps[0]).toMatchObject({ permissions: 'edit' })
    expect(ctx.persisted.at(-1)?.inputsUntrusted).toBe(true)
  })

  it('leaves a full step full when the issue author is a collaborator', async () => {
    const ctx = twoProfileRunner({ inputTrust: trustFetcher('trusted') })
    expect(await ctx.runner.start(ISSUE_START)).toEqual({ ok: false, reason: 'full-permission-unconfirmed' })
    const result = await ctx.runner.start({ ...ISSUE_START, allowFull: true })
    if (!result.ok) throw new Error(`start refused: ${result.reason}`)
    await flush()
    expect(ctx.tabFor('claude').spawn).toMatchObject({ permissionLevel: 'full' })
    expect(ctx.runner.getRunRecord(result.runId)?.inputsUntrusted).toBeUndefined()
  })

  it('looks up a pr input as a pull request', async () => {
    const inputTrust = trustFetcher('untrusted')
    const ctx = twoProfileRunner({ inputTrust })
    const result = await ctx.runner.start({ defId: 'personal:input-pr', worktreePath: '/wt/claude', inputs: { ticket: '12' } })
    expect(result.ok).toBe(true)
    await flush()
    expect(inputTrust).toHaveBeenCalledWith('/wt/claude', 'pr', '12')
    expect(ctx.tabFor('claude').spawn).toMatchObject({ permissionLevel: 'edit' })
  })

  it.each<[string, Partial<RunnerOptions>]>([
    ['the lookup throws', { inputTrust: vi.fn<InputTrustFetcher>(async () => Promise.reject(new Error('offline'))) }],
    ['the lookup throws synchronously', { inputTrust: vi.fn<InputTrustFetcher>(() => { throw new Error('boom') }) }],
    ['the lookup times out', { inputTrust: vi.fn<InputTrustFetcher>(() => new Promise(() => {})), inputTrustTimeoutMs: 5 }],
    ['the lookup returns something else', { inputTrust: vi.fn(async () => 'OWNER') as unknown as InputTrustFetcher }],
    ['no fetcher is wired', {}]
  ])('caps when %s', async (_name, options) => {
    const ctx = twoProfileRunner(options)
    const result = await ctx.runner.start(ISSUE_START)
    if (!result.ok) throw new Error(`start refused: ${result.reason}`)
    await flush()
    expect(ctx.tabFor('claude').spawn).toMatchObject({ permissionLevel: 'edit' })
    expect(ctx.runner.getRunRecord(result.runId)?.inputsUntrusted).toBe(true)
  })

  it('does not look anything up for a definition without issue or PR inputs', async () => {
    const inputTrust = trustFetcher('untrusted')
    const ctx = twoProfileRunner({ inputTrust })
    await ctx.start('claude')
    expect(inputTrust).not.toHaveBeenCalled()
  })

  it('does not look anything up for a request refused before the lookup', async () => {
    const inputTrust = trustFetcher('trusted')
    const ctx = twoProfileRunner({ inputTrust })
    expect(await ctx.runner.start({ ...ISSUE_START, worktreePath: '/wt/unknown' })).toEqual({
      ok: false,
      reason: 'unknown-worktree'
    })
    expect(await ctx.runner.start({ ...ISSUE_START, inputs: {} })).toEqual({ ok: false, reason: 'missing-input' })
    expect(inputTrust).not.toHaveBeenCalled()
  })

  it('re-checks the worktree and Labs after the lookup', async () => {
    let release: (verdict: 'trusted' | 'untrusted') => void = () => {}
    const inputTrust = vi.fn<InputTrustFetcher>(
      () => new Promise((resolve) => {
        release = resolve
      })
    )
    const ctx = twoProfileRunner({ inputTrust })
    const pending = ctx.runner.start(ISSUE_START)
    await flush()
    await ctx.start('claude')
    release('untrusted')
    expect(await pending).toEqual({ ok: false, reason: 'worktree-busy' })

    const other = twoProfileRunner({ inputTrust })
    const held = other.runner.start(ISSUE_START)
    await flush()
    expect(inputTrust).toHaveBeenCalledTimes(2)
    other.store.dispatch({ type: 'settings/labsChanged', payload: { workflows: false } })
    release('trusted')
    expect(await held).toEqual({ ok: false, reason: 'labs-off' })
    expect(Object.keys(other.wf().runs)).toHaveLength(0)
  })

  it('logs the verdict with the input name, type and number only', async () => {
    const ctx = twoProfileRunner({ inputTrust: trustFetcher('untrusted') })
    const result = await ctx.runner.start(ISSUE_START)
    if (!result.ok) throw new Error(`start refused: ${result.reason}`)
    expect(ctx.logs).toContainEqual({
      message: 'run input untrusted',
      data: { runId: result.runId, input: 'ticket', type: 'issue', number: '7' }
    })
    expect(ctx.logs).toContainEqual({ message: 'run capped at edit permissions', data: { runId: result.runId } })
  })

  it('never spawns full on retry or swap of an untrusted run and needs no allowFull', async () => {
    const ctx = twoProfileRunner({ inputTrust: trustFetcher('untrusted') })
    const result = await ctx.runner.start(ISSUE_START)
    if (!result.ok) throw new Error(`start refused: ${result.reason}`)
    const { runId } = result
    await flush()
    ctx.exit(ctx.tabFor('claude').tab.id, 1)
    expect(ctx.runner.retryStep(runId, 'plan')).toEqual({ ok: true })
    await flush()
    expect(ctx.tabFor('claude').spawn).toMatchObject({ permissionLevel: 'edit' })
    ctx.exit(ctx.tabFor('claude').tab.id, 1)
    expect(ctx.runner.swapStep(runId, 'plan', { agent: 'codex', model: 'gpt-swap' })).toEqual({ ok: true })
    await flush()
    expect(ctx.tabFor('codex').spawn).toMatchObject({ permissionLevel: 'edit' })
    expect(ctx.tabs.every(({ spawn }) => spawn.permissionLevel === 'edit')).toBe(true)
  })

  it('spawns edit on every later path of a two-step untrusted run: advance, retry from clean, restart and resume', async () => {
    const restored: string[] = []
    const artifacts: RunArtifacts = {
      prepare: async () => {},
      snapshot: async () => ({ commit: 'a'.repeat(40), ref: 'refs/harness/test' }),
      appendContext: async () => {},
      restore: async ({ commit }) => {
        restored.push(commit)
      }
    }
    const ctx = twoProfileRunner({ inputTrust: trustFetcher('untrusted'), artifacts })
    const result = await ctx.runner.start({ ...ISSUE_START, defId: 'personal:input-issue-ship' })
    if (!result.ok) throw new Error(`start refused: ${result.reason}`)
    const { runId } = result
    await vi.waitFor(() => expect(ctx.tabs).toHaveLength(1))
    expect(ctx.runner.markDone(runId, 'plan', { summary: 'planned', fields: {} })).toEqual({ ok: true })
    await vi.waitFor(() => expect(ctx.tabs).toHaveLength(2))
    expect(ctx.tabs[1].tab.workflow).toMatchObject({ stepId: 'ship' })
    ctx.exit(ctx.tabs[1].tab.id, 1)
    await vi.waitFor(() => expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused' }))
    expect(await ctx.runner.retryFromClean(runId, 'ship')).toEqual({ ok: true })
    expect(restored).toHaveLength(1)
    await vi.waitFor(() => expect(ctx.tabs).toHaveLength(3))
    await vi.waitFor(() => expect(ctx.runner.getRunRecord(runId)?.attempts.at(-1)?.sessionId).toBeDefined())

    const saved = ctx.runner.getRunRecord(runId)
    if (!saved) throw new Error('no record')
    ctx.runner.dispose()
    const resumed = twoProfileRunner({ records: [saved] })
    expect(resumed.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'interrupted' })
    expect(resumed.runner.resumeStep(runId, 'ship')).toEqual({ ok: true })
    await vi.waitFor(() => expect(resumed.tabs).toHaveLength(1))
    expect(resumed.tabs[0].spawn.sessionId).toBe(saved.attempts.at(-1)?.sessionId)

    expect([...ctx.tabs, ...resumed.tabs].map(({ spawn }) => spawn.permissionLevel)).toEqual(['edit', 'edit', 'edit', 'edit'])
  })

  it('keeps the cap for a reconciled untrusted record', async () => {
    const first = twoProfileRunner({ inputTrust: trustFetcher('untrusted') })
    const result = await first.runner.start(ISSUE_START)
    if (!result.ok) throw new Error(`start refused: ${result.reason}`)
    await flush()
    first.exit(first.tabFor('claude').tab.id, 1)
    const saved = first.persisted.at(-1)
    if (!saved) throw new Error('no record persisted')
    const ctx = twoProfileRunner({ records: [saved] })
    expect(ctx.runner.retryStep(result.runId, 'plan')).toEqual({ ok: true })
    await flush()
    expect(ctx.tabFor('claude').spawn).toMatchObject({ permissionLevel: 'edit' })
  })
})

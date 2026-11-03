import { describe, expect, it, vi } from 'vitest'
import { Store } from '../store'
import { initialState, type StateEvent } from '../../shared/state'
import type { CodexHookTrustSummary } from '../../shared/state/hooks'
import type { TerminalTab } from '../../shared/state/terminals'
import { hydrateWorkflowRuns, type WorkflowDefinitionDetail, type WorkflowRunRecord } from '../../shared/state/workflows'
import { validateWorkflowDefinition, type WorkflowAgent } from '../../shared/workflow-def'
import type { StepSpawnExtras } from '../agent-spawn'
import type { TrustStatus } from '../folder-trust'
import {
  WorkflowRunner,
  AGENT_START_SUMMARIES,
  StepStartError,
  claudeProfile,
  codexProfile,
  createAgentStepDriver,
  type StepDriverEvent
} from '.'
import { FakeStepDriver, worktreeFixture } from './fake-step-driver'

vi.mock('../perf-log', () => ({
  perfLog: vi.fn(),
  getPerfLogFilePath: vi.fn(() => '/tmp/perf.log')
}))

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function detail(agent: WorkflowAgent): WorkflowDefinitionDetail {
  const source = `name: ${agent}-def
steps:
  - id: plan
    agent: claude
    permissions: edit
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
      id: `personal:${agent}`,
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
const OK_TRUST: CodexHookTrustSummary = { state: 'ok', reviewEvents: [] }

interface RunnerOptions {
  codexTrust?: CodexHookTrustSummary | null
  codexFolder?: TrustStatus
  records?: WorkflowRunRecord[]
}

function twoProfileRunner({ codexTrust = OK_TRUST, codexFolder = 'trusted', records = [] }: RunnerOptions = {}) {
  const store = new Store({
    ...initialState,
    hooks: { ...initialState.hooks, consent: 'accepted', codexTrust },
    workflows: { ...initialState.workflows, ...hydrateWorkflowRuns(records) },
    worktrees: { ...initialState.worktrees, list: ['/wt/claude', '/wt/codex'].map(worktreeFixture) },
    settings: { ...initialState.settings, labs: { ...initialState.settings.labs, workflows: true } }
  })
  const tabs: Array<{ tab: TerminalTab; spawn: StepSpawnExtras }> = []
  const alive = new Set<string>()
  const killed: Array<{ id: string; signal: string }> = []
  const persisted: WorkflowRunRecord[] = []
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
      })
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
      getDefinition: (id) => (id === 'personal:claude' ? detail('claude') : id === 'personal:codex' ? detail('codex') : null)
    },
    drivers: { agent: driver, shell: new FakeStepDriver('shell') },
    now: () => ++next,
    newId: () => `id-${++next}`,
    log: () => {},
    persist: (run) => persisted.push(structuredClone(run))
  })
  runner.reconcile(records)
  const start = (agent: WorkflowAgent): string => {
    const result = runner.start({ defId: `personal:${agent}`, worktreePath: `/wt/${agent}`, inputs: {} })
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
    const claudeRun = ctx.start('claude')
    const codexRun = ctx.start('codex')
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
    const ctx = twoProfileRunner()
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
    ctx.start('codex')
    await flush()
    const { tab, spawn } = ctx.tabFor('codex')
    expect(tab).toMatchObject({ type: 'agent', agentKind: 'codex', label: '⚙ plan · Codex' })
    expect(spawn).toMatchObject({ permissionLevel: 'edit', model: 'gpt-test', initialPrompt: 'plan' })
    expect(spawn).not.toHaveProperty('sessionId')
    expect(ctx.codexTrustChecks).toEqual(['/wt/codex'])
  })

  it.each<TrustStatus>(['untrusted', 'unknown'])('pauses the run for trust when the folder is %s', async (status) => {
    const ctx = twoProfileRunner({ codexFolder: status })
    const runId = ctx.start('codex')
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
    const runId = ctx.start('codex')
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
    const runId = ctx.start('codex')
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
    ['an empty id', '']
  ])('drops %s without persisting or dispatching', async (_name, sessionId) => {
    const ctx = twoProfileRunner()
    const runId = ctx.start('codex')
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
    const runId = ctx.start('claude')
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
    const runId = ctx.start('codex')
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
    const claudeRun = ctx.start('claude')
    const codexRun = ctx.start('codex')
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
    const runId = ctx.start('codex')
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
    expect(ctx.runner.start({ defId: 'personal:codex', worktreePath: '/wt/codex', inputs: {} })).toEqual({
      ok: false,
      reason: 'codex-hooks-untrusted'
    })
    expect(Object.keys(ctx.wf().runs)).toHaveLength(0)
    ctx.start('claude')
    await flush()
    expect(ctx.tabs.map(({ tab }) => tab.agentKind)).toEqual(['claude'])
  })
})

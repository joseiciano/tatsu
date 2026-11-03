import { describe, expect, it, vi } from 'vitest'
import { Store } from '../store'
import { initialState, type StateEvent } from '../../shared/state'
import type { TerminalTab } from '../../shared/state/terminals'
import type { WorkflowDefinitionDetail } from '../../shared/state/workflows'
import { validateWorkflowDefinition, type WorkflowAgent } from '../../shared/workflow-def'
import type { StepSpawnExtras } from '../agent-spawn'
import {
  WorkflowRunner,
  AGENT_START_SUMMARIES,
  StepStartError,
  claudeProfile,
  createAgentStepDriver,
  type AgentProfile,
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
    permissions: read-only
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

const fakeCodexProfile: AgentProfile = {
  kind: 'codex',
  label: 'Codex',
  session: 'discovered',
  checkTrust: async () => 'trusted',
  startSummaries: { trust: 'codex trust required', spawnFailed: 'codex failed to start' }
}

function twoProfileRunner() {
  const store = new Store({
    ...initialState,
    hooks: { ...initialState.hooks, consent: 'accepted' },
    worktrees: { ...initialState.worktrees, list: ['/wt/claude', '/wt/codex'].map(worktreeFixture) },
    settings: { ...initialState.settings, labs: { ...initialState.settings.labs, workflows: true } }
  })
  const tabs: Array<{ tab: TerminalTab; spawn: StepSpawnExtras }> = []
  const alive = new Set<string>()
  const exitListeners = new Set<(id: string, code: number, signal?: number) => void>()
  let ids = 0
  const driver = createAgentStepDriver({
    profiles: [claudeProfile(async () => ({ status: 'trusted' })), fakeCodexProfile],
    addTab: (_worktreePath, tab, spawn) => {
      tabs.push({ tab, spawn })
      alive.add(tab.id)
    },
    hasTerminal: (id) => alive.has(id),
    onExit: (listener) => {
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    },
    kill: () => {},
    onStopEvent: () => () => {},
    onPromptSubmit: () => () => {},
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
    persist: () => {}
  })
  runner.reconcile([])
  const start = (agent: WorkflowAgent): string => {
    const result = runner.start({ defId: `personal:${agent}`, worktreePath: `/wt/${agent}`, inputs: {} })
    if (!result.ok) throw new Error(`start refused: ${result.reason}`)
    return result.runId
  }
  const exit = (id: string, code: number): void => {
    alive.delete(id)
    for (const listener of [...exitListeners]) listener(id, code)
  }
  return { store, runner, driver, tabs, driverEvents, exitListeners, start, exit }
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

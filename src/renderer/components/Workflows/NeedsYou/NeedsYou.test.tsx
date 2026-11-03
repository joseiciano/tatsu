// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NeedsYouGroup } from './NeedsYou'
import { initialState, type AppState } from '../../../../shared/state'
import type {
  WorkflowAttempt,
  WorkflowDefinitionSummary,
  WorkflowPausedReason,
  WorkflowRun,
  WorkflowRunRecord
} from '../../../../shared/state/workflows'
import type { PaneNode } from '../../../../shared/state/terminals'
import type { ResolvedWorkflowStep } from '../../../../shared/workflow-def'

const { backendApi, storeState } = vi.hoisted(() => ({
  backendApi: {
    getWorkflowRun: vi.fn(),
    retryWorkflowStep: vi.fn(),
    retryWorkflowStepFromClean: vi.fn(),
    skipWorkflowStep: vi.fn(),
    resumeWorkflowStep: vi.fn(),
    cancelWorkflowRun: vi.fn()
  },
  storeState: { current: null as AppState | null }
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../backend', () => ({ useBackend: () => backendApi }))
vi.mock('../../../store', async () => {
  const selectors = await import('../../../workflow-selectors')
  const selectPaused = selectors.createPausedRunIdsSelector()
  const useAppState = <T,>(selector: (s: AppState) => T): T => {
    if (!storeState.current) throw new Error('store not set')
    return selector(storeState.current)
  }
  return {
    useAppState,
    usePausedWorkflowRunIds: () => useAppState((s) => selectPaused(s.workflows)),
    useWorkflowRun: (id: string | null) => useAppState((s) => (id ? s.workflows.runs[id] ?? null : null)),
    useWorkflowAttempt: (id: string | null) => useAppState((s) => (id ? s.workflows.attempts[id] ?? null : null)),
    useWorkflowDefinition: (id: string | null) => useAppState((s) => (id ? s.workflows.definitions[id] ?? null : null)),
    useWorkflowStepTabLeaf: (path: string | null, ref: { runId: string; stepId: string; attemptId: string | null }) =>
      useAppState((s) => (path ? selectors.findWorkflowStepTab(s.terminals.panes[path], ref)?.leaf ?? null : null))
  }
})

const SUMMARY: WorkflowDefinitionSummary = {
  id: 'personal:ship',
  name: 'Ship it',
  scope: 'personal',
  path: '/d/ship.yaml',
  hash: 'h',
  stepIds: ['plan', 'build'],
  issues: []
}

const PLAN: ResolvedWorkflowStep = { id: 'plan', kind: 'shell', run: 'make plan', needs: [] }
const BUILD_CLAUDE: ResolvedWorkflowStep = {
  id: 'build',
  kind: 'agent',
  agent: 'claude',
  prompt: 'go',
  permissions: 'edit',
  allow: [],
  needs: ['plan']
}
const BUILD_SHELL: ResolvedWorkflowStep = { id: 'build', kind: 'shell', run: 'make', needs: ['plan'] }

function pausedRun(reason: WorkflowPausedReason, buildAttemptIds: string[], buildStatus: 'failed' | 'interrupted' | 'pending' | 'running' | 'cancelled' = 'failed'): WorkflowRun {
  return {
    defId: SUMMARY.id,
    defHash: 'h',
    worktreePath: '/wt/feature',
    status: 'paused',
    pausedReason: reason,
    startedAt: 1,
    steps: {
      plan: { status: 'done', attemptIds: ['a0'] },
      build: { status: buildStatus, attemptIds: buildAttemptIds }
    }
  }
}

function attempt(stepId: string, status: WorkflowAttempt['status']): WorkflowAttempt {
  return { runId: 'r1', stepId, n: 1, status, summaryPreview: '', startedAt: 2, endedAt: 3 }
}

function record(build: ResolvedWorkflowStep, attempts: WorkflowRunRecord['attempts']): WorkflowRunRecord {
  return {
    version: 1,
    runId: 'r1',
    defId: SUMMARY.id,
    defHash: 'h',
    definition: { name: 'Ship it', inputs: {}, steps: [PLAN, build] },
    inputs: {},
    worktreePath: '/wt/feature',
    contextPath: '/ctx',
    status: 'paused',
    cursor: 1,
    steps: {},
    startedAt: 1,
    attempts
  }
}

function attemptRecord(attemptId: string, stepId: string, status: WorkflowAttempt['status'], sessionId?: string) {
  return { attemptId, stepId, n: 1, status, startedAt: 2, metrics: { continuations: 0, pauses: [] }, ...(sessionId ? { sessionId } : {}) }
}

const STEP_TAB_PANE: PaneNode = {
  type: 'leaf',
  id: 'pane-1',
  activeTabId: 'shell-1',
  tabs: [
    { id: 'shell-1', type: 'shell', label: 'Shell' },
    { id: 'tab-build', type: 'shell', label: 'build', workflow: { runId: 'r1', stepId: 'build', attemptId: 'a1' } }
  ]
}

function setState(opts: {
  labs?: boolean
  runs?: Record<string, WorkflowRun>
  attempts?: Record<string, WorkflowAttempt>
  panes?: Record<string, PaneNode>
}): void {
  storeState.current = {
    ...initialState,
    settings: { ...initialState.settings, labs: { ...initialState.settings.labs, workflows: opts.labs ?? true } },
    terminals: { ...initialState.terminals, panes: opts.panes ?? {} },
    workflows: { definitions: { [SUMMARY.id]: SUMMARY }, runs: opts.runs ?? {}, attempts: opts.attempts ?? {} }
  }
}

let container: HTMLDivElement
let root: Root
const onJumpToTab = vi.fn<(path: string, paneId: string, tabId: string) => void>()

beforeEach(() => {
  for (const fn of Object.values(backendApi)) fn.mockReset()
  backendApi.getWorkflowRun.mockResolvedValue(null)
  for (const fn of [
    backendApi.retryWorkflowStep,
    backendApi.retryWorkflowStepFromClean,
    backendApi.skipWorkflowStep,
    backendApi.resumeWorkflowStep,
    backendApi.cancelWorkflowRun
  ]) {
    fn.mockResolvedValue({ ok: true })
  }
  onJumpToTab.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(): Promise<void> {
  await act(async () => {
    root.render(<NeedsYouGroup onJumpToTab={onJumpToTab} />)
  })
}

const buttonLabels = (): string[] => [...container.querySelectorAll('li button')].map((b) => b.textContent ?? '')
const button = (label: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll<HTMLButtonElement>('li button')].find((b) => b.textContent === label)
  if (!found) throw new Error(`no button ${label}; have ${buttonLabels().join(', ')}`)
  return found
}
const dialog = () => document.body.querySelector('[role="alertdialog"]')
const dialogButton = (label: string): HTMLButtonElement => {
  const found = [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent === label)
  if (!found) throw new Error(`no dialog button ${label}`)
  return found
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click()
  })
}

describe('NeedsYouGroup', () => {
  it('is hidden when labs is off or nothing is paused', async () => {
    setState({ labs: false, runs: { r1: pausedRun('step-failed', ['a1']) } })
    await render()
    expect(container.textContent).toBe('')
    setState({ runs: { r1: { ...pausedRun('step-failed', ['a1']), status: 'running' } } })
    await render()
    expect(container.textContent).toBe('')
  })

  it('lists a failed step with its workflow, worktree, reason and actions', async () => {
    setState({ runs: { r1: pausedRun('step-failed', ['a1']) }, attempts: { a1: attempt('build', 'failed') }, panes: { '/wt/feature': STEP_TAB_PANE } })
    await render()
    expect(container.querySelector('h2')?.textContent).toContain('NEEDS YOU')
    expect(container.textContent).toContain('Ship it')
    expect(container.textContent).toContain('feature · Step failed · build')
    expect(buttonLabels()).toEqual(['Retry', 'Retry from clean', 'Skip', 'Cancel run', 'Jump to tab'])
    expect(button('Retry').getAttribute('aria-label')).toBe('Retry: Ship it on feature')
  })

  it('says a step the user cancelled was cancelled by the user, not that it failed', async () => {
    setState({ runs: { r1: pausedRun('step-failed', ['a1'], 'cancelled') }, attempts: { a1: attempt('build', 'cancelled') } })
    await render()
    expect(container.textContent).toContain('feature · Cancelled by user · build')
    expect(container.textContent).not.toContain('Step failed')
  })

  it('runs Retry, Skip and Cancel against the current step', async () => {
    setState({ runs: { r1: pausedRun('step-failed', ['a1']) }, attempts: { a1: attempt('build', 'failed') } })
    await render()
    await click(button('Retry'))
    await click(button('Skip'))
    await click(button('Cancel run'))
    expect(backendApi.retryWorkflowStep).toHaveBeenCalledWith('r1', 'build')
    expect(backendApi.skipWorkflowStep).toHaveBeenCalledWith('r1', 'build')
    expect(backendApi.cancelWorkflowRun).toHaveBeenCalledWith('r1')
  })

  it('shows an action error inline', async () => {
    backendApi.retryWorkflowStep.mockResolvedValue({ error: 'Another action is in progress' })
    setState({ runs: { r1: pausedRun('step-failed', ['a1']) }, attempts: { a1: attempt('build', 'failed') } })
    await render()
    await click(button('Retry'))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Another action is in progress')
  })

  it('retries from clean only after the confirm dialog is confirmed', async () => {
    setState({ runs: { r1: pausedRun('step-failed', ['a1']) }, attempts: { a1: attempt('build', 'failed') } })
    await render()
    await click(button('Retry from clean'))
    const text = dialog()?.textContent ?? ''
    expect(text).toContain('“build”')
    expect(text).toContain('Uncommitted and untracked changes made since step “build” started will be discarded')
    expect(text).toContain('head snapshot')
    await click(dialogButton('Cancel'))
    expect(dialog()).toBeNull()
    expect(backendApi.retryWorkflowStepFromClean).not.toHaveBeenCalled()

    await click(button('Retry from clean'))
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(dialog()).toBeNull()
    expect(backendApi.retryWorkflowStepFromClean).not.toHaveBeenCalled()

    await click(button('Retry from clean'))
    await click(dialogButton('Discard changes and retry'))
    expect(dialog()).toBeNull()
    expect(backendApi.retryWorkflowStepFromClean).toHaveBeenCalledTimes(1)
    expect(backendApi.retryWorkflowStepFromClean).toHaveBeenCalledWith('r1', 'build', { confirmed: true })
  })

  it("jumps to the attempt's tab", async () => {
    setState({
      runs: { r1: pausedRun('needs-approval', ['a1'], 'running') },
      attempts: { a1: { ...attempt('build', 'running'), endedAt: undefined } },
      panes: { '/wt/feature': STEP_TAB_PANE }
    })
    await render()
    expect(buttonLabels()).toEqual(['Jump to tab', 'Cancel run'])
    await click(button('Jump to tab'))
    expect(onJumpToTab).toHaveBeenCalledWith('/wt/feature', 'pane-1', 'tab-build')
  })

  it('falls back to the run record to offer Resume when the server omits step kinds', async () => {
    backendApi.getWorkflowRun.mockResolvedValue(record(BUILD_CLAUDE, [attemptRecord('a1', 'build', 'interrupted', 's-1')]))
    setState({ runs: { r1: pausedRun('interrupted', ['a1'], 'interrupted') }, attempts: { a1: attempt('build', 'interrupted') } })
    await render()
    expect(backendApi.getWorkflowRun).toHaveBeenCalledWith('r1')
    expect(buttonLabels()).toEqual(['Resume', 'Retry', 'Cancel run'])
    await click(button('Resume'))
    expect(backendApi.resumeWorkflowStep).toHaveBeenCalledWith('r1', 'build')
  })

  it('does not offer Resume for an interrupted shell step', async () => {
    backendApi.getWorkflowRun.mockResolvedValue(record(BUILD_SHELL, [attemptRecord('a1', 'build', 'interrupted', 's-1')]))
    setState({ runs: { r1: pausedRun('interrupted', ['a1'], 'interrupted') }, attempts: { a1: attempt('build', 'interrupted') } })
    await render()
    expect(buttonLabels()).toEqual(['Retry', 'Cancel run'])
  })

  it('offers Retry for a run held while labs was off', async () => {
    backendApi.getWorkflowRun.mockResolvedValue(record(BUILD_CLAUDE, []))
    setState({ runs: { r1: pausedRun('interrupted', [], 'pending') } })
    await render()
    expect(container.textContent).toContain('Interrupted · build')
    expect(buttonLabels()).toEqual(['Retry', 'Cancel run'])
    await click(button('Retry'))
    expect(backendApi.retryWorkflowStep).toHaveBeenCalledWith('r1', 'build')
  })
})

function slicedRun(
  build: Pick<WorkflowRun['steps'][string], 'kind' | 'agent'>,
  buildAttemptIds: string[],
  buildStatus: 'interrupted' | 'pending'
): WorkflowRun {
  const base = pausedRun('interrupted', buildAttemptIds, buildStatus)
  return {
    ...base,
    cursorStepId: 'build',
    steps: {
      plan: { ...base.steps.plan, kind: 'shell' },
      build: { ...base.steps.build, ...build }
    }
  }
}

describe('NeedsYouGroup from slice data', () => {
  it('renders Resume and Cancel on first paint without fetching the run record', async () => {
    setState({
      runs: { r1: slicedRun({ kind: 'agent', agent: 'claude' }, ['a1'], 'interrupted') },
      attempts: { a1: { ...attempt('build', 'interrupted'), resumable: true } }
    })
    act(() => {
      root.render(<NeedsYouGroup onJumpToTab={onJumpToTab} />)
    })
    expect(buttonLabels()).toEqual(['Resume', 'Retry', 'Cancel run'])
    expect(button('Resume').disabled).toBe(false)
    expect(button('Cancel run').disabled).toBe(false)
    await click(button('Resume'))
    await click(button('Cancel run'))
    expect(backendApi.resumeWorkflowStep).toHaveBeenCalledWith('r1', 'build')
    expect(backendApi.cancelWorkflowRun).toHaveBeenCalledWith('r1')
    expect(backendApi.getWorkflowRun).not.toHaveBeenCalled()
  })

  it('offers no Resume for an interrupted Claude attempt without a recorded session', async () => {
    setState({
      runs: { r1: slicedRun({ kind: 'agent', agent: 'claude' }, ['a1'], 'interrupted') },
      attempts: { a1: attempt('build', 'interrupted') }
    })
    await render()
    expect(buttonLabels()).toEqual(['Retry', 'Cancel run'])
    expect(backendApi.getWorkflowRun).not.toHaveBeenCalled()
  })

  it('targets the cursor step of a held run without fetching the run record', async () => {
    setState({ runs: { r1: slicedRun({ kind: 'agent', agent: 'claude' }, [], 'pending') } })
    await render()
    expect(container.textContent).toContain('Interrupted · build')
    expect(button('Cancel run').disabled).toBe(false)
    await click(button('Retry'))
    expect(backendApi.retryWorkflowStep).toHaveBeenCalledWith('r1', 'build')
    expect(backendApi.getWorkflowRun).not.toHaveBeenCalled()
  })
})

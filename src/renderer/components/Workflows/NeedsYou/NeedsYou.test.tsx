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
    cancelWorkflowRun: vi.fn(),
    approveWorkflowGate: vi.fn(),
    requestWorkflowChanges: vi.fn(),
    resolveWorkflowLoopCap: vi.fn(),
    keepWaitingWorkflowStep: vi.fn(),
    setWorkflowRunBudget: vi.fn()
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
    useWorkflowRunAttempts: (runId: string) =>
      useAppState((s) => Object.values(s.workflows.attempts).filter((attempt) => attempt.runId === runId)),
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

const BASE_SNAPSHOT = { commit: 'c1', ref: 'refs/harness/base/a1' }

function failedBuildRecord(withSnapshot: boolean): WorkflowRunRecord {
  const failed = attemptRecord('a1', 'build', 'failed')
  return record(BUILD_SHELL, [withSnapshot ? { ...failed, baseSnapshot: BASE_SNAPSHOT } : failed])
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
    workflows: { definitions: { [SUMMARY.id]: SUMMARY }, runs: opts.runs ?? {}, attempts: opts.attempts ?? {}, trust: {} }
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
    backendApi.cancelWorkflowRun,
    backendApi.approveWorkflowGate,
    backendApi.requestWorkflowChanges,
    backendApi.resolveWorkflowLoopCap,
    backendApi.keepWaitingWorkflowStep,
    backendApi.setWorkflowRunBudget
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
    backendApi.getWorkflowRun.mockResolvedValue(failedBuildRecord(true))
    setState({ runs: { r1: pausedRun('step-failed', ['a1']) }, attempts: { a1: attempt('build', 'failed') }, panes: { '/wt/feature': STEP_TAB_PANE } })
    await render()
    expect(container.querySelector('h2')?.textContent).toContain('NEEDS YOU')
    expect(container.textContent).toContain('Ship it')
    expect(container.textContent).toContain('feature · Step failed · build')
    expect(buttonLabels()).toEqual(['Retry', 'Retry from clean', 'Skip', 'Cancel run', 'Jump to tab'])
    expect(button('Retry').getAttribute('aria-label')).toBe('Retry: Ship it on feature')
  })

  it('hides Retry from clean when the failed attempt has no base snapshot', async () => {
    backendApi.getWorkflowRun.mockResolvedValue(failedBuildRecord(false))
    setState({ runs: { r1: pausedRun('step-failed', ['a1']) }, attempts: { a1: attempt('build', 'failed') } })
    await render()
    expect(backendApi.getWorkflowRun).toHaveBeenCalledWith('r1')
    expect(buttonLabels()).toEqual(['Retry', 'Skip', 'Cancel run'])
  })

  it('fetches the run record for a failed step even when the slice names the step kind', async () => {
    backendApi.getWorkflowRun.mockResolvedValue(failedBuildRecord(true))
    setState({
      runs: { r1: { ...pausedRun('step-failed', ['a1']), cursorStepId: 'build', steps: { plan: { status: 'done', attemptIds: ['a0'], kind: 'shell' }, build: { status: 'failed', attemptIds: ['a1'], kind: 'shell' } } } },
      attempts: { a1: attempt('build', 'failed') }
    })
    act(() => {
      root.render(<NeedsYouGroup onJumpToTab={onJumpToTab} />)
    })
    expect(buttonLabels()).toEqual(['Retry', 'Skip', 'Cancel run'])
    await act(async () => {})
    expect(buttonLabels()).toEqual(['Retry', 'Retry from clean', 'Skip', 'Cancel run'])
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
    backendApi.getWorkflowRun.mockResolvedValue(failedBuildRecord(true))
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

  it.each(['codex', 'opencode'] as const)(
    'offers Resume for an interrupted, resumable %s attempt from slice data',
    async (agent) => {
      setState({
        runs: { r1: slicedRun({ kind: 'agent', agent }, ['a1'], 'interrupted') },
        attempts: { a1: { ...attempt('build', 'interrupted'), resumable: true } }
      })
      await render()
      expect(buttonLabels()).toEqual(['Resume', 'Retry', 'Cancel run'])
      await click(button('Resume'))
      expect(backendApi.resumeWorkflowStep).toHaveBeenCalledWith('r1', 'build')
      expect(backendApi.getWorkflowRun).not.toHaveBeenCalled()
    }
  )

  it.each(['codex', 'opencode'] as const)(
    'offers no Resume for an interrupted %s attempt without a recorded session',
    async (agent) => {
      setState({
        runs: { r1: slicedRun({ kind: 'agent', agent }, ['a1'], 'interrupted') },
        attempts: { a1: attempt('build', 'interrupted') }
      })
      await render()
      expect(buttonLabels()).toEqual(['Retry', 'Cancel run'])
    }
  )

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

function gatedRun(build: Pick<WorkflowRun['steps'][string], 'kind' | 'agent'>): WorkflowRun {
  const base = pausedRun('gate', ['a1'])
  return {
    ...base,
    cursorStepId: 'build',
    steps: {
      plan: { ...base.steps.plan, kind: 'shell' },
      build: { status: 'awaiting-gate', attemptIds: ['a1'], ...build }
    }
  }
}

const changesDialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]')
const feedbackBox = () => changesDialog()?.querySelector('textarea') ?? null
const freshBox = () => changesDialog()?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null
const submitButton = () => changesDialog()?.querySelector<HTMLButtonElement>('button[type="submit"]') ?? null

async function typeFeedback(value: string): Promise<void> {
  const box = feedbackBox()
  if (!box) throw new Error('no feedback box')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(box, value)
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function pressEscape(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
}

describe('NeedsYouGroup at a gate', () => {
  it('offers Approve and Request changes named for the gated agent step', async () => {
    setState({ runs: { r1: gatedRun({ kind: 'agent', agent: 'claude' }) }, attempts: { a1: attempt('build', 'done') } })
    await render()
    expect(container.textContent).toContain('feature · Waiting at gate · build')
    expect(buttonLabels()).toEqual(['Approve', 'Request changes', 'Cancel run'])
    expect(button('Approve').getAttribute('aria-label')).toBe('Approve: build, Ship it on feature')
    expect(button('Request changes').getAttribute('aria-label')).toBe('Request changes: build, Ship it on feature')
    await click(button('Approve'))
    expect(backendApi.approveWorkflowGate).toHaveBeenCalledWith('r1', 'build')
    expect(backendApi.getWorkflowRun).not.toHaveBeenCalled()
  })

  it('offers only Approve on a gated shell step', async () => {
    setState({ runs: { r1: gatedRun({ kind: 'shell' }) }, attempts: { a1: attempt('build', 'done') } })
    await render()
    expect(buttonLabels()).toEqual(['Approve', 'Cancel run'])
  })

  it('sends the feedback and the fresh-session choice from the Request changes dialog', async () => {
    setState({ runs: { r1: gatedRun({ kind: 'agent', agent: 'claude' }) }, attempts: { a1: attempt('build', 'done') } })
    await render()
    await click(button('Request changes'))
    expect(changesDialog()?.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(feedbackBox())
    expect(submitButton()?.disabled).toBe(true)
    await typeFeedback('   ')
    expect(submitButton()?.disabled).toBe(true)
    await typeFeedback('  tighten the tests  ')
    expect(submitButton()?.disabled).toBe(false)
    await click(submitButton()!)
    expect(backendApi.requestWorkflowChanges).toHaveBeenCalledWith('r1', 'build', { feedback: 'tighten the tests', fresh: false })
    expect(changesDialog()).toBeNull()

    await click(button('Request changes'))
    await typeFeedback('start over')
    await click(freshBox()!)
    await click(submitButton()!)
    expect(backendApi.requestWorkflowChanges).toHaveBeenLastCalledWith('r1', 'build', { feedback: 'start over', fresh: true })
  })

  it('keeps the dialog open with the refusal inline', async () => {
    backendApi.requestWorkflowChanges.mockResolvedValue({ error: 'This step is not waiting at its gate' })
    setState({ runs: { r1: gatedRun({ kind: 'agent', agent: 'claude' }) }, attempts: { a1: attempt('build', 'done') } })
    await render()
    await click(button('Request changes'))
    await typeFeedback('fix it')
    await click(submitButton()!)
    expect(changesDialog()?.querySelector('[role="alert"]')?.textContent).toBe('This step is not waiting at its gate')
    expect(container.querySelector('li > [role="alert"]')).toBeNull()
  })

  it('ignores Escape while the request is in flight, then closes on Escape and returns focus to the opener', async () => {
    let finish: (value: { error: string }) => void = () => {}
    backendApi.requestWorkflowChanges.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    setState({ runs: { r1: gatedRun({ kind: 'agent', agent: 'claude' }) }, attempts: { a1: attempt('build', 'done') } })
    await render()
    const opener = button('Request changes')
    opener.focus()
    await click(opener)
    await typeFeedback('fix it')
    await click(submitButton()!)
    expect(submitButton()?.disabled).toBe(true)
    expect(submitButton()?.textContent).toBe('Sending…')
    await pressEscape()
    expect(changesDialog()).not.toBeNull()
    await act(async () => finish({ error: 'Busy' }))
    await pressEscape()
    expect(changesDialog()).toBeNull()
    expect(document.activeElement).toBe(opener)
    expect(backendApi.requestWorkflowChanges).toHaveBeenCalledTimes(1)
  })
})

describe('NeedsYouGroup at a loop cap', () => {
  function cappedRun(): WorkflowRun {
    const base = pausedRun('loop-cap', ['a1'])
    return {
      ...base,
      cursorStepId: 'build',
      steps: {
        plan: { ...base.steps.plan, kind: 'shell' },
        build: { status: 'done', attemptIds: ['a1'], kind: 'agent', agent: 'claude' }
      }
    }
  }

  it('offers Loop again and Continue anyway named for the looping step, and sends each action', async () => {
    setState({ runs: { r1: cappedRun() }, attempts: { a1: attempt('build', 'done') } })
    await render()
    expect(container.textContent).toContain('feature · Loop limit reached · build')
    expect(buttonLabels()).toEqual(['Loop again', 'Continue anyway', 'Cancel run'])
    expect(button('Loop again').getAttribute('aria-label')).toBe('Loop again: build, Ship it on feature')
    expect(button('Continue anyway').getAttribute('aria-label')).toBe('Continue anyway: build, Ship it on feature')
    await click(button('Loop again'))
    expect(backendApi.resolveWorkflowLoopCap).toHaveBeenLastCalledWith('r1', 'build', 'again')
    await click(button('Continue anyway'))
    expect(backendApi.resolveWorkflowLoopCap).toHaveBeenLastCalledWith('r1', 'build', 'continue')
    expect(backendApi.resolveWorkflowLoopCap).toHaveBeenCalledTimes(2)
    expect(backendApi.getWorkflowRun).not.toHaveBeenCalled()
  })

  it('shows the refusal from a stale loop-cap action', async () => {
    backendApi.resolveWorkflowLoopCap.mockResolvedValue({ error: 'This step is not waiting at its loop cap' })
    setState({ runs: { r1: cappedRun() }, attempts: { a1: attempt('build', 'done') } })
    await render()
    await click(button('Continue anyway'))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('This step is not waiting at its loop cap')
  })
})

describe('NeedsYouGroup after a step timeout', () => {
  function timedOutRun(): WorkflowRun {
    const base = pausedRun('timeout', ['a1'])
    return {
      ...base,
      cursorStepId: 'build',
      steps: {
        plan: { ...base.steps.plan, status: 'done', kind: 'shell' },
        build: { status: 'running', attemptIds: ['a1'], kind: 'agent', agent: 'claude' }
      }
    }
  }

  it('offers Keep waiting named for the timed-out step and sends it', async () => {
    setState({ runs: { r1: timedOutRun() }, attempts: { a1: attempt('build', 'running') } })
    await render()
    expect(container.textContent).toContain('feature · Timed out · build')
    expect(buttonLabels()).toEqual(['Keep waiting', 'Cancel run'])
    expect(button('Keep waiting').getAttribute('aria-label')).toBe('Keep waiting: build, Ship it on feature')
    await click(button('Keep waiting'))
    expect(backendApi.keepWaitingWorkflowStep).toHaveBeenCalledExactlyOnceWith('r1', 'build')
    expect(backendApi.cancelWorkflowRun).not.toHaveBeenCalled()
  })

  it('shows the refusal from a stale Keep waiting', async () => {
    backendApi.keepWaitingWorkflowStep.mockResolvedValue({ error: 'This step has not timed out' })
    setState({ runs: { r1: timedOutRun() }, attempts: { a1: attempt('build', 'running') } })
    await render()
    await click(button('Keep waiting'))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('This step has not timed out')
  })
})

describe('NeedsYouGroup at the run budget', () => {
  function budgetRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
    const base = pausedRun('budget', ['a1'], 'running')
    return {
      ...base,
      cursorStepId: 'build',
      budgetUsd: 0.05,
      steps: {
        plan: { ...base.steps.plan, status: 'done', kind: 'shell' },
        build: { status: 'running', attemptIds: ['a1'], kind: 'agent', agent: 'claude' }
      },
      ...overrides
    }
  }

  const costed = (stepId: string, costUsd: number): WorkflowAttempt => ({ ...attempt(stepId, 'done'), costUsd })
  const budgetInput = (): HTMLInputElement => {
    const input = container.querySelector<HTMLInputElement>('li input[type="number"]')
    if (!input) throw new Error('no budget input')
    return input
  }
  async function typeBudget(value: string): Promise<void> {
    const input = budgetInput()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('shows Budget reached with the spend and no step, and offers Raise budget and Cancel run but no Jump', async () => {
    setState({
      runs: { r1: budgetRun() },
      attempts: { a0: costed('plan', 0.04), a1: { ...costed('build', 0.02), status: 'running' } },
      panes: { '/wt/feature': STEP_TAB_PANE }
    })
    await render()
    expect(container.textContent).toContain('feature · Budget reached')
    expect(container.textContent).toContain('Spent $0.06 of $0.05')
    expect(container.textContent).not.toContain('· build')
    expect(buttonLabels()).toEqual(['Raise budget', 'Cancel run'])
    expect(button('Raise budget').getAttribute('aria-label')).toBe('Raise budget: Ship it on feature')
    expect(budgetInput().getAttribute('aria-label')).toBe('New budget in USD: Ship it on feature')
    expect(budgetInput()).toMatchObject({ min: '0.07', max: '10000', value: '0.12' })
    expect(backendApi.getWorkflowRun).not.toHaveBeenCalled()
  })

  it('sends the typed budget and keeps Cancel run usable without a step', async () => {
    setState({ runs: { r1: budgetRun() }, attempts: { a1: costed('build', 0.06) } })
    await render()
    await typeBudget('2.5')
    await click(button('Raise budget'))
    expect(backendApi.setWorkflowRunBudget).toHaveBeenCalledExactlyOnceWith('r1', 2.5)
    expect(button('Cancel run').disabled).toBe(false)
    await click(button('Cancel run'))
    expect(backendApi.cancelWorkflowRun).toHaveBeenCalledExactlyOnceWith('r1')
  })

  it('disables Raise budget for an amount at or below the spend, or above the maximum', async () => {
    setState({ runs: { r1: budgetRun() }, attempts: { a1: costed('build', 0.06) } })
    await render()
    for (const value of ['0.06', '0.01', '', '10001', '-3']) {
      await typeBudget(value)
      expect(button('Raise budget').disabled).toBe(true)
    }
    await typeBudget('0.07')
    expect(button('Raise budget').disabled).toBe(false)
  })

  it('handles a budget-paused run whose steps are all settled', async () => {
    const base = budgetRun()
    setState({
      runs: { r1: { ...base, cursorStepId: undefined, steps: { ...base.steps, build: { ...base.steps.build, status: 'done' } } } },
      attempts: { a1: costed('build', 0.06) }
    })
    await render()
    expect(container.textContent).toContain('Spent $0.06 of $0.05')
    expect(buttonLabels()).toEqual(['Raise budget', 'Cancel run'])
  })

  it('moves the untouched suggestion above a spend that grows while the row is shown, but keeps a typed amount', async () => {
    setState({ runs: { r1: budgetRun() }, attempts: { a1: costed('build', 0.06) } })
    await render()
    expect(budgetInput().value).toBe('0.12')
    setState({ runs: { r1: budgetRun() }, attempts: { a1: costed('build', 0.09) } })
    await render()
    expect(budgetInput().value).toBe('0.18')
    expect(budgetInput().min).toBe('0.1')
    expect(button('Raise budget').disabled).toBe(false)
    await typeBudget('5')
    setState({ runs: { r1: budgetRun() }, attempts: { a1: costed('build', 0.2) } })
    await render()
    expect(budgetInput().value).toBe('5')
  })

  it('shows the refusal from a Raise budget on a finished run', async () => {
    backendApi.setWorkflowRunBudget.mockResolvedValue({ error: 'Unknown or finished run' })
    setState({ runs: { r1: budgetRun() }, attempts: { a1: costed('build', 0.06) } })
    await render()
    await click(button('Raise budget'))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Unknown or finished run')
  })
})

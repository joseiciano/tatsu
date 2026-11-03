// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RunDetailContainer } from '.'
import { initialState, type AppState } from '../../../../shared/state'
import type {
  WorkflowAttempt,
  WorkflowAttemptRecord,
  WorkflowDefinitionSummary,
  WorkflowRun,
  WorkflowRunRecord
} from '../../../../shared/state/workflows'
import type { PaneNode } from '../../../../shared/state/terminals'
import type { ResolvedWorkflowStep } from '../../../../shared/workflow-def'

const { backendApi, storeState } = vi.hoisted(() => ({
  backendApi: {
    getWorkflowRun: vi.fn(),
    getWorkflowAttemptResult: vi.fn(),
    retryWorkflowStep: vi.fn(),
    retryWorkflowStepFromClean: vi.fn(),
    skipWorkflowStep: vi.fn(),
    resumeWorkflowStep: vi.fn(),
    cancelWorkflowRun: vi.fn(),
    cancelWorkflowStep: vi.fn(),
    markWorkflowStepDone: vi.fn()
  },
  storeState: { current: null as AppState | null }
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../backend', () => ({ useBackend: () => backendApi }))
vi.mock('../../../store', async () => {
  const selectors = await import('../../../workflow-selectors')
  const selectAttempts = selectors.createRunAttemptsSelector()
  const useAppState = <T,>(selector: (s: AppState) => T): T => {
    if (!storeState.current) throw new Error('store not set')
    return selector(storeState.current)
  }
  return {
    useAppState,
    useWorkflowRun: (id: string | null) => useAppState((s) => (id ? s.workflows.runs[id] ?? null : null)),
    useWorkflowAttempt: (id: string | null) => useAppState((s) => (id ? s.workflows.attempts[id] ?? null : null)),
    useWorkflowDefinition: (id: string | null) => useAppState((s) => (id ? s.workflows.definitions[id] ?? null : null)),
    useWorkflowRunAttempts: (id: string) => useAppState((s) => selectAttempts(s.workflows, id)),
    useWorkflowRunRecordKey: (id: string) => useAppState((s) => selectors.workflowRunRecordKey(s.workflows, id)),
    useWorktreeRepoRoot: () => '/repos/app',
    useWorkflowStepTabLeaf: (path: string | null, ref: { runId: string; stepId: string; attemptId: string | null }) =>
      useAppState((s) => (path ? selectors.findWorkflowStepTab(s.terminals.panes[path], ref)?.leaf ?? null : null))
  }
})

const NOW = 1_000_000
const WT = '/repos/app/feature'

const SUMMARY: WorkflowDefinitionSummary = {
  id: 'personal:ship',
  name: 'Ship it',
  scope: 'personal',
  path: '/d/ship.yaml',
  hash: 'h',
  stepIds: ['plan', 'exit'],
  issues: []
}

const PLAN: ResolvedWorkflowStep = { id: 'plan', kind: 'shell', run: 'make plan', needs: [] }
const EXIT: ResolvedWorkflowStep = {
  id: 'exit',
  kind: 'agent',
  agent: 'claude',
  prompt: 'go',
  permissions: 'read-only',
  allow: [],
  needs: ['plan'],
  output: { fields: { verdict: { type: 'string' } } }
}

function attemptRecord(overrides: Partial<WorkflowAttemptRecord> & Pick<WorkflowAttemptRecord, 'attemptId' | 'stepId'>): WorkflowAttemptRecord {
  return { n: 1, status: 'done', startedAt: NOW - 50_000, endedAt: NOW - 45_000, metrics: { continuations: 0, pauses: [] }, ...overrides }
}

const PLAN_ATTEMPT = attemptRecord({
  attemptId: 'a-plan',
  stepId: 'plan',
  metrics: { continuations: 0, pauses: [], completedBy: 'exit' },
  result: { status: 'done', summary: 'planned', completedBy: 'exit', data: { files: ['a.ts', 'b.ts'], ok: true } }
})
const EXIT_FAILED = attemptRecord({
  attemptId: 'a-exit',
  stepId: 'exit',
  status: 'failed',
  startedAt: NOW - 40_000,
  endedAt: NOW - 30_000,
  metrics: { continuations: 0, pauses: [], completedBy: 'exit' },
  result: { status: 'failed', summary: '<b>crashed</b>\nline two', completedBy: 'exit', exitCode: 1 }
})

function record(attempts: WorkflowAttemptRecord[], overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    version: 1,
    runId: 'r1',
    defId: SUMMARY.id,
    defHash: 'h',
    definition: { name: 'Ship it', inputs: {}, steps: [PLAN, EXIT] },
    inputs: {},
    worktreePath: WT,
    contextPath: '/ctx',
    status: 'paused',
    pausedReason: 'step-failed',
    cursor: 1,
    steps: { plan: 'done', exit: 'failed' },
    startedAt: NOW - 60_000,
    attempts,
    ...overrides
  }
}

function sliceAttempt(stepId: string, status: WorkflowAttempt['status'], summaryPreview = ''): WorkflowAttempt {
  return { runId: 'r1', stepId, n: 1, status, summaryPreview, startedAt: NOW - 40_000, endedAt: NOW - 30_000 }
}

function pausedRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    defId: SUMMARY.id,
    defHash: 'h',
    worktreePath: WT,
    status: 'paused',
    pausedReason: 'step-failed',
    startedAt: NOW - 60_000,
    finishedAt: undefined,
    cursorStepId: 'exit',
    steps: {
      plan: { status: 'done', attemptIds: ['a-plan'], kind: 'shell' },
      exit: { status: 'failed', attemptIds: ['a-exit'], kind: 'agent', agent: 'claude' }
    },
    ...overrides
  }
}

const STEP_TAB_PANE: PaneNode = {
  type: 'leaf',
  id: 'pane-1',
  activeTabId: 'shell-1',
  tabs: [
    { id: 'shell-1', type: 'shell', label: 'Shell' },
    { id: 'tab-exit', type: 'shell', label: 'exit', workflow: { runId: 'r1', stepId: 'exit', attemptId: 'a-exit' } }
  ]
}

function setState(run: WorkflowRun, attempts: Record<string, WorkflowAttempt>, panes: Record<string, PaneNode> = {}): void {
  storeState.current = {
    ...initialState,
    terminals: { ...initialState.terminals, panes },
    workflows: { definitions: { [SUMMARY.id]: SUMMARY }, runs: { r1: run }, attempts, trust: {} }
  }
}

const DEFAULT_ATTEMPTS = { 'a-plan': sliceAttempt('plan', 'done'), 'a-exit': sliceAttempt('exit', 'failed') }

let container: HTMLDivElement
let root: Root
const onJumpToTab = vi.fn<(path: string, paneId: string, tabId: string) => void>()
const onBack = vi.fn()

function Harness(): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <RunDetailContainer
      runId="r1"
      now={NOW}
      selectedAttemptId={selected}
      onSelectAttempt={setSelected}
      onBack={onBack}
      onJumpToTab={onJumpToTab}
    />
  )
}

beforeEach(() => {
  for (const fn of Object.values(backendApi)) fn.mockReset()
  for (const fn of [
    backendApi.retryWorkflowStep,
    backendApi.retryWorkflowStepFromClean,
    backendApi.skipWorkflowStep,
    backendApi.resumeWorkflowStep,
    backendApi.cancelWorkflowRun,
    backendApi.cancelWorkflowStep,
    backendApi.markWorkflowStepDone
  ]) {
    fn.mockResolvedValue({ ok: true })
  }
  const attempts = [PLAN_ATTEMPT, EXIT_FAILED]
  backendApi.getWorkflowRun.mockResolvedValue(record(attempts))
  backendApi.getWorkflowAttemptResult.mockImplementation(async (id: string) => attempts.find((a) => a.attemptId === id) ?? null)
  onJumpToTab.mockReset()
  onBack.mockReset()
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
    root.render(<Harness />)
  })
}

async function click(el: Element | null | undefined): Promise<void> {
  if (!(el instanceof HTMLElement)) throw new Error('nothing to click')
  await act(async () => {
    el.click()
  })
}

const section = (name: string): HTMLElement => {
  const found = [...container.querySelectorAll<HTMLElement>('section')].find((s) => s.querySelector(':scope > h3')?.textContent?.startsWith(name))
  if (!found) throw new Error(`no section ${name}`)
  return found
}
const timelineRows = (): HTMLButtonElement[] => [...section('Attempt timeline').querySelectorAll<HTMLButtonElement>('li button')]
const actionButtons = (): string[] => [...section('Actions').querySelectorAll('button')].map((b) => b.textContent ?? '')
const actionButton = (label: string): HTMLButtonElement => {
  const found = [...section('Actions').querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)
  if (!found) throw new Error(`no action ${label}; have ${actionButtons().join(', ')}`)
  return found
}

describe('RunDetailContainer', () => {
  it('draws the step graph from the record with live slice statuses', async () => {
    setState(pausedRun(), DEFAULT_ATTEMPTS)
    await render()
    const graph = container.querySelector('[role="group"][aria-label="Workflow graph"]')
    const nodes = [...(graph?.querySelectorAll('[role="listitem"]') ?? [])].map((n) => n.getAttribute('aria-label'))
    expect(nodes).toEqual(['plan: done', 'exit: failed'])
  })

  it('lists every attempt in order and shows the latest attempt result by default', async () => {
    setState(pausedRun(), DEFAULT_ATTEMPTS)
    await render()
    expect(timelineRows().map((b) => b.getAttribute('aria-label'))).toEqual([
      'plan #1: done, completed by process exit, 5s, cost —',
      'exit #1: failed, completed by process exit, 10s, cost —'
    ])
    expect(timelineRows()[1].getAttribute('aria-pressed')).toBe('true')
    expect(backendApi.getWorkflowAttemptResult).toHaveBeenCalledWith('a-exit')
    const summary = section('Attempt result').querySelector('pre')
    expect(summary?.textContent).toBe('<b>crashed</b>\nline two')
    expect(summary?.querySelector('b')).toBeNull()
    expect(section('Attempt result').textContent).toContain('Exit code1')
  })

  it('fetches and shows the selected attempt summary and output fields', async () => {
    setState(pausedRun(), DEFAULT_ATTEMPTS)
    await render()
    await click(timelineRows()[0])
    expect(backendApi.getWorkflowAttemptResult).toHaveBeenLastCalledWith('a-plan')
    expect(timelineRows()[0].getAttribute('aria-pressed')).toBe('true')
    const result = section('Attempt result')
    const pres = [...result.querySelectorAll('pre')].map((p) => p.textContent)
    expect(pres).toEqual(['planned', '[\n  "a.ts",\n  "b.ts"\n]', 'true'])
    const fields = result.querySelectorAll('dl')[1]
    expect([...(fields?.querySelectorAll('dt') ?? [])].map((dt) => dt.textContent)).toEqual(['files', 'ok'])
  })

  it('jumps to the selected attempt tab through the jump handler', async () => {
    setState(pausedRun(), DEFAULT_ATTEMPTS, { [WT]: STEP_TAB_PANE })
    await render()
    await click(actionButton('Jump to tab'))
    expect(onJumpToTab).toHaveBeenCalledWith(WT, 'pane-1', 'tab-exit')
  })

  it('refetches the run record when an attempt status changes, not on streamed text', async () => {
    setState(pausedRun(), DEFAULT_ATTEMPTS)
    await render()
    expect(backendApi.getWorkflowRun).toHaveBeenCalledTimes(1)
    setState(pausedRun(), { ...DEFAULT_ATTEMPTS, 'a-exit': sliceAttempt('exit', 'failed', 'streamed text') })
    await render()
    expect(backendApi.getWorkflowRun).toHaveBeenCalledTimes(1)
    setState(pausedRun({ status: 'running', pausedReason: undefined }), { ...DEFAULT_ATTEMPTS, 'a-exit': sliceAttempt('exit', 'running') })
    await render()
    expect(backendApi.getWorkflowRun).toHaveBeenCalledTimes(2)
  })

  it('offers the paused step actions and runs them against the cursor step', async () => {
    backendApi.getWorkflowRun.mockResolvedValue(record([PLAN_ATTEMPT, { ...EXIT_FAILED, baseSnapshot: { commit: 'c', ref: 'r' } }]))
    setState(pausedRun(), DEFAULT_ATTEMPTS)
    await render()
    expect(actionButtons()).toEqual(['Retry', 'Retry from clean', 'Mark done', 'Skip', 'Cancel run'])
    expect(actionButton('Retry').getAttribute('aria-label')).toBe('Retry: exit')
    await click(actionButton('Retry'))
    await click(actionButton('Skip'))
    await click(actionButton('Cancel run'))
    expect(backendApi.retryWorkflowStep).toHaveBeenCalledWith('r1', 'exit')
    expect(backendApi.skipWorkflowStep).toHaveBeenCalledWith('r1', 'exit')
    expect(backendApi.cancelWorkflowRun).toHaveBeenCalledWith('r1')

    await click(actionButton('Retry from clean'))
    const dialog = document.body.querySelector('[role="alertdialog"]')
    await click([...(dialog?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Discard changes and retry'))
    expect(backendApi.retryWorkflowStepFromClean).toHaveBeenCalledWith('r1', 'exit', { confirmed: true })
  })

  it('hides Retry from clean when the latest attempt has no base snapshot', async () => {
    setState(pausedRun(), DEFAULT_ATTEMPTS)
    await render()
    expect(actionButtons()).toEqual(['Retry', 'Mark done', 'Skip', 'Cancel run'])
  })

  it('marks the cursor step done from the inline form', async () => {
    setState(pausedRun(), DEFAULT_ATTEMPTS)
    await render()
    await click(actionButton('Mark done'))
    const form = container.querySelector('form[aria-label="Mark step done"]')
    const summary = form?.querySelector('textarea')
    if (!(summary instanceof HTMLTextAreaElement)) throw new Error('no summary field')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(summary, 'fixed by hand')
      summary.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      form?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click()
    })
    expect(backendApi.markWorkflowStepDone).toHaveBeenCalledWith('r1', 'exit', { summary: 'fixed by hand', fields: {} })
  })

  it('cancels a running step after confirming', async () => {
    const running = attemptRecord({ attemptId: 'a-exit', stepId: 'exit', status: 'running', startedAt: NOW - 5_000, endedAt: undefined })
    backendApi.getWorkflowRun.mockResolvedValue(
      record([PLAN_ATTEMPT, running], { status: 'running', pausedReason: undefined, steps: { plan: 'done', exit: 'running' } })
    )
    setState(pausedRun({ status: 'running', pausedReason: undefined }), { ...DEFAULT_ATTEMPTS, 'a-exit': sliceAttempt('exit', 'running') })
    await render()
    expect(actionButtons()).toEqual(['Cancel step', 'Cancel run'])
    await click(actionButton('Cancel step'))
    const dialog = document.body.querySelector('[role="alertdialog"]')
    await click([...(dialog?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Cancel step'))
    expect(backendApi.cancelWorkflowStep).toHaveBeenCalledWith('r1', 'exit')
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('goes back to the run list', async () => {
    setState(pausedRun(), DEFAULT_ATTEMPTS)
    await render()
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'All runs'))
    expect(onBack).toHaveBeenCalledOnce()
  })
})

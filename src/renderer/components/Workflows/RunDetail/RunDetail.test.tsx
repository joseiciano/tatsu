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
    getWorkflowAttemptChangedFiles: vi.fn(),
    getWorkflowAttemptFileDiff: vi.fn(),
    retryWorkflowStep: vi.fn(),
    retryWorkflowStepFromClean: vi.fn(),
    skipWorkflowStep: vi.fn(),
    resumeWorkflowStep: vi.fn(),
    cancelWorkflowRun: vi.fn(),
    cancelWorkflowStep: vi.fn(),
    markWorkflowStepDone: vi.fn(),
    swapWorkflowStep: vi.fn(),
    approveWorkflowGate: vi.fn(),
    requestWorkflowChanges: vi.fn(),
    resolveWorkflowLoopCap: vi.fn()
  },
  storeState: { current: null as AppState | null }
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../backend', () => ({ useBackend: () => backendApi }))
vi.mock('../../MonacoDiffEditor', () => ({
  MonacoDiffEditor: ({ original, modified, filePath, sideBySide }: { original: string; modified: string; filePath?: string; sideBySide?: boolean }) => (
    <div data-testid="diff-editor" data-path={filePath} data-side-by-side={String(sideBySide)}>
      <pre data-side="original">{original}</pre>
      <pre data-side="modified">{modified}</pre>
    </div>
  )
}))
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
    backendApi.markWorkflowStepDone,
    backendApi.swapWorkflowStep,
    backendApi.approveWorkflowGate,
    backendApi.requestWorkflowChanges,
    backendApi.resolveWorkflowLoopCap
  ]) {
    fn.mockResolvedValue({ ok: true })
  }
  const attempts = [PLAN_ATTEMPT, EXIT_FAILED]
  backendApi.getWorkflowRun.mockResolvedValue(record(attempts))
  backendApi.getWorkflowAttemptResult.mockImplementation(async (id: string) => attempts.find((a) => a.attemptId === id) ?? null)
  backendApi.getWorkflowAttemptChangedFiles.mockResolvedValue({ files: [], truncated: false })
  backendApi.getWorkflowAttemptFileDiff.mockResolvedValue({ original: '', modified: '' })
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
  it('draws the step graph from the record with live slice statuses and marks the paused step', async () => {
    setState(pausedRun(), DEFAULT_ATTEMPTS)
    await render()
    const graph = container.querySelector('[role="group"][aria-label="Workflow graph"]')
    const nodes = [...(graph?.querySelectorAll('[role="listitem"]') ?? [])].map((n) => n.getAttribute('aria-label'))
    expect(nodes).toEqual(['plan: done', 'exit: failed, needs you'])
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
    expect(actionButtons()).toEqual(['Retry', 'Retry from clean', 'Swap harness/model', 'Mark done', 'Skip', 'Cancel run'])
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
    expect(actionButtons()).toEqual(['Retry', 'Swap harness/model', 'Mark done', 'Skip', 'Cancel run'])
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

  describe('swap harness/model', () => {
    const swapDialog = (): HTMLElement => {
      const dialog = document.body.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')
      if (!dialog) throw new Error('no swap dialog')
      return dialog
    }
    const swapButton = (): HTMLButtonElement => {
      const found = [...swapDialog().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Swap and retry')
      if (!found) throw new Error('no Swap and retry button')
      return found
    }
    async function change(el: HTMLInputElement | HTMLSelectElement | null, value: string, event = 'input'): Promise<void> {
      if (!el) throw new Error('no field')
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
      await act(async () => {
        Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
        el.dispatchEvent(new Event(event, { bubbles: true }))
      })
    }
    async function openSwap(): Promise<void> {
      await click(actionButton('Swap harness/model'))
      expect(actionButton('Swap harness/model').getAttribute('aria-label')).toBe('Swap harness/model: exit')
    }

    it('swaps the failed step to another agent and model and closes', async () => {
      setState(pausedRun(), DEFAULT_ATTEMPTS)
      await render()
      await openSwap()
      const dialog = swapDialog()
      expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
      expect(document.activeElement).toBe(dialog.querySelector('select'))
      expect(swapButton().disabled).toBe(true)
      await change(dialog.querySelector('select'), 'codex', 'change')
      await change(dialog.querySelector('input[type="text"]'), ' gpt-test ')
      await click(swapButton())
      expect(backendApi.swapWorkflowStep).toHaveBeenCalledWith('r1', 'exit', { agent: 'codex', model: 'gpt-test' })
      expect(document.body.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull()
    })

    it('keeps the dialog open with the refusal message', async () => {
      backendApi.swapWorkflowStep.mockResolvedValue({ error: 'Open a Codex tab and run /hooks' })
      setState(pausedRun(), DEFAULT_ATTEMPTS)
      await render()
      await openSwap()
      await change(swapDialog().querySelector('select'), 'codex', 'change')
      await click(swapButton())
      expect(swapDialog().querySelector('[role="alert"]')?.textContent).toBe('Open a Codex tab and run /hooks')
    })

    it('needs the full-access box for a full step and sends allowFull', async () => {
      const full: ResolvedWorkflowStep = { ...EXIT, permissions: 'full' }
      backendApi.getWorkflowRun.mockResolvedValue(record([PLAN_ATTEMPT, EXIT_FAILED], { definition: { name: 'Ship it', inputs: {}, steps: [PLAN, full] } }))
      setState(pausedRun(), DEFAULT_ATTEMPTS)
      await render()
      await openSwap()
      await change(swapDialog().querySelector('select'), 'opencode', 'change')
      expect(swapButton().disabled).toBe(true)
      await click(swapDialog().querySelector('input[type="checkbox"]'))
      await click(swapButton())
      expect(backendApi.swapWorkflowStep).toHaveBeenCalledWith('r1', 'exit', { agent: 'opencode', allowFull: true })
    })

    it('is not offered for a failed shell step', async () => {
      backendApi.getWorkflowRun.mockResolvedValue(
        record([{ ...PLAN_ATTEMPT, status: 'failed' }], { cursor: 0, steps: { plan: 'failed', exit: 'pending' } })
      )
      setState(pausedRun({ cursorStepId: 'plan' }), DEFAULT_ATTEMPTS)
      await render()
      expect(actionButtons()).not.toContain('Swap harness/model')
    })
  })

  describe('at a gate', () => {
    const EXIT_DONE = attemptRecord({ attemptId: 'a-exit', stepId: 'exit', startedAt: NOW - 40_000, endedAt: NOW - 30_000, sessionId: 's1' })
    const gatedRecord = (overrides: Partial<WorkflowRunRecord> = {}) =>
      record([PLAN_ATTEMPT, EXIT_DONE], { pausedReason: 'gate', steps: { plan: 'done', exit: 'awaiting-gate' }, ...overrides })
    const gatedRun = (overrides: Partial<WorkflowRun> = {}) =>
      pausedRun({
        pausedReason: 'gate',
        steps: {
          plan: { status: 'done', attemptIds: ['a-plan'], kind: 'shell' },
          exit: { status: 'awaiting-gate', attemptIds: ['a-exit'], kind: 'agent', agent: 'claude' }
        },
        ...overrides
      })
    const gateAttempts = { 'a-plan': sliceAttempt('plan', 'done'), 'a-exit': sliceAttempt('exit', 'done') }
    const graphLabels = (): (string | null)[] =>
      [...container.querySelectorAll('[aria-label="Workflow graph"] [role="listitem"]')].map((n) => n.getAttribute('aria-label'))
    const changesDialog = () => document.body.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')
    const submitButton = () => changesDialog()?.querySelector<HTMLButtonElement>('button[type="submit"]') ?? null
    async function typeFeedback(value: string): Promise<void> {
      const box = changesDialog()?.querySelector('textarea')
      if (!box) throw new Error('no feedback box')
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(box, value)
        box.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }

    beforeEach(() => {
      backendApi.getWorkflowRun.mockResolvedValue(gatedRecord())
      backendApi.getWorkflowAttemptResult.mockImplementation(async (id: string) => [PLAN_ATTEMPT, EXIT_DONE].find((a) => a.attemptId === id) ?? null)
    })

    it('marks the gated step in the graph as needing you and offers Approve and Request changes', async () => {
      setState(gatedRun(), gateAttempts)
      await render()
      expect(graphLabels()).toEqual(['plan: done', 'exit: waiting at gate, needs you'])
      expect(actionButtons()).toEqual(['Approve', 'Request changes', 'Cancel run'])
      expect(actionButton('Approve').getAttribute('aria-label')).toBe('Approve: exit')
      expect(actionButton('Request changes').getAttribute('aria-label')).toBe('Request changes: exit')
      await click(actionButton('Approve'))
      expect(backendApi.approveWorkflowGate).toHaveBeenCalledWith('r1', 'exit')
    })

    it('sends the feedback and fresh choice, and shows a refusal inside the dialog', async () => {
      backendApi.requestWorkflowChanges.mockResolvedValueOnce({ error: 'This step is not waiting at its gate' })
      setState(gatedRun(), gateAttempts)
      await render()
      await click(actionButton('Request changes'))
      expect(submitButton()?.disabled).toBe(true)
      await typeFeedback('add a test')
      await click(changesDialog()?.querySelector('input[type="checkbox"]'))
      await click(submitButton())
      expect(backendApi.requestWorkflowChanges).toHaveBeenCalledWith('r1', 'exit', { feedback: 'add a test', fresh: true })
      expect(changesDialog()?.querySelector('[role="alert"]')?.textContent).toBe('This step is not waiting at its gate')
      await click(submitButton())
      expect(changesDialog()).toBeNull()
    })

    it('closes on Escape and returns focus to the Request changes button', async () => {
      setState(gatedRun(), gateAttempts)
      await render()
      const opener = actionButton('Request changes')
      opener.focus()
      await click(opener)
      expect(document.activeElement).toBe(changesDialog()?.querySelector('textarea'))
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      })
      expect(changesDialog()).toBeNull()
      expect(document.activeElement).toBe(opener)
      expect(backendApi.requestWorkflowChanges).not.toHaveBeenCalled()
    })

    it('shows a run cancelled at its gate as cancelled, without the needs-you mark or gate actions', async () => {
      backendApi.getWorkflowRun.mockResolvedValue(gatedRecord({ status: 'cancelled', pausedReason: undefined }))
      setState(gatedRun({ status: 'cancelled', pausedReason: undefined }), gateAttempts)
      await render()
      expect(graphLabels()).toEqual(['plan: done', 'exit: cancelled'])
      expect(actionButtons()).toEqual([])
    })
  })

  describe('at a loop cap', () => {
    const EXIT_DONE = attemptRecord({ attemptId: 'a-exit', stepId: 'exit', startedAt: NOW - 40_000, endedAt: NOW - 30_000 })
    const cappedRun = () =>
      pausedRun({
        pausedReason: 'loop-cap',
        steps: {
          plan: { status: 'done', attemptIds: ['a-plan'], kind: 'shell' },
          exit: { status: 'done', attemptIds: ['a-exit'], kind: 'agent', agent: 'claude' }
        }
      })
    const cappedAttempts = { 'a-plan': sliceAttempt('plan', 'done'), 'a-exit': sliceAttempt('exit', 'done') }

    beforeEach(() => {
      backendApi.getWorkflowRun.mockResolvedValue(
        record([PLAN_ATTEMPT, EXIT_DONE], { pausedReason: 'loop-cap', steps: { plan: 'done', exit: 'done' } })
      )
      backendApi.getWorkflowAttemptResult.mockImplementation(async (id: string) => [PLAN_ATTEMPT, EXIT_DONE].find((a) => a.attemptId === id) ?? null)
    })

    it('offers Loop again and Continue anyway named for the looping step, and sends each action', async () => {
      setState(cappedRun(), cappedAttempts)
      await render()
      expect(actionButtons()).toEqual(['Loop again', 'Continue anyway', 'Cancel run'])
      expect(actionButton('Loop again').getAttribute('aria-label')).toBe('Loop again: exit')
      expect(actionButton('Continue anyway').getAttribute('aria-label')).toBe('Continue anyway: exit')
      await click(actionButton('Loop again'))
      expect(backendApi.resolveWorkflowLoopCap).toHaveBeenLastCalledWith('r1', 'exit', 'again')
      await click(actionButton('Continue anyway'))
      expect(backendApi.resolveWorkflowLoopCap).toHaveBeenLastCalledWith('r1', 'exit', 'continue')
      expect(backendApi.resolveWorkflowLoopCap).toHaveBeenCalledTimes(2)
    })
  })

  it('goes back to the run list', async () => {
    setState(pausedRun(), DEFAULT_ATTEMPTS)
    await render()
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'All runs'))
    expect(onBack).toHaveBeenCalledOnce()
  })

  describe('attempt changes', () => {
    const SNAPSHOTS = {
      baseSnapshot: { commit: 'a'.repeat(40), ref: 'refs/harness/runs/r1/exit/0' },
      headSnapshot: { commit: 'b'.repeat(40), ref: 'refs/harness/runs/r1/exit/1' }
    }
    const SNAPPED = { ...EXIT_FAILED, ...SNAPSHOTS }
    const FILES = [
      { path: 'smoke.txt', status: 'added', additions: 1, deletions: 0 },
      { path: 'notes.md', status: 'modified', additions: 2, deletions: 1 },
      { path: 'logo.png', status: 'modified', additions: null, deletions: null }
    ]

    function useAttempt(attempt: WorkflowAttemptRecord): void {
      backendApi.getWorkflowRun.mockResolvedValue(record([PLAN_ATTEMPT, attempt]))
      backendApi.getWorkflowAttemptResult.mockImplementation(async (id: string) =>
        id === attempt.attemptId ? attempt : PLAN_ATTEMPT
      )
    }

    const changedFiles = (): HTMLElement => section('Changed files')
    const fileButtons = (): HTMLButtonElement[] => [...changedFiles().querySelectorAll<HTMLButtonElement>('li button')]
    const diffSide = (side: string): string | null | undefined =>
      changedFiles().querySelector(`[data-testid="diff-editor"] [data-side="${side}"]`)?.textContent

    it('lists the attempt’s changed files and shows the first file’s side-by-side diff', async () => {
      useAttempt(SNAPPED)
      backendApi.getWorkflowAttemptChangedFiles.mockResolvedValue({ files: FILES, truncated: false })
      backendApi.getWorkflowAttemptFileDiff.mockImplementation(async (_id: string, path: string) =>
        path === 'smoke.txt' ? { original: '', modified: 'smoke\n' } : { original: 'old\n', modified: 'new\n' }
      )
      setState(pausedRun(), DEFAULT_ATTEMPTS)
      await render()

      expect(backendApi.getWorkflowAttemptChangedFiles).toHaveBeenCalledWith('a-exit')
      expect(fileButtons().map((b) => b.getAttribute('aria-label'))).toEqual([
        'smoke.txt, added, +1 −0',
        'notes.md, modified, +2 −1',
        'logo.png, modified, binary'
      ])
      expect(fileButtons()[0].getAttribute('aria-pressed')).toBe('true')
      expect(backendApi.getWorkflowAttemptFileDiff).toHaveBeenCalledWith('a-exit', 'smoke.txt')
      expect(diffSide('modified')).toBe('smoke\n')
      const editor = changedFiles().querySelector('[data-testid="diff-editor"]')
      expect(editor?.getAttribute('data-side-by-side')).toBe('true')
      expect(editor?.getAttribute('data-path')).toBe('smoke.txt')

      await click(fileButtons()[1])
      expect(backendApi.getWorkflowAttemptFileDiff).toHaveBeenLastCalledWith('a-exit', 'notes.md')
      expect(fileButtons()[1].getAttribute('aria-pressed')).toBe('true')
      expect(diffSide('original')).toBe('old\n')
      expect(diffSide('modified')).toBe('new\n')
    })

    it('shows No snapshot for an attempt without snapshots and does not ask the backend', async () => {
      setState(pausedRun(), DEFAULT_ATTEMPTS)
      await render()
      expect(changedFiles().textContent).toContain('No snapshot for this attempt')
      expect(backendApi.getWorkflowAttemptChangedFiles).not.toHaveBeenCalled()
    })

    it('shows the backend error for the list and for the diff', async () => {
      useAttempt(SNAPPED)
      backendApi.getWorkflowAttemptChangedFiles.mockResolvedValue({ error: 'snapshot missing' })
      setState(pausedRun(), DEFAULT_ATTEMPTS)
      await render()
      expect(changedFiles().querySelector('[role="alert"]')?.textContent).toBe('snapshot missing')

      backendApi.getWorkflowAttemptChangedFiles.mockResolvedValue({ files: FILES, truncated: true })
      backendApi.getWorkflowAttemptFileDiff.mockResolvedValue({ error: 'File too large to show' })
      await click(timelineRows()[0])
      await click(timelineRows()[1])
      expect(changedFiles().querySelector('[role="alert"]')?.textContent).toBe('File too large to show')
      expect(changedFiles().textContent).toContain('Showing the first 3 files')
    })

    it('says when the attempt changed nothing', async () => {
      useAttempt(SNAPPED)
      setState(pausedRun(), DEFAULT_ATTEMPTS)
      await render()
      expect(changedFiles().textContent).toContain('No changes in this attempt')
    })

    it('waits for a just-ended attempt’s head snapshot and then lists its files', async () => {
      const endedNow = { ...EXIT_FAILED, endedAt: Date.now(), baseSnapshot: SNAPSHOTS.baseSnapshot }
      let calls = 0
      backendApi.getWorkflowRun.mockResolvedValue(record([PLAN_ATTEMPT, endedNow]))
      backendApi.getWorkflowAttemptResult.mockImplementation(async (id: string) => {
        if (id !== 'a-exit') return PLAN_ATTEMPT
        calls += 1
        return calls === 1 ? endedNow : { ...endedNow, headSnapshot: SNAPSHOTS.headSnapshot }
      })
      backendApi.getWorkflowAttemptChangedFiles.mockResolvedValue({ files: FILES.slice(0, 1), truncated: false })
      setState(pausedRun(), DEFAULT_ATTEMPTS)
      await render()
      expect(changedFiles().textContent).toContain('Loading changed files')

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 400))
      })
      expect(fileButtons().map((b) => b.getAttribute('aria-label'))).toEqual(['smoke.txt, added, +1 −0'])
    })
  })
})


// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTabHandlers } from './useTabHandlers'
import { CancelStepDialog } from '../../components/Workflows/StepTab'
import type { PaneNode } from '../../../shared/state/terminals'
import type { WorkflowAttempt, WorkflowAttemptStatus } from '../../../shared/state/workflows'

const { backendApi, attempts, calls } = vi.hoisted(() => {
  const calls: string[] = []
  const backendApi = {
    killTerminal: vi.fn((id: string) => {
      calls.push(`kill:${id}`)
    }),
    panesCloseTab: vi.fn(async (_wt: string, id: string) => {
      calls.push(`close:${id}`)
      return true
    }),
    cancelWorkflowStep: vi.fn()
  }
  const attempts: Record<string, WorkflowAttempt> = {}
  return { backendApi, attempts, calls }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../backend', () => ({ useBackend: () => backendApi }))
vi.mock('../../store', () => ({ readWorkflowAttempt: (id: string) => attempts[id] ?? null }))
vi.mock('../../components/XTerminal', () => ({ markTerminalClosing: vi.fn(), focusTerminalById: vi.fn() }))

const WT = '/wt/feature'
const PANES: Record<string, PaneNode> = {
  [WT]: {
    type: 'leaf',
    id: 'pane-1',
    activeTabId: 'step-tab',
    tabs: [
      { id: 'step-tab', type: 'agent', label: '⚙ fix · Claude', workflow: { runId: 'run-1', stepId: 'fix', attemptId: 'att-1' } },
      { id: 'shell-1', type: 'shell', label: 'Shell' }
    ]
  }
}

function setAttempt(status: WorkflowAttemptStatus): void {
  attempts['att-1'] = { runId: 'run-1', stepId: 'fix', n: 1, status, summaryPreview: '', startedAt: 1 }
}

function Harness(): JSX.Element {
  const { handleCloseTab, pendingStepClose, confirmStepClose, dismissStepClose } = useTabHandlers({
    panes: PANES,
    activePaneId: {},
    setActivePaneId: () => {},
    activeWorktreeId: WT,
    setActiveWorktreeId: () => {}
  })
  return (
    <>
      <button type="button" onClick={() => handleCloseTab(WT, 'step-tab')}>
        close step
      </button>
      <button type="button" onClick={() => handleCloseTab(WT, 'shell-1')}>
        close shell
      </button>
      {pendingStepClose && (
        <CancelStepDialog
          stepId={pendingStepClose.stepId}
          busy={pendingStepClose.busy}
          error={pendingStepClose.error}
          onConfirm={() => void confirmStepClose()}
          onCancel={dismissStepClose}
        />
      )}
    </>
  )
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  calls.length = 0
  for (const key of Object.keys(attempts)) delete attempts[key]
  backendApi.killTerminal.mockClear()
  backendApi.panesCloseTab.mockClear()
  backendApi.cancelWorkflowStep.mockReset().mockImplementation(async () => {
    calls.push('cancel')
    return { ok: true }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<Harness />))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function button(text: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!found) throw new Error(`missing button ${text}`)
  return found
}

async function click(text: string): Promise<void> {
  await act(async () => {
    button(text).click()
  })
}

const dialog = (): HTMLElement | null => document.body.querySelector('[role="alertdialog"]')

describe('useTabHandlers close on a step tab', () => {
  it('asks to cancel a running step before closing', async () => {
    setAttempt('running')
    await click('close step')
    expect(dialog()?.textContent).toContain('Cancel step “fix”?')
    expect(document.activeElement).toBe(button('Keep running'))
    expect(calls).toEqual([])
  })

  it('keeps the tab and the step when the user declines', async () => {
    setAttempt('running')
    await click('close step')
    await click('Keep running')
    expect(dialog()).toBeNull()
    expect(calls).toEqual([])
  })

  it('declines on Escape', async () => {
    setAttempt('running')
    await click('close step')
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(dialog()).toBeNull()
    expect(calls).toEqual([])
  })

  it('cancels the step and then closes the tab on confirm', async () => {
    setAttempt('running')
    await click('close step')
    await click('Cancel step and close tab')
    expect(backendApi.cancelWorkflowStep).toHaveBeenCalledWith('run-1', 'fix')
    expect(calls).toEqual(['cancel', 'kill:step-tab', 'close:step-tab'])
    expect(dialog()).toBeNull()
  })

  it('keeps the tab and shows the error when the cancel is refused', async () => {
    setAttempt('running')
    backendApi.cancelWorkflowStep.mockResolvedValue({ error: 'The step is not running or queued' })
    await click('close step')
    await click('Cancel step and close tab')
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('The step is not running or queued')
    expect(backendApi.panesCloseTab).not.toHaveBeenCalled()
    expect(backendApi.killTerminal).not.toHaveBeenCalled()
  })

  it('closes an ended step tab without asking', async () => {
    setAttempt('failed')
    await click('close step')
    expect(dialog()).toBeNull()
    expect(backendApi.cancelWorkflowStep).not.toHaveBeenCalled()
    expect(calls).toEqual(['kill:step-tab', 'close:step-tab'])
  })

  it('closes a plain tab without asking', async () => {
    await click('close shell')
    expect(dialog()).toBeNull()
    expect(calls).toEqual(['kill:shell-1', 'close:shell-1'])
  })
})

// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DndContext } from '@dnd-kit/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalPanel } from './TerminalPanel'
import { HotkeysProvider } from '../Tooltip'
import { resolveHotkeys } from '../../hotkeys'
import type { TerminalTab } from '../../../shared/state/terminals'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../store', () => ({
  getClientId: () => 'client-1',
  useTerminalProgress: () => null,
  useTerminalSession: () => null,
  useWorkflowAttempt: () => null
}))

vi.mock('../../backend', () => ({ useBackend: () => ({}) }))

const STEP_TAB: TerminalTab = {
  id: 'step-1',
  type: 'agent',
  label: '⚙ hang · Claude',
  agentKind: 'claude',
  workflow: { runId: 'run-1', stepId: 'hang', attemptId: 'att-1' }
}
const SHELL_TAB: TerminalTab = { id: 'shell-1', type: 'shell', label: 'Shell' }

let container: HTMLDivElement
let root: Root
const onCloseTab = vi.fn<(tabId: string) => void>()

beforeEach(() => {
  onCloseTab.mockReset()
  Element.prototype.scrollIntoView ??= () => {}
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(tabs: TerminalTab[]): void {
  act(() =>
    root.render(
      <HotkeysProvider bindings={resolveHotkeys(undefined)}>
        <DndContext>
          <TerminalPanel
            worktreePath="/wt/a"
            pane={{ type: 'leaf', id: 'pane-1', tabs, activeTabId: tabs[0].id }}
            isFocused
            paneCount={1}
            statuses={{}}
            shellActivity={{}}
            repoLabel="repo"
            branch="main"
            registerSlot={() => {}}
            onSelectTab={() => {}}
            onAddTab={() => {}}
            onAddAgentTab={() => {}}
            onAddBrowserTab={() => {}}
            defaultAgent="claude"
            onSleepTab={() => {}}
            onCloseTab={onCloseTab}
          />
        </DndContext>
      </HotkeysProvider>
    )
  )
}

describe('TerminalPanel tab close button', () => {
  it('names each close button after its tab so a step tab can be closed by name', () => {
    render([STEP_TAB, SHELL_TAB])

    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close tab ⚙ hang · Claude"]')
    expect(close).not.toBeNull()
    expect(container.querySelector('button[aria-label="Close tab Shell"]')).not.toBeNull()

    act(() => close!.click())
    expect(onCloseTab).toHaveBeenCalledWith('step-1')
  })

  it('names the close button after the custom label when the tab is renamed', () => {
    render([{ ...SHELL_TAB, customLabel: 'Logs' }, STEP_TAB])

    expect(container.querySelector('button[aria-label="Close tab Logs"]')).not.toBeNull()
  })
})

// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette } from './CommandPalette'
import { initialState, type AppState } from '../../../shared/state'
import { DEFAULT_HOTKEYS, type Action } from '../../hotkeys'
import { PALETTE_RECENTS_KEY } from './constants'

const { storeState } = vi.hoisted(() => ({ storeState: { current: null as AppState | null } }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../backend', () => ({ useBackend: () => ({ listAllFiles: vi.fn().mockResolvedValue([]) }) }))
vi.mock('../../store', () => {
  const read = (): AppState => {
    if (!storeState.current) throw new Error('store not set')
    return storeState.current
  }
  return { useSettings: () => read().settings, useSnooze: () => read().snooze }
})

function setLabs(workflows: boolean): void {
  storeState.current = {
    ...initialState,
    settings: { ...initialState.settings, labs: { ...initialState.settings.labs, workflows } }
  }
}

let container: HTMLDivElement
let root: Root
const onAction = vi.fn<(action: Action) => void>()

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  localStorage.clear()
  onAction.mockReset()
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
    root.render(
      <CommandPalette
        worktrees={[]}
        worktreeStatuses={{}}
        prStatuses={{}}
        mergedPaths={{}}
        activeWorktreeId={null}
        resolvedHotkeys={DEFAULT_HOTKEYS}
        onClose={vi.fn()}
        onSelectWorktree={vi.fn()}
        onAction={onAction}
        onOpenFile={vi.fn()}
        onAddBackend={vi.fn()}
      />
    )
  })
}

const workflowItem = (): HTMLButtonElement | undefined =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.startsWith('Toggle workflows'))

describe('CommandPalette Workflows action', () => {
  it('is absent with Labs workflows off, even from recents', async () => {
    localStorage.setItem(PALETTE_RECENTS_KEY, JSON.stringify([{ type: 'action', id: 'toggleWorkflows', label: 'Toggle workflows', timestamp: 1 }]))
    setLabs(false)
    await render()
    expect(container.textContent).toContain('Toggle command center')
    expect(container.textContent).not.toContain('Toggle workflows')
  })

  it('is listed with Labs workflows on and runs the toggleWorkflows action', async () => {
    setLabs(true)
    await render()
    expect(container.textContent).toContain('Toggle workflows')
    const item = workflowItem()
    expect(item).toBeDefined()
    await act(async () => item?.click())
    expect(onAction).toHaveBeenCalledWith('toggleWorkflows')
  })
})

describe('CommandPalette Run workflow action', () => {
  const runItem = (): HTMLButtonElement | undefined =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.startsWith('Run workflow…'))

  it('is absent with Labs workflows off', async () => {
    setLabs(false)
    await render()
    expect(runItem()).toBeUndefined()
  })

  it('is listed with no shortcut hint with Labs workflows on and runs the runWorkflow action', async () => {
    setLabs(true)
    await render()
    const item = runItem()
    expect(item?.textContent).toBe('Run workflow…')
    await act(async () => item?.click())
    expect(onAction).toHaveBeenCalledWith('runWorkflow')
  })
})

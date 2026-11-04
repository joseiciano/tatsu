// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHotkeyHandlers } from './useHotkeyHandlers'
import { initialState, type AppState } from '../../../shared/state'
import type { Action } from '../../hotkeys'
import type { Worktree } from '../../types'

const { storeState } = vi.hoisted(() => ({ storeState: { current: null as AppState | null } }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../backend', () => ({ useBackend: () => ({}) }))
vi.mock('../../components/XTerminal', () => ({ focusTerminalById: vi.fn() }))
vi.mock('../../store', () => {
  const read = (): AppState => {
    if (!storeState.current) throw new Error('store not set')
    return storeState.current
  }
  return {
    useSettings: () => read().settings,
    useSnooze: () => read().snooze,
    useConnections: () => [],
    getBackendsRegistry: () => ({ setActive: vi.fn() })
  }
})

const WORKTREE: Worktree = {
  path: '/wt/feature',
  branch: 'feature',
  head: 'abc',
  isBare: false,
  isMain: false,
  createdAt: 0,
  repoRoot: '/repo'
}

function setLabs(workflows: boolean): void {
  storeState.current = {
    ...initialState,
    settings: { ...initialState.settings, labs: { ...initialState.settings.labs, workflows } }
  }
}

const noop = vi.fn()
const openRunWorkflowHere = vi.fn<(worktreePath: string) => void>()
const openRunWorkflow = vi.fn<() => void>()
let actions: Partial<Record<Action, () => void>> = {}
let container: HTMLDivElement
let root: Root

function Harness({ activeWorktreeId }: { activeWorktreeId: string | null }): null {
  actions = useHotkeyHandlers({
    worktrees: [WORKTREE],
    repoRoots: ['/repo'],
    unifiedRepos: false,
    prStatuses: {},
    mergedPaths: {},
    collapsedRepos: {},
    setCollapsedRepos: noop,
    setCollapsedGroups: noop,
    isGroupCollapsed: () => false,
    activeWorktreeId,
    setActiveWorktreeId: noop,
    panes: {},
    activePaneId: {},
    terminalTabs: {},
    activeTabId: {},
    hotkeyOverrides: undefined,
    setSidebarVisible: noop,
    setRightColumnHidden: noop,
    setSingleScreenMode: noop,
    setShowNewWorktree: noop,
    setShowCommandCenter: noop,
    setShowCommandPalette: noop,
    setCommandPaletteMode: noop,
    setShowPerfMonitor: noop,
    setShowHotkeyCheatsheet: noop,
    setShowReview: noop,
    toggleWorkflows: noop,
    openRunWorkflowHere,
    openRunWorkflow,
    handleAddTerminalTab: noop,
    handleCloseTab: noop,
    handleSelectTab: noop,
    handleSplitPane: noop,
    handleRefreshWorktrees: noop,
    setShowSettings: noop
  }).hotkeyActions
  return null
}

async function render(activeWorktreeId: string | null): Promise<void> {
  await act(async () => root.render(<Harness activeWorktreeId={activeWorktreeId} />))
}

beforeEach(() => {
  openRunWorkflowHere.mockReset()
  openRunWorkflow.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('runWorkflow action', () => {
  it('opens the launch sheet on the active worktree with Labs workflows on', async () => {
    setLabs(true)
    await render(WORKTREE.path)
    act(() => actions.runWorkflow?.())
    expect(openRunWorkflowHere).toHaveBeenCalledWith(WORKTREE.path)
    expect(openRunWorkflow).not.toHaveBeenCalled()
  })

  it('opens the launch sheet with no target when no listed worktree is active', async () => {
    setLabs(true)
    await render('pending:abc')
    act(() => actions.runWorkflow?.())
    expect(openRunWorkflow).toHaveBeenCalledTimes(1)
    expect(openRunWorkflowHere).not.toHaveBeenCalled()
  })

  it('does nothing with Labs workflows off', async () => {
    setLabs(false)
    await render(WORKTREE.path)
    act(() => actions.runWorkflow?.())
    expect(openRunWorkflowHere).not.toHaveBeenCalled()
    expect(openRunWorkflow).not.toHaveBeenCalled()
  })
})

// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from './Sidebar'
import { initialState, type AppState } from '../../../shared/state'

const { storeState } = vi.hoisted(() => ({ storeState: { current: null as AppState | null } }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../ReportIssueScreen', () => ({ openReportIssue: vi.fn() }))
vi.mock('../Tooltip', () => ({ Tooltip: ({ children }: { children: ReactNode }) => children }))
vi.mock('../HotkeyBadge', () => ({ HotkeyBadge: () => null }))
vi.mock('../BackendChipStrip', () => ({ BackendChipStrip: () => null }))
vi.mock('../WorktreeTab', () => ({ WorktreeTab: () => null }))
vi.mock('../Workflows/NeedsYou', () => ({ NeedsYouGroup: () => null }))
vi.mock('../../backend', () => ({ useBackend: () => ({}) }))
vi.mock('../../store', () => ({
  useAppState: <T,>(selector: (s: AppState) => T): T => {
    if (!storeState.current) throw new Error('store not set')
    return selector(storeState.current)
  }
}))

function setLabs(workflows: boolean): void {
  storeState.current = {
    ...initialState,
    settings: { ...initialState.settings, labs: { ...initialState.settings.labs, workflows } }
  }
}

let container: HTMLDivElement
let root: Root
const onOpenWorkflows = vi.fn()

beforeEach(() => {
  onOpenWorkflows.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(): Promise<void> {
  const noop = vi.fn()
  const props: ComponentProps<typeof Sidebar> = {
    worktrees: [],
    pendingWorktrees: [],
    pendingDeletions: [],
    activeWorktreeId: null,
    statuses: {},
    pendingTools: {},
    shellActivity: {},
    prStatuses: {},
    prLoading: false,
    agentCount: 0,
    onSelectWorktree: noop,
    onDismissPendingWorktree: noop,
    onNewWorktree: noop,
    onContinueWorktree: async () => {},
    onDeleteWorktree: async () => {},
    onRefresh: noop,
    repoRoots: [],
    onAddRepo: noop,
    onRemoveRepo: async () => {},
    onOpenSettings: noop,
    onOpenConfig: noop,
    onOpenAddBackend: noop,
    onOpenHotkeyCheatsheet: noop,
    onOpenCleanup: noop,
    onOpenCommandCenter: noop,
    onOpenWorkflows,
    onOpenNewProject: noop,
    width: 280,
    collapsedGroups: {},
    onToggleGroup: noop,
    isGroupCollapsed: () => false,
    collapsedRepos: {},
    onToggleRepo: noop,
    unifiedRepos: false,
    onToggleUnifiedRepos: noop,
    onCollapseSidebar: noop
  }
  await act(async () => {
    root.render(<Sidebar {...props} />)
  })
}

const workflowsButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Workflows"]')

describe('Sidebar Workflows button', () => {
  it('is absent with Labs workflows off', async () => {
    setLabs(false)
    await render()
    expect(container.querySelector('button')).not.toBeNull()
    expect(workflowsButton()).toBeNull()
  })

  it('opens the Workflows section with Labs workflows on', async () => {
    setLabs(true)
    await render()
    await act(async () => workflowsButton()?.click())
    expect(onOpenWorkflows).toHaveBeenCalledOnce()
  })
})

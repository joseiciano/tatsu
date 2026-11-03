// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CollapsedSidebar } from './CollapsedSidebar'
import { initialState, type AppState } from '../../../shared/state'

const { storeState } = vi.hoisted(() => ({ storeState: { current: null as AppState | null } }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../ReportIssueScreen', () => ({ openReportIssue: vi.fn() }))
vi.mock('../Tooltip', () => ({ Tooltip: ({ children }: { children: ReactNode }) => children }))
vi.mock('../../store', () => {
  const read = (): AppState => {
    if (!storeState.current) throw new Error('store not set')
    return storeState.current
  }
  return {
    useSettings: () => read().settings,
    useSnooze: () => read().snooze,
    usePrs: () => read().prs,
    useWorktrees: () => read().worktrees
  }
})

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
  await act(async () => {
    root.render(
      <CollapsedSidebar
        onExpand={noop}
        onAddRepo={noop}
        onNewWorktree={noop}
        onOpenCleanup={noop}
        onOpenCommandCenter={noop}
        onOpenWorkflows={onOpenWorkflows}
        onOpenNewProject={noop}
        onOpenHotkeyCheatsheet={noop}
        onOpenSettings={noop}
      />
    )
  })
}

const workflowsButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Workflows"]')

describe('CollapsedSidebar Workflows button', () => {
  it('is absent with Labs workflows off', async () => {
    setLabs(false)
    await render()
    expect(workflowsButton()).toBeNull()
  })

  it('opens the Workflows section with Labs workflows on', async () => {
    setLabs(true)
    await render()
    await act(async () => workflowsButton()?.click())
    expect(onOpenWorkflows).toHaveBeenCalledOnce()
  })
})

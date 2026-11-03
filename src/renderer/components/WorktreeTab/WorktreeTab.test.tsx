// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreeTab } from './WorktreeTab'
import { initialState, type AppState } from '../../../shared/state'
import type { WorkflowRun } from '../../../shared/state/workflows'

const { storeState } = vi.hoisted(() => ({ storeState: { current: null as AppState | null } }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../store', () => ({
  useAppState: <T,>(selector: (s: AppState) => T): T => {
    if (!storeState.current) throw new Error('store not set')
    return selector(storeState.current)
  }
}))

const WORKTREE = { path: '/wt/a', branch: 'feature', head: 'abc', isBare: false, isMain: false, createdAt: 0, repoRoot: '/repo' }

function setState(labs: boolean, runs: Record<string, WorkflowRun> = {}): void {
  storeState.current = {
    ...initialState,
    settings: { ...initialState.settings, labs: { ...initialState.settings.labs, workflows: labs } },
    workflows: { ...initialState.workflows, runs }
  }
}

let container: HTMLDivElement
let root: Root
const onClick = vi.fn<() => void>()
const onRunWorkflow = vi.fn<() => void>()

beforeEach(() => {
  onClick.mockReset()
  onRunWorkflow.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(): void {
  act(() => {
    root.render(<WorktreeTab worktree={WORKTREE} isActive={false} status="idle" onClick={onClick} onRunWorkflow={onRunWorkflow} />)
  })
}

function rightClick(): MouseEvent {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 20 })
  act(() => {
    container.firstElementChild?.dispatchEvent(event)
  })
  return event
}

const menuItem = () => document.body.querySelector<HTMLButtonElement>('[role="menuitem"]')

describe('WorktreeTab context menu', () => {
  it('opens on right-click and runs the workflow without selecting the row', () => {
    setState(true)
    render()
    expect(rightClick().defaultPrevented).toBe(true)
    const item = menuItem()
    expect(item?.textContent).toContain('Run workflow here')
    expect(document.activeElement).toBe(item)
    act(() => item?.click())
    expect(onRunWorkflow).toHaveBeenCalledTimes(1)
    expect(onClick).not.toHaveBeenCalled()
    expect(menuItem()).toBeNull()
  })

  it('closes on Escape and on an outside click', () => {
    setState(true)
    render()
    rightClick()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(menuItem()).toBeNull()
    rightClick()
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(menuItem()).toBeNull()
    expect(onRunWorkflow).not.toHaveBeenCalled()
  })

  it.each([
    ['labs is off', false, {}],
    [
      'the worktree has a running run',
      true,
      { r: { defId: 'personal:x', defHash: 'h', worktreePath: '/wt/a', status: 'running', startedAt: 1, steps: {} } }
    ]
  ] as const)('leaves the native menu alone when %s', (_name, labs, runs) => {
    setState(labs, runs as Record<string, WorkflowRun>)
    render()
    expect(rightClick().defaultPrevented).toBe(false)
    expect(menuItem()).toBeNull()
  })
})

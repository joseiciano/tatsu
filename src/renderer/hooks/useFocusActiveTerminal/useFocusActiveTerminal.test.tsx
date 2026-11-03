// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFocusActiveTerminal } from './useFocusActiveTerminal'

const { focusTerminalById } = vi.hoisted(() => ({ focusTerminalById: vi.fn<(id: string) => void>() }))

vi.mock('../../components/XTerminal', () => ({ focusTerminalById }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Probe({ worktree, tabs }: { worktree: string | null; tabs: Record<string, string> }): null {
  useFocusActiveTerminal(worktree, tabs)
  return null
}

let container: HTMLDivElement
let root: Root
let frames: Map<number, FrameRequestCallback>
let nextFrame: number

beforeEach(() => {
  focusTerminalById.mockReset()
  frames = new Map()
  nextFrame = 1
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.set(nextFrame, cb)
    return nextFrame++
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id)
  })
  container = document.createElement('div')
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  vi.restoreAllMocks()
})

function render(worktree: string | null, tabs: Record<string, string>): void {
  act(() => root.render(<Probe worktree={worktree} tabs={tabs} />))
}

function flushFrames(): void {
  const pending = [...frames.values()]
  frames.clear()
  for (const cb of pending) cb(0)
}

describe('useFocusActiveTerminal', () => {
  it('focuses the active tab of the active worktree on the next frame', () => {
    render('/wt/a', { '/wt/a': 'tab-1' })
    flushFrames()
    expect(focusTerminalById).toHaveBeenCalledWith('tab-1')
  })

  it('does not steal focus when an unrelated pane change rebuilds the tab map', () => {
    render('/wt/a', { '/wt/a': 'tab-1', '/wt/b': 'tab-9' })
    flushFrames()
    focusTerminalById.mockReset()

    render('/wt/a', { '/wt/a': 'tab-1', '/wt/b': 'tab-10' })
    flushFrames()

    expect(focusTerminalById).not.toHaveBeenCalled()
  })

  it('focuses again when the active tab or worktree changes', () => {
    render('/wt/a', { '/wt/a': 'tab-1', '/wt/b': 'tab-9' })
    flushFrames()
    render('/wt/a', { '/wt/a': 'tab-2', '/wt/b': 'tab-9' })
    flushFrames()
    render('/wt/b', { '/wt/a': 'tab-2', '/wt/b': 'tab-9' })
    flushFrames()
    expect(focusTerminalById.mock.calls.map(([id]) => id)).toEqual(['tab-1', 'tab-2', 'tab-9'])
  })

  it('skips diff tabs and an empty selection', () => {
    render('/wt/a', { '/wt/a': 'diff-1' })
    render(null, { '/wt/a': 'tab-1' })
    flushFrames()
    expect(focusTerminalById).not.toHaveBeenCalled()
  })
})

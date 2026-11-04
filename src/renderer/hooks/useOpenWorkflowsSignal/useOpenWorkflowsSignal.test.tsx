// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useOpenWorkflowsSignal, type OpenWorkflowsSignalSource } from './useOpenWorkflowsSignal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function fakeSource(): OpenWorkflowsSignalSource & { fire: () => void; listeners: Set<() => void> } {
  const listeners = new Set<() => void>()
  return {
    listeners,
    onOpenWorkflowsSection: (callback) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
    fire: () => {
      for (const listener of listeners) listener()
    }
  }
}

function Probe({ source, open }: { source: OpenWorkflowsSignalSource; open: () => void }): null {
  useOpenWorkflowsSignal(source, open)
  return null
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
})

describe('useOpenWorkflowsSignal', () => {
  it('opens the workflows section when the signal arrives', () => {
    const source = fakeSource()
    const open = vi.fn()
    act(() => root.render(<Probe source={source} open={open} />))

    act(() => source.fire())

    expect(open).toHaveBeenCalledTimes(1)
  })

  it('calls the latest open callback without resubscribing', () => {
    const source = fakeSource()
    const first = vi.fn()
    const second = vi.fn()
    const subscribe = vi.spyOn(source, 'onOpenWorkflowsSection')
    act(() => root.render(<Probe source={source} open={first} />))
    act(() => root.render(<Probe source={source} open={second} />))

    act(() => source.fire())

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes on unmount', () => {
    const source = fakeSource()
    act(() => root.render(<Probe source={source} open={vi.fn()} />))
    expect(source.listeners.size).toBe(1)

    act(() => root.unmount())
    root = createRoot(container)

    expect(source.listeners.size).toBe(0)
  })
})

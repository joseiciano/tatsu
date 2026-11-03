// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CancelStepDialog } from './CancelStepDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let opener: HTMLButtonElement
let onCancel: ReturnType<typeof vi.fn<() => void>>
let onConfirm: ReturnType<typeof vi.fn<() => void>>

function render(busy: boolean): void {
  act(() =>
    root.render(<CancelStepDialog stepId="fix" busy={busy} error={null} onConfirm={onConfirm} onCancel={onCancel} />)
  )
}

function dialog(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[role="alertdialog"]')
  if (!el) throw new Error('dialog missing')
  return el
}

function buttonNamed(name: string): HTMLButtonElement {
  const el = [...dialog().querySelectorAll('button')].find((b) => b.textContent === name)
  if (!el) throw new Error(`missing button ${name}`)
  return el
}

function pressEscape(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
  })
}

beforeEach(() => {
  onCancel = vi.fn<() => void>()
  onConfirm = vi.fn<() => void>()
  opener = document.createElement('button')
  document.body.appendChild(opener)
  opener.focus()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  opener.remove()
})

describe('CancelStepDialog', () => {
  it('focuses Keep running and dismisses on Escape, backdrop click and Keep running when idle', () => {
    render(false)
    expect(document.activeElement).toBe(buttonNamed('Keep running'))
    pressEscape()
    act(() => dialog().parentElement?.click())
    act(() => buttonNamed('Keep running').click())
    expect(onCancel).toHaveBeenCalledTimes(3)
  })

  it('cannot be dismissed while the cancel is pending', () => {
    render(true)
    pressEscape()
    act(() => dialog().parentElement?.click())
    act(() => buttonNamed('Keep running').click())
    expect(onCancel).not.toHaveBeenCalled()
    expect(buttonNamed('Keep running').getAttribute('aria-disabled')).toBe('true')
    expect(buttonNamed('Cancelling…').disabled).toBe(true)
  })

  it('becomes dismissible again once the pending cancel settles', () => {
    render(true)
    render(false)
    pressEscape()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('returns focus to the opener when it closes', () => {
    render(false)
    act(() => root.render(<></>))
    expect(document.activeElement).toBe(opener)
  })
})

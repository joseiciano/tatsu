// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFocusTrap } from './useFocusTrap'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Panel({ active = true }: { active?: boolean }): JSX.Element {
  const ref = useRef<HTMLFormElement | null>(null)
  useFocusTrap(ref, { active })
  return (
    <form ref={ref} aria-label="panel">
      <textarea aria-label="panel field" />
      <button type="submit">panel submit</button>
    </form>
  )
}

interface DialogProps {
  active?: boolean
  onEscape?: () => void
  focusLast?: boolean
}

function Dialog({ active = true, onEscape, focusLast = false }: DialogProps): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const lastRef = useRef<HTMLButtonElement | null>(null)
  useFocusTrap(ref, { active, onEscape, initialFocus: focusLast ? lastRef : undefined })
  return (
    <div ref={ref} role="dialog" aria-modal="true" tabIndex={-1}>
      <button type="button">first</button>
      <button type="button" disabled>
        disabled
      </button>
      <input aria-label="middle" />
      <button ref={lastRef} type="button">
        last
      </button>
    </div>
  )
}

let host: HTMLDivElement
let opener: HTMLButtonElement
let root: Root

beforeEach(() => {
  opener = document.createElement('button')
  opener.textContent = 'opener'
  document.body.appendChild(opener)
  opener.focus()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  opener.remove()
})

function render(props: DialogProps = {}): void {
  act(() => root.render(<Dialog {...props} />))
}

function button(name: string): HTMLElement {
  const el = [...host.querySelectorAll<HTMLElement>('button, input')].find(
    (b) => b.textContent === name || b.getAttribute('aria-label') === name
  )
  if (!el) throw new Error(`missing ${name}`)
  return el
}

function press(key: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
  act(() => {
    ;(document.activeElement ?? document.body).dispatchEvent(event)
  })
  return event
}

describe('useFocusTrap', () => {
  it('moves focus to the first focusable element when it activates', () => {
    render()
    expect(document.activeElement).toBe(button('first'))
  })

  it('moves focus to initialFocus when given', () => {
    render({ focusLast: true })
    expect(document.activeElement).toBe(button('last'))
  })

  it('wraps Tab from the last focusable to the first, skipping disabled ones', () => {
    render({ focusLast: true })
    const event = press('Tab')
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(button('first'))
    press('Tab')
    expect(document.activeElement).toBe(button('middle'))
  })

  it('wraps Shift+Tab from the first focusable to the last', () => {
    render()
    press('Tab', true)
    expect(document.activeElement).toBe(button('last'))
  })

  it('pulls Tab back into the dialog when focus was dropped to the body', () => {
    render()
    button('first').blur()
    press('Tab')
    expect(document.activeElement).toBe(button('first'))
  })

  it('leaves Tab alone when focus is in another element outside the dialog', () => {
    render()
    const other = document.createElement('input')
    document.body.appendChild(other)
    other.focus()
    const event = press('Tab')
    expect(event.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(other)
    other.remove()
  })

  it('calls onEscape on Escape', () => {
    const onEscape = vi.fn()
    render({ onEscape })
    const event = press('Escape')
    expect(onEscape).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('returns focus to the opener on unmount', () => {
    render()
    expect(document.activeElement).not.toBe(opener)
    act(() => root.render(<></>))
    expect(document.activeElement).toBe(opener)
  })

  it('does nothing while inactive', () => {
    const onEscape = vi.fn()
    render({ active: false, onEscape })
    expect(document.activeElement).toBe(opener)
    press('Escape')
    press('Tab')
    expect(onEscape).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(opener)
  })

  it('does not pull focus back when focus has moved elsewhere before it deactivates', () => {
    render()
    const other = document.createElement('input')
    document.body.appendChild(other)
    other.focus()
    render({ active: false })
    expect(document.activeElement).toBe(other)
    other.remove()
  })

  it('keeps the first element focused across re-renders with new callbacks', () => {
    render({ onEscape: () => {} })
    button('middle').focus()
    render({ onEscape: () => {} })
    expect(document.activeElement).toBe(button('middle'))
  })

  it('lets a non-modal trap leave focus in an open modal when it mounts', () => {
    act(() => root.render(<Dialog />))
    act(() =>
      root.render(
        <>
          <Dialog />
          <Panel />
        </>
      )
    )
    expect(document.activeElement).toBe(button('first'))
  })

  it('pulls a dropped Tab into the modal rather than a non-modal trap mounted first', () => {
    act(() => root.render(<Panel />))
    act(() =>
      root.render(
        <>
          <Panel />
          <Dialog />
        </>
      )
    )
    expect(document.activeElement).toBe(button('first'))
    button('first').blur()
    press('Tab')
    expect(document.activeElement).toBe(button('first'))
  })

  it('leaves a dropped Tab alone in a non-modal trap', () => {
    act(() => root.render(<Panel />))
    ;(document.activeElement as HTMLElement | null)?.blur()
    const event = press('Tab')
    expect(event.defaultPrevented).toBe(false)
  })
})

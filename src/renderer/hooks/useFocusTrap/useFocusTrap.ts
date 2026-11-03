import { useEffect, useRef, type RefObject } from 'react'

export interface FocusTrapOptions {
  active: boolean
  onEscape?: () => void
  initialFocus?: RefObject<HTMLElement | null>
}

export const FOCUS_TRAP_ATTRIBUTE = 'data-focus-trap'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function focusableWithin(node: HTMLElement): HTMLElement[] {
  return [...node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((el) => el.tabIndex >= 0)
}

function focusDropped(): boolean {
  const current = document.activeElement
  return current === null || current === document.body
}

function insideAnotherTrap(): boolean {
  return document.activeElement?.closest(`[${FOCUS_TRAP_ATTRIBUTE}]`) != null
}

export function useFocusTrap(ref: RefObject<HTMLElement | null>, { active, onEscape, initialFocus }: FocusTrapOptions): void {
  const onEscapeRef = useRef(onEscape)
  const initialFocusRef = useRef(initialFocus)
  onEscapeRef.current = onEscape
  initialFocusRef.current = initialFocus

  useEffect(() => {
    const node = ref.current
    if (!active || !node) return

    const current = document.activeElement
    const previous = current instanceof HTMLElement && !node.contains(current) ? current : null
    const modal = node.getAttribute('aria-modal') === 'true'
    if (modal || !insideAnotherTrap()) {
      const target = initialFocusRef.current?.current ?? focusableWithin(node)[0] ?? node
      target.focus()
    }
    node.setAttribute(FOCUS_TRAP_ATTRIBUTE, '')

    const cycle = (e: KeyboardEvent): void => {
      if (!node.contains(document.activeElement) && !(modal && focusDropped())) return
      e.preventDefault()
      const focusables = focusableWithin(node)
      if (focusables.length === 0) {
        node.focus()
        return
      }
      const index = document.activeElement instanceof HTMLElement ? focusables.indexOf(document.activeElement) : -1
      const step = e.shiftKey ? -1 : 1
      const next = index === -1 ? (e.shiftKey ? focusables.length - 1 : 0) : (index + step + focusables.length) % focusables.length
      focusables[next].focus()
    }

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Tab') {
        cycle(e)
        return
      }
      const handler = onEscapeRef.current
      if (e.key !== 'Escape' || !handler) return
      e.preventDefault()
      e.stopPropagation()
      handler()
    }

    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      node.removeAttribute(FOCUS_TRAP_ATTRIBUTE)
      if (previous && document.contains(previous) && (focusDropped() || node.contains(document.activeElement))) previous.focus()
    }
  }, [active, ref])
}

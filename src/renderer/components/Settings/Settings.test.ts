import { describe, expect, it, vi } from 'vitest'

type PickerKeyboardEvent = Pick<KeyboardEvent, 'key' | 'preventDefault' | 'stopPropagation'>

type SettingsHelpers = {
  dismissPickerOnEscape?: (event: PickerKeyboardEvent, closePicker: () => void) => void
  reindexRevealedRowsAfterRemoval?: (revealed: ReadonlySet<number>, removedIndex: number) => Set<number>
}

// Dynamic import keeps missing helpers as runtime assertions while implementation is absent.
async function loadSettingsHelpers(): Promise<SettingsHelpers> {
  return (await import('./index')) as unknown as SettingsHelpers
}

function pickerEvent(key: string): PickerKeyboardEvent {
  return {
    key,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn()
  }
}

describe('Settings pure helpers', () => {
  it('dismisses a picker only for Escape and consumes that keyboard event', async () => {
    const { dismissPickerOnEscape } = await loadSettingsHelpers()
    expect(typeof dismissPickerOnEscape).toBe('function')
    if (typeof dismissPickerOnEscape !== 'function') return

    const closePicker = vi.fn()
    const escape = pickerEvent('Escape')

    dismissPickerOnEscape(escape, closePicker)

    expect(closePicker).toHaveBeenCalledOnce()
    expect(escape.preventDefault).toHaveBeenCalledOnce()
    expect(escape.stopPropagation).toHaveBeenCalledOnce()

    const otherKey = pickerEvent('ArrowDown')
    dismissPickerOnEscape(otherKey, closePicker)

    expect(closePicker).toHaveBeenCalledOnce()
    expect(otherKey.preventDefault).not.toHaveBeenCalled()
    expect(otherKey.stopPropagation).not.toHaveBeenCalled()
  })

  it('removes a reveal index and shifts every higher index down after row removal', async () => {
    const { reindexRevealedRowsAfterRemoval } = await loadSettingsHelpers()
    expect(typeof reindexRevealedRowsAfterRemoval).toBe('function')
    if (typeof reindexRevealedRowsAfterRemoval !== 'function') return

    const revealed = new Set([0, 2, 4, 6])
    const reindexed = reindexRevealedRowsAfterRemoval(revealed, 2)

    expect(reindexed).toEqual(new Set([0, 3, 5]))
    expect(revealed).toEqual(new Set([0, 2, 4, 6]))
  })
})

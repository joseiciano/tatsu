import { describe, expect, it } from 'vitest'
import {
  ACTION_CATEGORIES,
  ACTION_LABELS,
  DEFAULT_HOTKEYS,
  bindingToString,
  matchesBinding,
  parseBinding,
  resolveHotkeys
} from './index'

describe('openNotifications hotkey', () => {
  it('defaults to Cmd+Shift+N', () => {
    expect(DEFAULT_HOTKEYS.openNotifications).toEqual({ key: 'n', modifiers: { cmd: true, shift: true } })
  })

  it('does not share its default binding with any other action', () => {
    const target = bindingToString(DEFAULT_HOTKEYS.openNotifications)
    const clashes = Object.entries(DEFAULT_HOTKEYS)
      .filter(([action, binding]) => action !== 'openNotifications' && bindingToString(binding) === target)
      .map(([action]) => action)
    expect(clashes).toEqual([])
  })

  it('round-trips through bindingToString and parseBinding', () => {
    const text = bindingToString(DEFAULT_HOTKEYS.openNotifications)
    expect(text).toBe('Shift+Cmd+N')
    expect(parseBinding(text)).toEqual({ key: 'N', modifiers: { cmd: true, shift: true } })
  })

  it('matches a Cmd+Shift+N keydown regardless of letter case', () => {
    const upper = { key: 'N', metaKey: true, shiftKey: true, ctrlKey: false, altKey: false } as KeyboardEvent
    const lower = { key: 'n', metaKey: true, shiftKey: true, ctrlKey: false, altKey: false } as KeyboardEvent
    const plainN = { key: 'n', metaKey: true, shiftKey: false, ctrlKey: false, altKey: false } as KeyboardEvent
    expect(matchesBinding(upper, DEFAULT_HOTKEYS.openNotifications)).toBe(true)
    expect(matchesBinding(lower, DEFAULT_HOTKEYS.openNotifications)).toBe(true)
    expect(matchesBinding(plainN, DEFAULT_HOTKEYS.openNotifications)).toBe(false)
  })

  it('accepts a user override like any other action', () => {
    const resolved = resolveHotkeys({ openNotifications: 'Cmd+Alt+N' })
    expect(resolved.openNotifications).toEqual({ key: 'N', modifiers: { cmd: true, alt: true } })
  })

  it('has a label and lives in the commands category', () => {
    expect(ACTION_LABELS.openNotifications).toBe('Notifications')
    const commands = ACTION_CATEGORIES.find((c) => c.id === 'commands')
    expect(commands?.actions).toContain('openNotifications')
  })
})

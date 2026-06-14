import { DEFAULT_HOTKEYS } from './constants'
import type { Action, HotkeyBinding, Modifiers } from './types'

/** Check if a KeyboardEvent matches a hotkey binding */
export function matchesBinding(e: KeyboardEvent, binding: HotkeyBinding): boolean {
  const wantCmd = binding.modifiers.cmd ?? false
  const wantCtrl = binding.modifiers.ctrl ?? false
  const wantShift = binding.modifiers.shift ?? false
  const wantAlt = binding.modifiers.alt ?? false

  if (e.metaKey !== wantCmd) return false
  if (e.ctrlKey !== wantCtrl) return false
  if (e.shiftKey !== wantShift) return false
  if (e.altKey !== wantAlt) return false

  // Normalize key comparison — e.key is case-sensitive but we want case-insensitive for letters
  const eventKey = e.key.length === 1 ? e.key.toLowerCase() : e.key
  const bindingKey = binding.key.length === 1 ? binding.key.toLowerCase() : binding.key

  return eventKey === bindingKey
}

/**
 * Parse a shortcut string like "Cmd+Shift+T" into a HotkeyBinding.
 * Recognized modifier tokens: Cmd, Ctrl, Shift, Alt.
 * The last token is the key.
 */
export function parseBinding(shortcut: string): HotkeyBinding {
  const parts = shortcut.split('+')
  const modifiers: Modifiers = {}

  for (let i = 0; i < parts.length - 1; i++) {
    const mod = parts[i].trim().toLowerCase()
    if (mod === 'cmd' || mod === 'meta') modifiers.cmd = true
    else if (mod === 'ctrl' || mod === 'control') modifiers.ctrl = true
    else if (mod === 'shift') modifiers.shift = true
    else if (mod === 'alt' || mod === 'option') modifiers.alt = true
  }

  const key = parts[parts.length - 1].trim()

  return { key, modifiers }
}

/** Format a Cmd+Shift+E-style string as ⌘⇧E with Unicode mac glyphs. */
export function formatBindingGlyphs(binding: string, separator = ' '): string {
  return binding
    .split('+')
    .map((part) => {
      const lower = part.trim().toLowerCase()
      if (lower === 'cmd' || lower === 'meta') return '\u2318' // ⌘
      if (lower === 'ctrl' || lower === 'control') return '\u2303' // ⌃
      if (lower === 'alt' || lower === 'option') return '\u2325' // ⌥
      if (lower === 'shift') return '\u21E7' // ⇧
      if (part === 'ArrowUp') return '\u2191'
      if (part === 'ArrowDown') return '\u2193'
      if (part === 'ArrowLeft') return '\u2190'
      if (part === 'ArrowRight') return '\u2192'
      if (part === 'Enter') return '\u23CE'
      if (part === 'Tab') return 'Tab'
      if (part === 'Escape') return 'Esc'
      return part
    })
    .join(separator)
}

/** Convert a binding back to a human-readable string like "Ctrl+Alt+Shift+Cmd+T" — Mac order. */
export function bindingToString(binding: HotkeyBinding): string {
  const parts: string[] = []
  if (binding.modifiers.ctrl) parts.push('Ctrl')
  if (binding.modifiers.alt) parts.push('Alt')
  if (binding.modifiers.shift) parts.push('Shift')
  if (binding.modifiers.cmd) parts.push('Cmd')
  parts.push(binding.key.length === 1 ? binding.key.toUpperCase() : binding.key)
  return parts.join('+')
}

/** Capture a KeyboardEvent into a HotkeyBinding (for the rebind UI) */
export function eventToBinding(e: KeyboardEvent): HotkeyBinding | null {
  // Ignore pure modifier presses
  if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return null
  return {
    key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
    modifiers: {
      cmd: e.metaKey,
      ctrl: e.ctrlKey,
      shift: e.shiftKey,
      alt: e.altKey
    }
  }
}

/** Build a resolved hotkey map by merging defaults with user overrides */
export function resolveHotkeys(
  overrides?: Record<string, string>
): Record<Action, HotkeyBinding> {
  if (!overrides) return { ...DEFAULT_HOTKEYS }

  const resolved = { ...DEFAULT_HOTKEYS }
  for (const [action, shortcut] of Object.entries(overrides)) {
    if (action in DEFAULT_HOTKEYS) {
      resolved[action as Action] = parseBinding(shortcut)
    }
  }
  return resolved
}

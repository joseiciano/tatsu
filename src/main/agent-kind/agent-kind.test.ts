import { describe, it, expect } from 'vitest'
import { toAgentKind } from '.'

describe('toAgentKind', () => {
  it('returns claude for undefined', () => {
    expect(toAgentKind(undefined)).toBe('claude')
  })

  it('returns claude for empty string', () => {
    expect(toAgentKind('')).toBe('claude')
  })

  it('returns claude for unknown values', () => {
    expect(toAgentKind('foo')).toBe('claude')
    expect(toAgentKind('gpt-4')).toBe('claude')
  })

  it('returns codex for codex', () => {
    expect(toAgentKind('codex')).toBe('codex')
  })

  it('returns opencode for opencode', () => {
    expect(toAgentKind('opencode')).toBe('opencode')
  })
})

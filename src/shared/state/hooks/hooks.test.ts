import { describe, it, expect } from 'vitest'
import { initialHooks, hooksReducer, type HooksState, type CodexHookTrustSummary } from '.'

describe('hooksReducer', () => {
  it('consentChanged transitions through all three states', () => {
    let state: HooksState = initialHooks
    expect(state.consent).toBe('pending')
    state = hooksReducer(state, { type: 'hooks/consentChanged', payload: 'accepted' })
    expect(state.consent).toBe('accepted')
    state = hooksReducer(state, { type: 'hooks/consentChanged', payload: 'declined' })
    expect(state.consent).toBe('declined')
    state = hooksReducer(state, { type: 'hooks/consentChanged', payload: 'pending' })
    expect(state.consent).toBe('pending')
  })

  it('returns a new object reference', () => {
    const next = hooksReducer(initialHooks, {
      type: 'hooks/consentChanged',
      payload: 'accepted'
    })
    expect(next).not.toBe(initialHooks)
    expect(initialHooks.consent).toBe('pending')
  })

  describe('codexTrustChanged', () => {
    const summary: CodexHookTrustSummary = { state: 'needs-review', reviewEvents: ['SessionStart', 'Stop'] }
    const changed = (payload: CodexHookTrustSummary) =>
      ({ type: 'hooks/codexTrustChanged', payload }) as const

    it('sets codexTrust', () => {
      const next = hooksReducer(initialHooks, changed(summary))
      expect(next.codexTrust).toEqual(summary)
    })

    it('returns the same state object for an equal payload', () => {
      const s1 = hooksReducer(initialHooks, changed(summary))
      expect(s1.codexTrust).toEqual(summary)
      const s2 = hooksReducer(s1, changed(structuredClone(summary)))
      expect(s2).toBe(s1)
    })

    it.each<[string, CodexHookTrustSummary]>([
      ['a different state', { state: 'ok', reviewEvents: ['SessionStart', 'Stop'] }],
      ['one differing review event', { state: 'needs-review', reviewEvents: ['SessionStart', 'PreToolUse'] }],
      ['one fewer review event', { state: 'needs-review', reviewEvents: ['SessionStart'] }],
      ['one extra review event', { state: 'needs-review', reviewEvents: ['SessionStart', 'Stop', 'UserPromptSubmit'] }]
    ])('replaces codexTrust for %s', (_name, payload) => {
      const s1 = hooksReducer(initialHooks, changed(summary))
      const s2 = hooksReducer(s1, changed(payload))
      expect(s2).not.toBe(s1)
      expect(s2.codexTrust).toEqual(payload)
    })

    it('consentChanged keeps codexTrust', () => {
      const s1 = hooksReducer(initialHooks, changed(summary))
      const s2 = hooksReducer(s1, { type: 'hooks/consentChanged', payload: 'accepted' })
      expect(s2.consent).toBe('accepted')
      expect(s2.codexTrust).toEqual(summary)
    })
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('../secrets', () => ({
  getSecret: (key: string) => store.get(key) ?? null,
  setSecret: async (key: string, value: string) => {
    store.set(key, value)
  },
  deleteSecret: async (key: string) => {
    store.delete(key)
  }
}))

import { getOrCreateWsToken, rotateWsToken, safeEqualToken, issueSessionToken, consumeSessionToken } from '.'

beforeEach(() => {
  store.clear()
})

describe('ws-token', () => {
  it('generates and persists a token on first call', async () => {
    const t = await getOrCreateWsToken()
    expect(t).toMatch(/^[0-9a-f]{64}$/)
    expect(store.get('wsAuthToken')).toBe(t)
  })

  it('returns the same token on subsequent calls (survives reboots)', async () => {
    const a = await getOrCreateWsToken()
    const b = await getOrCreateWsToken()
    expect(a).toBe(b)
  })

  it('rotateWsToken replaces the stored token', async () => {
    const a = await getOrCreateWsToken()
    const b = await rotateWsToken()
    expect(b).not.toBe(a)
    expect(await getOrCreateWsToken()).toBe(b)
  })


  it('compares matching tokens safely', () => {
    expect(safeEqualToken('secret', 'secret')).toBe(true)
    expect(safeEqualToken('secret', 'other')).toBe(false)
  })

  it('returns false for undefined provided token', () => {
    expect(safeEqualToken(undefined, 'secret')).toBe(false)
  })

  it('returns false for null provided token', () => {
    expect(safeEqualToken(null, 'secret')).toBe(false)
  })

  it('returns false instead of throwing for different token lengths', () => {
    expect(safeEqualToken('secret', 'secrets')).toBe(false)
  })
})

describe('session tokens', () => {
  it('issues a session token when root token matches', () => {
    const token = issueSessionToken('root', 'root')
    expect(token).toMatch(/^[0-9a-f]{32}$/)
  })

  it('returns null when root token does not match', () => {
    expect(issueSessionToken('wrong', 'root')).toBeNull()
  })

  it('returns null for non-string provided token', () => {
    expect(issueSessionToken(undefined, 'root')).toBeNull()
    expect(issueSessionToken(null, 'root')).toBeNull()
    expect(issueSessionToken(123, 'root')).toBeNull()
  })

  it('consumes a valid session token exactly once', () => {
    const token = issueSessionToken('root', 'root')!
    expect(consumeSessionToken(token)).toBe(true)
    // Second use fails — single-use
    expect(consumeSessionToken(token)).toBe(false)
  })

  it('returns false for unknown session tokens', () => {
    expect(consumeSessionToken('bogus')).toBe(false)
  })

  it('returns false for non-string session tokens', () => {
    expect(consumeSessionToken(undefined)).toBe(false)
    expect(consumeSessionToken(null)).toBe(false)
    expect(consumeSessionToken(42)).toBe(false)
  })

  it('rejects expired session tokens', async () => {
    // Issue a token, then fast-forward past the TTL.
    const token = issueSessionToken('root', 'root')!
    vi.useFakeTimers()
    vi.advanceTimersByTime(31_000) // SESSION_TTL_MS is 30_000
    expect(consumeSessionToken(token)).toBe(false)
    vi.useRealTimers()
  })
})

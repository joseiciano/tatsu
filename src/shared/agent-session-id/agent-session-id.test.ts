import { describe, expect, it } from 'vitest'
import { isAgentSessionId } from '.'

describe('isAgentSessionId', () => {
  it('accepts a UUID for claude and codex', () => {
    const id = '0f8e2b7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b'
    expect(isAgentSessionId('claude', id)).toBe(true)
    expect(isAgentSessionId('codex', id)).toBe(true)
    expect(isAgentSessionId('opencode', id)).toBe(false)
  })

  it('accepts a ses_ id only for opencode', () => {
    expect(isAgentSessionId('opencode', 'ses_abc123')).toBe(true)
    expect(isAgentSessionId('codex', 'ses_abc123')).toBe(false)
  })

  it.each(['', 'ses_x;touch /tmp/p', '$(id)', 'ses_', "ses_a'b", '../ses_abc'])('rejects %j', (id) => {
    expect(isAgentSessionId('opencode', id)).toBe(false)
    expect(isAgentSessionId('codex', id)).toBe(false)
  })
})

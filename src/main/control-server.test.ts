import { describe, it, expect } from 'vitest'
import { parseAgentKind } from './control-server'

describe('parseAgentKind', () => {
  it('returns undefined for missing/empty values', () => {
    expect(parseAgentKind(undefined)).toEqual({ kind: undefined })
    expect(parseAgentKind(null)).toEqual({ kind: undefined })
    expect(parseAgentKind('')).toEqual({ kind: undefined })
  })

  it('accepts claude', () => {
    expect(parseAgentKind('claude')).toEqual({ kind: 'claude' })
    expect(parseAgentKind('CLAUDE')).toEqual({ kind: 'claude' })
    expect(parseAgentKind('  claude  ')).toEqual({ kind: 'claude' })
  })

  it('accepts codex', () => {
    expect(parseAgentKind('codex')).toEqual({ kind: 'codex' })
    expect(parseAgentKind('CODEX')).toEqual({ kind: 'codex' })
  })

  it('accepts opencode', () => {
    expect(parseAgentKind('opencode')).toEqual({ kind: 'opencode' })
    expect(parseAgentKind('OPENCODE')).toEqual({ kind: 'opencode' })
  })

  it('rejects unknown agents', () => {
    expect(parseAgentKind('foo')).toEqual({
      error: 'agentKind must be "claude", "codex", or "opencode"'
    })
  })
})

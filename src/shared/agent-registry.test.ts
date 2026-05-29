import { describe, it, expect } from 'vitest'
import { getNextAgentKind, cycleAltAgent, agentSupportsChatMode } from './agent-registry'

describe('getNextAgentKind', () => {
  it('cycles claude -> codex', () => {
    expect(getNextAgentKind('claude')).toBe('codex')
  })

  it('cycles codex -> opencode', () => {
    expect(getNextAgentKind('codex')).toBe('opencode')
  })

  it('cycles opencode -> claude', () => {
    expect(getNextAgentKind('opencode')).toBe('claude')
  })
})

describe('cycleAltAgent', () => {
  it('cycles through non-default agents for claude default', () => {
    expect(cycleAltAgent('claude', 0)).toBe('codex')
    expect(cycleAltAgent('claude', 1)).toBe('opencode')
    expect(cycleAltAgent('claude', 2)).toBe('codex')
    expect(cycleAltAgent('claude', 3)).toBe('opencode')
  })

  it('cycles through non-default agents for codex default', () => {
    expect(cycleAltAgent('codex', 0)).toBe('claude')
    expect(cycleAltAgent('codex', 1)).toBe('opencode')
    expect(cycleAltAgent('codex', 2)).toBe('claude')
  })

  it('cycles through non-default agents for opencode default', () => {
    expect(cycleAltAgent('opencode', 0)).toBe('claude')
    expect(cycleAltAgent('opencode', 1)).toBe('codex')
    expect(cycleAltAgent('opencode', 2)).toBe('claude')
  })
})

describe('agentSupportsChatMode', () => {
  it('returns true for claude', () => {
    expect(agentSupportsChatMode('claude')).toBe(true)
  })

  it('returns true for opencode', () => {
    expect(agentSupportsChatMode('opencode')).toBe(true)
  })

  it('returns false for codex', () => {
    expect(agentSupportsChatMode('codex')).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(agentSupportsChatMode(undefined)).toBe(false)
  })
})

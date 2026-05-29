import { describe, it, expect } from 'vitest'
import {
  getNextAgentKind,
  cycleAltAgent,
  getAgentInfo,
  agentDisplayName,
  AGENT_REGISTRY
} from './agent-registry'

describe('backwards-compatible agent-registry shim', () => {
  it('AGENT_REGISTRY has the three built-ins', () => {
    expect(AGENT_REGISTRY).toHaveLength(3)
    expect(AGENT_REGISTRY.map((a) => a.kind)).toEqual(['claude', 'codex', 'opencode'])
  })

  it('getAgentInfo returns the matching entry', () => {
    const info = getAgentInfo('codex')
    expect(info.displayName).toBe('Codex')
    expect(info.vendor).toBe('OpenAI')
  })

  it('getAgentInfo falls back to first entry for unknown kind', () => {
    const info = getAgentInfo('unknown' as any)
    expect(info.kind).toBe('claude')
  })

  it('agentDisplayName returns display name for known kind', () => {
    expect(agentDisplayName('opencode')).toBe('Opencode')
  })

  it('agentDisplayName returns default when undefined', () => {
    expect(agentDisplayName(undefined)).toBe('Claude Code')
  })

  it('getNextAgentKind cycles claude -> codex', () => {
    expect(getNextAgentKind('claude')).toBe('codex')
  })

  it('getNextAgentKind cycles codex -> opencode', () => {
    expect(getNextAgentKind('codex')).toBe('opencode')
  })

  it('getNextAgentKind cycles opencode -> claude', () => {
    expect(getNextAgentKind('opencode')).toBe('claude')
  })

  it('cycleAltAgent cycles through non-default agents for claude default', () => {
    expect(cycleAltAgent('claude', 0)).toBe('codex')
    expect(cycleAltAgent('claude', 1)).toBe('opencode')
    expect(cycleAltAgent('claude', 2)).toBe('codex')
    expect(cycleAltAgent('claude', 3)).toBe('opencode')
  })

  it('cycleAltAgent cycles through non-default agents for codex default', () => {
    expect(cycleAltAgent('codex', 0)).toBe('claude')
    expect(cycleAltAgent('codex', 1)).toBe('opencode')
    expect(cycleAltAgent('codex', 2)).toBe('claude')
  })

  it('cycleAltAgent cycles through non-default agents for opencode default', () => {
    expect(cycleAltAgent('opencode', 0)).toBe('claude')
    expect(cycleAltAgent('opencode', 1)).toBe('codex')
    expect(cycleAltAgent('opencode', 2)).toBe('claude')
  })
})

import { describe, it, expect } from 'vitest'
import {
  BUILTIN_TERMINAL_AGENTS,
  getMergedTerminalAgents,
  getTerminalAgentDefinition,
  terminalAgentDisplayName,
  getNextTerminalAgentId,
  cycleAltTerminalAgent
} from './terminal-agent-registry'

describe('BUILTIN_TERMINAL_AGENTS', () => {
  it('contains claude, codex, and opencode', () => {
    const ids = BUILTIN_TERMINAL_AGENTS.map((a) => a.id)
    expect(ids).toContain('claude')
    expect(ids).toContain('codex')
    expect(ids).toContain('opencode')
  })

  it('claude has models', () => {
    const claude = BUILTIN_TERMINAL_AGENTS.find((a) => a.id === 'claude')
    expect(claude?.models.length).toBeGreaterThan(0)
  })

  it('codex has models', () => {
    const codex = BUILTIN_TERMINAL_AGENTS.find((a) => a.id === 'codex')
    expect(codex?.models.length).toBeGreaterThan(0)
  })

  it('opencode has empty models array', () => {
    const opencode = BUILTIN_TERMINAL_AGENTS.find((a) => a.id === 'opencode')
    expect(opencode?.models).toEqual([])
  })
})

describe('getMergedTerminalAgents', () => {
  it('returns builtins when no user agents provided', () => {
    const merged = getMergedTerminalAgents()
    expect(merged).toHaveLength(3)
    expect(merged.map((a) => a.id)).toEqual(['claude', 'codex', 'opencode'])
  })

  it('merges user agents that override builtins', () => {
    const user = [
      {
        id: 'claude',
        displayName: 'Claude Pro',
        vendor: 'Anthropic',
        capabilities: {
          assignsSessionId: true,
          supportsResume: true,
          supportsModel: true,
          supportsPrompt: true,
          supportsJsonMode: true,
          supportsHarnessMcp: true,
          supportsHooks: true
        }
      }
    ]
    const merged = getMergedTerminalAgents(user)
    const claude = merged.find((a) => a.id === 'claude')
    expect(claude?.displayName).toBe('Claude Pro')
    expect(claude?.models.length).toBeGreaterThan(0) // preserves builtin models
  })

  it('adds new user agents not in builtins', () => {
    const user = [
      {
        id: 'custom',
        displayName: 'Custom',
        vendor: 'CustomCo',
        capabilities: {
          assignsSessionId: false,
          supportsResume: false,
          supportsModel: true,
          supportsPrompt: true,
          supportsJsonMode: false,
          supportsHarnessMcp: true,
          supportsHooks: false
        }
      }
    ]
    const merged = getMergedTerminalAgents(user)
    expect(merged).toHaveLength(4)
    expect(merged.map((a) => a.id)).toContain('custom')
  })
})

describe('getTerminalAgentDefinition', () => {
  it('returns builtin definition by id', () => {
    const def = getTerminalAgentDefinition('claude')
    expect(def?.displayName).toBe('Claude Code')
  })

  it('returns user definition for custom agents', () => {
    const user = [
      {
        id: 'custom',
        displayName: 'Custom',
        vendor: 'CustomCo',
        capabilities: {
          assignsSessionId: false,
          supportsResume: false,
          supportsModel: true,
          supportsPrompt: true,
          supportsJsonMode: false,
          supportsHarnessMcp: true,
          supportsHooks: false
        }
      }
    ]
    const def = getTerminalAgentDefinition('custom', user)
    expect(def?.displayName).toBe('Custom')
    expect(def?.models).toEqual([])
  })

  it('returns undefined for unknown id', () => {
    expect(getTerminalAgentDefinition('unknown')).toBeUndefined()
  })
})

describe('terminalAgentDisplayName', () => {
  it('returns display name for known id', () => {
    expect(terminalAgentDisplayName('claude')).toBe('Claude Code')
  })

  it('returns default when id is undefined', () => {
    expect(terminalAgentDisplayName(undefined)).toBe('Claude Code')
  })

  it('returns default for unknown id', () => {
    expect(terminalAgentDisplayName('unknown')).toBe('Claude Code')
  })
})

describe('getNextTerminalAgentId', () => {
  it('cycles claude -> codex', () => {
    expect(getNextTerminalAgentId('claude')).toBe('codex')
  })

  it('cycles codex -> opencode', () => {
    expect(getNextTerminalAgentId('codex')).toBe('opencode')
  })

  it('cycles opencode -> claude', () => {
    expect(getNextTerminalAgentId('opencode')).toBe('claude')
  })
})

describe('cycleAltTerminalAgent', () => {
  it('cycles through non-default agents for claude default', () => {
    expect(cycleAltTerminalAgent('claude', 0)).toBe('codex')
    expect(cycleAltTerminalAgent('claude', 1)).toBe('opencode')
    expect(cycleAltTerminalAgent('claude', 2)).toBe('codex')
    expect(cycleAltTerminalAgent('claude', 3)).toBe('opencode')
  })

  it('cycles through non-default agents for codex default', () => {
    expect(cycleAltTerminalAgent('codex', 0)).toBe('claude')
    expect(cycleAltTerminalAgent('codex', 1)).toBe('opencode')
    expect(cycleAltTerminalAgent('codex', 2)).toBe('claude')
  })

  it('cycles through non-default agents for opencode default', () => {
    expect(cycleAltTerminalAgent('opencode', 0)).toBe('claude')
    expect(cycleAltTerminalAgent('opencode', 1)).toBe('codex')
    expect(cycleAltTerminalAgent('opencode', 2)).toBe('claude')
  })

  it('includes user agents in alt cycle', () => {
    const user = [
      {
        id: 'custom',
        displayName: 'Custom',
        vendor: 'CustomCo',
        capabilities: {
          assignsSessionId: false,
          supportsResume: false,
          supportsModel: true,
          supportsPrompt: true,
          supportsJsonMode: false,
          supportsHarnessMcp: true,
          supportsHooks: false
        }
      }
    ]
    expect(cycleAltTerminalAgent('claude', 0, user)).toBe('codex')
    expect(cycleAltTerminalAgent('claude', 1, user)).toBe('opencode')
    expect(cycleAltTerminalAgent('claude', 2, user)).toBe('custom')
    expect(cycleAltTerminalAgent('claude', 3, user)).toBe('codex')
  })
})

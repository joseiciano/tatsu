import { describe, it, expect } from 'vitest'
import { getNextAgentKind, cycleAltAgent } from './agent-registry'

describe('getNextAgentKind', () => {
  it('cycles claude -> codex', () => {
    expect(getNextAgentKind('claude')).toBe('codex')
  })

  it('cycles codex -> opencode', () => {
    expect(getNextAgentKind('codex')).toBe('opencode')
  })

  it('cycles opencode -> pi', () => {
    expect(getNextAgentKind('opencode')).toBe('pi')
  })

  it('cycles pi -> claude', () => {
    expect(getNextAgentKind('pi')).toBe('claude')
  })
})

describe('cycleAltAgent', () => {
  it('cycles through non-default agents for claude default', () => {
    expect(cycleAltAgent('claude', 0)).toBe('codex')
    expect(cycleAltAgent('claude', 1)).toBe('opencode')
    expect(cycleAltAgent('claude', 2)).toBe('pi')
    expect(cycleAltAgent('claude', 3)).toBe('codex')
  })

  it('cycles through non-default agents for codex default', () => {
    expect(cycleAltAgent('codex', 0)).toBe('claude')
    expect(cycleAltAgent('codex', 1)).toBe('opencode')
    expect(cycleAltAgent('codex', 2)).toBe('pi')
    expect(cycleAltAgent('codex', 3)).toBe('claude')
  })

  it('cycles through non-default agents for opencode default', () => {
    expect(cycleAltAgent('opencode', 0)).toBe('claude')
    expect(cycleAltAgent('opencode', 1)).toBe('codex')
    expect(cycleAltAgent('opencode', 2)).toBe('pi')
    expect(cycleAltAgent('opencode', 3)).toBe('claude')
  })

  it('cycles through non-default agents for pi default', () => {
    expect(cycleAltAgent('pi', 0)).toBe('claude')
    expect(cycleAltAgent('pi', 1)).toBe('codex')
    expect(cycleAltAgent('pi', 2)).toBe('opencode')
    expect(cycleAltAgent('pi', 3)).toBe('claude')
  })
})

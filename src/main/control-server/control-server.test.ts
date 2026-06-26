import { describe, it, expect } from 'vitest'
import { parseAgentKind } from '.'
import { AGENT_REGISTRY } from '../../shared/agent-registry'

describe('parseAgentKind', () => {
  it('returns undefined for missing/empty values', () => {
    expect(parseAgentKind(undefined)).toEqual({ kind: undefined })
    expect(parseAgentKind(null)).toEqual({ kind: undefined })
    expect(parseAgentKind('')).toEqual({ kind: undefined })
  })

  it('accepts every registered agent', () => {
    for (const { kind } of AGENT_REGISTRY) {
      expect(parseAgentKind(kind)).toEqual({ kind })
      expect(parseAgentKind(kind.toUpperCase())).toEqual({ kind })
      expect(parseAgentKind(`  ${kind}  `)).toEqual({ kind })
    }
  })

  it('rejects unknown agents', () => {
    const agentNames = AGENT_REGISTRY.map((agent) => `"${agent.kind}"`)
    const validAgents = agentNames.length > 1
      ? `${agentNames.slice(0, -1).join(', ')}, or ${agentNames[agentNames.length - 1]}`
      : agentNames[0]

    expect(parseAgentKind('foo')).toEqual({ error: `agentKind must be ${validAgents}` })
  })
})

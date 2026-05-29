import type { TerminalAgentId, TerminalAgentDefinition, UserTerminalAgentDefinition, AgentRuntimeConfig } from './terminal-agents'
import { BUILTIN_TERMINAL_AGENTS } from './builtin-terminal-agents'

export { BUILTIN_TERMINAL_AGENTS }

export function getMergedTerminalAgents(
  userAgents: UserTerminalAgentDefinition[] = []
): TerminalAgentDefinition[] {
  const merged = new Map<TerminalAgentId, TerminalAgentDefinition>(
    BUILTIN_TERMINAL_AGENTS.map((a) => [a.id, a])
  )
  for (const user of userAgents) {
    const builtin = merged.get(user.id)
    if (builtin) {
      merged.set(user.id, { ...builtin, ...user, models: builtin.models })
    } else {
      merged.set(user.id, { ...user, models: [] })
    }
  }
  return Array.from(merged.values())
}

export function getTerminalAgentDefinition(
  id: TerminalAgentId,
  userAgents?: UserTerminalAgentDefinition[]
): TerminalAgentDefinition | undefined {
  const builtin = BUILTIN_TERMINAL_AGENTS.find((a) => a.id === id)
  if (builtin) return builtin
  const user = userAgents?.find((a) => a.id === id)
  if (user) return { ...user, models: [] }
  return undefined
}

export function terminalAgentDisplayName(
  id: TerminalAgentId | undefined,
  userAgents?: UserTerminalAgentDefinition[]
): string {
  if (!id) return BUILTIN_TERMINAL_AGENTS[0].displayName
  const def = getTerminalAgentDefinition(id, userAgents)
  return def?.displayName ?? BUILTIN_TERMINAL_AGENTS[0].displayName
}

export function getNextTerminalAgentId(defaultId: TerminalAgentId): TerminalAgentId {
  const agents = BUILTIN_TERMINAL_AGENTS
  const idx = agents.findIndex((a) => a.id === defaultId)
  const nextIdx = (idx + 1) % agents.length
  return agents[nextIdx].id
}

export function cycleAltTerminalAgent(
  defaultId: TerminalAgentId,
  clickCount: number,
  userAgents?: UserTerminalAgentDefinition[]
): TerminalAgentId {
  const agents = getMergedTerminalAgents(userAgents)
  const altAgents = agents.filter((a) => a.id !== defaultId)
  if (altAgents.length === 0) return defaultId
  return altAgents[clickCount % altAgents.length].id
}

// Backwards-compatible aliases for old call sites
export type AgentKind = TerminalAgentId
export const AGENT_REGISTRY = BUILTIN_TERMINAL_AGENTS.map((a) => ({
  kind: a.id,
  displayName: a.displayName,
  vendor: a.vendor,
  assignsSessionId: a.capabilities.assignsSessionId
}))

export function getAgentInfo(kind: AgentKind): typeof AGENT_REGISTRY[0] {
  return AGENT_REGISTRY.find((a) => a.kind === kind) ?? AGENT_REGISTRY[0]
}

export function agentDisplayName(kind: AgentKind | undefined): string {
  return terminalAgentDisplayName(kind)
}

export function getNextAgentKind(defaultAgent: AgentKind): AgentKind {
  return getNextTerminalAgentId(defaultAgent)
}

export function cycleAltAgent(defaultAgent: AgentKind, clickCount: number): AgentKind {
  return cycleAltTerminalAgent(defaultAgent, clickCount)
}

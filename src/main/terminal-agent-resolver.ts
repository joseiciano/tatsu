import type { TerminalAgentId, AgentRuntimeConfig } from '../shared/terminal-agents'
import {
  getMergedTerminalAgents,
  getTerminalAgentDefinition
} from '../shared/terminal-agent-registry'
import type { SettingsState } from '../shared/state/settings'

export interface ResolveAgentOptions {
  settings: SettingsState
  requestedAgentId?: TerminalAgentId
  fallbackToDefault?: boolean
}

export function resolveTerminalAgentId(opts: ResolveAgentOptions): TerminalAgentId {
  const { settings, requestedAgentId, fallbackToDefault = true } = opts
  const merged = getMergedTerminalAgents(settings.userTerminalAgents)
  const validIds = new Set(merged.map((a) => a.id))

  if (requestedAgentId && validIds.has(requestedAgentId)) {
    return requestedAgentId
  }

  if (fallbackToDefault) {
    const defaultId = settings.defaultTerminalAgentId
    if (validIds.has(defaultId)) {
      return defaultId
    }
    // Fallback to claude if default is somehow invalid
    if (validIds.has('claude')) {
      return 'claude'
    }
    // Last resort: first available agent
    return merged[0]?.id ?? 'claude'
  }

  // No fallback: return the requested id even if invalid, or claude
  return requestedAgentId ?? settings.defaultTerminalAgentId ?? 'claude'
}

export function getDefaultTerminalAgentId(settings: SettingsState): TerminalAgentId {
  const merged = getMergedTerminalAgents(settings.userTerminalAgents)
  const validIds = new Set(merged.map((a) => a.id))
  const defaultId = settings.defaultTerminalAgentId
  if (validIds.has(defaultId)) {
    return defaultId
  }
  if (validIds.has('claude')) {
    return 'claude'
  }
  return merged[0]?.id ?? 'claude'
}

export function getAgentRuntimeConfig(
  settings: SettingsState,
  agentId: TerminalAgentId
): AgentRuntimeConfig {
  return settings.agentConfigs[agentId] ?? {}
}

export function resolveAgentCommand(
  settings: SettingsState,
  agentId: TerminalAgentId
): string {
  const config = getAgentRuntimeConfig(settings, agentId)
  if (config.command) {
    return config.command
  }
  // Built-in defaults
  if (agentId === 'claude') return 'claude'
  if (agentId === 'codex') return 'codex'
  if (agentId === 'opencode') return 'opencode'
  // For custom agents, fallback to the agent id as command
  return agentId
}

export function resolveAgentModel(
  settings: SettingsState,
  agentId: TerminalAgentId,
  tabModelOverride?: string
): string | null {
  if (tabModelOverride && tabModelOverride.trim()) {
    return tabModelOverride.trim()
  }
  const config = getAgentRuntimeConfig(settings, agentId)
  return config.model ?? null
}

export function resolveAgentEnvVars(
  settings: SettingsState,
  agentId: TerminalAgentId
): Record<string, string> {
  const config = getAgentRuntimeConfig(settings, agentId)
  return config.envVars ?? {}
}

export function isManagedAgent(agentId: TerminalAgentId): boolean {
  return agentId === 'claude' || agentId === 'codex' || agentId === 'opencode'
}

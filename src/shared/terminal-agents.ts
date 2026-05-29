export type TerminalAgentId = string

export interface ModelOption {
  id: string
  displayName: string
  tier: 'current' | 'legacy'
}

export interface TerminalAgentCapabilities {
  assignsSessionId: boolean
  supportsResume: boolean
  supportsModel: boolean
  supportsPrompt: boolean
  supportsJsonMode: boolean
  supportsHarnessMcp: boolean
  supportsHooks: boolean
}

export interface TerminalAgentDefinition {
  id: TerminalAgentId
  displayName: string
  vendor: string
  capabilities: TerminalAgentCapabilities
  models: ModelOption[]
}

export interface UserTerminalAgentDefinition {
  id: TerminalAgentId
  displayName: string
  vendor: string
  capabilities: TerminalAgentCapabilities
}

export interface AgentRuntimeConfig {
  command?: string
  envVars?: Record<string, string>
  model?: string | null
}

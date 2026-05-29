// Backwards-compatible re-export shim.
// New code should import from `terminal-agent-registry` or `builtin-terminal-agents` directly.

export type { TerminalAgentId, ModelOption } from './terminal-agents'
export {
  BUILTIN_TERMINAL_AGENTS,
  CLAUDE_MODELS,
  CODEX_MODELS
} from './builtin-terminal-agents'
export {
  getMergedTerminalAgents,
  getTerminalAgentDefinition,
  terminalAgentDisplayName,
  getNextTerminalAgentId,
  cycleAltTerminalAgent,
  // Legacy aliases
  AGENT_REGISTRY,
  getAgentInfo,
  agentDisplayName,
  getNextAgentKind,
  cycleAltAgent,
  type AgentKind
} from './terminal-agent-registry'

import type { AgentKind } from '../../shared/state/terminals'

export function toAgentKind(value: string | undefined): AgentKind {
  if (value === 'codex') return 'codex'
  if (value === 'opencode') return 'opencode'
  return 'claude'
}

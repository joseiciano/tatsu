import type { AgentKindSetting } from '../shared/state/settings'

export function toAgentKind(value: string | undefined): AgentKindSetting {
  if (value === 'codex') return 'codex'
  if (value === 'opencode') return 'opencode'
  return 'claude'
}

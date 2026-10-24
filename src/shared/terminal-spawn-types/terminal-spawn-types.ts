import type { AgentKind } from '../state/terminals'

export type TerminalSpawnSpec =
  | {
      kind: 'agent'
      terminalId: string
      cwd: string
      agentKind: AgentKind
      sessionId?: string
      initialPrompt?: string
      teleportSessionId?: string
      sessionName?: string
      modelOverride?: string
    }
  | { kind: 'shell'; terminalId: string; cwd: string; command?: string }

export type SpawnOutcome = 'spawned' | 'attached' | 'failed'

export interface TerminalAttachResult {
  alive: boolean
  history: string
}

export interface TerminalCreateResult {
  outcome: SpawnOutcome
  history: string
}

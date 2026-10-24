import type { AgentKind } from '../../shared/state/terminals'
import type { PermissionLevel } from '../../shared/permission-level'
import type {
  SpawnOutcome,
  TerminalAttachResult,
  TerminalCreateResult,
  TerminalSpawnSpec
} from '../../shared/terminal-spawn-types'
import type { AgentModule, HarnessMcpServerSpec } from '../agents'
import type { ClaudeLaunchConfig } from '../claude-launch'
import type { PtyManager } from '../pty-manager'
import type { Store } from '../store'

export interface AgentSpawnRequest {
  terminalId: string
  cwd: string
  agentKind: AgentKind
  sessionId?: string
  initialPrompt?: string
  teleportSessionId?: string
  sessionName?: string
  modelOverride?: string
  cols?: number
  rows?: number
  permissionLevel?: PermissionLevel
  bashAllow?: string[]
}

export interface ShellSpawnRequest {
  terminalId: string
  cwd: string
  command?: string
  cols?: number
  rows?: number
}

export interface AgentSpawnConfig extends ClaudeLaunchConfig {
  claudeCommand?: string
  codexCommand?: string
  opencodeCommand?: string
  piCommand?: string
  codexModel?: string | null
  opencodeModel?: string | null
  piModel?: string | null
  claudeEnvVars?: Record<string, string>
  codexEnvVars?: Record<string, string>
  opencodeEnvVars?: Record<string, string>
  piEnvVars?: Record<string, string>
}

export interface AgentSpawnerDeps {
  pty: Pick<PtyManager, 'hasTerminal' | 'create' | 'getHistory'>
  store: Pick<Store, 'dispatch' | 'getSnapshot'>
  getConfig: () => AgentSpawnConfig
  writeMcpConfig: (terminalId: string) => string | null
  mcpServerSpec: (configPath: string) => HarnessMcpServerSpec
  inheritedEnv?: Readonly<Record<string, string | undefined>>
  getAgent?: (kind: AgentKind) => AgentModule
}

export interface AgentSpawner {
  buildAgentCommand(req: AgentSpawnRequest): string
  buildAgentLaunch(req: AgentSpawnRequest): { command: string; env: Record<string, string> }
  spawnAgentTerminal(req: AgentSpawnRequest, clientId?: string): SpawnOutcome
  spawnShellTerminal(req: ShellSpawnRequest, clientId?: string): SpawnOutcome
  attach(terminalId: string, clientId?: string): TerminalAttachResult
  createOrAttach(
    spec: TerminalSpawnSpec,
    clientId: string,
    cols?: number,
    rows?: number
  ): TerminalCreateResult
}

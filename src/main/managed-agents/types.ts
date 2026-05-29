import type { AgentSpawnOpts } from '../agents'

export interface ManagedAgentIntegration {
  id: string
  hookEvents: string[]
  defaultCommand: string
  assignsSessionId: boolean
  installHooks(): void
  uninstallHooks(): void
  hooksInstalled(): boolean
  stripHooksFromWorktree(worktreePath: string): boolean
  sessionFileExists(cwd: string, sessionId: string): boolean
  latestSessionId(cwd: string): string | null
  buildSpawnArgs(opts: AgentSpawnOpts): string
}

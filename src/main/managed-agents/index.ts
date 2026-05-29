import * as claude from '../agents/claude'
import * as codex from '../agents/codex'
import * as opencode from '../agents/opencode'
import type { ManagedAgentIntegration } from './types'

const managedAgents: Record<string, ManagedAgentIntegration> = {
  claude: {
    id: 'claude',
    hookEvents: claude.hookEvents,
    defaultCommand: claude.defaultCommand,
    assignsSessionId: claude.assignsSessionId,
    installHooks: claude.installHooks,
    uninstallHooks: claude.uninstallHooks,
    hooksInstalled: claude.hooksInstalled,
    stripHooksFromWorktree: claude.stripHooksFromWorktree,
    sessionFileExists: claude.sessionFileExists,
    latestSessionId: claude.latestSessionId,
    buildSpawnArgs: claude.buildSpawnArgs
  },
  codex: {
    id: 'codex',
    hookEvents: codex.hookEvents,
    defaultCommand: codex.defaultCommand,
    assignsSessionId: codex.assignsSessionId,
    installHooks: codex.installHooks,
    uninstallHooks: codex.uninstallHooks,
    hooksInstalled: codex.hooksInstalled,
    stripHooksFromWorktree: codex.stripHooksFromWorktree,
    sessionFileExists: codex.sessionFileExists,
    latestSessionId: codex.latestSessionId,
    buildSpawnArgs: codex.buildSpawnArgs
  },
  opencode: {
    id: 'opencode',
    hookEvents: opencode.hookEvents,
    defaultCommand: opencode.defaultCommand,
    assignsSessionId: opencode.assignsSessionId,
    installHooks: opencode.installHooks,
    uninstallHooks: opencode.uninstallHooks,
    hooksInstalled: opencode.hooksInstalled,
    stripHooksFromWorktree: opencode.stripHooksFromWorktree,
    sessionFileExists: opencode.sessionFileExists,
    latestSessionId: opencode.latestSessionId,
    buildSpawnArgs: opencode.buildSpawnArgs
  }
}

export function getManagedAgent(agentId: string): ManagedAgentIntegration | undefined {
  return managedAgents[agentId]
}

export function listManagedAgentIds(): string[] {
  return Object.keys(managedAgents)
}

export function isManagedAgentId(agentId: string): boolean {
  return agentId in managedAgents
}

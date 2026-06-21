import type { AgentKind } from '../../shared/state/terminals'
import * as claude from './claude'
import * as codex from './codex'
import * as opencode from './opencode'

export type { AgentKind }

export interface AgentSpawnOpts {
  command: string
  cwd: string
  sessionId?: string
  initialPrompt?: string
  teleportSessionId?: string
  sessionName?: string
  mcpConfigPath?: string | null
  model?: string | null
  systemPrompt?: string
  tuiFullscreen?: boolean
}

export interface AgentModule {
  hookEvents: string[]
  defaultCommand: string
  /** If true, Tatsu generates the session ID and passes it to the agent
   * CLI on first spawn (e.g. Claude's --session-id). If false, the agent
   * assigns its own ID and Tatsu discovers it from the first hook event. */
  assignsSessionId: boolean
  /** Install status hooks at the agent's user-scope settings file
   *  (~/.claude/settings.json for Claude, ~/.codex/hooks.json for Codex,
   *   ~/.config/opencode/plugins/ for Opencode).
   *  The hook command is gated on $TATSU_TERMINAL_ID so sessions spawned
   *  outside Tatsu are untouched. */
  installHooks(): void
  hooksInstalled(): boolean
  /** Remove only the Tatsu-marked entries from the user-scope settings file.
   *  Any user-authored hooks and unrelated keys survive. */
  uninstallHooks(): void
  /** Migration: strip legacy Tatsu entries from a single worktree's
   *  per-worktree settings file. Returns true if the file was modified. */
  stripHooksFromWorktree(worktreePath: string): boolean
  sessionFileExists(cwd: string, sessionId: string): boolean
  latestSessionId(cwd: string): string | null
  buildSpawnArgs(opts: AgentSpawnOpts): string
}

const agents: Record<AgentKind, AgentModule> = { claude, codex, opencode }

export function getAgent(kind: AgentKind): AgentModule {
  return agents[kind]
}

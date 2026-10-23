import type { AgentKind, ChatRuntimeCapabilities, ChatRuntimeId, JsonClaudeState } from './types'

export const CHAT_RUNTIME_IDS: readonly ChatRuntimeId[] = ['claude', 'opencode', 'codex']

export function isChatRuntimeId(kind: AgentKind | undefined): kind is ChatRuntimeId {
  return kind !== undefined && (CHAT_RUNTIME_IDS as readonly string[]).includes(kind)
}

/** Whether a chat tab may be offered for an agent right now: Claude always;
 *  OpenCode and Codex only behind the experimentalChatAgentsEnabled setting. */
export function chatRuntimeAvailable(
  kind: AgentKind | undefined,
  experimentalChatAgentsEnabled: boolean
): kind is ChatRuntimeId {
  if (!isChatRuntimeId(kind)) return false
  return kind === 'claude' || experimentalChatAgentsEnabled
}

/** Tool names that the approval card groups under "Allow edits this
 *  session". Granting any of these grants all of them — every tool that
 *  can write to the file system. Kept as a single grant because the user
 *  intent ("I trust this agent to edit") doesn't decompose meaningfully
 *  across these four. */
export const EDIT_TOOL_NAMES = [
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit'
] as const

/** Default capability set for ACP chat runtime. */
export function defaultAcpCapabilities(): ChatRuntimeCapabilities {
  return {
    canInterrupt: true,
    canRewind: false,
    canSetPermissionMode: false,
    canApproveTools: false,
    canResume: true,
    canOpenAuthLogin: false,
    hasSlashCommands: false,
    hasCostTracking: false
  }
}

export const initialJsonClaude: JsonClaudeState = {
  sessions: {},
  pendingApprovals: {}
}

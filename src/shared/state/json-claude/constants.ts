import type { ChatRuntimeCapabilities, JsonClaudeState } from './types'

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

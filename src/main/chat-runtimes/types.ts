import type {
  JsonClaudePermissionMode,
  JsonClaudeChatEntry,
  ChatRuntimeCapabilities
} from '../../shared/state/json-claude'

/** Main-process chat runtime abstraction. Current implementation:
 *  - ClaudeAcpRuntime (uses @anthropic-ai/claude-agent-sdk)
 *
 *  Renderer still talks to same `jsonClaude:*` backend API; registry keeps
 *  IPC surface stable even though ACP is only registered runtime today. */
export interface ChatRuntime {
  /** Returns true if this runtime currently owns a live session. */
  hasSession(sessionId: string): boolean

  /** Start a new session. The runtime should dispatch `sessionStarted`
   *  and subsequent state events through the store. */
  start(
    sessionId: string,
    worktreePath: string,
    opts?: {
      permissionMode?: JsonClaudePermissionMode
      modelOverride?: string
    }
  ): void

  /** Send a user message (and optional image attachments) to the session. */
  send(
    sessionId: string,
    text: string,
    images?: Array<{ mediaType: string; data: string; path: string }>
  ): void

  /** Interrupt the current assistant turn without killing the session. */
  interrupt(sessionId: string): void

  /** Kill the session subprocess and clean up resources. */
  kill(sessionId: string): void

  /** Kill all active sessions managed by this runtime. */
  killAll(): void

  /** Rewind the conversation to a specific entry. Returns ok=false with
   *  a human-readable reason when unsupported or the entry is invalid. */
  rewindTo(sessionId: string, fromEntryId: string): { ok: boolean; reason?: string }

  /** Change permission mode mid-session if supported. */
  setPermissionMode(sessionId: string, mode: JsonClaudePermissionMode): void

  /** Cancel a queued user message before it reaches the model. */
  cancelQueued(sessionId: string, entryId: string): void

  /** Return the capability flags for this runtime. May vary per session
   *  if the runtime discovers features dynamically. */
  getCapabilities(sessionId: string): ChatRuntimeCapabilities
}

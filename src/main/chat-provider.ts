import type {
  ChatProvider,
  ChatCapabilities,
  JsonClaudePermissionMode
} from '../shared/state/json-claude'
import type { ApprovalResult } from './approval-bridge'
import type { Store } from './store'

export interface RewindOutcome {
  ok: boolean
  reason?: string
}

export interface ChatSessionAdapter {
  readonly provider: ChatProvider
  readonly sessionId: string
  start(worktreePath: string, opts?: {
    permissionMode?: JsonClaudePermissionMode
    modelOverride?: string
  }): void
  send(text: string, images?: Array<{ mediaType: string; data: string; path: string }>): void
  cancelQueued(entryId: string): void
  interrupt(): void
  kill(): void
  killAll(): void
  rewindTo(entryId: string): RewindOutcome
  setPermissionMode(mode: JsonClaudePermissionMode): void
  seedFromTranscript(worktreePath: string): void
  resolveApproval(requestId: string, result: ApprovalResult): boolean
  rerunAutoApprovalReview(requestId: string): boolean
}

export class ChatProviderManager {
  private adapters = new Map<string, ChatSessionAdapter>()
  private store: Store

  constructor(store: Store) {
    this.store = store
  }

  registerAdapter(adapter: ChatSessionAdapter): void {
    this.adapters.set(adapter.sessionId, adapter)
  }

  hasSession(sessionId: string): boolean {
    return this.adapters.has(sessionId)
  }

  start(
    sessionId: string,
    worktreePath: string,
    provider: ChatProvider,
    opts?: {
      permissionMode?: JsonClaudePermissionMode
      modelOverride?: string
    }
  ): void {
    const adapter = this.adapters.get(sessionId)
    if (adapter) {
      // Already running — idempotent start
      return
    }
    // The actual adapter creation and registration happens in the
    // provider-specific factory (ClaudeChatAdapter or OpencodeChatAdapter).
    // This method is called AFTER the adapter is already registered.
    // If no adapter is registered, dispatch sessionStarted but don't spawn.
    this.store.dispatch({
      type: 'jsonClaude/sessionStarted',
      payload: {
        sessionId,
        worktreePath,
        provider,
        capabilities:
          provider === 'opencode'
            ? {
                supportsPermissionMode: false,
                supportsRewind: false,
                supportsSubAgentNesting: false,
                supportsImageAttachments: false,
                supportsSlashCommands: false,
                supportsAutoApprover: false,
                composerPlaceholder: 'Message Opencode',
                agentName: 'Opencode'
              }
            : {
                supportsPermissionMode: true,
                supportsRewind: true,
                supportsSubAgentNesting: true,
                supportsImageAttachments: true,
                supportsSlashCommands: true,
                supportsAutoApprover: true,
                composerPlaceholder: 'Message Claude',
                agentName: 'Claude'
              }
      }
    })
  }

  private getAdapter(sessionId: string): ChatSessionAdapter | undefined {
    return this.adapters.get(sessionId)
  }

  send(
    sessionId: string,
    text: string,
    images?: Array<{ mediaType: string; data: string; path: string }>
  ): void {
    this.getAdapter(sessionId)?.send(text, images)
  }

  cancelQueued(sessionId: string, entryId: string): void {
    this.getAdapter(sessionId)?.cancelQueued(entryId)
  }

  interrupt(sessionId: string): void {
    this.getAdapter(sessionId)?.interrupt()
  }

  kill(sessionId: string): void {
    this.getAdapter(sessionId)?.kill()
    this.adapters.delete(sessionId)
  }

  killAll(): void {
    for (const [id, adapter] of this.adapters) {
      adapter.kill()
    }
    this.adapters.clear()
  }

  rewindTo(sessionId: string, entryId: string): RewindOutcome {
    return this.getAdapter(sessionId)?.rewindTo(entryId) ?? { ok: false, reason: 'no adapter' }
  }

  setPermissionMode(sessionId: string, mode: JsonClaudePermissionMode): void {
    this.getAdapter(sessionId)?.setPermissionMode(mode)
  }

  seedFromTranscript(sessionId: string, worktreePath: string): void {
    this.getAdapter(sessionId)?.seedFromTranscript(worktreePath)
  }

  resolveApproval(
    sessionId: string,
    requestId: string,
    result: ApprovalResult
  ): boolean {
    return this.getAdapter(sessionId)?.resolveApproval(requestId, result) ?? false
  }

  rerunAutoApprovalReview(sessionId: string, requestId: string): boolean {
    return this.getAdapter(sessionId)?.rerunAutoApprovalReview(requestId) ?? false
  }
}

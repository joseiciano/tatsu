import type { ChatSessionAdapter, RewindOutcome } from './chat-provider'
import type { JsonClaudeManager } from './json-claude-manager'
import type { ApprovalBridge, ApprovalResult } from './approval-bridge'
import type { JsonClaudePermissionMode } from '../shared/state/json-claude'

export class ClaudeChatAdapter implements ChatSessionAdapter {
  readonly provider = 'claude' as const
  readonly sessionId: string
  private manager: JsonClaudeManager
  private approvalBridge: ApprovalBridge

  constructor(
    sessionId: string,
    manager: JsonClaudeManager,
    approvalBridge: ApprovalBridge
  ) {
    this.sessionId = sessionId
    this.manager = manager
    this.approvalBridge = approvalBridge
  }

  start(worktreePath: string, opts?: {
    permissionMode?: JsonClaudePermissionMode
    modelOverride?: string
  }): void {
    if (this.manager.hasSession(this.sessionId)) return
    this.manager.seedFromTranscript(this.sessionId, worktreePath)
    this.manager.create(
      this.sessionId,
      worktreePath,
      opts?.permissionMode ?? 'default',
      opts?.modelOverride
    )
  }

  send(text: string, images?: Array<{ mediaType: string; data: string; path: string }>): void {
    this.manager.send(this.sessionId, text, images)
  }

  cancelQueued(entryId: string): void {
    this.manager.cancelQueued(this.sessionId, entryId)
  }

  interrupt(): void {
    this.manager.interrupt(this.sessionId)
  }

  kill(): void {
    this.manager.kill(this.sessionId)
  }

  killAll(): void {
    this.manager.killAll()
  }

  rewindTo(entryId: string): RewindOutcome {
    return this.manager.rewindTo(this.sessionId, entryId)
  }

  setPermissionMode(mode: JsonClaudePermissionMode): void {
    this.manager.setPermissionMode(this.sessionId, mode)
  }

  seedFromTranscript(worktreePath: string): void {
    this.manager.seedFromTranscript(this.sessionId, worktreePath)
  }

  resolveApproval(requestId: string, result: ApprovalResult): boolean {
    return this.approvalBridge.resolveApproval(requestId, result)
  }

  rerunAutoApprovalReview(requestId: string): boolean {
    return this.approvalBridge.rerunAutoApprovalReview(requestId)
  }
}

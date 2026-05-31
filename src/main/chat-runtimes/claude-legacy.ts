import type { ChatRuntime } from './types'
import type { JsonClaudeManager } from '../json-claude-manager'
import type {
  JsonClaudePermissionMode,
  ChatRuntimeCapabilities
} from '../../shared/state/json-claude'
import { defaultCapabilitiesFor } from '../../shared/state/json-claude'

/** Thin adapter that wraps the existing JsonClaudeManager so it
 *  implements the ChatRuntime interface. No behavior changes —
 *  this is pure delegation. */
export class ClaudeLegacyRuntime implements ChatRuntime {
  private manager: JsonClaudeManager

  constructor(manager: JsonClaudeManager) {
    this.manager = manager
  }

  hasSession(sessionId: string): boolean {
    return this.manager.hasSession(sessionId)
  }

  start(
    sessionId: string,
    worktreePath: string,
    opts?: {
      permissionMode?: JsonClaudePermissionMode
      modelOverride?: string
    }
  ): void {
    this.manager.seedFromTranscript(sessionId, worktreePath)
    this.manager.create(
      sessionId,
      worktreePath,
      opts?.permissionMode ?? 'default',
      opts?.modelOverride
    )
  }

  send(
    sessionId: string,
    text: string,
    images?: Array<{ mediaType: string; data: string; path: string }>
  ): void {
    this.manager.send(sessionId, text, images)
  }

  interrupt(sessionId: string): void {
    this.manager.interrupt(sessionId)
  }

  kill(sessionId: string): void {
    this.manager.kill(sessionId)
  }

  killAll(): void {
    this.manager.killAll()
  }

  rewindTo(sessionId: string, fromEntryId: string): { ok: boolean; reason?: string } {
    return this.manager.rewindTo(sessionId, fromEntryId)
  }

  setPermissionMode(sessionId: string, mode: JsonClaudePermissionMode): void {
    this.manager.setPermissionMode(sessionId, mode)
  }

  cancelQueued(sessionId: string, entryId: string): void {
    this.manager.cancelQueued(sessionId, entryId)
  }

  getCapabilities(_sessionId: string): ChatRuntimeCapabilities {
    return defaultCapabilitiesFor('legacy')
  }
}

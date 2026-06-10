import type { ChatRuntime } from './types'
import type { Store } from '../store'
import type {
  ClaudeChatRuntime,
  JsonClaudePermissionMode,
  ChatRuntimeCapabilities
} from '../../shared/state/json-claude'

/** Main-process registry that holds chat runtimes and routes jsonClaude
 *  operations to the correct implementation. */
export class ChatRuntimeRegistry {
  private runtimes: Map<ClaudeChatRuntime, ChatRuntime> = new Map()

  constructor(_store: Store) {}

  register(runtimeId: ClaudeChatRuntime, runtime: ChatRuntime): void {
    this.runtimes.set(runtimeId, runtime)
  }

  getDefaultRuntimeId(): ClaudeChatRuntime {
    return 'acp'
  }

  getRuntimeById(runtimeId: ClaudeChatRuntime): ChatRuntime {
    const runtime = this.runtimes.get(runtimeId)
    if (!runtime) throw new Error(`Chat runtime not registered: ${runtimeId}`)
    return runtime
  }

  /** Return concrete ChatRuntime instance for session. */
  getRuntime(sessionId: string): ChatRuntime {
    void sessionId
    const id = this.getDefaultRuntimeId()
    return this.getRuntimeById(id)
  }

  hasSession(sessionId: string): boolean {
    return this.getRuntime(sessionId).hasSession(sessionId)
  }

  start(
    sessionId: string,
    worktreePath: string,
    opts?: {
      permissionMode?: JsonClaudePermissionMode
      modelOverride?: string
    }
  ): void {
    this.getRuntime(sessionId).start(sessionId, worktreePath, opts)
  }

  send(
    sessionId: string,
    text: string,
    images?: Array<{ mediaType: string; data: string; path: string }>
  ): void {
    this.getRuntime(sessionId).send(sessionId, text, images)
  }

  interrupt(sessionId: string): void {
    this.getRuntime(sessionId).interrupt(sessionId)
  }

  kill(sessionId: string): void {
    this.getRuntime(sessionId).kill(sessionId)
  }

  killAll(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.killAll()
    }
  }

  rewindTo(sessionId: string, fromEntryId: string): { ok: boolean; reason?: string } {
    return this.getRuntime(sessionId).rewindTo(sessionId, fromEntryId)
  }

  setPermissionMode(sessionId: string, mode: JsonClaudePermissionMode): void {
    this.getRuntime(sessionId).setPermissionMode(sessionId, mode)
  }

  cancelQueued(sessionId: string, entryId: string): void {
    this.getRuntime(sessionId).cancelQueued(sessionId, entryId)
  }

  getCapabilities(sessionId: string): ChatRuntimeCapabilities {
    return this.getRuntime(sessionId).getCapabilities(sessionId)
  }
}

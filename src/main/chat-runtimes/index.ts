import type { ChatRuntime } from './types'
import type { Store } from '../store'
import type { AgentKind } from '../../shared/state/terminals'
import type {
  JsonClaudePermissionMode,
  ChatRuntimeCapabilities
} from '../../shared/state/json-claude'

/** Main-process registry that holds chat runtimes and routes jsonClaude
 *  operations to the correct implementation. Runtimes are keyed by agent
 *  kind; routing per session reads the session's `agentKind` from the
 *  store slice instead of a hard-coded default. */
export class ChatRuntimeRegistry {
  private runtimes: Map<AgentKind, ChatRuntime> = new Map()
  private store: Store

  constructor(store: Store) {
    this.store = store
  }

  register(agentKind: AgentKind, runtime: ChatRuntime): void {
    this.runtimes.set(agentKind, runtime)
  }

  getRuntimeById(agentKind: AgentKind): ChatRuntime {
    const runtime = this.runtimes.get(agentKind)
    if (!runtime) {
      throw new Error(
        `Chat runtime not registered for agent kind: ${agentKind}`
      )
    }
    return runtime
  }

  /** Return the concrete ChatRuntime for a session by looking up the
   *  session's agent kind in the store slice. Throws a clear error for
   *  an unknown session or an agent kind with no registered runtime. */
  getRuntime(sessionId: string): ChatRuntime {
    const session = this.store.getSnapshot().state.jsonClaude.sessions[sessionId]
    if (!session) {
      throw new Error(`Chat runtime lookup failed: unknown session ${sessionId}`)
    }
    return this.getRuntimeById(session.agentKind)
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

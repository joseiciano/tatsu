import type { ChatRuntime } from './types'
import type { Store } from '../store'
import type {
  ClaudeChatRuntime,
  JsonClaudePermissionMode,
  ChatRuntimeCapabilities
} from '../../shared/state/json-claude'
import { defaultCapabilitiesFor } from '../../shared/state/json-claude'
import { getLeaves } from '../../shared/state/terminals'

/** Resolve the runtime identifier for a session from the jsonClaude slice.
 *  Falls back to 'legacy' when the session does not exist. */
export function resolveSessionRuntime(
  sessions: Record<string, { runtime?: ClaudeChatRuntime }>,
  sessionId: string
): ClaudeChatRuntime {
  return sessions[sessionId]?.runtime ?? 'legacy'
}

/** Resolve the runtime identifier for a json-claude tab from the pane tree.
 *  Falls back to 'legacy' when the tab or its session metadata can't be found. */
export function resolveTabRuntime(
  panes: Record<string, import('../../shared/state/terminals').PaneNode>,
  sessions: Record<string, { runtime?: ClaudeChatRuntime }>,
  tabId: string
): ClaudeChatRuntime {
  // First check the session slice (authoritative)
  const fromSession = resolveSessionRuntime(sessions, tabId)
  if (fromSession !== 'legacy') return fromSession

  // Then check the tab metadata in the pane tree
  for (const tree of Object.values(panes)) {
    for (const leaf of getLeaves(tree)) {
      for (const tab of leaf.tabs) {
        if (tab.id === tabId && tab.type === 'json-claude') {
          return tab.runtime ?? 'legacy'
        }
      }
    }
  }

  return 'legacy'
}

/** Main-process registry that holds chat runtimes and routes jsonClaude
 *  operations to the correct implementation. */
export class ChatRuntimeRegistry {
  private store: Store
  private runtimes: Map<ClaudeChatRuntime, ChatRuntime> = new Map()

  constructor(store: Store) {
    this.store = store
  }

  register(runtimeId: ClaudeChatRuntime, runtime: ChatRuntime): void {
    this.runtimes.set(runtimeId, runtime)
  }

  /** Return the runtime identifier for a session, falling back to 'legacy'. */
  resolveRuntime(sessionId: string): ClaudeChatRuntime {
    const state = this.store.getSnapshot().state
    return resolveSessionRuntime(state.jsonClaude.sessions, sessionId)
  }

  /** Return the runtime identifier for a session, checking both the session
   *  slice and the pane tree tab metadata. Falls back to 'legacy'. */
  resolveRuntimeFromSessionOrTab(sessionId: string): ClaudeChatRuntime {
    const state = this.store.getSnapshot().state
    return resolveTabRuntime(state.terminals.panes, state.jsonClaude.sessions, sessionId)
  }

  /** Return the concrete ChatRuntime instance for a runtime identifier.
   *  Falls back to the 'legacy' runtime if the identifier is unknown. */
  getRuntimeById(runtimeId: ClaudeChatRuntime): ChatRuntime {
    const runtime = this.runtimes.get(runtimeId)
    if (!runtime) {
      return this.runtimes.get('legacy')!
    }
    return runtime
  }

  /** Return the concrete ChatRuntime instance for a session. */
  getRuntime(sessionId: string): ChatRuntime {
    const id = this.resolveRuntime(sessionId)
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

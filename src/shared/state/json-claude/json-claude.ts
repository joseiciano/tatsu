// Chat-tab state. Distinct from terminals slice because this UI does not run
// PTY — lifecycle comes from ChatRuntimeRegistry + ClaudeAcpRuntime driving
// @anthropic-ai/claude-agent-sdk query() stream, while terminal-hook status
// remains separate. Renderer still consumes legacy `jsonClaude:*` event names
// so runtime swap stayed transport-compatible.

import type {
  JsonClaudeChatEntry,
  JsonClaudeEvent,
  JsonClaudePendingApproval,
  JsonClaudeState
} from './types'
import { defaultAcpCapabilities } from './constants'
import { appendBlocksToEntry, applyBlockTextDelta } from './helpers'

export function jsonClaudeReducer(
  state: JsonClaudeState,
  event: JsonClaudeEvent
): JsonClaudeState {
  switch (event.type) {
    case 'jsonClaude/sessionStarted': {
      const { sessionId, worktreePath } = event.payload
      // Preserve entries + permissionMode + slashCommands +
      // sessionToolApprovals + sessionAllowedDecisions if this session
      // id already exists (re-attach on reload or mode-change respawn).
      // The session-allow set is a user grant that should outlive a
      // kill+respawn the same way permissionMode does. Reset exit
      // bookkeeping.
      const existing = state.sessions[sessionId]
      const capabilities =
        existing?.capabilities ??
        event.payload.capabilities ??
        defaultAcpCapabilities()
      // Preserve agent identity on re-attach so routing stays stable even
      // if a start payload were ever mislabeled. Fresh sessions take the
      // kind/id the runtime requested.
      const agentKind = existing?.agentKind ?? event.payload.agentKind
      const runtimeId = existing?.runtimeId ?? event.payload.runtimeId
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [sessionId]: {
            sessionId,
            worktreePath,
            agentKind,
            runtimeId,
            state: 'connecting',
            exitCode: null,
            exitReason: null,
            entries: existing?.entries ?? [],
            entriesHydrated: existing?.entriesHydrated ?? false,
            busy: false,
            permissionMode:
              existing?.permissionMode ??
              event.payload.defaultPermissionMode ??
              'default',
            slashCommands: existing?.slashCommands ?? [],
            autoApprovedDecisions: existing?.autoApprovedDecisions ?? {},
            sessionToolApprovals: existing?.sessionToolApprovals ?? [],
            sessionAllowedDecisions: existing?.sessionAllowedDecisions ?? {},
            capabilities
          }
        }
      }
    }
    case 'jsonClaude/sessionStateChanged': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      const { state: next, exitCode, exitReason } = event.payload
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: {
            ...session,
            state: next,
            exitCode: exitCode ?? session.exitCode,
            exitReason: exitReason ?? session.exitReason
          }
        }
      }
    }
    case 'jsonClaude/entryAppended': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: {
            ...session,
            entries: appendBlocksToEntry(session.entries, event.payload.entry)
          }
        }
      }
    }
    case 'jsonClaude/entriesSeeded': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: {
            ...session,
            entries: event.payload.entries,
            entriesHydrated: true
          }
        }
      }
    }
    case 'jsonClaude/assistantTextDelta': {
      // Target the *last* text block. Messages can have
      // text→tool_use→text shape, and deltas always belong to the
      // most recently opened content block.
      return applyBlockTextDelta(
        state,
        event.payload.sessionId,
        event.payload.entryId,
        event.payload.textDelta,
        'text'
      )
    }
    case 'jsonClaude/assistantThinkingDelta': {
      return applyBlockTextDelta(
        state,
        event.payload.sessionId,
        event.payload.entryId,
        event.payload.textDelta,
        'thinking'
      )
    }
    case 'jsonClaude/assistantBlockAppended': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      const { entryId, block } = event.payload
      const i = session.entries.findIndex((e) => e.entryId === entryId)
      if (i === -1) return state
      const entry = session.entries[i]
      const patched = { ...entry, blocks: [...(entry.blocks ?? []), block] }
      const nextEntries = [
        ...session.entries.slice(0, i),
        patched,
        ...session.entries.slice(i + 1)
      ]
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: { ...session, entries: nextEntries }
        }
      }
    }
    case 'jsonClaude/assistantEntryFinalized': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      const { entryId, blocks } = event.payload
      const i = session.entries.findIndex((e) => e.entryId === entryId)
      if (i === -1) return state
      const { isPartial: _drop, ...rest } = session.entries[i]
      void _drop
      const patched = { ...rest, blocks }
      const nextEntries = [
        ...session.entries.slice(0, i),
        patched,
        ...session.entries.slice(i + 1)
      ]
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: { ...session, entries: nextEntries }
        }
      }
    }
    case 'jsonClaude/toolResultAttached': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      const { toolUseId, content, isError } = event.payload
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: {
            ...session,
            entries: [
              ...session.entries,
              {
                entryId: `${session.sessionId}-tr-${toolUseId}-${session.entries.length}`,
                kind: 'tool_result',
                timestamp: Date.now(),
                blocks: [
                  {
                    type: 'tool_result',
                    toolUseId,
                    content,
                    isError
                  }
                ]
              }
            ]
          }
        }
      }
    }
    case 'jsonClaude/busyChanged': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: { ...session, busy: event.payload.busy }
        }
      }
    }
    case 'jsonClaude/sessionCleared': {
      const { sessionId } = event.payload
      if (!state.sessions[sessionId]) return state
      const { [sessionId]: _dropped, ...rest } = state.sessions
      void _dropped
      // Drop any pending approvals from this session so the renderer
      // doesn't show dangling cards.
      const nextPending: Record<string, JsonClaudePendingApproval> = {}
      for (const [id, req] of Object.entries(state.pendingApprovals)) {
        if (req.sessionId !== sessionId) nextPending[id] = req
      }
      return { ...state, sessions: rest, pendingApprovals: nextPending }
    }
    case 'jsonClaude/approvalRequested': {
      const req = event.payload
      return {
        ...state,
        pendingApprovals: { ...state.pendingApprovals, [req.requestId]: req }
      }
    }
    case 'jsonClaude/approvalResolved': {
      const { requestId } = event.payload
      if (!state.pendingApprovals[requestId]) return state
      const { [requestId]: _dropped, ...rest } = state.pendingApprovals
      void _dropped
      return { ...state, pendingApprovals: rest }
    }
    case 'jsonClaude/approvalAutoApproved': {
      const { sessionId, toolUseId, model, reason, timestamp } = event.payload
      const session = state.sessions[sessionId]
      if (!session) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            autoApprovedDecisions: {
              ...session.autoApprovedDecisions,
              [toolUseId]: { model, reason, timestamp }
            }
          }
        }
      }
    }
    case 'jsonClaude/approvalAutoReviewFinished': {
      const { requestId, decision, reason, model } = event.payload
      const existing = state.pendingApprovals[requestId]
      if (!existing) return state
      return {
        ...state,
        pendingApprovals: {
          ...state.pendingApprovals,
          [requestId]: {
            ...existing,
            autoReview: { state: 'finished', decision, reason, model }
          }
        }
      }
    }
    case 'jsonClaude/permissionModeChanged': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: {
            ...session,
            permissionMode: event.payload.mode
          }
        }
      }
    }
    case 'jsonClaude/userEntriesUnqueued': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      if (!session.entries.some((e) => e.isQueued)) return state
      const nextEntries = session.entries.map((entry) => {
        if (!entry.isQueued) return entry
        const { isQueued: _drop, ...rest } = entry
        void _drop
        return rest
      })
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: { ...session, entries: nextEntries }
        }
      }
    }
    case 'jsonClaude/userEntryUnqueued': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      const idx = session.entries.findIndex(
        (e) => e.entryId === event.payload.entryId && e.isQueued
      )
      if (idx === -1) return state
      const target = session.entries[idx]
      const { isQueued: _drop, ...rest } = target
      void _drop
      const nextEntries = [
        ...session.entries.slice(0, idx),
        rest,
        ...session.entries.slice(idx + 1)
      ]
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: { ...session, entries: nextEntries }
        }
      }
    }
    case 'jsonClaude/entryRemoved': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      const next = session.entries.filter(
        (e) => e.entryId !== event.payload.entryId
      )
      if (next.length === session.entries.length) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: { ...session, entries: next }
        }
      }
    }
    case 'jsonClaude/entriesTruncated': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      const idx = session.entries.findIndex(
        (e) => e.entryId === event.payload.fromEntryId
      )
      if (idx === -1) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: {
            ...session,
            entries: session.entries.slice(0, idx)
          }
        }
      }
    }
    case 'jsonClaude/slashCommandsChanged': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: {
            ...session,
            slashCommands: event.payload.slashCommands
          }
        }
      }
    }
    case 'jsonClaude/compactBoundaryReceived': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      const { entryId, trigger, preTokens, postTokens, timestamp } =
        event.payload
      const entry: JsonClaudeChatEntry = {
        entryId,
        kind: 'compact',
        timestamp,
        ...(trigger ? { compactTrigger: trigger } : {}),
        ...(typeof preTokens === 'number' ? { compactPreTokens: preTokens } : {}),
        ...(typeof postTokens === 'number'
          ? { compactPostTokens: postTokens }
          : {})
      }
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: {
            ...session,
            entries: [...session.entries, entry]
          }
        }
      }
    }
    case 'jsonClaude/sessionToolApprovalsGranted': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      const existing = new Set(session.sessionToolApprovals)
      let added = false
      for (const name of event.payload.toolNames) {
        if (!existing.has(name)) {
          existing.add(name)
          added = true
        }
      }
      if (!added) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: {
            ...session,
            sessionToolApprovals: Array.from(existing)
          }
        }
      }
    }
    case 'jsonClaude/sessionToolApprovalsCleared': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      const { toolNames } = event.payload
      if (!toolNames) {
        if (session.sessionToolApprovals.length === 0) return state
        return {
          ...state,
          sessions: {
            ...state.sessions,
            [session.sessionId]: { ...session, sessionToolApprovals: [] }
          }
        }
      }
      const drop = new Set(toolNames)
      const next = session.sessionToolApprovals.filter((n) => !drop.has(n))
      if (next.length === session.sessionToolApprovals.length) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: { ...session, sessionToolApprovals: next }
        }
      }
    }
    case 'jsonClaude/approvalSessionAllowed': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      const { toolUseId, toolName, timestamp } = event.payload
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: {
            ...session,
            sessionAllowedDecisions: {
              ...session.sessionAllowedDecisions,
              [toolUseId]: { toolName, timestamp }
            }
          }
        }
      }
    }
    case 'jsonClaude/capabilitiesChanged': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      const nextCaps = event.payload.capabilities
      const prevCaps = session.capabilities
      if (
        prevCaps.canInterrupt === nextCaps.canInterrupt &&
        prevCaps.canRewind === nextCaps.canRewind &&
        prevCaps.canSetPermissionMode === nextCaps.canSetPermissionMode &&
        prevCaps.canApproveTools === nextCaps.canApproveTools &&
        prevCaps.canResume === nextCaps.canResume &&
        prevCaps.canOpenAuthLogin === nextCaps.canOpenAuthLogin &&
        prevCaps.hasSlashCommands === nextCaps.hasSlashCommands &&
        prevCaps.hasCostTracking === nextCaps.hasCostTracking
      ) {
        return state
      }
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: {
            ...session,
            capabilities: nextCaps
          }
        }
      }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

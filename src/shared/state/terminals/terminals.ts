import type { PaneNode, TerminalSession, TerminalTab, TerminalsEvent, TerminalsState } from './types'
import { findSplit, mapLeaves, replaceNode } from './tree-helpers'

export function terminalsReducer(
  state: TerminalsState,
  event: TerminalsEvent
): TerminalsState {
  switch (event.type) {
    case 'terminals/statusChanged': {
      const { id, status, pendingTool } = event.payload
      // pendingTool only matters when the status is needs-approval; null it
      // otherwise so the renderer doesn't flash stale approval UI.
      const nextPending = status === 'needs-approval' ? pendingTool : null
      return {
        ...state,
        statuses: { ...state.statuses, [id]: status },
        pendingTools: { ...state.pendingTools, [id]: nextPending }
      }
    }
    case 'terminals/shellActivityChanged': {
      const { id, active, processName } = event.payload
      return {
        ...state,
        shellActivity: {
          ...state.shellActivity,
          [id]: { active, processName }
        }
      }
    }
    case 'terminals/progressChanged': {
      const { id, state: pstate, value } = event.payload
      const prev = state.progress[id]
      // state 0 = no progress: drop the entry to reset cleanly.
      if (pstate === 0) {
        if (!prev) return state
        const { [id]: _dropped, ...rest } = state.progress
        void _dropped
        return { ...state, progress: rest }
      }
      // Dedup identical updates so high-frequency OSC streams don't fan out.
      if (prev && prev.state === pstate && prev.value === value) return state
      return {
        ...state,
        progress: { ...state.progress, [id]: { state: pstate, value } }
      }
    }
    case 'terminals/removed': {
      const id = event.payload
      if (
        !(id in state.statuses) &&
        !(id in state.pendingTools) &&
        !(id in state.shellActivity) &&
        !(id in state.progress) &&
        !(id in state.sessions)
      ) {
        return state
      }
      const { [id]: _s, ...restStatuses } = state.statuses
      const { [id]: _p, ...restPending } = state.pendingTools
      const { [id]: _a, ...restActivity } = state.shellActivity
      const { [id]: _pg, ...restProgress } = state.progress
      const { [id]: _session, ...restSessions } = state.sessions
      void _s
      void _p
      void _a
      void _pg
      void _session
      return {
        ...state,
        statuses: restStatuses,
        pendingTools: restPending,
        shellActivity: restActivity,
        progress: restProgress,
        sessions: restSessions
      }
    }
    case 'terminals/panesReplaced': {
      return { ...state, panes: event.payload }
    }
    case 'terminals/panesForWorktreeChanged': {
      const { worktreePath, panes } = event.payload
      return {
        ...state,
        panes: { ...state.panes, [worktreePath]: panes }
      }
    }
    case 'terminals/panesForWorktreeCleared': {
      const worktreePath = event.payload
      if (!(worktreePath in state.panes)) return state
      const { [worktreePath]: _dropped, ...rest } = state.panes
      void _dropped
      return { ...state, panes: rest }
    }
    case 'terminals/lastActiveChanged': {
      const { worktreePath, ts } = event.payload
      return {
        ...state,
        lastActive: { ...state.lastActive, [worktreePath]: ts }
      }
    }
    case 'terminals/paneRatioChanged': {
      const { worktreePath, splitId, ratio } = event.payload
      const tree = state.panes[worktreePath]
      if (!tree) return state
      const updated = replaceNode(tree, splitId, {
        ...findSplit(tree, splitId)!,
        ratio
      })
      if (updated === tree) return state
      return { ...state, panes: { ...state.panes, [worktreePath]: updated } }
    }
    case 'terminals/sessionIdDiscovered': {
      const { terminalId, sessionId } = event.payload
      const nextPanes: Record<string, PaneNode> = {}
      let changed = false
      for (const [path, tree] of Object.entries(state.panes)) {
        nextPanes[path] = mapLeaves(tree, (leaf) => {
          let tabsChanged = false
          const newTabs = leaf.tabs.map((tab) => {
            if (tab.id !== terminalId || tab.sessionId) return tab
            tabsChanged = true
            changed = true
            return { ...tab, sessionId }
          })
          return tabsChanged ? { ...leaf, tabs: newTabs } : leaf
        })
      }
      return changed ? { ...state, panes: nextPanes } : state
    }
    case 'terminals/controlTaken': {
      const { terminalId, clientId, cols, rows } = event.payload
      const existing = state.sessions[terminalId]
      // When a new client takes control the previous controller (if any)
      // demotes to spectator. If they were already in the spectator list
      // we keep their position; otherwise append.
      const prevController = existing?.controllerClientId
      const prevSpectators = existing?.spectatorClientIds ?? []
      const nextSpectators = prevSpectators.filter((id) => id !== clientId)
      if (prevController && prevController !== clientId && !nextSpectators.includes(prevController)) {
        nextSpectators.push(prevController)
      }
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [terminalId]: {
            controllerClientId: clientId,
            spectatorClientIds: nextSpectators,
            size: { cols, rows }
          }
        }
      }
    }
    case 'terminals/controlReleased': {
      const { terminalId, clientId } = event.payload
      const existing = state.sessions[terminalId]
      if (!existing) return state
      if (existing.controllerClientId === clientId) {
        return {
          ...state,
          sessions: {
            ...state.sessions,
            [terminalId]: { ...existing, controllerClientId: null }
          }
        }
      }
      if (!existing.spectatorClientIds.includes(clientId)) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [terminalId]: {
            ...existing,
            spectatorClientIds: existing.spectatorClientIds.filter((id) => id !== clientId)
          }
        }
      }
    }
    case 'terminals/clientJoined': {
      const { terminalId, clientId } = event.payload
      const existing = state.sessions[terminalId]
      if (!existing) {
        // First-ever join for this terminal: the joiner becomes controller
        // so a lone client can type immediately without a click. Size stays
        // null until pty:resize or takeControl lands a real dimension.
        return {
          ...state,
          sessions: {
            ...state.sessions,
            [terminalId]: {
              controllerClientId: clientId,
              spectatorClientIds: [],
              size: null
            }
          }
        }
      }
      if (
        existing.controllerClientId === clientId ||
        existing.spectatorClientIds.includes(clientId)
      ) {
        return state
      }
      // Someone already has control — this client joins as a spectator. If
      // there's no controller, they're still a spectator; taking control
      // is an explicit click, not an implicit promotion, so Electron doesn't
      // steal control from a web client whose tab just focused elsewhere.
      if (existing.controllerClientId === null) {
        return {
          ...state,
          sessions: {
            ...state.sessions,
            [terminalId]: {
              ...existing,
              controllerClientId: clientId
            }
          }
        }
      }
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [terminalId]: {
            ...existing,
            spectatorClientIds: [...existing.spectatorClientIds, clientId]
          }
        }
      }
    }
    case 'terminals/clientDisconnected': {
      const { clientId } = event.payload
      let changed = false
      const nextSessions: Record<string, TerminalSession> = {}
      for (const [id, session] of Object.entries(state.sessions)) {
        let next = session
        if (session.controllerClientId === clientId) {
          next = { ...next, controllerClientId: null }
          changed = true
        }
        if (next.spectatorClientIds.includes(clientId)) {
          next = {
            ...next,
            spectatorClientIds: next.spectatorClientIds.filter((s) => s !== clientId)
          }
          changed = true
        }
        nextSessions[id] = next
      }
      return changed ? { ...state, sessions: nextSessions } : state
    }
    case 'terminals/tabTypeChanged': {
      const { worktreePath, tabId, newId, newType, newLabel } = event.payload
      const tree = state.panes[worktreePath]
      if (!tree) return state
      let changed = false
      const updated = mapLeaves(tree, (leaf) => {
        if (!leaf.tabs.some((t) => t.id === tabId)) return leaf
        const tabs = leaf.tabs.map((t) => {
          if (t.id !== tabId) return t
          // For json-claude, the convention is tab.id == tab.sessionId.
          // For agent, sessionId stays bound to the on-disk jsonl so
          // --resume picks it up after the swap. Carry it across either
          // way, generating one if the source tab somehow lacked it.
          const sessionId = t.sessionId ?? newId
          changed = true
          if (newType === 'json-claude') {
            return {
              id: newId,
              type: 'json-claude' as const,
              label: newLabel,
              sessionId,
              mode: 'awake' as const
            }
          }
          return {
            id: newId,
            type: 'agent' as const,
            agentKind: 'claude' as const,
            label: newLabel,
            sessionId
          }
        })
        const activeTabId = leaf.activeTabId === tabId ? newId : leaf.activeTabId
        return { ...leaf, tabs, activeTabId }
      })
      if (!changed) return state
      return { ...state, panes: { ...state.panes, [worktreePath]: updated } }
    }
    case 'terminals/tabSlept':
    case 'terminals/tabWoken': {
      const { worktreePath, tabId } = event.payload
      const target: 'awake' | 'asleep' =
        event.type === 'terminals/tabSlept' ? 'asleep' : 'awake'
      const tree = state.panes[worktreePath]
      if (!tree) return state
      let mutated = false
      const updated = mapLeaves(tree, (leaf) => {
        const i = leaf.tabs.findIndex((t) => t.id === tabId)
        if (i === -1) return leaf
        const tab = leaf.tabs[i]
        if (tab.type !== 'json-claude' && tab.type !== 'shell') return leaf
        if ((tab.mode ?? 'awake') === target) return leaf
        const patched: TerminalTab = { ...tab, mode: target }
        const nextTabs = [
          ...leaf.tabs.slice(0, i),
          patched,
          ...leaf.tabs.slice(i + 1)
        ]
        mutated = true
        return { ...leaf, tabs: nextTabs }
      })
      if (!mutated) return state
      return { ...state, panes: { ...state.panes, [worktreePath]: updated } }
    }
    case 'terminals/tabRenamed': {
      const { worktreePath, tabId, label } = event.payload
      const tree = state.panes[worktreePath]
      if (!tree) return state
      const trimmed = label.trim()
      let mutated = false
      const updated = mapLeaves(tree, (leaf) => {
        const i = leaf.tabs.findIndex((t) => t.id === tabId)
        if (i === -1) return leaf
        const tab = leaf.tabs[i]
        const current = tab.customLabel
        if (trimmed === '') {
          if (current === undefined) return leaf
          const { customLabel: _dropped, ...rest } = tab
          void _dropped
          mutated = true
          return {
            ...leaf,
            tabs: [...leaf.tabs.slice(0, i), rest as TerminalTab, ...leaf.tabs.slice(i + 1)]
          }
        }
        if (current === trimmed) return leaf
        mutated = true
        return {
          ...leaf,
          tabs: [
            ...leaf.tabs.slice(0, i),
            { ...tab, customLabel: trimmed },
            ...leaf.tabs.slice(i + 1)
          ]
        }
      })
      if (!mutated) return state
      return { ...state, panes: { ...state.panes, [worktreePath]: updated } }
    }
    case 'terminals/sizeChanged': {
      const { terminalId, cols, rows } = event.payload
      const existing = state.sessions[terminalId]
      if (!existing) {
        return {
          ...state,
          sessions: {
            ...state.sessions,
            [terminalId]: {
              controllerClientId: null,
              spectatorClientIds: [],
              size: { cols, rows }
            }
          }
        }
      }
      if (existing.size && existing.size.cols === cols && existing.size.rows === rows) {
        return state
      }
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [terminalId]: { ...existing, size: { cols, rows } }
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

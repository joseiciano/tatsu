import { describe, it, expect } from 'vitest'
import { resolveSessionRuntime, resolveTabRuntime, ChatRuntimeRegistry } from './index'
import { Store } from '../store'
import type { PaneNode } from '../../shared/state/terminals'

describe('resolveSessionRuntime', () => {
  it('returns legacy when session has no runtime', () => {
    const sessions = {
      s1: { runtime: undefined as 'legacy' | 'acp' | undefined }
    }
    expect(resolveSessionRuntime(sessions, 's1')).toBe('legacy')
  })

  it('returns the session runtime when set', () => {
    const sessions = {
      s1: { runtime: 'acp' as const }
    }
    expect(resolveSessionRuntime(sessions, 's1')).toBe('acp')
  })

  it('falls back to legacy for unknown session', () => {
    expect(resolveSessionRuntime({}, 'missing')).toBe('legacy')
  })
})

describe('resolveTabRuntime', () => {
  it('returns legacy when tab has no runtime and session has no runtime', () => {
    const panes: Record<string, PaneNode> = {
      '/wt': {
        type: 'leaf',
        id: 'p1',
        tabs: [
          {
            id: 'tab1',
            type: 'json-claude',
            label: 'Chat'
          }
        ],
        activeTabId: 'tab1'
      }
    }
    expect(resolveTabRuntime(panes, {}, 'tab1')).toBe('legacy')
  })

  it('returns tab runtime when set on tab', () => {
    const panes: Record<string, PaneNode> = {
      '/wt': {
        type: 'leaf',
        id: 'p1',
        tabs: [
          {
            id: 'tab1',
            type: 'json-claude',
            label: 'Chat',
            runtime: 'acp'
          }
        ],
        activeTabId: 'tab1'
      }
    }
    expect(resolveTabRuntime(panes, {}, 'tab1')).toBe('acp')
  })

  it('prefers session runtime over tab runtime', () => {
    const panes: Record<string, PaneNode> = {
      '/wt': {
        type: 'leaf',
        id: 'p1',
        tabs: [
          {
            id: 'tab1',
            type: 'json-claude',
            label: 'Chat',
            runtime: 'legacy'
          }
        ],
        activeTabId: 'tab1'
      }
    }
    const sessions = {
      tab1: { runtime: 'acp' as const }
    }
    expect(resolveTabRuntime(panes, sessions, 'tab1')).toBe('acp')
  })

  it('falls back to legacy when tab is not found', () => {
    const panes: Record<string, PaneNode> = {}
    expect(resolveTabRuntime(panes, {}, 'tab1')).toBe('legacy')
  })
})

describe('ChatRuntimeRegistry.resolveRuntimeFromSessionOrTab', () => {
  function createStoreWithPanes(
    panes: Record<string, PaneNode>,
    sessions: Record<string, { runtime?: 'legacy' | 'acp' }> = {}
  ): Store {
    const store = new Store()
    for (const [worktreePath, tree] of Object.entries(panes)) {
      store.dispatch({
        type: 'terminals/panesForWorktreeChanged',
        payload: { worktreePath, panes: tree }
      })
    }
    for (const [sessionId, session] of Object.entries(sessions)) {
      store.dispatch({
        type: 'jsonClaude/sessionStarted',
        payload: {
          sessionId,
          worktreePath: '/wt',
          defaultPermissionMode: 'default',
          runtime: session.runtime ?? 'legacy',
          capabilities: {
            canInterrupt: false,
            canRewind: false,
            canSetPermissionMode: false,
            canApproveTools: false,
            canResume: false,
            canOpenAuthLogin: false,
            hasSlashCommands: false,
            hasCostTracking: false
          }
        }
      })
    }
    return store
  }

  it('resolves to acp for a brand-new tab with runtime=acp before session exists', () => {
    const panes: Record<string, PaneNode> = {
      '/wt': {
        type: 'leaf',
        id: 'p1',
        tabs: [
          {
            id: 'tab1',
            type: 'json-claude',
            label: 'Chat',
            runtime: 'acp'
          }
        ],
        activeTabId: 'tab1'
      }
    }
    const store = createStoreWithPanes(panes)
    const registry = new ChatRuntimeRegistry(store)
    expect(registry.resolveRuntimeFromSessionOrTab('tab1')).toBe('acp')
  })

  it('resolves to legacy for a brand-new tab with no runtime before session exists', () => {
    const panes: Record<string, PaneNode> = {
      '/wt': {
        type: 'leaf',
        id: 'p1',
        tabs: [
          {
            id: 'tab1',
            type: 'json-claude',
            label: 'Chat'
          }
        ],
        activeTabId: 'tab1'
      }
    }
    const store = createStoreWithPanes(panes)
    const registry = new ChatRuntimeRegistry(store)
    expect(registry.resolveRuntimeFromSessionOrTab('tab1')).toBe('legacy')
  })

  it('prefers session runtime over tab runtime for resumed sessions', () => {
    const panes: Record<string, PaneNode> = {
      '/wt': {
        type: 'leaf',
        id: 'p1',
        tabs: [
          {
            id: 'tab1',
            type: 'json-claude',
            label: 'Chat',
            runtime: 'legacy'
          }
        ],
        activeTabId: 'tab1'
      }
    }
    const store = createStoreWithPanes(panes, { tab1: { runtime: 'acp' } })
    const registry = new ChatRuntimeRegistry(store)
    expect(registry.resolveRuntimeFromSessionOrTab('tab1')).toBe('acp')
  })

  it('falls back to legacy when neither session nor tab has a runtime', () => {
    const store = createStoreWithPanes({})
    const registry = new ChatRuntimeRegistry(store)
    expect(registry.resolveRuntimeFromSessionOrTab('tab1')).toBe('legacy')
  })
})

describe('ChatRuntimeRegistry.getRuntimeById', () => {
  function createMockRuntime(): import('./types').ChatRuntime {
    return {
      hasSession: () => false,
      start: () => {},
      send: () => {},
      interrupt: () => {},
      kill: () => {},
      killAll: () => {},
      rewindTo: () => ({ ok: false }),
      setPermissionMode: () => {},
      cancelQueued: () => {},
      getCapabilities: () => ({
        canInterrupt: false,
        canRewind: false,
        canSetPermissionMode: false,
        canApproveTools: false,
        canResume: false,
        canOpenAuthLogin: false,
        hasSlashCommands: false,
        hasCostTracking: false
      })
    }
  }

  it('returns the registered runtime for legacy', () => {
    const registry = new ChatRuntimeRegistry(new Store())
    const legacy = createMockRuntime()
    registry.register('legacy', legacy)
    expect(registry.getRuntimeById('legacy')).toBe(legacy)
  })

  it('returns the registered runtime for acp', () => {
    const registry = new ChatRuntimeRegistry(new Store())
    const legacy = createMockRuntime()
    const acp = createMockRuntime()
    registry.register('legacy', legacy)
    registry.register('acp', acp)
    expect(registry.getRuntimeById('acp')).toBe(acp)
  })

  it('falls back to legacy runtime for unknown ids', () => {
    const registry = new ChatRuntimeRegistry(new Store())
    const legacy = createMockRuntime()
    registry.register('legacy', legacy)
    expect(registry.getRuntimeById('unknown-runtime' as 'legacy')).toBe(legacy)
  })
})

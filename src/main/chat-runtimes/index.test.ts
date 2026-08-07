import { describe, it, expect } from 'vitest'
import { ChatRuntimeRegistry } from './index'
import { Store } from '../store'

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

/** Seed a jsonClaude session of the given agent kind into the store. */
function seedSession(store: Store, sessionId: string, agentKind: 'claude' | 'opencode' | 'codex'): void {
  store.dispatch({
    type: 'jsonClaude/sessionStarted',
    payload: {
      sessionId,
      worktreePath: '/wt',
      agentKind,
      runtimeId: agentKind
    }
  })
}

describe('ChatRuntimeRegistry.getRuntimeById', () => {
  it('returns the registered runtime for claude', () => {
    const registry = new ChatRuntimeRegistry(new Store())
    const claude = createMockRuntime()
    registry.register('claude', claude)
    expect(registry.getRuntimeById('claude')).toBe(claude)
  })

  it('throws a clear error for an unregistered agent kind', () => {
    const registry = new ChatRuntimeRegistry(new Store())
    expect(() => registry.getRuntimeById('claude')).toThrow(/not registered/)
    expect(() => registry.getRuntimeById('codex')).toThrow(/not registered/)
  })
})

describe('ChatRuntimeRegistry.getRuntime (per-session routing)', () => {
  it('routes to the claude runtime when the session has agentKind claude', () => {
    const store = new Store()
    seedSession(store, 's1', 'claude')
    const registry = new ChatRuntimeRegistry(store)
    const claude = createMockRuntime()
    registry.register('claude', claude)
    expect(registry.getRuntime('s1')).toBe(claude)
  })

  it('throws a clear error for an unknown session', () => {
    const registry = new ChatRuntimeRegistry(new Store())
    expect(() => registry.getRuntime('no-such-session')).toThrow(/unknown session/)
  })

  it('throws a clear error when the session kind has no registered runtime', () => {
    const store = new Store()
    seedSession(store, 's-codex', 'codex')
    const registry = new ChatRuntimeRegistry(store)
    registry.register('claude', createMockRuntime())
    expect(() => registry.getRuntime('s-codex')).toThrow(/not registered/)
  })

  it('routes each bundled agent kind to its own registered runtime', () => {
    const store = new Store()
    seedSession(store, 'c', 'claude')
    seedSession(store, 'o', 'opencode')
    seedSession(store, 'x', 'codex')
    const registry = new ChatRuntimeRegistry(store)
    const claude = createMockRuntime()
    const opencode = createMockRuntime()
    const codex = createMockRuntime()
    registry.register('claude', claude)
    registry.register('opencode', opencode)
    registry.register('codex', codex)
    expect(registry.getRuntime('c')).toBe(claude)
    expect(registry.getRuntime('o')).toBe(opencode)
    expect(registry.getRuntime('x')).toBe(codex)
  })
})

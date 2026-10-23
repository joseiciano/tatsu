import { describe, it, expect } from 'vitest'
import { ChatRuntimeRegistry } from './index'
import { Store } from '../store'
import type { ApprovalDecision, ChatRuntime } from './types'

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

describe('ChatRuntimeRegistry.resolveApproval', () => {
  function seedApproval(store: Store, requestId: string, sessionId: string): void {
    store.dispatch({
      type: 'jsonClaude/approvalRequested',
      payload: { requestId, sessionId, toolName: 'bash', input: {}, timestamp: 0 }
    })
  }

  function recordingRuntime(answer: boolean) {
    const calls: Array<{ requestId: string; decision: ApprovalDecision }> = []
    const runtime: ChatRuntime = {
      ...createMockRuntime(),
      resolveApproval: (requestId, decision) => {
        calls.push({ requestId, decision })
        return answer
      }
    }
    return { runtime, calls }
  }

  it("routes the answer to the runtime of the pending approval's session", () => {
    const store = new Store()
    seedSession(store, 'c', 'claude')
    seedSession(store, 'o', 'opencode')
    seedApproval(store, 'o-perm-1', 'o')
    const registry = new ChatRuntimeRegistry(store)
    const claude = recordingRuntime(true)
    const opencode = recordingRuntime(true)
    registry.register('claude', claude.runtime)
    registry.register('opencode', opencode.runtime)

    expect(registry.resolveApproval('o-perm-1', { behavior: 'deny', interrupt: true })).toBe(true)
    expect(opencode.calls).toEqual([
      { requestId: 'o-perm-1', decision: { behavior: 'deny', interrupt: true } }
    ])
    expect(claude.calls).toEqual([])
  })

  it("returns the runtime's answer when it does not recognize the request", () => {
    const store = new Store()
    seedSession(store, 'o', 'opencode')
    seedApproval(store, 'o-perm-1', 'o')
    const registry = new ChatRuntimeRegistry(store)
    registry.register('opencode', recordingRuntime(false).runtime)

    expect(registry.resolveApproval('o-perm-1', { behavior: 'allow' })).toBe(false)
  })

  it('returns false without touching any runtime for an unknown request id', () => {
    const store = new Store()
    seedSession(store, 'o', 'opencode')
    const registry = new ChatRuntimeRegistry(store)
    const opencode = recordingRuntime(true)
    registry.register('opencode', opencode.runtime)

    expect(registry.resolveApproval('nope', { behavior: 'allow' })).toBe(false)
    expect(opencode.calls).toEqual([])
  })

  it('returns false when the owning runtime has no resolveApproval', () => {
    const store = new Store()
    seedSession(store, 'c', 'claude')
    seedApproval(store, 'c-perm-1', 'c')
    const registry = new ChatRuntimeRegistry(store)
    registry.register('claude', createMockRuntime())

    expect(registry.resolveApproval('c-perm-1', { behavior: 'allow' })).toBe(false)
  })
})

describe('ChatRuntimeRegistry.authenticate', () => {
  it("routes the login to the runtime of the session's agent kind and returns its result", async () => {
    const store = new Store()
    seedSession(store, 'c', 'claude')
    seedSession(store, 'x', 'codex')
    const registry = new ChatRuntimeRegistry(store)
    const calls: Array<{ runtime: string; sessionId: string; methodId: string }> = []
    const recording = (name: string, result: { ok: boolean; error?: string }): ChatRuntime => ({
      ...createMockRuntime(),
      authenticate: async (sessionId, methodId) => {
        calls.push({ runtime: name, sessionId, methodId })
        return result
      }
    })
    registry.register('claude', recording('claude', { ok: true }))
    registry.register('codex', recording('codex', { ok: false, error: 'denied' }))

    await expect(registry.authenticate('x', 'api-key')).resolves.toEqual({ ok: false, error: 'denied' })
    expect(calls).toEqual([{ runtime: 'codex', sessionId: 'x', methodId: 'api-key' }])
  })

  it('returns ok false with a message when the runtime has no in-app login', async () => {
    const store = new Store()
    seedSession(store, 'c', 'claude')
    const registry = new ChatRuntimeRegistry(store)
    registry.register('claude', createMockRuntime())

    await expect(registry.authenticate('c', 'chat-gpt')).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/\S/)
    })
  })
})

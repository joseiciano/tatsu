import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Store } from './store'
import { ChatProviderManager } from './chat-provider'

const mockAdapter = {
  sessionId: 'sess-1',
  provider: 'opencode' as const,
  start: vi.fn(),
  send: vi.fn(),
  cancelQueued: vi.fn(),
  interrupt: vi.fn(),
  kill: vi.fn(),
  killAll: vi.fn(),
  rewindTo: vi.fn(),
  setPermissionMode: vi.fn(),
  seedFromTranscript: vi.fn(),
  resolveApproval: vi.fn(),
  rerunAutoApprovalReview: vi.fn()
}

describe('ChatProviderManager', () => {
  let store: Store
  let manager: ChatProviderManager

  beforeEach(() => {
    store = new Store()
    manager = new ChatProviderManager(store)
    vi.clearAllMocks()
  })

  it('dispatches sessionStarted when start is called before registerAdapter', () => {
    // This is the real startup path: start() is called first (no adapter yet),
    // then registerAdapter(), then adapter.start().
    manager.start('sess-1', '/wt/test', 'opencode')

    const snapshot = store.getSnapshot()
    const session = snapshot.state.jsonClaude.sessions['sess-1']
    expect(session).toBeDefined()
    expect(session.provider).toBe('opencode')
    expect(session.state).toBe('connecting')
    expect(session.capabilities?.supportsPermissionMode).toBe(false)
  })

  it('is idempotent when adapter already exists', () => {
    manager.start('sess-1', '/wt/test', 'opencode')
    const snapshot1 = store.getSnapshot()

    manager.registerAdapter(mockAdapter as any)
    // Second start should be a no-op since adapter is registered
    manager.start('sess-1', '/wt/test', 'opencode')
    const snapshot2 = store.getSnapshot()

    expect(snapshot2.state.jsonClaude.sessions['sess-1']).toEqual(snapshot1.state.jsonClaude.sessions['sess-1'])
  })

  it('dispatches claude capabilities for claude provider', () => {
    manager.start('sess-1', '/wt/test', 'claude')

    const snapshot = store.getSnapshot()
    const session = snapshot.state.jsonClaude.sessions['sess-1']
    expect(session.capabilities?.supportsPermissionMode).toBe(true)
    expect(session.capabilities?.supportsRewind).toBe(true)
  })
})

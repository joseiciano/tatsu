import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Store } from './store'
import { OpencodeChatAdapter } from './opencode-chat-adapter'
import type { AcpEventHandler } from './opencode-acp-client'

const mockSendRequest = vi.fn()
const mockSendNotification = vi.fn()
const mockSendResponse = vi.fn()
const mockOnEvent = vi.fn()
const mockKill = vi.fn()
const mockStart = vi.fn()

vi.mock('./opencode-acp-client', () => ({
  AcpClient: vi.fn(function () {
    return {
      start: mockStart,
      onEvent: mockOnEvent,
      sendRequest: mockSendRequest,
      sendNotification: mockSendNotification,
      sendResponse: mockSendResponse,
      kill: mockKill
    }
  })
}))

vi.mock('./debug', () => ({
  log: vi.fn()
}))

describe('OpencodeChatAdapter', () => {
  let store: Store
  let adapter: OpencodeChatAdapter
  let eventHandler: AcpEventHandler | null = null

  beforeEach(() => {
    store = new Store()
    mockSendRequest.mockReset()
    mockSendNotification.mockReset()
    mockSendResponse.mockReset()
    mockKill.mockReset()
    mockStart.mockReset()
    mockOnEvent.mockReset()
    mockOnEvent.mockImplementation((handler: AcpEventHandler) => {
      eventHandler = handler
    })
    adapter = new OpencodeChatAdapter('sess-1', '/wt/test', store, () => 'opencode')
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  function seedSession(provider: string = 'opencode') {
    store.dispatch({
      type: 'jsonClaude/sessionStarted',
      payload: { sessionId: 'sess-1', worktreePath: '/wt/test', provider: provider as any }
    })
  }

  function setupPanes(providerSessionId?: string) {
    store.dispatch({
      type: 'terminals/panesForWorktreeChanged',
      payload: {
        worktreePath: '/wt/test',
        panes: {
          type: 'leaf',
          id: 'p1',
          tabs: [
            {
              id: 'sess-1',
              type: 'json-claude',
              label: 'Chat',
              sessionId: 'sess-1',
              provider: 'opencode',
              providerSessionId
            }
          ],
          activeTabId: 'sess-1'
        }
      }
    })
  }

  describe('start', () => {
    it('sends initialize then session/new for a fresh tab', async () => {
      mockSendRequest.mockResolvedValueOnce({
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: true } }
      })
      mockSendRequest.mockResolvedValueOnce({ sessionId: 'prov-123' })

      await adapter.start('/wt/test')

      expect(mockStart).toHaveBeenCalled()
      expect(mockSendRequest).toHaveBeenNthCalledWith(1, 'initialize', expect.any(Object))
      expect(mockSendRequest).toHaveBeenNthCalledWith(2, 'session/new', expect.any(Object))
    })

    it('uses session/load when providerSessionId exists and loadSession is supported', async () => {
      setupPanes('prov-existing')
      mockSendRequest.mockResolvedValueOnce({
        agentCapabilities: { loadSession: true }
      })
      mockSendRequest.mockResolvedValueOnce(undefined)

      await adapter.start('/wt/test')

      expect(mockSendRequest).toHaveBeenNthCalledWith(2, 'session/load', {
        sessionId: 'prov-existing',
        cwd: '/wt/test',
        mcpServers: []
      })
    })

    it('uses session/resume when providerSessionId exists but loadSession is not supported', async () => {
      setupPanes('prov-existing')
      mockSendRequest.mockResolvedValueOnce({
        agentCapabilities: { sessionCapabilities: { resume: true } }
      })
      mockSendRequest.mockResolvedValueOnce(undefined)

      await adapter.start('/wt/test')

      expect(mockSendRequest).toHaveBeenNthCalledWith(2, 'session/resume', {
        sessionId: 'prov-existing',
        cwd: '/wt/test',
        mcpServers: []
      })
    })

    it('dispatches error when initialize fails', async () => {
      seedSession()
      mockSendRequest.mockResolvedValueOnce(undefined)

      await adapter.start('/wt/test')

      const snapshot = store.getSnapshot()
      const entries = snapshot.state.jsonClaude.sessions['sess-1']?.entries ?? []
      expect(entries.some((e) => e.kind === 'error')).toBe(true)
    })
  })

  describe('send', () => {
    it('sends session/prompt with text content', async () => {
      mockSendRequest.mockResolvedValueOnce({
        agentCapabilities: {}
      })
      mockSendRequest.mockResolvedValueOnce({ sessionId: 'prov-123' })
      mockSendRequest.mockResolvedValueOnce({ stopReason: 'end_turn' })
      await adapter.start('/wt/test')

      adapter.send('hello')
      expect(mockSendRequest).toHaveBeenLastCalledWith('session/prompt', {
        sessionId: 'prov-123',
        prompt: [{ type: 'text', text: 'hello' }]
      })
    })

    it('ignores send before initialization', () => {
      adapter.send('hello')
      expect(mockSendRequest).not.toHaveBeenCalledWith('session/prompt', expect.anything())
    })

    it('appends user entry optimistically and clears busy on prompt result', async () => {
      seedSession()
      let promptResolve: (value: unknown) => void = () => {}
      mockSendRequest.mockImplementation((method: string) => {
        if (method === 'initialize') return Promise.resolve({ agentCapabilities: {} })
        if (method === 'session/new') return Promise.resolve({ sessionId: 'prov-123' })
        if (method === 'session/prompt') return new Promise((resolve) => { promptResolve = resolve })
        return Promise.resolve(undefined)
      })
      await adapter.start('/wt/test')

      adapter.send('hello')

      const snapshot1 = store.getSnapshot()
      const entries1 = snapshot1.state.jsonClaude.sessions['sess-1']?.entries ?? []
      expect(entries1.some((e) => e.kind === 'user' && e.text === 'hello')).toBe(true)
      expect(snapshot1.state.jsonClaude.sessions['sess-1']?.busy).toBe(true)

      promptResolve({ stopReason: 'end_turn' })
      await new Promise((r) => setTimeout(r, 10))

      const snapshot2 = store.getSnapshot()
      expect(snapshot2.state.jsonClaude.sessions['sess-1']?.busy).toBe(false)
    })
  })

  describe('interrupt', () => {
    it('sends session/cancel notification', async () => {
      mockSendRequest.mockResolvedValueOnce({ agentCapabilities: {} })
      mockSendRequest.mockResolvedValueOnce({ sessionId: 'prov-123' })
      await adapter.start('/wt/test')

      adapter.interrupt()
      expect(mockSendNotification).toHaveBeenCalledWith('session/cancel', {
        sessionId: 'prov-123'
      })
    })
  })

  describe('kill', () => {
    it('kills the client and dispatches exited state', async () => {
      seedSession()
      mockSendRequest.mockResolvedValueOnce({ agentCapabilities: {} })
      mockSendRequest.mockResolvedValueOnce({ sessionId: 'prov-123' })
      await adapter.start('/wt/test')

      adapter.kill()
      expect(mockKill).toHaveBeenCalled()
      const snapshot = store.getSnapshot()
      expect(snapshot.state.jsonClaude.sessions['sess-1']?.state).toBe('exited')
    })
  })

  describe('ACP event handling', () => {
    beforeEach(() => {
      seedSession()
    })

    it('first agent_message_chunk creates a partial entry automatically', async () => {
      mockSendRequest.mockResolvedValueOnce({ agentCapabilities: {} })
      mockSendRequest.mockResolvedValueOnce({ sessionId: 'prov-123' })
      await adapter.start('/wt/test')

      eventHandler?.({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { text: 'hello' }
          }
        }
      })

      // Wait for flush timer
      await new Promise((r) => setTimeout(r, 50))

      const snapshot = store.getSnapshot()
      const entries = snapshot.state.jsonClaude.sessions['sess-1']?.entries ?? []
      const partialEntry = entries.find((e) => e.kind === 'assistant' && e.isPartial)
      expect(partialEntry).toBeDefined()
      expect(partialEntry?.blocks?.[0]?.text).toBe('hello')
    })

    it('handles permission request and dispatches approvalRequested', async () => {
      mockSendRequest.mockResolvedValueOnce({ agentCapabilities: {} })
      mockSendRequest.mockResolvedValueOnce({ sessionId: 'prov-123' })
      await adapter.start('/wt/test')

      eventHandler?.({
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'session/request_permission',
        params: {
          sessionId: 'prov-123',
          toolCall: { toolCallId: 'tc-1', title: 'Bash', kind: 'bash', status: 'pending' },
          options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'action' }]
        }
      })

      const snapshot = store.getSnapshot()
      const approvals = Object.values(snapshot.state.jsonClaude.pendingApprovals)
      expect(approvals.length).toBe(1)
      expect(approvals[0].toolName).toBe('Bash')
    })

    it('handles session/exit and sets state to exited', async () => {
      mockSendRequest.mockResolvedValueOnce({ agentCapabilities: {} })
      mockSendRequest.mockResolvedValueOnce({ sessionId: 'prov-123' })
      await adapter.start('/wt/test')

      eventHandler?.({
        jsonrpc: '2.0',
        method: 'session/exit',
        params: { code: 1, signal: null }
      })

      const snapshot = store.getSnapshot()
      expect(snapshot.state.jsonClaude.sessions['sess-1']?.state).toBe('exited')
    })

    it('reads availableCommands from available_commands_update and strips leading slash', async () => {
      mockSendRequest.mockResolvedValueOnce({ agentCapabilities: {} })
      mockSendRequest.mockResolvedValueOnce({ sessionId: 'prov-123' })
      await adapter.start('/wt/test')

      eventHandler?.({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: ['/compact', '/clear']
          }
        }
      })

      const snapshot = store.getSnapshot()
      const commands = snapshot.state.jsonClaude.sessions['sess-1']?.slashCommands ?? []
      expect(commands).toEqual(['compact', 'clear'])
    })
  })

  describe('resolveApproval', () => {
    beforeEach(() => {
      seedSession()
    })

    it('sends response on original inbound request id for allow', async () => {
      mockSendRequest.mockResolvedValueOnce({ agentCapabilities: {} })
      mockSendRequest.mockResolvedValueOnce({ sessionId: 'prov-123' })
      await adapter.start('/wt/test')

      // Trigger permission request
      eventHandler?.({
        jsonrpc: '2.0',
        id: 'acp-req-1',
        method: 'session/request_permission',
        params: {
          sessionId: 'prov-123',
          toolCall: { toolCallId: 'tc-1', title: 'Bash', kind: 'bash', status: 'pending' },
          options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'action' }]
        }
      })

      const snapshot = store.getSnapshot()
      const approval = Object.values(snapshot.state.jsonClaude.pendingApprovals)[0]
      expect(approval).toBeDefined()
      const result = adapter.resolveApproval(approval.requestId, { behavior: 'allow' })
      expect(result).toBe(true)
      expect(mockSendResponse).toHaveBeenCalledWith('acp-req-1', {
        outcome: { outcome: 'selected', optionId: 'allow-once' }
      })
      expect(mockSendRequest).not.toHaveBeenCalledWith('session/request_permission', expect.anything())
    })

    it('returns false for unknown requestId', () => {
      const result = adapter.resolveApproval('unknown', { behavior: 'allow' })
      expect(result).toBe(false)
    })
  })

  describe('rewindTo', () => {
    it('returns not supported', () => {
      expect(adapter.rewindTo('entry-1')).toEqual({
        ok: false,
        reason: 'rewind not supported for opencode'
      })
    })
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ClaudeAcpRuntime, resolveClaudeAgentSdkExecutablePath } from './claude-acp'
import { Store } from '../store'
import type { JsonClaudeEvent } from '../../shared/state/json-claude'
import type { StateEvent } from '../../shared/state'


// Mock the SDK before importing the runtime.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn()
}))

import { query } from '@anthropic-ai/claude-agent-sdk'

function createMockQuery(): any {
  const messages: any[] = []
  const streamInputMessages: any[] = []
  let closed = false
  let interrupted = false
  let pendingResolve: ((value: IteratorResult<any>) => void) | null = null

  const q: any = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        if (messages.length > 0) {
          return { done: false, value: messages.shift() }
        }
        if (closed) {
          return { done: true, value: undefined }
        }
        return new Promise<IteratorResult<any>>((resolve) => {
          pendingResolve = resolve
        })
      },
      return: async () => {
        closed = true
        if (pendingResolve) {
          pendingResolve({ done: true, value: undefined })
          pendingResolve = null
        }
        return { done: true, value: undefined }
      }
    }),
    streamInput: vi.fn(async (stream: AsyncIterable<any>) => {
      for await (const msg of stream) {
        streamInputMessages.push(msg)
        messages.push({ type: 'user', message: msg.message, parent_tool_use_id: null })
      }
    }),
    interrupt: vi.fn(async () => {
      interrupted = true
      closed = true
      if (pendingResolve) {
        pendingResolve({ done: true, value: undefined })
        pendingResolve = null
      }
    }),
    close: vi.fn(() => {
      closed = true
      if (pendingResolve) {
        pendingResolve({ done: true, value: undefined })
        pendingResolve = null
      }
    }),
    isClosed: () => closed,
    _pushMessage: (msg: any) => {
      messages.push(msg)
      if (pendingResolve) {
        pendingResolve({ done: false, value: messages.shift() })
        pendingResolve = null
      }
    },
    _wasInterrupted: () => interrupted,
    _getStreamInputMessages: () => streamInputMessages
  }

  q._consumePrompt = async (prompt: unknown) => {
    if (!prompt || typeof prompt === 'string') return
    for await (const msg of prompt as AsyncIterable<any>) {
      streamInputMessages.push(msg)
      messages.push({ type: 'user', message: msg.message, parent_tool_use_id: null })
      if (pendingResolve) {
        pendingResolve({ done: false, value: messages.shift() })
        pendingResolve = null
      }
    }
  }

  return q
}

function createStore(): Store & { events: StateEvent[] } {
  const store = new Store()
  const events: StateEvent[] = []
  store.subscribe((event) => events.push(event))
  return Object.assign(store, { events })
}

describe('resolveClaudeAgentSdkExecutablePath', () => {
  it('rewrites packaged app.asar paths to app.asar.unpacked', () => {
    const path = resolveClaudeAgentSdkExecutablePath({
      platform: 'darwin',
      arch: 'arm64',
      resolveFromSdk: () => '/Applications/Harness.app/Contents/Resources/app.asar/node_modules/pkg/package.json'
    })

    expect(path).toBe('/Applications/Harness.app/Contents/Resources/app.asar.unpacked/node_modules/pkg/claude')
  })
})

describe('ClaudeAcpRuntime', () => {
  let runtime: ClaudeAcpRuntime
  let store: ReturnType<typeof createStore>
  let mockQuery: ReturnType<typeof createMockQuery>

  beforeEach(() => {
    store = createStore()
    runtime = new ClaudeAcpRuntime(store)
    mockQuery = createMockQuery()
    vi.mocked(query).mockImplementation((args: any) => {
      void mockQuery._consumePrompt(args?.prompt)
      return mockQuery
    })
    vi.mocked(query).mockClear()
    store.events.length = 0
  })

  describe('hasSession', () => {
    it('returns false before start', () => {
      expect(runtime.hasSession('s1')).toBe(false)
    })

    it('returns true after start but before first send', () => {
      runtime.start('s1', '/wt')
      expect(runtime.hasSession('s1')).toBe(true)
    })

    it('returns true after first send creates the query', async () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'hello')
      expect(runtime.hasSession('s1')).toBe(true)
    })
  })

  describe('start', () => {
    it('does not dispatch sessionStarted (caller already does)', () => {
      runtime.start('s1', '/wt', { permissionMode: 'plan' })
      const ev = store.events.find((e) => e.type === 'jsonClaude/sessionStarted')
      expect(ev).toBeUndefined()
    })

    it('moves session to idle so it does not stay stuck in connecting', () => {
      runtime.start('s1', '/wt')
      const ev = store.events.find((e) => e.type === 'jsonClaude/sessionStateChanged')
      expect(ev).toBeDefined()
      expect((ev as any).payload.state).toBe('idle')
    })
  })

  describe('send', () => {
    it('creates a query on first send and appends user entry', () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'hello')

      expect(query).toHaveBeenCalledTimes(1)
      const userEntries = store.events.filter(
        (e) => e.type === 'jsonClaude/entryAppended' && (e as any).payload.entry.kind === 'user'
      )
      expect(userEntries.length).toBe(1)
      expect((userEntries[0] as any).payload.entry.text).toBe('hello')
    })

    it('warns and uses started worktree path when store session state is absent', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      runtime.start('s1', '/wt')
      runtime.send('s1', 'hello')

      expect(warn).toHaveBeenCalledWith(
        '[json-claude] missing sessionStarted state for s1; falling back to runtime start worktree path'
      )
      expect(query).toHaveBeenCalledTimes(1)
      expect((query as any).mock.calls[0][0].options.cwd).toBe('/wt')

      warn.mockRestore()
    })

    it('queues subsequent sends while busy and streams them when the turn finishes', async () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'first')
      runtime.send('s1', 'second')

      // While busy, queued input is buffered in runtime state until the turn finishes.
      expect(mockQuery._getStreamInputMessages()).toHaveLength(0)
      const userEntries = store.events.filter(
        (e) => e.type === 'jsonClaude/entryAppended' && (e as any).payload.entry.kind === 'user'
      )
      expect(userEntries.length).toBe(2)
      expect((userEntries[1] as any).payload.entry.isQueued).toBe(true)

      // Finish the turn — queued message should reach the prompt queue.
      mockQuery._pushMessage({
        type: 'result',
        subtype: 'success',
        is_error: false
      })
      mockQuery.close()

      await new Promise((r) => setTimeout(r, 50))

      expect(mockQuery._getStreamInputMessages()).toHaveLength(2)
      const unqueued = store.events.filter((e) => e.type === 'jsonClaude/userEntriesUnqueued')
      expect(unqueued.length).toBe(1)
    })

    it('sets busy to true on first send', () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'hello')
      const ev = store.events.find((e) => e.type === 'jsonClaude/busyChanged')
      expect((ev as any).payload.busy).toBe(true)
    })

    it('moves session to running after first send starts the query', () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'hello')

      const stateEvents = store.events.filter((e) => e.type === 'jsonClaude/sessionStateChanged')
      const lastState = stateEvents[stateEvents.length - 1]
      expect((lastState as any).payload.state).toBe('running')
    })

    it('sets busy to true on subsequent send when session is not busy', async () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'first')

      // Finish the turn without closing the iterator yet.
      mockQuery._pushMessage({
        type: 'result',
        subtype: 'success',
        is_error: false
      })

      // Yield to the microtask queue so the result message is processed
      // and session.busy becomes false before the second send.
      await new Promise((r) => setTimeout(r, 0))

      // At this point the session exists and is not busy.
      store.events.length = 0
      runtime.send('s1', 'second')

      const busyEvents = store.events.filter((e) => e.type === 'jsonClaude/busyChanged')
      expect(busyEvents.length).toBe(1)
      expect((busyEvents[0] as any).payload.busy).toBe(true)


      const stateEvents = store.events.filter((e) => e.type === 'jsonClaude/sessionStateChanged')
      const lastState = stateEvents[stateEvents.length - 1]
      expect((lastState as any).payload.state).toBe('running')

      mockQuery.close()
      await new Promise((r) => setTimeout(r, 50))
    })
  })

  describe('queue', () => {
    it('retains base64 data in pendingSends when image has a disk path', () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'first')

      const image = { mediaType: 'image/png', data: 'base64data', path: '/tmp/img.png' }
      runtime.send('s1', 'second', [image])

      const pending = (runtime as any).pendingSends.get('s1')
      expect(pending.length).toBe(1)
      expect(pending[0].images[0].path).toBe('/tmp/img.png')
      expect(pending[0].images[0].mediaType).toBe('image/png')
      expect(pending[0].images[0].data).toBe('base64data')
    })

    it('retains base64 data in pendingSends when image has no disk path', () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'first')

      const image = { mediaType: 'image/png', data: 'base64data', path: '' }
      runtime.send('s1', 'second', [image])

      const pending = (runtime as any).pendingSends.get('s1')
      expect(pending.length).toBe(1)
      expect(pending[0].images[0].data).toBe('base64data')
    })

    it('appends isQueued user entry when sending while busy', () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'first')
      runtime.send('s1', 'second')

      const userEntries = store.events.filter(
        (e) => e.type === 'jsonClaude/entryAppended' && (e as any).payload.entry.kind === 'user'
      )
      expect(userEntries.length).toBe(2)
      expect((userEntries[0] as any).payload.entry.isQueued).toBeUndefined()
      expect((userEntries[1] as any).payload.entry.isQueued).toBe(true)
    })

    it('sends multiple queued messages one at a time', async () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'first')
      runtime.send('s1', 'second')
      runtime.send('s1', 'third')

      expect(mockQuery._getStreamInputMessages()).toHaveLength(0)

      // Finish first turn — second should be sent.
      mockQuery._pushMessage({
        type: 'result',
        subtype: 'success',
        is_error: false
      })
      mockQuery.close()

      await new Promise((r) => setTimeout(r, 50))

      expect(mockQuery._getStreamInputMessages()).toHaveLength(2)
    })

    it('clears queued messages on kill', () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'first')
      runtime.send('s1', 'second')

      runtime.kill('s1')

      const userEntries = store.events.filter(
        (e) => e.type === 'jsonClaude/entryAppended' && (e as any).payload.entry.kind === 'user'
      )
      expect(userEntries.length).toBe(2)
      expect(mockQuery._getStreamInputMessages()).toHaveLength(0)
    })

    it('uses original base64 data when dequeuing queued images without reading disk', async () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'first')

      const image = { mediaType: 'image/png', data: 'original-base64', path: '/tmp/img.png' }
      runtime.send('s1', 'second', [image])

      // Finish first turn — queued message should reach the prompt queue with original base64.
      mockQuery._pushMessage({
        type: 'result',
        subtype: 'success',
        is_error: false
      })
      mockQuery.close()

      await new Promise((r) => setTimeout(r, 50))

      const messages = mockQuery._getStreamInputMessages()

      expect(messages.length).toBe(2)
      const content = messages[1].message.content
      expect(content[0].type).toBe('image')
      expect(content[0].source.data).toBe('original-base64')
    })
  })

  describe('streaming assistant output', () => {
    it('appends assistant entry on message_start and finalizes on message_stop', async () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'hello')

      mockQuery._pushMessage({
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'msg-1' } }
      })
      mockQuery._pushMessage({
        type: 'stream_event',
        event: { type: 'message_stop' }
      })
      mockQuery.close()

      // Wait for iteration to process.
      await new Promise((r) => setTimeout(r, 50))

      const appended = store.events.filter(
        (e) => e.type === 'jsonClaude/entryAppended' && (e as any).payload.entry.kind === 'assistant'
      )
      expect(appended.length).toBe(1)
      expect((appended[0] as any).payload.entry.isPartial).toBe(true)

      const finalized = store.events.filter((e) => e.type === 'jsonClaude/assistantEntryFinalized')
      expect(finalized.length).toBe(1)
    })

    it('does not append a duplicate assistant row when the complete message follows partials', async () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'hello')

      mockQuery._pushMessage({
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'msg-1' } }
      })
      mockQuery._pushMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'partial' }
        }
      })
      mockQuery._pushMessage({
        type: 'stream_event',
        event: { type: 'message_stop' }
      })
      mockQuery._pushMessage({
        type: 'assistant',
        message: {
          id: 'msg-1',
          content: [{ type: 'text', text: 'final' }]
        }
      })
      mockQuery.close()

      await new Promise((r) => setTimeout(r, 50))

      const appended = store.events.filter(
        (e) => e.type === 'jsonClaude/entryAppended' && (e as any).payload.entry.kind === 'assistant'
      )
      expect(appended.length).toBe(1)

      const finalized = store.events.filter((e) => e.type === 'jsonClaude/assistantEntryFinalized')
      expect(finalized.length).toBe(1)
      expect((finalized[0] as any).payload.blocks).toEqual([{ type: 'text', text: 'final' }])
    })

    it('dispatches text deltas', async () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'hello')

      mockQuery._pushMessage({
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'msg-1' } }
      })
      mockQuery._pushMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'world' }
        }
      })
      mockQuery._pushMessage({
        type: 'stream_event',
        event: { type: 'message_stop' }
      })
      mockQuery.close()

      await new Promise((r) => setTimeout(r, 50))

      const deltas = store.events.filter((e) => e.type === 'jsonClaude/assistantTextDelta')
      expect(deltas.length).toBe(1)
      expect((deltas[0] as any).payload.textDelta).toBe('world')
    })

    it('dispatches thinking deltas', async () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'hello')

      mockQuery._pushMessage({
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'msg-1' } }
      })
      mockQuery._pushMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: 'hmm' }
        }
      })
      mockQuery.close()

      await new Promise((r) => setTimeout(r, 50))

      const deltas = store.events.filter((e) => e.type === 'jsonClaude/assistantThinkingDelta')
      expect(deltas.length).toBe(1)
      expect((deltas[0] as any).payload.textDelta).toBe('hmm')
    })

    it('batches multiple text deltas into a single dispatch', async () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'hello')

      mockQuery._pushMessage({
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'msg-1' } }
      })
      mockQuery._pushMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'a' }
        }
      })
      mockQuery._pushMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'b' }
        }
      })
      mockQuery._pushMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'c' }
        }
      })

      // Before the flush timer fires, no deltas should be dispatched.
      await new Promise((r) => setTimeout(r, 10))
      let deltas = store.events.filter((e) => e.type === 'jsonClaude/assistantTextDelta')
      expect(deltas.length).toBe(0)

      // After the flush timer fires, all deltas should be coalesced.
      await new Promise((r) => setTimeout(r, 50))
      deltas = store.events.filter((e) => e.type === 'jsonClaude/assistantTextDelta')
      expect(deltas.length).toBe(1)
      expect((deltas[0] as any).payload.textDelta).toBe('abc')

      mockQuery.close()
      await new Promise((r) => setTimeout(r, 50))
    })

    it('flushes pending deltas immediately on message_stop', async () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'hello')

      mockQuery._pushMessage({
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'msg-1' } }
      })
      mockQuery._pushMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'world' }
        }
      })
      mockQuery._pushMessage({
        type: 'stream_event',
        event: { type: 'message_stop' }
      })
      mockQuery.close()

      await new Promise((r) => setTimeout(r, 10))

      const deltas = store.events.filter((e) => e.type === 'jsonClaude/assistantTextDelta')
      expect(deltas.length).toBe(1)
      expect((deltas[0] as any).payload.textDelta).toBe('world')
    })
  })

  describe('result handling', () => {
    it('sets busy to false on result', async () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'hello')

      mockQuery._pushMessage({
        type: 'result',
        subtype: 'success',
        is_error: false
      })
      mockQuery.close()

      await new Promise((r) => setTimeout(r, 50))

      const busyEvents = store.events.filter((e) => e.type === 'jsonClaude/busyChanged')
      const lastBusy = busyEvents[busyEvents.length - 1]
      expect((lastBusy as any).payload.busy).toBe(false)
    })

    it('emits error entry on error result', async () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'hello')

      mockQuery._pushMessage({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['something broke']
      })
      mockQuery.close()

      await new Promise((r) => setTimeout(r, 50))

      const errors = store.events.filter(
        (e) => e.type === 'jsonClaude/entryAppended' && (e as any).payload.entry.kind === 'error'
      )
      expect(errors.length).toBe(1)
      expect((errors[0] as any).payload.entry.errorMessage).toContain('something broke')
    })


    it('does not emit busy false then true when dequeuing queued messages after result', async () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'first')
      runtime.send('s1', 'second')

      store.events.length = 0
      mockQuery._pushMessage({
        type: 'result',
        subtype: 'success',
        is_error: false
      })

      await new Promise((r) => setTimeout(r, 0))

      const busyEvents = store.events.filter((e) => e.type === 'jsonClaude/busyChanged')
      expect(busyEvents.length).toBe(0)
      const unqueued = store.events.filter((e) => e.type === 'jsonClaude/userEntriesUnqueued')
      expect(unqueued.length).toBe(1)
    })
  })

  describe('system messages', () => {
    it('dispatches slashCommandsChanged on init', async () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'hello')

      mockQuery._pushMessage({
        type: 'system',
        subtype: 'init',
        slash_commands: ['clear', 'compact']
      })
      mockQuery.close()

      await new Promise((r) => setTimeout(r, 50))

      const ev = store.events.find((e) => e.type === 'jsonClaude/slashCommandsChanged')
      expect(ev).toBeDefined()
      expect((ev as any).payload.slashCommands).toEqual(['clear', 'compact'])
    })


    it('emits auth failure guidance that tells users how to re-authenticate', async () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'hello')

      mockQuery._pushMessage({
        type: 'auth_status',
        error: 'token expired'
      })
      mockQuery.close()

      await new Promise((r) => setTimeout(r, 50))

      const errors = store.events.filter(
        (e) => e.type === 'jsonClaude/entryAppended' && (e as any).payload.entry.kind === 'error'
      )
      expect(errors.length).toBe(1)
      expect((errors[0] as any).payload.entry.errorMessage).toContain('claude auth login')
    })
  })

  describe('interrupt', () => {
    it('calls query.interrupt when session exists', async () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'hello')
      runtime.interrupt('s1')
      expect(mockQuery.interrupt).toHaveBeenCalledTimes(1)
    })

    it('is a no-op when session does not exist', () => {
      runtime.interrupt('s1')
      expect(mockQuery.interrupt).not.toHaveBeenCalled()
    })

    it('keeps the session reusable and moves to idle', async () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'hello')
      runtime.interrupt('s1')

      await new Promise((r) => setTimeout(r, 50))

      expect(runtime.hasSession('s1')).toBe(true)
      const stateEv = store.events
        .filter((e) => e.type === 'jsonClaude/sessionStateChanged')
        .pop()
      expect((stateEv as any).payload.state).toBe('idle')
    })

    it('sets busy to true when interrupt-resume dequeues a queued message', async () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'first')
      runtime.send('s1', 'second')

      store.events.length = 0
      runtime.interrupt('s1')

      await new Promise((r) => setTimeout(r, 50))

      const busyEvents = store.events.filter((e) => e.type === 'jsonClaude/busyChanged')
      // Runtime should stay busy while the queued message is resumed.
      expect(busyEvents.length).toBe(0)
      expect(mockQuery._getStreamInputMessages()).toHaveLength(2)
    })
  })

  describe('kill', () => {
    it('closes query and removes session', async () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'hello')
      runtime.kill('s1')

      expect(mockQuery.close).toHaveBeenCalledTimes(1)
      expect(runtime.hasSession('s1')).toBe(false)
    })

    it('dispatches exited state', () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'hello')
      runtime.kill('s1')

      const ev = store.events
        .filter((e) => e.type === 'jsonClaude/sessionStateChanged')
        .pop()
      expect((ev as any).payload.state).toBe('exited')
    })

    it('removes started-but-not-sent sessions', () => {
      runtime.start('s1', '/wt')
      expect(runtime.hasSession('s1')).toBe(true)
      runtime.kill('s1')
      expect(runtime.hasSession('s1')).toBe(false)
    })

    it('dispatches busyChanged false before exited state', () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'hello')
      store.events.length = 0
      runtime.kill('s1')

      const busyEvents = store.events.filter((e) => e.type === 'jsonClaude/busyChanged')
      expect(busyEvents.length).toBe(1)
      expect((busyEvents[0] as any).payload.busy).toBe(false)

      const stateEvents = store.events.filter((e) => e.type === 'jsonClaude/sessionStateChanged')
      expect(stateEvents.length).toBe(1)
      expect((stateEvents[0] as any).payload.state).toBe('exited')
    })


    it('flushes pending deltas and finalizes partial assistant entry before kill cleanup', async () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'hello')

      mockQuery._pushMessage({
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'msg-1' } }
      })
      mockQuery._pushMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'text' }
        }
      })
      mockQuery._pushMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'partial text' }
        }
      })

      await new Promise((r) => setTimeout(r, 0))
      store.events.length = 0

      runtime.kill('s1')

      const deltas = store.events.filter((e) => e.type === 'jsonClaude/assistantTextDelta')
      expect(deltas.length).toBe(1)
      expect((deltas[0] as any).payload.textDelta).toBe('partial text')

      const finalized = store.events.filter((e) => e.type === 'jsonClaude/assistantEntryFinalized')
      expect(finalized.length).toBe(1)
    })
  })

  describe('killAll', () => {
    it('kills all active sessions', () => {
      runtime.start('s1', '/wt')
      runtime.start('s2', '/wt2')
      runtime.send('s1', 'a')
      runtime.send('s2', 'b')

      runtime.killAll()

      expect(runtime.hasSession('s1')).toBe(false)
      expect(runtime.hasSession('s2')).toBe(false)
    })
  })

  describe('unsupported operations', () => {
    it('rewindTo returns ok=false', () => {
      const result = runtime.rewindTo('s1', 'e1')
      expect(result.ok).toBe(false)
      expect(result.reason).toContain('not supported')
    })

    it('setPermissionMode is a no-op', () => {
      runtime.start('s1', '/wt')
      runtime.setPermissionMode('s1', 'acceptEdits')
      // No error thrown; capability gate prevents UI from calling this.
    })

    it('cancelQueued is a no-op', () => {
      runtime.start('s1', '/wt')
      runtime.cancelQueued('s1', 'e1')
      // No error thrown; capability gate prevents UI from calling this.
    })
  })

  describe('tool result handling', () => {
    it('dispatches toolResultAttached for user messages carrying tool_use_result', async () => {
      runtime.start('s1', '/wt')
      runtime.send('s1', 'hello')

      mockQuery._pushMessage({
        type: 'user',
        message: { role: 'user', content: [] },
        parent_tool_use_id: null,
        tool_use_result: {
          tool_use_id: 'tu-1',
          content: 'done',
          is_error: false
        }
      })
      mockQuery.close()

      await new Promise((r) => setTimeout(r, 50))

      const ev = store.events.find((e) => e.type === 'jsonClaude/toolResultAttached')
      expect(ev).toBeDefined()
      expect((ev as any).payload.toolUseId).toBe('tu-1')
      expect((ev as any).payload.content).toBe('done')
      expect((ev as any).payload.isError).toBe(false)
    })
  })

  describe('permission mode safety', () => {
    it('uses stored permission mode when creating ACP query options', () => {
      store.dispatch({
        type: 'jsonClaude/sessionStarted',
        payload: { sessionId: 's1', worktreePath: '/wt', defaultPermissionMode: 'acceptEdits' }
      })
      runtime.start('s1', '/wt')
      runtime.send('s1', 'hello')

      expect(query).toHaveBeenCalledTimes(1)
      const opts = (query as any).mock.calls[0][0].options
      expect(opts.permissionMode).toBe('acceptEdits')
    })
  })

  describe('model override', () => {
    it('threads modelOverride into the SDK query options', () => {
      runtime.start('s1', '/wt', { modelOverride: 'claude-sonnet-4-6' })
      runtime.send('s1', 'hello')

      expect(query).toHaveBeenCalledTimes(1)
      const opts = (query as any).mock.calls[0][0].options
      expect(opts.model).toBe('claude-sonnet-4-6')
    })

    it('passes resolved native Claude path to the SDK query options', () => {
      const resolveExecutablePath = vi.fn(() => '/tmp/claude')
      runtime = new ClaudeAcpRuntime(store, { resolveExecutablePath })

      runtime.start('s1', '/wt')
      runtime.send('s1', 'hello')

      expect(resolveExecutablePath).toHaveBeenCalledTimes(1)
      const opts = (query as any).mock.calls[0][0].options
      expect(opts.pathToClaudeCodeExecutable).toBe('/tmp/claude')
    })

    it('cleans up modelOverride after consumption', () => {
      runtime.start('s1', '/wt', { modelOverride: 'claude-sonnet-4-6' })
      runtime.send('s1', 'hello')

      // Sending again should not pass the same override since it was consumed.
      runtime.send('s1', 'again')
      const secondOpts = (query as any).mock.calls[1]?.[0]?.options
      expect(secondOpts?.model).toBeUndefined()
    })

    it('cleans up modelOverride on kill before send', () => {
      runtime.start('s1', '/wt', { modelOverride: 'claude-sonnet-4-6' })
      runtime.kill('s1')
      runtime.start('s1', '/wt')
      runtime.send('s1', 'hello')

      const opts = (query as any).mock.calls[0][0].options
      expect(opts.model).toBeUndefined()
    })
  })

  describe('capabilities', () => {
    it('returns ACP default capabilities', () => {
      const caps = runtime.getCapabilities('s1')
      expect(caps.canInterrupt).toBe(true)
      expect(caps.canRewind).toBe(false)
      expect(caps.canSetPermissionMode).toBe(false)
      expect(caps.canApproveTools).toBe(false)
      expect(caps.canResume).toBe(true)
      expect(caps.canOpenAuthLogin).toBe(false)
      expect(caps.hasSlashCommands).toBe(false)
      expect(caps.hasCostTracking).toBe(false)
    })
  })

  describe('error handling', () => {
    it('emits error when query creation throws', () => {
      vi.mocked(query).mockImplementation(() => {
        throw new Error('no api key')
      })

      runtime.start('s1', '/wt')
      runtime.send('s1', 'hello')

      const errors = store.events.filter(
        (e) => e.type === 'jsonClaude/entryAppended' && (e as any).payload.entry.kind === 'error'
      )
      expect(errors.length).toBe(1)
      expect((errors[0] as any).payload.entry.errorMessage).toContain('no api key')
    })
  })
})

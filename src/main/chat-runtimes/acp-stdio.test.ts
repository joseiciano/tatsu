import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AcpStdioRuntime, defaultAcpStdioCapabilities } from './acp-stdio'
import { Store } from '../store'
import type { StateEvent } from '../../shared/state'

/** Fake ACP stdio client injected into the runtime. Records the wire
 *  sequence and lets tests push notifications / resolve prompts. */
class FakeAcpClient {
  requests: Array<{ method: string; params: any; timeoutMs?: number }> = []
  notifications: Array<{ method: string; params: any }> = []
  killCalls = 0
  initResult: any = { protocolVersion: 1, agentCapabilities: {} }
  newResult: any = { sessionId: 'acp-sess-1' }
  pendingPrompts: Array<(r: any) => void> = []
  pendingPromptRejectors: Array<(e: Error) => void> = []
  initReject: Error | null = null
  /** When true, initialize never resolves — simulates a stuck bootstrap. */
  initBlocked = false
  onRequestCb: ((method: string, params: unknown) => unknown) | null = null
  onNotificationCb: ((method: string, params: unknown) => void) | null = null
  onExitCb: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null
  onErrorCb: ((err: Error) => void) | null = null
  onMalformedCb: ((raw: string) => void) | null = null

  request(method: string, params: unknown, timeoutMs?: number): Promise<any> {
    this.requests.push({ method, params, timeoutMs })
    if (method === 'initialize') {
      if (this.initReject) return Promise.reject(this.initReject)
      if (this.initBlocked) return new Promise(() => {})
      return Promise.resolve(this.initResult)
    }
    if (method === 'session/new') return Promise.resolve(this.newResult)
    if (method === 'session/prompt') {
      return new Promise((resolve, reject) => {
        this.pendingPrompts.push(resolve)
        this.pendingPromptRejectors.push(reject)
      })
    }
    return Promise.resolve(null)
  }

  notify(method: string, params: unknown): void {
    this.notifications.push({ method, params })
  }

  kill(): void {
    this.killCalls++
  }

  onRequest(cb: any): void {
    this.onRequestCb = cb
  }
  onNotification(cb: any): void {
    this.onNotificationCb = cb
  }
  onExit(cb: any): void {
    this.onExitCb = cb
  }
  onError(cb: any): void {
    this.onErrorCb = cb
  }
  onMalformedFrame(cb: any): void {
    this.onMalformedCb = cb
  }

  resolvePrompt(stopReason: string): void {
    const r = this.pendingPrompts.shift()
    r?.({ stopReason })
  }

  rejectPrompt(err: Error): void {
    const r = this.pendingPromptRejectors.shift()
    r?.(err)
  }

  pushUpdate(update: any, sessionId = 'acp-sess-1'): void {
    this.onNotificationCb?.('session/update', { sessionId, update })
  }
}

function createStore() {
  const store = new Store()
  const events: StateEvent[] = []
  store.subscribe((e) => events.push(e))
  return { store, events }
}

function eventsOf(events: StateEvent[], type: string): StateEvent[] {
  return events.filter((e) => e.type === type)
}

function seed(
  opts: { flushIntervalMs?: number; initResult?: any; requestTimeoutMs?: number } = {}
) {
  const { store, events } = createStore()
  const fake = new FakeAcpClient()
  if (opts.initResult) fake.initResult = opts.initResult
  const runtime = new AcpStdioRuntime(store, {
    agentKind: 'opencode',
    command: ['opencode', 'acp'],
    flushIntervalMs: opts.flushIntervalMs ?? 50,
    requestTimeoutMs: opts.requestTimeoutMs,
    createClient: () => fake as any
  })
  // Seed the slice session the way main/index.ts does before start().
  store.dispatch({
    type: 'jsonClaude/sessionStarted',
    payload: {
      sessionId: 's1',
      worktreePath: '/wt',
      agentKind: 'opencode',
      runtimeId: 'opencode'
    }
  })
  runtime.start('s1', '/wt')
  return { store, events, fake, runtime }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('AcpStdioRuntime wire sequence', () => {
  it('sends initialize → session/new → session/prompt with minimal capabilities', async () => {
    const { fake, runtime } = seed()
    runtime.send('s1', 'hello')
    await tick()

    const methods = fake.requests.map((r) => r.method)
    expect(methods).toEqual(['initialize', 'session/new', 'session/prompt'])

    const init = fake.requests[0].params
    expect(init.protocolVersion).toBe(1)
    expect(init.clientCapabilities).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false
    })
    expect(init.clientInfo).toBeTruthy()

    const newSess = fake.requests[1].params
    expect(newSess.cwd).toBe('/wt')
    expect(newSess.mcpServers).toEqual([])

    const prompt = fake.requests[2].params
    // ACP session id is distinct from the Tatsu session/tab id.
    expect(prompt.sessionId).toBe('acp-sess-1')
    expect(prompt.sessionId).not.toBe('s1')
    expect(prompt.prompt).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('includes image content blocks when images are sent', async () => {
    const { fake, runtime } = seed()
    runtime.send('s1', 'look', [
      { mediaType: 'image/png', data: 'aGVsbG8=', path: '/img.png' }
    ])
    await tick()
    const prompt = fake.requests[2].params
    expect(prompt.prompt).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=', uri: '/img.png' },
      { type: 'text', text: 'look' }
    ])
  })

  it('gives bootstrap requests a finite timeout but session/prompt no timeout', async () => {
    const { fake, runtime } = seed()
    runtime.send('s1', 'hi')
    await tick()

    const init = fake.requests.find((r) => r.method === 'initialize')
    const sessionNew = fake.requests.find((r) => r.method === 'session/new')
    const prompt = fake.requests.find((r) => r.method === 'session/prompt')

    // Bootstrap must not hang forever — finite per-request timeout.
    expect(init?.timeoutMs).toBeGreaterThan(0)
    expect(sessionNew?.timeoutMs).toBeGreaterThan(0)
    // session/prompt can run arbitrarily long (agent thinking); it must NOT
    // carry the 180s bootstrap timeout. 0 = no timeout; it stays recoverable
    // via interrupt/kill rather than auto-failing mid-turn.
    expect(prompt?.timeoutMs).toBe(0)
  })
})

describe('AcpStdioRuntime notification normalization + batching', () => {
  it('batches agent_message_chunk deltas into a single assistantTextDelta', async () => {
    const { events, fake, runtime } = seed({ flushIntervalMs: 5 })
    runtime.send('s1', 'hi')
    await tick()

    fake.pushUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: { type: 'text', text: 'a' }
    })
    fake.pushUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: { type: 'text', text: 'b' }
    })
    fake.pushUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: { type: 'text', text: 'c' }
    })

    // No per-token dispatch before the flush timer fires.
    expect(eventsOf(events, 'jsonClaude/assistantTextDelta')).toHaveLength(0)

    await new Promise((r) => setTimeout(r, 20))
    const deltas = eventsOf(events, 'jsonClaude/assistantTextDelta')
    expect(deltas).toHaveLength(1)
    expect((deltas[0] as any).payload.textDelta).toBe('abc')
  })

  it('finalizes the partial entry when messageId changes', async () => {
    const { events, fake, runtime } = seed({ flushIntervalMs: 5 })
    runtime.send('s1', 'hi')
    await tick()

    fake.pushUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: { type: 'text', text: 'hello ' }
    })
    await new Promise((r) => setTimeout(r, 20))

    fake.pushUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm2',
      content: { type: 'text', text: 'world' }
    })
    await new Promise((r) => setTimeout(r, 20))

    const finalized = eventsOf(events, 'jsonClaude/assistantEntryFinalized')
    expect(finalized).toHaveLength(1)
    const blocks = (finalized[0] as any).payload.blocks
    expect(blocks).toEqual([{ type: 'text', text: 'hello ' }])
  })

  it('maps tool_call to an assistant tool block and tool_call_update result to a tool result', async () => {
    const { events, fake, runtime } = seed({ flushIntervalMs: 5 })
    runtime.send('s1', 'run')
    await tick()

    fake.pushUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      title: 'Reading file',
      kind: 'read',
      status: 'pending',
      rawInput: { path: '/a.txt' }
    })
    fake.pushUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'file contents' } }]
    })

    const blocks = eventsOf(events, 'jsonClaude/assistantBlockAppended')
    expect(blocks).toHaveLength(1)
    expect((blocks[0] as any).payload.block).toMatchObject({
      type: 'tool_use',
      id: 'call_1',
      name: 'Reading file'
    })

    const results = eventsOf(events, 'jsonClaude/toolResultAttached')
    expect(results).toHaveLength(1)
    expect((results[0] as any).payload).toMatchObject({
      toolUseId: 'call_1',
      content: 'file contents',
      isError: false
    })
  })

  it('tolerates unknown session/update variants and notifications without crashing', async () => {
    const { fake, runtime } = seed()
    runtime.send('s1', 'hi')
    await tick()
    expect(() => {
      fake.pushUpdate({ sessionUpdate: 'totally_unknown_variant' })
      fake.onNotificationCb?.('some/unknown_notification', {})
      fake.onRequestCb?.('some/unknown_method', {})
    }).not.toThrow()
  })

  it('preserves text → tool → text order without merging noncontiguous same-kind blocks', async () => {
    const { events, fake, runtime } = seed({ flushIntervalMs: 10_000 })
    runtime.send('s1', 'run')
    await tick()

    // 'hello ' text, then a tool call, then more text — same messageId.
    fake.pushUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: { type: 'text', text: 'hello ' }
    })
    fake.pushUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      title: 'read',
      kind: 'read',
      status: 'pending',
      rawInput: { path: '/a.txt' }
    })
    fake.pushUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: { type: 'text', text: 'world' }
    })

    fake.resolvePrompt('end_turn')
    await tick()

    const finalized = eventsOf(events, 'jsonClaude/assistantEntryFinalized')
    expect(finalized).toHaveLength(1)
    expect((finalized[0] as any).payload.blocks).toEqual([
      { type: 'text', text: 'hello ' },
      { type: 'tool_use', id: 'call_1', name: 'read', input: { path: '/a.txt' } },
      { type: 'text', text: 'world' }
    ])
  })

  it('preserves text → thinking → text order with separate blocks', async () => {
    const { events, fake, runtime } = seed({ flushIntervalMs: 10_000 })
    runtime.send('s1', 'run')
    await tick()

    fake.pushUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: { type: 'text', text: 'outer ' }
    })
    fake.pushUpdate({
      sessionUpdate: 'agent_thought_chunk',
      messageId: 'm1',
      content: { type: 'text', text: 'inner thinking' }
    })
    fake.pushUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: { type: 'text', text: 'tail' }
    })

    fake.resolvePrompt('end_turn')
    await tick()

    const finalized = eventsOf(events, 'jsonClaude/assistantEntryFinalized')
    const blocks = (finalized[0] as any).payload.blocks
    expect(blocks.map((b: any) => b.type)).toEqual(['text', 'thinking', 'text'])
    expect(blocks[0].text).toBe('outer ')
    expect(blocks[1].text).toBe('inner thinking')
    expect(blocks[2].text).toBe('tail')
  })
})

describe('AcpStdioRuntime queue behavior', () => {
  it('queues a second message while busy and sends it after completion', async () => {
    const { events, fake, runtime } = seed()
    runtime.send('s1', 'one')
    await tick()
    expect(fake.requests.filter((r) => r.method === 'session/prompt')).toHaveLength(1)

    runtime.send('s1', 'two')
    // Second user entry is queued.
    const queued = eventsOf(events, 'jsonClaude/entryAppended').filter(
      (e) => (e as any).payload.entry.isQueued
    )
    expect(queued).toHaveLength(1)
    const queuedEntryId = (queued[0] as any).payload.entry.entryId

    fake.resolvePrompt('end_turn')
    await tick()

    const prompts = fake.requests.filter((r) => r.method === 'session/prompt')
    expect(prompts).toHaveLength(2)
    expect(prompts[1].params.prompt).toEqual([{ type: 'text', text: 'two' }])
    // Exactly the dispatched queued entry is promoted — not a fresh entry.
    expect(eventsOf(events, 'jsonClaude/userEntryUnqueued')).toHaveLength(1)
    expect((eventsOf(events, 'jsonClaude/userEntryUnqueued')[0] as any).payload.entryId).toBe(
      queuedEntryId
    )
    const allEntries = eventsOf(events, 'jsonClaude/entryAppended').map(
      (e) => (e as any).payload.entry.entryId
    )
    expect(allEntries.filter((id) => id === queuedEntryId)).toHaveLength(1)

    fake.resolvePrompt('end_turn')
    await tick()
    const idle = eventsOf(events, 'jsonClaude/sessionStateChanged').filter(
      (e) => (e as any).payload.state === 'idle'
    )
    expect(idle.length).toBeGreaterThan(0)
  })

  it('does not silently lose queued messages on interrupt/cancel', async () => {
    const { fake, runtime } = seed()
    runtime.send('s1', 'one')
    await tick()
    runtime.send('s1', 'two')

    runtime.interrupt('s1')
    fake.resolvePrompt('cancelled')
    await tick()

    const prompts = fake.requests.filter((r) => r.method === 'session/prompt')
    expect(prompts).toHaveLength(2)
    expect(prompts[1].params.prompt).toEqual([{ type: 'text', text: 'two' }])
  })

  it('queues exactly one user entry per queued send and promotes only the dispatched item', async () => {
    const { store, events, fake, runtime } = seed()
    runtime.send('s1', 'one')
    await tick()
    runtime.send('s1', 'two')
    runtime.send('s1', 'three')

    // Two queued entries (one per queued send), no duplication.
    const queued = eventsOf(events, 'jsonClaude/entryAppended').filter(
      (e) => (e as any).payload.entry.isQueued
    )
    expect(queued).toHaveLength(2)
    const queuedIds = queued.map((e) => (e as any).payload.entry.entryId)
    expect(new Set(queuedIds).size).toBe(2)

    // Dispatch the first queued item only.
    fake.resolvePrompt('end_turn')
    await tick()

    const unqueued = eventsOf(events, 'jsonClaude/userEntryUnqueued')
    expect(unqueued).toHaveLength(1)
    expect((unqueued[0] as any).payload.entryId).toBe(queuedIds[0])
    // The second queued item is untouched and still queued.
    const stateAfter = store.getSnapshot().state.jsonClaude.sessions['s1']
    const stillQueued = stateAfter.entries.filter((e) => e.isQueued)
    expect(stillQueued.map((e) => e.entryId)).toEqual([queuedIds[1]])
  })

  it('cancelQueued removes the target queued message and its entry so it never reaches the agent', async () => {
    const { store, events, fake, runtime } = seed()
    runtime.send('s1', 'one')
    await tick()
    runtime.send('s1', 'two')
    runtime.send('s1', 'three')

    const queued = eventsOf(events, 'jsonClaude/entryAppended').filter(
      (e) => (e as any).payload.entry.isQueued
    )
    const secondId = (queued[1] as any).payload.entry.entryId

    runtime.cancelQueued('s1', secondId)

    const removed = eventsOf(events, 'jsonClaude/entryRemoved')
    expect(removed).toHaveLength(1)
    expect((removed[0] as any).payload.entryId).toBe(secondId)

    // First queued message still dispatched on turn completion; cancelled one does not.
    fake.resolvePrompt('end_turn')
    await tick()
    const prompts = fake.requests.filter((r) => r.method === 'session/prompt')
    expect(prompts).toHaveLength(2)
    expect(prompts[1].params.prompt).toEqual([{ type: 'text', text: 'two' }])
    expect(prompts.map((p) => p.params.prompt[0].text)).not.toContain('three')

    // The cancelled entry was removed from state, the remaining one was promoted.
    const stateAfter = store.getSnapshot().state.jsonClaude.sessions['s1']
    const stillQueued = stateAfter.entries.filter((e) => e.isQueued)
    expect(stillQueued).toHaveLength(0)
    expect(eventsOf(events, 'jsonClaude/userEntryUnqueued')).toHaveLength(1)
  })

  it('cancelQueued is a no-op for an unknown entry id', async () => {
    const { events, fake, runtime } = seed()
    runtime.send('s1', 'one')
    await tick()
    runtime.send('s1', 'two')

    runtime.cancelQueued('s1', 'does-not-exist')
    expect(eventsOf(events, 'jsonClaude/entryRemoved')).toHaveLength(0)

    fake.resolvePrompt('end_turn')
    await tick()
    const prompts = fake.requests.filter((r) => r.method === 'session/prompt')
    expect(prompts).toHaveLength(2)
    expect(prompts[1].params.prompt).toEqual([{ type: 'text', text: 'two' }])
  })

})

describe('AcpStdioRuntime interrupt / kill / exit', () => {
  it('interrupt sends session/cancel and returns to idle on cancelled stop reason', async () => {
    const { events, fake, runtime } = seed()
    runtime.send('s1', 'hi')
    await tick()

    runtime.interrupt('s1')
    expect(fake.notifications).toContainEqual({
      method: 'session/cancel',
      params: { sessionId: 'acp-sess-1' }
    })

    fake.resolvePrompt('cancelled')
    await tick()
    const idle = eventsOf(events, 'jsonClaude/sessionStateChanged').filter(
      (e) => (e as any).payload.state === 'idle'
    )
    expect(idle.length).toBeGreaterThan(0)
    const busy = eventsOf(events, 'jsonClaude/busyChanged').filter(
      (e) => (e as any).payload.busy === false
    )
    expect(busy.length).toBeGreaterThan(0)
  })

  it('kill() kills the client and dispatches exited state', async () => {
    const { events, fake, runtime } = seed()
    runtime.send('s1', 'hi')
    await tick()

    runtime.kill('s1')
    expect(fake.killCalls).toBe(1)
    const exited = eventsOf(events, 'jsonClaude/sessionStateChanged').filter(
      (e) => (e as any).payload.state === 'exited'
    )
    expect(exited).toHaveLength(1)
    expect((exited[0] as any).payload.exitReason).toBe('killed')
  })

  it('unexpected process exit produces an error card and exited state', async () => {
    const { events, fake, runtime } = seed()
    runtime.send('s1', 'hi')
    await tick()

    fake.onExitCb?.(1, null)
    const errors = eventsOf(events, 'jsonClaude/entryAppended').filter(
      (e) => (e as any).payload.entry.kind === 'error'
    )
    expect(errors).toHaveLength(1)
    expect((errors[0] as any).payload.entry.errorKind).toBe('subprocess-exit')

    const exited = eventsOf(events, 'jsonClaude/sessionStateChanged').filter(
      (e) => (e as any).payload.state === 'exited'
    )
    expect(exited).toHaveLength(1)
    expect((exited[0] as any).payload.exitCode).toBe(1)
  })

  it('prompt failure after kill() does not dispatch idle/error or overwrite exited', async () => {
    const { events, fake, runtime } = seed()
    runtime.send('s1', 'hi')
    await tick()

    const busyBefore = eventsOf(events, 'jsonClaude/busyChanged').length
    const snap = events.length
    runtime.kill('s1')
    const exitedBefore = events.slice(snap).filter(
      (e) =>
        e.type === 'jsonClaude/sessionStateChanged' &&
        (e as any).payload.state === 'exited'
    )
    expect(exitedBefore).toHaveLength(1)

    // The in-flight session/prompt resolves/rejects after teardown.
    fake.rejectPrompt(new Error('subprocess exited'))
    await tick()

    const post = events.slice(snap)
    // No idle dispatched after the kill.
    const idle = post.filter(
      (e) =>
        e.type === 'jsonClaude/sessionStateChanged' &&
        (e as any).payload.state === 'idle'
    )
    expect(idle).toHaveLength(0)
    // No additional busy-false dispatched after the kill (kill already emitted one).
    const busyAfter = post.filter(
      (e) => e.type === 'jsonClaude/busyChanged'
    ).length
    expect(busyAfter).toBe(1) // only the kill's busy false
    // No additional error cards.
    const errors = post.filter(
      (e) =>
        e.type === 'jsonClaude/entryAppended' &&
        (e as any).payload.entry.kind === 'error'
    )
    expect(errors).toHaveLength(0)
    const exited = post.filter(
      (e) =>
        e.type === 'jsonClaude/sessionStateChanged' &&
        (e as any).payload.state === 'exited'
    )
    expect(exited).toHaveLength(1)
    expect((exited[0] as any).payload.exitReason).toBe('killed')
  })
  it('prompt failure during subprocess exit does not dispatch idle or a duplicate error', async () => {
    const { events, fake, runtime } = seed()
    runtime.send('s1', 'hi')
    await tick()

    const snap = events.length
    // Subprocess exits while a prompt is in flight → client rejects the request.
    fake.rejectPrompt(new Error('ACP subprocess exited'))
    fake.onExitCb?.(1, null)
    await tick()

    const post = events.slice(snap)
    // Exactly one error card (from the exit handler), and never an idle.
    const errors = post.filter(
      (e) =>
        e.type === 'jsonClaude/entryAppended' &&
        (e as any).payload.entry.kind === 'error'
    )
    expect(errors).toHaveLength(1)
    const idle = post.filter(
      (e) =>
        e.type === 'jsonClaude/sessionStateChanged' &&
        (e as any).payload.state === 'idle'
    )
    expect(idle).toHaveLength(0)
    const exited = post.filter(
      (e) =>
        e.type === 'jsonClaude/sessionStateChanged' &&
        (e as any).payload.state === 'exited'
    )
    expect(exited).toHaveLength(1)
  })

  it('initialize failure surfaces exited state, not idle, and never reaches session/new', async () => {
    const { events, fake, runtime } = seed()
    fake.initReject = new Error('agent failed to start')
    const snap = events.length
    runtime.send('s1', 'hi')
    await tick()

    const post = events.slice(snap)
    const newSess = fake.requests.filter((r) => r.method === 'session/new')
    expect(newSess).toHaveLength(0)

    const errors = post.filter(
      (e) => e.type === 'jsonClaude/entryAppended' && (e as any).payload.entry.kind === 'error'
    )
    expect(errors).toHaveLength(1)

    const idle = post.filter(
      (e) => e.type === 'jsonClaude/sessionStateChanged' && (e as any).payload.state === 'idle'
    )
    expect(idle).toHaveLength(0)
    const exited = post.filter(
      (e) => e.type === 'jsonClaude/sessionStateChanged' && (e as any).payload.state === 'exited'
    )
    expect(exited).toHaveLength(1)
  })

  it('unsupported initialize protocolVersion terminates without session/new and reports exited', async () => {
    const { events, fake, runtime } = seed({ initResult: { protocolVersion: 2 } })
    const snap = events.length
    runtime.send('s1', 'hi')
    await tick()

    expect(fake.requests.filter((r) => r.method === 'session/new')).toHaveLength(0)

    const post = events.slice(snap)
    const errors = post.filter(
      (e) => e.type === 'jsonClaude/entryAppended' && (e as any).payload.entry.kind === 'error'
    )
    expect(errors).toHaveLength(1)
    expect((errors[0] as any).payload.entry.errorKind).toBe('protocol-version')

    const idle = post.filter(
      (e) => e.type === 'jsonClaude/sessionStateChanged' && (e as any).payload.state === 'idle'
    )
    expect(idle).toHaveLength(0)
    const exited = post.filter(
      (e) => e.type === 'jsonClaude/sessionStateChanged' && (e as any).payload.state === 'exited'
    )
    expect(exited).toHaveLength(1)
  })

  it('unexpected exit flushes pending deltas and finalizes the partial entry before error/exited', async () => {
    const { events, fake, runtime } = seed({ flushIntervalMs: 10_000 })
    runtime.send('s1', 'hi')
    await tick()

    fake.pushUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: { type: 'text', text: 'partial' }
    })
    // No flush timer fired (10s cadence) — delta still pending.

    fake.onExitCb?.(1, null)

    const deltas = eventsOf(events, 'jsonClaude/assistantTextDelta')
    expect(deltas).toHaveLength(1)
    expect((deltas[0] as any).payload.textDelta).toBe('partial')

    const finalized = eventsOf(events, 'jsonClaude/assistantEntryFinalized')
    expect(finalized).toHaveLength(1)
    expect((finalized[0] as any).payload.blocks).toEqual([
      { type: 'text', text: 'partial' }
    ])

    // Finalize happens before the terminal error + exited events.
    const seq = events.map((e) => e.type)
    const finalizeIdx = seq.indexOf('jsonClaude/assistantEntryFinalized')
    const exitedIdx = seq.findIndex(
      (_, i) =>
        events[i].type === 'jsonClaude/sessionStateChanged' &&
        (events[i] as any).payload.state === 'exited'
    )
    expect(finalizeIdx).toBeGreaterThan(-1)
    expect(exitedIdx).toBeGreaterThan(-1)
    expect(finalizeIdx).toBeLessThan(exitedIdx)
  })

  it('killAll kills every active session', async () => {
    const { store, fake, runtime } = seed()
    store.dispatch({
      type: 'jsonClaude/sessionStarted',
      payload: {
        sessionId: 's2',
        worktreePath: '/wt2',
        agentKind: 'opencode',
        runtimeId: 'opencode'
      }
    })
    runtime.start('s2', '/wt2')
    runtime.send('s1', 'hi')
    runtime.send('s2', 'yo')
    await tick()
    runtime.killAll()
    expect(fake.killCalls).toBe(2)
  })

  it('a stale subprocess exit after kill does not tear down a same-id restarted session', async () => {
    const { store, events } = createStore()
    const clients: FakeAcpClient[] = []
    const runtime = new AcpStdioRuntime(store, {
      agentKind: 'opencode',
      command: ['opencode', 'acp'],
      flushIntervalMs: 5,
      createClient: () => {
        const c = new FakeAcpClient()
        clients.push(c)
        return c as any
      }
    })
    store.dispatch({
      type: 'jsonClaude/sessionStarted',
      payload: {
        sessionId: 's1',
        worktreePath: '/wt',
        agentKind: 'opencode',
        runtimeId: 'opencode'
      }
    })
    runtime.start('s1', '/wt')

    // First turn → client A.
    runtime.send('s1', 'one')
    await tick()
    expect(clients).toHaveLength(1)
    const clientA = clients[0]
    clientA.resolvePrompt('end_turn')
    await tick()

    // Kill, then restart the same Tatsu session id → client B.
    runtime.kill('s1')
    runtime.send('s1', 'two')
    await tick()
    expect(clients).toHaveLength(2)
    const clientB = clients[1]
    expect(clientB.onExitCb).toBeTruthy()

    // Old client A exits late (finally reaped). It must NOT tear down client
    // B's replacement session just because the session id matches.
    const snap = events.length
    clientA.onExitCb?.(1, null)
    await tick()

    const post = events.slice(snap)
    const exited = post.filter(
      (e) =>
        e.type === 'jsonClaude/sessionStateChanged' &&
        (e as any).payload.state === 'exited'
    )
    expect(exited).toHaveLength(0)
    const errors = post.filter(
      (e) =>
        e.type === 'jsonClaude/entryAppended' &&
        (e as any).payload.entry.kind === 'error'
    )
    expect(errors).toHaveLength(0)
    // Client B still owns a live session and its prompt is still in flight.
    expect(runtime.hasSession('s1')).toBe(true)
    expect(clientB.pendingPrompts.length).toBeGreaterThan(0)
  })

  it('configures a finite request timeout on the client for initialize/new/prompt', async () => {
    const { store } = createStore()
    const fake = new FakeAcpClient()
    let captured: any = null
    const runtime = new AcpStdioRuntime(store, {
      agentKind: 'opencode',
      command: ['opencode', 'acp'],
      requestTimeoutMs: 250,
      createClient: (opts) => {
        captured = opts
        return fake as any
      }
    })
    store.dispatch({
      type: 'jsonClaude/sessionStarted',
      payload: {
        sessionId: 's1',
        worktreePath: '/wt',
        agentKind: 'opencode',
        runtimeId: 'opencode'
      }
    })
    runtime.start('s1', '/wt')
    runtime.send('s1', 'hi')
    await tick()

    expect(captured.requestTimeoutMs).toBe(250)
  })

  it('interrupt during bootstrap terminates the session instead of a silent no-op', async () => {
    const { events, fake, runtime } = seed()
    fake.initBlocked = true // initialize never resolves — bootstrap stuck
    const snap = events.length
    runtime.send('s1', 'hi')
    await tick()

    expect(fake.requests.map((r) => r.method)).toContain('initialize')
    expect(fake.requests.map((r) => r.method)).not.toContain('session/new')
    expect(fake.killCalls).toBe(0)

    runtime.interrupt('s1')

    // Safe recovery: the pending bootstrap request is aborted and the session
    // reaches a terminal state, rather than interrupting being a no-op.
    expect(fake.killCalls).toBe(1)
    expect(fake.requests.map((r) => r.method)).not.toContain('session/new')

    const post = events.slice(snap)
    const exited = post.filter(
      (e) =>
        e.type === 'jsonClaude/sessionStateChanged' &&
        (e as any).payload.state === 'exited'
    )
    expect(exited).toHaveLength(1)
    const idle = post.filter(
      (e) =>
        e.type === 'jsonClaude/sessionStateChanged' &&
        (e as any).payload.state === 'idle'
    )
    expect(idle).toHaveLength(0)
  })

  it('interrupt after initialize but before session/new resolves also terminates', async () => {
    const { events, fake, runtime } = seed()
    // Keep session/new pending so we are mid-bootstrap (acpSessionId null).
    fake.newResult = new Promise(() => {})

    const snap = events.length
    runtime.send('s1', 'hi')
    await tick()
    expect(fake.requests.map((r) => r.method)).toContain('session/new')
    expect((runtime as any).sessions.get('s1').acpSessionId).toBeNull()

    runtime.interrupt('s1')

    const post = events.slice(snap)
    const exited = post.filter(
      (e) =>
        e.type === 'jsonClaude/sessionStateChanged' &&
        (e as any).payload.state === 'exited'
    )
    expect(exited).toHaveLength(1)
    expect(fake.killCalls).toBe(1)
  })
})

describe('AcpStdioRuntime permission + capabilities', () => {
  it('responds to session/request_permission with the cancelled outcome', async () => {
    const { fake, runtime } = seed()
    runtime.send('s1', 'hi')
    await tick()
    const result = fake.onRequestCb?.('session/request_permission', {
      sessionId: 'acp-sess-1',
      toolCall: { toolCallId: 'call_1' }
    })
    expect(result).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('exposes conservative capabilities by default', () => {
    const { runtime } = seed()
    const caps = runtime.getCapabilities('s1')
    expect(caps).toEqual(defaultAcpStdioCapabilities())
    expect(caps.canInterrupt).toBe(true)
    expect(caps.canRewind).toBe(false)
    expect(caps.canSetPermissionMode).toBe(false)
    expect(caps.canApproveTools).toBe(false)
    expect(caps.canResume).toBe(false)
  })

  it('flips canResume when initialize advertises sessionCapabilities.resume', async () => {
    const { events, runtime } = seed({
      initResult: {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: {} } }
      }
    })
    runtime.send('s1', 'hi')
    await tick()
    const capsChanged = eventsOf(events, 'jsonClaude/capabilitiesChanged')
    expect(capsChanged).toHaveLength(1)
    expect((capsChanged[0] as any).payload.capabilities.canResume).toBe(true)
  })

  it('rewind/setPermissionMode are no-ops consistent with capabilities', () => {
    const { events, runtime } = seed()
    expect(runtime.rewindTo('s1', 'x')).toEqual({
      ok: false,
      reason: expect.any(String)
    })
    expect(() => runtime.setPermissionMode('s1', 'acceptEdits')).not.toThrow()
    expect(eventsOf(events, 'jsonClaude/permissionModeChanged')).toHaveLength(0)
  })
})

describe('defaultAcpStdioCapabilities', () => {
  it('returns a fresh object each call', () => {
    expect(defaultAcpStdioCapabilities()).not.toBe(defaultAcpStdioCapabilities())
  })
})
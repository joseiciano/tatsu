import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  AcpStdioRuntime,
  acpModeFor,
  currentModelOf,
  defaultAcpStdioCapabilities,
  parseAuthMethods,
  permissionModeForAcp
} from './acp-stdio'
import { ACP_AUTH_REQUIRED, AcpRequestError } from './acp-stdio-client'
import { RuntimeMissingError } from './runtime-path-resolver'
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

  /** Per-method override consulted before the defaults below, so a test can
   *  make any request reject (e.g. with an AcpRequestError) or vary its reply
   *  across calls. */
  responders: Record<string, (params: any) => Promise<any>> = {}

  request(method: string, params: unknown, timeoutMs?: number): Promise<any> {
    this.requests.push({ method, params, timeoutMs })
    const responder = this.responders[method]
    if (responder) return responder(params)
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
  opts: {
    flushIntervalMs?: number
    initResult?: any
    requestTimeoutMs?: number
    agentSessionId?: string
    modelOverride?: string
  } = {}
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
      runtimeId: 'opencode',
      ...(opts.agentSessionId ? { agentSessionId: opts.agentSessionId } : {})
    }
  })
  runtime.start('s1', '/wt', opts.modelOverride ? { modelOverride: opts.modelOverride } : undefined)
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

describe('AcpStdioRuntime permission requests', () => {
  /** Options deliberately ordered so that "take the first option" or
   *  "take the first allow/reject" picks the wrong one. */
  const ALL_OPTIONS = [
    { optionId: 'opt-reject-always', name: 'Never', kind: 'reject_always' },
    { optionId: 'opt-allow-always', name: 'Always', kind: 'allow_always' },
    { optionId: 'opt-reject-once', name: 'Reject', kind: 'reject_once' },
    { optionId: 'opt-allow-once', name: 'Allow', kind: 'allow_once' }
  ]

  function permissionParams(
    options: Array<{ optionId: string; name: string; kind: string }> = ALL_OPTIONS,
    toolCall: Record<string, unknown> = {
      toolCallId: 'call_1',
      title: 'Run `ls`',
      kind: 'execute',
      rawInput: { command: 'ls' }
    }
  ) {
    return { sessionId: 'acp-sess-1', toolCall, options }
  }

  async function seedWithPrompt() {
    const seeded = seed()
    seeded.runtime.send('s1', 'hi')
    await tick()
    return seeded
  }

  function requestPermission(fake: FakeAcpClient, params: unknown = permissionParams()): Promise<any> {
    return fake.onRequestCb!('session/request_permission', params) as Promise<any>
  }

  function trackSettled(p: Promise<any>): { settled: boolean } {
    const state = { settled: false }
    p.then(() => {
      state.settled = true
    })
    return state
  }

  function grantForSession(store: Store, toolName: string): void {
    store.dispatch({
      type: 'jsonClaude/sessionToolApprovalsGranted',
      payload: { sessionId: 's1', toolNames: [toolName] }
    })
  }

  it('surfaces a request as a pending approval and leaves the agent waiting', async () => {
    const { store, fake } = await seedWithPrompt()
    const reply = trackSettled(requestPermission(fake))
    await tick()

    expect(reply.settled).toBe(false)
    expect(store.getSnapshot().state.jsonClaude.pendingApprovals).toEqual({
      's1-perm-1': {
        requestId: 's1-perm-1',
        sessionId: 's1',
        toolName: 'execute',
        input: { title: 'Run `ls`', command: 'ls' },
        toolUseId: 'call_1',
        timestamp: expect.any(Number)
      }
    })
  })

  it.each([
    {
      name: 'is the stable kind, not the per-call title, so session grants match later calls',
      toolCall: { toolCallId: 'c', title: 'Edit src/a.ts', kind: 'edit', rawInput: { path: 'src/a.ts' } },
      expected: { toolName: 'edit', input: { title: 'Edit src/a.ts', path: 'src/a.ts' } }
    },
    {
      name: 'keeps the agent title field when rawInput already has one',
      toolCall: { toolCallId: 'c', title: 'ignored', kind: 'edit', rawInput: { title: 'from input' } },
      expected: { toolName: 'edit', input: { title: 'from input' } }
    },
    {
      name: "falls back to 'tool' with no kind",
      toolCall: { toolCallId: 'c', title: 'Something' },
      expected: { toolName: 'tool', input: { title: 'Something' } }
    }
  ])('pending approval tool name $name', async ({ toolCall, expected }) => {
    const { store, fake } = await seedWithPrompt()
    void requestPermission(fake, permissionParams(ALL_OPTIONS, toolCall))
    expect(store.getSnapshot().state.jsonClaude.pendingApprovals['s1-perm-1']).toMatchObject(
      expected
    )
  })

  it('gives each request in a session a distinct request id', async () => {
    const { store, fake } = await seedWithPrompt()
    void requestPermission(fake)
    void requestPermission(fake)
    expect(Object.keys(store.getSnapshot().state.jsonClaude.pendingApprovals).sort()).toEqual([
      's1-perm-1',
      's1-perm-2'
    ])
  })

  it('allow answers with the allow_once option and clears the pending approval', async () => {
    const { store, fake, runtime } = await seedWithPrompt()
    const reply = requestPermission(fake)

    expect(runtime.resolveApproval('s1-perm-1', { behavior: 'allow' })).toBe(true)
    await expect(reply).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-allow-once' }
    })
    expect(store.getSnapshot().state.jsonClaude.pendingApprovals).toEqual({})
  })

  it('allow after the user granted the tool for the session answers allow_always', async () => {
    const { store, fake, runtime } = await seedWithPrompt()
    const reply = requestPermission(fake)

    grantForSession(store, 'execute')
    runtime.resolveApproval('s1-perm-1', { behavior: 'allow' })
    await expect(reply).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-allow-always' }
    })
  })

  it('allow falls back to allow_always when the agent offers no allow_once', async () => {
    const { fake, runtime } = await seedWithPrompt()
    const reply = requestPermission(
      fake,
      permissionParams(ALL_OPTIONS.filter((o) => o.kind !== 'allow_once'))
    )
    runtime.resolveApproval('s1-perm-1', { behavior: 'allow' })
    await expect(reply).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-allow-always' }
    })
  })

  it('deny answers with the reject_once option without interrupting', async () => {
    const { store, fake, runtime } = await seedWithPrompt()
    const reply = requestPermission(fake)

    expect(runtime.resolveApproval('s1-perm-1', { behavior: 'deny' })).toBe(true)
    await expect(reply).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-reject-once' }
    })
    expect(store.getSnapshot().state.jsonClaude.pendingApprovals).toEqual({})
    expect(fake.notifications.map((n) => n.method)).not.toContain('session/cancel')
  })

  it('deny falls back to reject_always when the agent offers no reject_once', async () => {
    const { fake, runtime } = await seedWithPrompt()
    const reply = requestPermission(
      fake,
      permissionParams(ALL_OPTIONS.filter((o) => o.kind !== 'reject_once'))
    )
    runtime.resolveApproval('s1-perm-1', { behavior: 'deny' })
    await expect(reply).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-reject-always' }
    })
  })

  it('deny with interrupt rejects the request and cancels the turn', async () => {
    const { fake, runtime } = await seedWithPrompt()
    const reply = requestPermission(fake)

    runtime.resolveApproval('s1-perm-1', { behavior: 'deny', interrupt: true })
    await expect(reply).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-reject-once' }
    })
    expect(fake.notifications).toContainEqual({
      method: 'session/cancel',
      params: { sessionId: 'acp-sess-1' }
    })
  })

  it('answers cancelled when the agent offers no option matching the decision', async () => {
    const { store, fake, runtime } = await seedWithPrompt()
    const reply = requestPermission(
      fake,
      permissionParams(ALL_OPTIONS.filter((o) => o.kind.startsWith('reject')))
    )

    expect(runtime.resolveApproval('s1-perm-1', { behavior: 'allow' })).toBe(true)
    await expect(reply).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(store.getSnapshot().state.jsonClaude.pendingApprovals).toEqual({})
  })

  it('auto-allows a tool already granted for the session without raising a card', async () => {
    const { store, events, fake } = await seedWithPrompt()
    grantForSession(store, 'execute')

    await expect(requestPermission(fake)).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-allow-always' }
    })
    expect(eventsOf(events, 'jsonClaude/approvalRequested')).toHaveLength(0)
  })

  it('auto-allow uses allow_once when the agent offers no allow_always', async () => {
    const { store, events, fake } = await seedWithPrompt()
    grantForSession(store, 'execute')

    await expect(
      requestPermission(fake, permissionParams(ALL_OPTIONS.filter((o) => o.kind !== 'allow_always')))
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'opt-allow-once' } })
    expect(eventsOf(events, 'jsonClaude/approvalRequested')).toHaveLength(0)
  })

  it('a session grant for a different tool still raises a card', async () => {
    const { store, fake } = await seedWithPrompt()
    grantForSession(store, 'edit')
    const reply = trackSettled(requestPermission(fake))
    await tick()

    expect(reply.settled).toBe(false)
    expect(Object.keys(store.getSnapshot().state.jsonClaude.pendingApprovals)).toEqual([
      's1-perm-1'
    ])
  })

  it('interrupt answers every open request with cancelled and clears them from the slice', async () => {
    const { store, fake, runtime } = await seedWithPrompt()
    const first = requestPermission(fake)
    const second = requestPermission(fake)

    runtime.interrupt('s1')
    await expect(first).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    await expect(second).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(store.getSnapshot().state.jsonClaude.pendingApprovals).toEqual({})
  })

  it('kill answers open requests with cancelled and clears them from the slice', async () => {
    const { store, fake, runtime } = await seedWithPrompt()
    const reply = requestPermission(fake)

    runtime.kill('s1')
    await expect(reply).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(store.getSnapshot().state.jsonClaude.pendingApprovals).toEqual({})
  })

  it('unexpected subprocess exit answers open requests with cancelled and clears the slice', async () => {
    const { store, fake } = await seedWithPrompt()
    const reply = requestPermission(fake)

    fake.onExitCb?.(1, null)
    await expect(reply).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(store.getSnapshot().state.jsonClaude.pendingApprovals).toEqual({})
  })

  it('a request id answered once cannot be answered again', async () => {
    const { fake, runtime } = await seedWithPrompt()
    void requestPermission(fake)

    expect(runtime.resolveApproval('s1-perm-1', { behavior: 'allow' })).toBe(true)
    expect(runtime.resolveApproval('s1-perm-1', { behavior: 'deny' })).toBe(false)
  })

  const acceptEditsCases: Array<{ name: string; mode: 'default' | 'acceptEdits'; kind: string; options?: typeof ALL_OPTIONS; autoAllowed?: string }> = [
    { name: 'acceptEdits auto-allows an edit with allow_always', mode: 'acceptEdits', kind: 'edit', autoAllowed: 'opt-allow-always' },
    {
      name: 'acceptEdits auto-allows an edit with allow_once when no allow_always is offered',
      mode: 'acceptEdits',
      kind: 'edit',
      options: ALL_OPTIONS.filter((o) => o.kind !== 'allow_always'),
      autoAllowed: 'opt-allow-once'
    },
    { name: 'acceptEdits still asks before executing a command', mode: 'acceptEdits', kind: 'execute' },
    { name: 'default mode still asks before an edit', mode: 'default', kind: 'edit' }
  ]
  for (const c of acceptEditsCases) {
    it(c.name, async () => {
      const { store, events, fake } = await seedWithPrompt()
      store.dispatch({ type: 'jsonClaude/permissionModeChanged', payload: { sessionId: 's1', mode: c.mode } })
      const reply = requestPermission(
        fake,
        permissionParams(c.options ?? ALL_OPTIONS, { toolCallId: 'c', title: 'Edit a.ts', kind: c.kind, rawInput: {} })
      )
      if (c.autoAllowed) {
        await expect(reply).resolves.toEqual({ outcome: { outcome: 'selected', optionId: c.autoAllowed } })
        expect(eventsOf(events, 'jsonClaude/approvalRequested')).toHaveLength(0)
      } else {
        const settled = trackSettled(reply)
        await tick()
        expect(settled.settled).toBe(false)
        expect(Object.keys(store.getSnapshot().state.jsonClaude.pendingApprovals)).toEqual(['s1-perm-1'])
      }
    })
  }

  it('returns false for an unknown request id and leaves open requests pending', async () => {
    const { store, fake, runtime } = await seedWithPrompt()
    const reply = trackSettled(requestPermission(fake))

    expect(runtime.resolveApproval('s1-perm-99', { behavior: 'allow' })).toBe(false)
    await tick()
    expect(reply.settled).toBe(false)
    expect(Object.keys(store.getSnapshot().state.jsonClaude.pendingApprovals)).toEqual([
      's1-perm-1'
    ])
  })
})

describe('AcpStdioRuntime capabilities', () => {
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

  it('rewind is refused', () => {
    const { runtime } = seed()
    expect(runtime.rewindTo('s1', 'x')).toEqual({
      ok: false,
      reason: expect.any(String)
    })
  })

  it('merges canSetPermissionMode from session/new modes with canResume from initialize', async () => {
    const { fake, runtime } = seed({
      initResult: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } }
    })
    fake.newResult = {
      sessionId: 'acp-sess-1',
      modes: { availableModes: [{ id: 'agent', name: 'Agent' }], currentModeId: 'agent' }
    }
    runtime.send('s1', 'hi')
    await tick()
    expect(runtime.getCapabilities('s1')).toMatchObject({ canResume: true, canSetPermissionMode: true })
  })

  it('leaves canSetPermissionMode off when the agent offers no modes', async () => {
    const { runtime } = seed()
    runtime.send('s1', 'hi')
    await tick()
    expect(runtime.getCapabilities('s1').canSetPermissionMode).toBe(false)
  })
})

describe('acpModeFor', () => {
  const modes = (...ids: string[]) => ids.map((id) => ({ id, name: id }))
  const cases: Array<{ name: string; mode: 'plan' | 'default' | 'acceptEdits'; modes: Array<{ id: string; name: string }>; expected: string | undefined }> = [
    { name: 'plan prefers read-only over plan', mode: 'plan', modes: modes('plan', 'read-only', 'agent'), expected: 'read-only' },
    { name: 'plan falls back to plan', mode: 'plan', modes: modes('agent', 'plan'), expected: 'plan' },
    { name: 'plan never maps to a write mode', mode: 'plan', modes: modes('agent', 'default'), expected: undefined },
    { name: 'default prefers agent', mode: 'default', modes: modes('auto', 'default', 'agent'), expected: 'agent' },
    { name: 'default falls back to default before auto', mode: 'default', modes: modes('auto', 'default'), expected: 'default' },
    { name: 'acceptEdits falls back to auto', mode: 'acceptEdits', modes: modes('read-only', 'auto'), expected: 'auto' },
    { name: 'full access is never selected', mode: 'default', modes: modes('read-only', 'agent-full-access'), expected: undefined },
    { name: 'no modes yields nothing', mode: 'acceptEdits', modes: [], expected: undefined }
  ]
  for (const c of cases) {
    it(c.name, () => {
      expect(acpModeFor(c.mode, c.modes)).toBe(c.expected)
    })
  }
})

describe('permissionModeForAcp', () => {
  const CODEX = [
    { id: 'read-only', name: 'Read Only' },
    { id: 'agent', name: 'Agent' },
    { id: 'agent-full-access', name: 'Agent (full access)' }
  ]
  const cases: Array<{ name: string; modeId: string; current: 'plan' | 'default' | 'acceptEdits'; modes: Array<{ id: string; name: string }>; expected: string }> = [
    { name: 'acceptEdits survives the echo of its own agent mode', modeId: 'agent', current: 'acceptEdits', modes: CODEX, expected: 'acceptEdits' },
    { name: 'acceptEdits becomes plan on read-only', modeId: 'read-only', current: 'acceptEdits', modes: CODEX, expected: 'plan' },
    { name: 'plan survives the echo of read-only', modeId: 'read-only', current: 'plan', modes: CODEX, expected: 'plan' },
    { name: 'plan becomes default on agent', modeId: 'agent', current: 'plan', modes: CODEX, expected: 'default' },
    { name: 'default becomes plan on an agent plan mode', modeId: 'plan', current: 'default', modes: [{ id: 'plan', name: 'Plan' }, { id: 'build', name: 'Build' }], expected: 'plan' },
    { name: 'acceptEdits becomes default on a mode it does not map to', modeId: 'agent-full-access', current: 'acceptEdits', modes: CODEX, expected: 'default' },
    { name: 'plan becomes default on an unrecognised mode', modeId: 'build', current: 'plan', modes: [{ id: 'plan', name: 'Plan' }, { id: 'build', name: 'Build' }], expected: 'default' }
  ]
  for (const c of cases) {
    it(c.name, () => {
      expect(permissionModeForAcp(c.modeId, c.current, c.modes)).toBe(c.expected)
    })
  }
})

describe('currentModelOf', () => {
  const cases: Array<{ name: string; options: Array<{ id: string; currentValue?: unknown }> | null; expected: string | null }> = [
    { name: 'reads the model option value', options: [{ id: 'effort', currentValue: 'low' }, { id: 'model', currentValue: 'gpt-5' }], expected: 'gpt-5' },
    { name: 'null for no options', options: null, expected: null },
    { name: 'null without a model option', options: [{ id: 'effort', currentValue: 'low' }], expected: null },
    { name: 'null for an empty model value', options: [{ id: 'model', currentValue: '' }], expected: null },
    { name: 'null for a non-string model value', options: [{ id: 'model', currentValue: 5 }], expected: null },
    { name: 'null for a missing model value', options: [{ id: 'model' }], expected: null }
  ]
  for (const c of cases) {
    it(c.name, () => {
      expect(currentModelOf(c.options)).toBe(c.expected)
    })
  }
})

describe('AcpStdioRuntime permission mode + model sync', () => {
  const CODEX_MODES = {
    availableModes: [
      { id: 'read-only', name: 'Read Only' },
      { id: 'agent', name: 'Agent' },
      { id: 'agent-full-access', name: 'Agent (full access)' }
    ],
    currentModeId: 'agent'
  }

  function setModeRequests(fake: FakeAcpClient) {
    return fake.requests.filter((r) => r.method === 'session/set_mode').map((r) => r.params)
  }

  function setModelRequests(fake: FakeAcpClient) {
    return fake.requests.filter((r) => r.method === 'session/set_config_option').map((r) => r.params)
  }

  it("pushes the slice's plan mode to the agent as read-only on the ACP session id", async () => {
    const { store, fake, runtime } = seed()
    store.dispatch({ type: 'jsonClaude/permissionModeChanged', payload: { sessionId: 's1', mode: 'plan' } })
    fake.newResult = { sessionId: 'acp-sess-1', modes: CODEX_MODES }
    runtime.send('s1', 'hi')
    await tick()
    expect(setModeRequests(fake)).toEqual([{ sessionId: 'acp-sess-1', modeId: 'read-only' }])
  })

  it('pushes the mode from a session/load result too', async () => {
    const { fake, runtime } = seed({
      agentSessionId: 'prev-acp',
      initResult: { protocolVersion: 1, agentCapabilities: { loadSession: true } }
    })
    fake.responders['session/load'] = () => Promise.resolve({ modes: CODEX_MODES })
    runtime.send('s1', 'hi')
    await tick()
    expect(setModeRequests(fake)).toEqual([{ sessionId: 'prev-acp', modeId: 'agent' }])
  })

  it('sends no set_mode when the agent offers no matching mode', async () => {
    const { store, fake, runtime } = seed()
    store.dispatch({ type: 'jsonClaude/permissionModeChanged', payload: { sessionId: 's1', mode: 'plan' } })
    fake.newResult = { sessionId: 'acp-sess-1', modes: { availableModes: [{ id: 'agent', name: 'Agent' }] } }
    runtime.send('s1', 'hi')
    await tick()
    expect(setModeRequests(fake)).toEqual([])
  })

  it('setPermissionMode later sends set_mode for the mapped mode', async () => {
    const { fake, runtime } = seed()
    fake.newResult = { sessionId: 'acp-sess-1', modes: CODEX_MODES }
    runtime.send('s1', 'hi')
    await tick()
    runtime.setPermissionMode('s1', 'plan')
    expect(setModeRequests(fake).at(-1)).toEqual({ sessionId: 'acp-sess-1', modeId: 'read-only' })
  })

  it('setPermissionMode sends nothing when the agent has no modes', async () => {
    const { fake, runtime } = seed()
    runtime.send('s1', 'hi')
    await tick()
    runtime.setPermissionMode('s1', 'plan')
    expect(setModeRequests(fake)).toEqual([])
  })

  it('setPermissionMode sends nothing while the ACP session is dropped awaiting login', async () => {
    const { fake, runtime } = seed()
    fake.newResult = { sessionId: 'acp-sess-1', modes: CODEX_MODES }
    runtime.send('s1', 'hi')
    await tick()
    fake.rejectPrompt(new AcpRequestError('Authentication required', ACP_AUTH_REQUIRED))
    await tick()
    runtime.setPermissionMode('s1', 'plan')
    expect(setModeRequests(fake)).toEqual([{ sessionId: 'acp-sess-1', modeId: 'agent' }])
  })

  it("sets the tab's model pin when the agent's current model differs", async () => {
    const { fake, runtime } = seed({ modelOverride: 'gpt-5' })
    fake.newResult = {
      sessionId: 'acp-sess-1',
      configOptions: [{ id: 'model', type: 'select', currentValue: 'gpt-4' }]
    }
    runtime.send('s1', 'hi')
    await tick()
    expect(setModelRequests(fake)).toEqual([
      { sessionId: 'acp-sess-1', configOptionId: 'model', value: 'gpt-5' }
    ])
  })

  const noModelCases: Array<{ name: string; modelOverride?: string; configOptions?: unknown }> = [
    { name: 'the current model already matches', modelOverride: 'gpt-5', configOptions: [{ id: 'model', currentValue: 'gpt-5' }] },
    { name: 'the agent exposes no model option', modelOverride: 'gpt-5', configOptions: [{ id: 'effort', currentValue: 'low' }] },
    { name: 'no override was given', configOptions: [{ id: 'model', currentValue: 'gpt-4' }] }
  ]
  for (const c of noModelCases) {
    it(`sends no model change when ${c.name}`, async () => {
      const { fake, runtime } = seed({ modelOverride: c.modelOverride })
      fake.newResult = { sessionId: 'acp-sess-1', configOptions: c.configOptions }
      runtime.send('s1', 'hi')
      await tick()
      expect(setModelRequests(fake)).toEqual([])
    })
  }
})

describe('AcpStdioRuntime session continuity (session/load)', () => {
  const LOADABLE = { protocolVersion: 1, agentCapabilities: { loadSession: true } }

  function slice(store: Store) {
    return store.getSnapshot().state.jsonClaude.sessions['s1']
  }

  function transcript(store: Store): Array<{ kind: string; text: string }> {
    return slice(store).entries.map((e: any) => ({
      kind: e.kind,
      text: e.kind === 'assistant' ? (e.blocks ?? []).map((b: any) => b.text ?? b.name).join('|') : (e.text ?? e.errorKind)
    }))
  }

  /** session/load streams these updates as history, then resolves. */
  function replaying(fake: FakeAcpClient, updates: any[], result: any = {}) {
    fake.responders['session/load'] = () => {
      for (const u of updates) fake.pushUpdate(u, 'prev-acp')
      return Promise.resolve(result)
    }
  }

  const HISTORY = [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'first ' } },
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'question' } },
    { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'first answer' } },
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'second question' } }
  ]

  it('loads the previous agent session and prompts on it instead of creating a new one', async () => {
    const { fake, runtime } = seed({ agentSessionId: 'prev-acp', initResult: LOADABLE })
    runtime.send('s1', 'continue')
    await tick()

    expect(fake.requests.map((r) => r.method)).toEqual(['initialize', 'session/load', 'session/prompt'])
    expect(fake.requests[1].params).toEqual({ sessionId: 'prev-acp', cwd: '/wt', mcpServers: [] })
    expect(fake.requests[2].params.sessionId).toBe('prev-acp')
  })

  const newSessionCases = [
    { name: 'the agent cannot load sessions', agentSessionId: 'prev-acp', initResult: { protocolVersion: 1, agentCapabilities: {} } },
    { name: 'loadSession is truthy but not true', agentSessionId: 'prev-acp', initResult: { protocolVersion: 1, agentCapabilities: { loadSession: {} } } },
    { name: 'there is no previous agent session', agentSessionId: undefined, initResult: LOADABLE }
  ]
  for (const c of newSessionCases) {
    it(`creates a new session when ${c.name}`, async () => {
      const { fake, runtime } = seed({ agentSessionId: c.agentSessionId, initResult: c.initResult })
      runtime.send('s1', 'hi')
      await tick()
      expect(fake.requests.map((r) => r.method)).toEqual(['initialize', 'session/new', 'session/prompt'])
      expect(fake.requests[2].params.sessionId).toBe('acp-sess-1')
    })
  }

  it('records the id of a newly created session on the slice', async () => {
    const { store, runtime } = seed()
    runtime.send('s1', 'hi')
    await tick()
    expect(slice(store).agentSessionId).toBe('acp-sess-1')
  })

  it('rebuilds the transcript from the replay on a fresh slice, before the new prompt', async () => {
    const { store, fake, runtime } = seed({
      agentSessionId: 'prev-acp',
      initResult: LOADABLE,
      flushIntervalMs: 10_000
    })
    replaying(fake, HISTORY)
    runtime.send('s1', 'continue')
    await tick()

    expect(transcript(store)).toEqual([
      { kind: 'user', text: 'first question' },
      { kind: 'assistant', text: 'first answer' },
      { kind: 'user', text: 'second question' },
      { kind: 'user', text: 'continue' }
    ])
  })

  it('drops the replay when the slice already holds the transcript', async () => {
    const { store, fake, runtime } = seed({
      agentSessionId: 'prev-acp',
      initResult: LOADABLE,
      flushIntervalMs: 10_000
    })
    store.dispatch({
      type: 'jsonClaude/entryAppended',
      payload: { sessionId: 's1', entry: { entryId: 'prior', kind: 'user', text: 'prior', timestamp: 0 } }
    })
    replaying(fake, [
      ...HISTORY,
      { sessionUpdate: 'tool_call', toolCallId: 'old_call', title: 'Read', kind: 'read', rawInput: {} }
    ])
    runtime.send('s1', 'continue')
    await tick()

    expect(transcript(store)).toEqual([
      { kind: 'user', text: 'prior' },
      { kind: 'user', text: 'continue' }
    ])
  })

  it('after a silent replay, live agent output still renders', async () => {
    const { store, fake, runtime } = seed({
      agentSessionId: 'prev-acp',
      initResult: LOADABLE,
      flushIntervalMs: 10_000
    })
    replaying(fake, HISTORY)
    runtime.send('s1', 'continue')
    await tick()
    fake.pushUpdate({ sessionUpdate: 'agent_message_chunk', messageId: 'm9', content: { type: 'text', text: 'live' } }, 'prev-acp')
    fake.resolvePrompt('end_turn')
    await tick()

    expect(transcript(store).at(-1)).toEqual({ kind: 'assistant', text: 'live' })
  })

  it('a failed load leaves a notice naming the agent, then starts a new session', async () => {
    const { store, fake, runtime } = seed({ agentSessionId: 'prev-acp', initResult: LOADABLE })
    fake.responders['session/load'] = () => Promise.reject(new AcpRequestError('session not found', -32603))
    runtime.send('s1', 'continue')
    await tick()

    const notices = slice(store).entries.filter((e) => e.errorKind === 'session-load-failed')
    expect(notices).toHaveLength(1)
    expect(notices[0].kind).toBe('system')
    expect(notices[0].errorMessage).toContain('opencode')
    expect(fake.requests.map((r) => r.method)).toEqual([
      'initialize',
      'session/load',
      'session/new',
      'session/prompt'
    ])
    expect(fake.requests[3].params.sessionId).toBe('acp-sess-1')
    expect(slice(store).agentSessionId).toBe('acp-sess-1')
    expect(slice(store).state).toBe('running')
  })
})

describe('AcpStdioRuntime session metadata updates', () => {
  const CODEX_MODES = {
    availableModes: [
      { id: 'read-only', name: 'Read Only' },
      { id: 'agent', name: 'Agent' },
      { id: 'agent-full-access', name: 'Agent (full access)' }
    ],
    currentModeId: 'agent'
  }
  const LOADABLE = { protocolVersion: 1, agentCapabilities: { loadSession: true } }
  const modelOption = (value: string) => [{ id: 'model', type: 'select', currentValue: value }]
  const usd = (amount: unknown) => ({ sessionUpdate: 'usage_update', used: 1000, size: 200000, cost: { amount, currency: 'USD' } })

  function usageOf(events: StateEvent[]): any[] {
    return eventsOf(events, 'costs/usageUpdated').map((e: any) => e.payload)
  }

  async function started(newResult: any = { sessionId: 'acp-sess-1' }) {
    const seeded = seed()
    seeded.fake.newResult = newResult
    seeded.runtime.send('s1', 'hi')
    await tick()
    return seeded
  }

  describe('session_info_update', () => {
    it('dispatches the trimmed title for the tab session', async () => {
      const { store, events, fake } = await started()
      fake.pushUpdate({ sessionUpdate: 'session_info_update', title: '  Fix the parser  ' })
      expect(eventsOf(events, 'jsonClaude/sessionTitleChanged').map((e: any) => e.payload)).toEqual([
        { sessionId: 's1', title: 'Fix the parser' }
      ])
      expect(store.getSnapshot().state.jsonClaude.sessions['s1'].title).toBe('Fix the parser')
    })

    const blankCases = [
      { name: 'an empty title', title: '' },
      { name: 'a whitespace title', title: '   ' },
      { name: 'a non-string title', title: 42 },
      { name: 'no title', title: undefined }
    ]
    for (const c of blankCases) {
      it(`dispatches nothing for ${c.name}`, async () => {
        const { events, fake } = await started()
        fake.pushUpdate({ sessionUpdate: 'session_info_update', title: c.title })
        expect(eventsOf(events, 'jsonClaude/sessionTitleChanged')).toEqual([])
      })
    }
  })

  describe('current_mode_update', () => {
    function modeChanges(events: StateEvent[]) {
      return eventsOf(events, 'jsonClaude/permissionModeChanged').map((e: any) => e.payload)
    }

    it('moves the slice to plan when the agent switches itself to read-only', async () => {
      const { store, events, fake } = await started({ sessionId: 'acp-sess-1', modes: CODEX_MODES })
      fake.pushUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'read-only' })
      expect(modeChanges(events)).toEqual([{ sessionId: 's1', mode: 'plan' }])
      expect(store.getSnapshot().state.jsonClaude.sessions['s1'].permissionMode).toBe('plan')
    })

    it('moves the slice out of plan when the agent switches to agent', async () => {
      const { store, events, fake, runtime } = seed()
      store.dispatch({ type: 'jsonClaude/permissionModeChanged', payload: { sessionId: 's1', mode: 'plan' } })
      fake.newResult = { sessionId: 'acp-sess-1', modes: CODEX_MODES }
      runtime.send('s1', 'hi')
      await tick()
      const before = modeChanges(events).length
      fake.pushUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'agent' })
      expect(modeChanges(events).slice(before)).toEqual([{ sessionId: 's1', mode: 'default' }])
    })

    it('dispatches nothing when the agent echoes the mode Tatsu set', async () => {
      const { store, events, fake, runtime } = seed()
      store.dispatch({ type: 'jsonClaude/permissionModeChanged', payload: { sessionId: 's1', mode: 'plan' } })
      fake.newResult = { sessionId: 'acp-sess-1', modes: CODEX_MODES }
      runtime.send('s1', 'hi')
      await tick()
      const before = modeChanges(events).length
      fake.pushUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'read-only' })
      expect(modeChanges(events).slice(before)).toEqual([])
    })

    it('keeps acceptEdits when the agent echoes agent', async () => {
      const { store, events, fake, runtime } = seed()
      store.dispatch({ type: 'jsonClaude/permissionModeChanged', payload: { sessionId: 's1', mode: 'acceptEdits' } })
      fake.newResult = { sessionId: 'acp-sess-1', modes: CODEX_MODES }
      runtime.send('s1', 'hi')
      await tick()
      const before = modeChanges(events).length
      fake.pushUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'agent' })
      expect(modeChanges(events).slice(before)).toEqual([])
      expect(store.getSnapshot().state.jsonClaude.sessions['s1'].permissionMode).toBe('acceptEdits')
    })

    it('dispatches nothing when the agent returned no modes at session/new', async () => {
      const { events, fake } = await started()
      fake.pushUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'read-only' })
      expect(modeChanges(events)).toEqual([])
    })
  })

  describe('usage_update', () => {
    it('records the session cost under the current model and turns on cost tracking', async () => {
      const { events, fake, runtime } = await started({ sessionId: 'acp-sess-1', configOptions: modelOption('gpt-5') })
      fake.pushUpdate(usd(0.25))
      const usage = usageOf(events)
      expect(usage).toHaveLength(1)
      expect(usage[0].terminalId).toBe('s1')
      expect(usage[0].usage).toMatchObject({
        sessionId: 's1',
        transcriptPath: 'acp:opencode:acp-sess-1',
        currentModel: 'gpt-5',
        byModel: { 'gpt-5': { messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.25 } }
      })
      expect(Object.keys(usage[0].usage.byModel)).toEqual(['gpt-5'])
      expect(runtime.getCapabilities('s1').hasCostTracking).toBe(true)
    })

    it('files the cost under the agent kind when the agent names no model', async () => {
      const { events, fake } = await started()
      fake.pushUpdate(usd(0.1))
      const [{ usage }] = usageOf(events)
      expect(usage.currentModel).toBeNull()
      expect(Object.keys(usage.byModel)).toEqual(['opencode'])
      expect(usage.byModel.opencode.cost).toBe(0.1)
    })

    it('replaces the cost with each larger cumulative amount and skips a repeat', async () => {
      const { events, fake } = await started()
      fake.pushUpdate(usd(0.1))
      fake.pushUpdate(usd(0.1))
      fake.pushUpdate(usd(0.35))
      expect(usageOf(events).map((p) => p.usage.byModel.opencode.cost)).toEqual([0.1, 0.35])
    })

    const ignoredCases = [
      { name: 'cost is null (Codex)', update: { sessionUpdate: 'usage_update', used: 10, size: 100, cost: null } },
      { name: 'cost is absent', update: { sessionUpdate: 'usage_update', used: 10, size: 100 } },
      { name: 'the currency is not USD', update: { sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: 1, currency: 'EUR' } } },
      { name: 'the amount is NaN', update: usd(Number.NaN) },
      { name: 'the amount is infinite', update: usd(Number.POSITIVE_INFINITY) },
      { name: 'the amount is a string', update: usd('0.5') }
    ]
    for (const c of ignoredCases) {
      it(`records nothing when ${c.name}`, async () => {
        const { events, fake, runtime } = await started()
        fake.pushUpdate(c.update)
        expect(usageOf(events)).toEqual([])
        expect(runtime.getCapabilities('s1').hasCostTracking).toBe(false)
      })
    }
  })

  describe('config_option_update', () => {
    it('re-files the reported cost under the newly selected model', async () => {
      const { events, fake } = await started({ sessionId: 'acp-sess-1', configOptions: modelOption('gpt-5') })
      fake.pushUpdate(usd(0.4))
      fake.pushUpdate({ sessionUpdate: 'config_option_update', configOptions: modelOption('gpt-5-mini') })
      const usage = usageOf(events)
      expect(usage).toHaveLength(2)
      expect(usage[1].usage.currentModel).toBe('gpt-5-mini')
      expect(usage[1].usage.byModel).toEqual({
        'gpt-5-mini': { messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.4 }
      })
    })

    it('names the new model on costs reported after the switch', async () => {
      const { events, fake } = await started({ sessionId: 'acp-sess-1', configOptions: modelOption('gpt-5') })
      fake.pushUpdate({ sessionUpdate: 'config_option_update', configOptions: modelOption('gpt-5-mini') })
      fake.pushUpdate(usd(0.2))
      const [{ usage }] = usageOf(events)
      expect(usage.currentModel).toBe('gpt-5-mini')
      expect(Object.keys(usage.byModel)).toEqual(['gpt-5-mini'])
    })

    it('records nothing to costs before any cost was reported', async () => {
      const { events, fake } = await started({ sessionId: 'acp-sess-1', configOptions: modelOption('gpt-5') })
      fake.pushUpdate({ sessionUpdate: 'config_option_update', configOptions: modelOption('gpt-5-mini') })
      expect(usageOf(events)).toEqual([])
    })

    it('records nothing when the model is unchanged', async () => {
      const { events, fake } = await started({ sessionId: 'acp-sess-1', configOptions: modelOption('gpt-5') })
      fake.pushUpdate(usd(0.4))
      fake.pushUpdate({ sessionUpdate: 'config_option_update', configOptions: modelOption('gpt-5') })
      expect(usageOf(events)).toHaveLength(1)
    })
  })

  it('takes a session title pushed during a silent session/load replay', async () => {
    const { store, events, fake, runtime } = seed({ agentSessionId: 'prev-acp', initResult: LOADABLE })
    store.dispatch({
      type: 'jsonClaude/entryAppended',
      payload: { sessionId: 's1', entry: { entryId: 'prior', kind: 'user', text: 'prior', timestamp: 0 } }
    })
    fake.responders['session/load'] = () => {
      fake.pushUpdate({ sessionUpdate: 'session_info_update', title: 'Earlier work' }, 'prev-acp')
      return Promise.resolve({})
    }
    runtime.send('s1', 'continue')
    await tick()
    expect(eventsOf(events, 'jsonClaude/sessionTitleChanged').map((e: any) => e.payload)).toEqual([
      { sessionId: 's1', title: 'Earlier work' }
    ])
  })
})

describe('defaultAcpStdioCapabilities', () => {
  it('returns a fresh object each call', () => {
    expect(defaultAcpStdioCapabilities()).not.toBe(defaultAcpStdioCapabilities())
  })
})
describe('AcpStdioRuntime launch resolution', () => {
  function seedLaunch(launch: () => { command: string[]; env?: NodeJS.ProcessEnv }) {
    const { store, events } = createStore()
    const clients: Array<{ fake: FakeAcpClient; command: string[]; env?: NodeJS.ProcessEnv }> = []
    const runtime = new AcpStdioRuntime(store, {
      agentKind: 'opencode',
      launch,
      flushIntervalMs: 5,
      createClient: (opts) => {
        const fake = new FakeAcpClient()
        clients.push({ fake, command: opts.command, env: opts.env })
        return fake as any
      }
    })
    store.dispatch({
      type: 'jsonClaude/sessionStarted',
      payload: { sessionId: 's1', worktreePath: '/wt', agentKind: 'opencode', runtimeId: 'opencode' }
    })
    runtime.start('s1', '/wt')
    return { store, events, runtime, clients }
  }

  function errorEntries(events: StateEvent[]): any[] {
    return events
      .filter((e) => e.type === 'jsonClaude/entryAppended' && (e as any).payload.entry.kind === 'error')
      .map((e) => (e as any).payload.entry)
  }

  function sessionStates(events: StateEvent[]): string[] {
    return events
      .filter((e) => e.type === 'jsonClaude/sessionStateChanged')
      .map((e) => (e as any).payload.state)
  }

  it('resolves the command at spawn time, so a launch config that changes after construction is used', async () => {
    let current: { command: string[]; env?: NodeJS.ProcessEnv } = {
      command: ['/before/opencode', 'acp']
    }
    const { runtime, clients } = seedLaunch(() => current)
    current = { command: ['/downloaded/opencode', 'acp'], env: { FOO: '1' } }

    runtime.send('s1', 'hi')
    await tick()

    expect(clients).toHaveLength(1)
    expect(clients[0].command).toEqual(['/downloaded/opencode', 'acp'])
    expect(clients[0].env).toEqual({ FOO: '1' })
  })

  it('construction and start succeed while the runtime is missing; send surfaces a runtime-missing card', async () => {
    const { events, runtime, clients } = seedLaunch(() => {
      throw new RuntimeMissingError('opencode')
    })
    expect(sessionStates(events)).toEqual(['idle'])

    const snap = events.length
    runtime.send('s1', 'hi')
    await tick()

    const post = events.slice(snap)
    expect(clients).toHaveLength(0)
    const errors = errorEntries(post)
    expect(errors).toHaveLength(1)
    expect(errors[0].errorKind).toBe('runtime-missing')
    expect(sessionStates(post)).not.toContain('idle')
    expect(sessionStates(post).at(-1)).toBe('exited')
    expect(runtime.hasSession('s1')).toBe(false)
  })

  it('after a runtime-missing failure, the next send spawns with the now-available runtime', async () => {
    let installed: string | null = null
    const { runtime, clients } = seedLaunch(() => {
      if (!installed) throw new RuntimeMissingError('opencode')
      return { command: [installed, 'acp'] }
    })
    runtime.send('s1', 'first')
    await tick()
    expect(clients).toHaveLength(0)

    installed = '/userData/runtimes/opencode-linux-x64@1.0.0/bin/opencode'
    runtime.send('s1', 'second')
    await tick()

    expect(clients).toHaveLength(1)
    expect(clients[0].command).toEqual([installed, 'acp'])
    expect(clients[0].fake.requests.map((r) => r.method)).toEqual([
      'initialize',
      'session/new',
      'session/prompt'
    ])
  })

  it('a new session after kill spawns with the latest launch result', async () => {
    let path = '/first/opencode'
    const { runtime, clients } = seedLaunch(() => ({ command: [path, 'acp'] }))
    runtime.send('s1', 'one')
    await tick()
    clients[0].fake.resolvePrompt('end_turn')
    await tick()

    runtime.kill('s1')
    path = '/second/opencode'
    runtime.send('s1', 'two')
    await tick()

    expect(clients.map((c) => c.command)).toEqual([
      ['/first/opencode', 'acp'],
      ['/second/opencode', 'acp']
    ])
  })

  it('a non-runtime-missing launch failure keeps the generic subprocess-exit card', async () => {
    const { events, runtime } = seedLaunch(() => {
      throw new Error('resolver exploded')
    })
    runtime.send('s1', 'hi')
    await tick()

    const errors = errorEntries(events)
    expect(errors).toHaveLength(1)
    expect(errors[0].errorKind).toBe('subprocess-exit')
    expect(errors[0].errorMessage).toContain('resolver exploded')
  })

  it('throws at construction when neither command nor launch is given', () => {
    const { store } = createStore()
    expect(() => new AcpStdioRuntime(store, { agentKind: 'opencode' })).toThrow(/command or launch/)
  })
})

describe('parseAuthMethods', () => {
  const cases: Array<{ name: string; raw: unknown; expected: unknown }> = [
    {
      name: 'an explicit terminal type is terminal',
      raw: [{ id: 'login', name: 'Login', type: 'terminal' }],
      expected: [{ id: 'login', name: 'Login', type: 'terminal' }]
    },
    {
      name: 'a description naming the terminal is terminal (OpenCode opencode-login)',
      raw: [
        {
          id: 'opencode-login',
          name: 'Login with opencode',
          description: 'Run `opencode auth login` in the terminal'
        }
      ],
      expected: [
        {
          id: 'opencode-login',
          name: 'Login with opencode',
          description: 'Run `opencode auth login` in the terminal',
          type: 'terminal'
        }
      ]
    },
    {
      name: 'a method with neither a terminal type nor description is agent-run',
      raw: [{ id: 'chat-gpt', name: 'Login with ChatGPT', description: 'Opens a browser' }],
      expected: [
        { id: 'chat-gpt', name: 'Login with ChatGPT', description: 'Opens a browser', type: 'agent' }
      ]
    },
    {
      name: 'a word merely containing "terminal" does not make it terminal',
      raw: [{ id: 'x', name: 'X', description: 'Uses terminals-api tokens' }],
      expected: [{ id: 'x', name: 'X', description: 'Uses terminals-api tokens', type: 'agent' }]
    },
    {
      name: 'a missing or empty name falls back to the id',
      raw: [{ id: 'api-key' }, { id: 'other', name: '' }],
      expected: [
        { id: 'api-key', name: 'api-key', type: 'agent' },
        { id: 'other', name: 'other', type: 'agent' }
      ]
    },
    {
      name: 'malformed entries are skipped and valid neighbours kept',
      raw: [null, 'api-key', { name: 'no id' }, { id: 7 }, { id: 'ok', name: 'OK' }],
      expected: [{ id: 'ok', name: 'OK', type: 'agent' }]
    },
    { name: 'a non-array yields no methods', raw: { id: 'x' }, expected: [] }
  ]

  for (const c of cases) {
    it(c.name, () => {
      expect(parseAuthMethods(c.raw)).toEqual(c.expected)
    })
  }
})

describe('AcpStdioRuntime login (auth required)', () => {
  const AUTH_METHODS = [
    { id: 'chat-gpt', name: 'Login with ChatGPT', description: 'Opens a browser' },
    { id: 'api-key', name: 'Use an API key' },
    {
      id: 'opencode-login',
      name: 'Login with opencode',
      description: 'Run `opencode auth login` in the terminal'
    }
  ]

  const authRequired = () => new AcpRequestError('Authentication required', ACP_AUTH_REQUIRED)

  /** Every spawn gets a fresh FakeAcpClient, recorded in `clients`, so a
   *  restart is observable. `configure` runs on each before it is used. */
  function seedAuth(
    opts: {
      initResult?: any
      configure?: (fake: FakeAcpClient, index: number) => void
    } = {}
  ) {
    const { store, events } = createStore()
    const clients: FakeAcpClient[] = []
    let launches = 0
    const runtime = new AcpStdioRuntime(store, {
      agentKind: 'codex',
      launch: () => {
        launches++
        return { command: ['codex-acp'] }
      },
      flushIntervalMs: 5,
      createClient: () => {
        const fake = new FakeAcpClient()
        fake.initResult = opts.initResult ?? {
          protocolVersion: 1,
          agentCapabilities: {},
          authMethods: AUTH_METHODS
        }
        opts.configure?.(fake, clients.length)
        clients.push(fake)
        return fake as any
      }
    })
    store.dispatch({
      type: 'jsonClaude/sessionStarted',
      payload: { sessionId: 's1', worktreePath: '/wt', agentKind: 'codex', runtimeId: 'codex' }
    })
    runtime.start('s1', '/wt')
    return { store, events, runtime, clients, launches: () => launches }
  }

  /** session/new fails with auth-required until `loggedIn.value` is set. */
  function gatedSessionNew(fake: FakeAcpClient, loggedIn: { value: boolean }): void {
    fake.responders['session/new'] = () =>
      loggedIn.value ? Promise.resolve({ sessionId: 'acp-sess-1' }) : Promise.reject(authRequired())
  }

  function slice(store: Store) {
    return store.getSnapshot().state.jsonClaude.sessions['s1']
  }

  function authCards(store: Store): any[] {
    return slice(store).entries.filter((e) => e.kind === 'error' && e.errorKind === 'auth-failure')
  }

  function userEntries(store: Store): any[] {
    return slice(store).entries.filter((e) => e.kind === 'user')
  }

  function sessionStates(events: StateEvent[]): string[] {
    return events
      .filter((e) => e.type === 'jsonClaude/sessionStateChanged')
      .map((e) => (e as any).payload.state)
  }

  /** Seed a session whose first prompt was parked on an auth failure. */
  async function seedParked(opts: { configure?: (fake: FakeAcpClient, index: number) => void } = {}) {
    const loggedIn = { value: false }
    const seeded = seedAuth({
      configure: (fake, i) => {
        gatedSessionNew(fake, loggedIn)
        opts.configure?.(fake, i)
      }
    })
    seeded.runtime.send('s1', 'fix the bug')
    await tick()
    expect(authCards(seeded.store)).toHaveLength(1)
    return { ...seeded, loggedIn }
  }

  describe('initialize capabilities', () => {
    it('advertises canOpenAuthLogin when the agent offers a terminal login', async () => {
      const { events, runtime } = seedAuth()
      runtime.send('s1', 'hi')
      await tick()
      const caps = eventsOf(events, 'jsonClaude/capabilitiesChanged')
      expect(caps).toHaveLength(1)
      expect((caps[0] as any).payload.capabilities.canOpenAuthLogin).toBe(true)
    })

    it('does not advertise canOpenAuthLogin when every login runs inside the agent', async () => {
      const { events, runtime } = seedAuth({
        initResult: {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { resume: {} } },
          authMethods: [AUTH_METHODS[0], AUTH_METHODS[1]]
        }
      })
      runtime.send('s1', 'hi')
      await tick()
      const caps = eventsOf(events, 'jsonClaude/capabilitiesChanged')
      expect(caps).toHaveLength(1)
      expect((caps[0] as any).payload.capabilities).toMatchObject({
        canResume: true,
        canOpenAuthLogin: false
      })
    })
  })

  describe('auth failure handling', () => {
    it('session/new auth-required shows a login card, keeps the subprocess, and goes idle', async () => {
      const { store, events, runtime, clients } = seedAuth({
        configure: (fake) => {
          fake.responders['session/new'] = () =>
            Promise.reject(new AcpRequestError('Sign in to continue', ACP_AUTH_REQUIRED))
        }
      })
      runtime.send('s1', 'hi')
      await tick()

      const cards = authCards(store)
      expect(cards).toHaveLength(1)
      expect(cards[0].errorMessage).toContain('Sign in to continue')
      expect(cards[0].authMethods).toEqual(parseAuthMethods(AUTH_METHODS))
      expect(slice(store).state).toBe('idle')
      expect(slice(store).busy).toBe(false)
      expect(sessionStates(events)).not.toContain('exited')
      expect(clients).toHaveLength(1)
      expect(clients[0].killCalls).toBe(0)
      expect(clients[0].requests.map((r) => r.method)).not.toContain('session/prompt')
      expect(runtime.hasSession('s1')).toBe(true)
    })

    const promptCases: Array<{ name: string; error: AcpRequestError; auth: boolean }> = [
      { name: 'code -32000', error: new AcpRequestError('Auth required', ACP_AUTH_REQUIRED), auth: true },
      {
        name: 'a -32603 whose message reports an expired API key',
        error: new AcpRequestError('This API key has expired', -32603),
        auth: true
      },
      {
        name: 'a -32603 saying authentication is required',
        error: new AcpRequestError('Authentication required', -32603),
        auth: true
      },
      { name: 'a -32603 with an unrelated message', error: new AcpRequestError('boom', -32603), auth: false }
    ]

    for (const c of promptCases) {
      it(`session/prompt rejecting with ${c.name} ${c.auth ? 'is' : 'is not'} treated as a login failure`, async () => {
        const { store, events, runtime, clients } = seedAuth()
        runtime.send('s1', 'hi')
        await tick()
        clients[0].rejectPrompt(c.error)
        await tick()

        const errors = slice(store).entries.filter((e) => e.kind === 'error')
        expect(errors).toHaveLength(1)
        expect(errors[0].errorMessage).toContain(c.error.message)
        if (c.auth) {
          expect(errors[0].errorKind).toBe('auth-failure')
          expect(errors[0].authMethods).toEqual(parseAuthMethods(AUTH_METHODS))
        } else {
          expect(errors[0].errorKind).not.toBe('auth-failure')
          expect(errors[0].authMethods).toBeUndefined()
        }
        expect(slice(store).state).toBe('idle')
        expect(sessionStates(events)).not.toContain('exited')
        expect(clients[0].killCalls).toBe(0)
      })
    }

    it('session/load auth-required shows the login card instead of a load-failed notice or a new session', async () => {
      const { store, runtime, clients } = seedAuth({
        initResult: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: AUTH_METHODS },
        configure: (fake) => {
          fake.responders['session/load'] = () => Promise.reject(authRequired())
        }
      })
      store.dispatch({ type: 'jsonClaude/agentSessionIdChanged', payload: { sessionId: 's1', agentSessionId: 'prev-acp' } })
      runtime.send('s1', 'hi')
      await tick()

      expect(authCards(store)).toHaveLength(1)
      expect(slice(store).entries.filter((e) => e.errorKind === 'session-load-failed')).toHaveLength(0)
      expect(clients[0].requests.map((r) => r.method)).toEqual(['initialize', 'session/load'])
      expect(slice(store).state).toBe('idle')
    })

    it('a non-auth session/new failure still terminates the session', async () => {
      const { store, events, runtime, clients } = seedAuth({
        configure: (fake) => {
          fake.responders['session/new'] = () => Promise.reject(new AcpRequestError('boom', -32603))
        }
      })
      runtime.send('s1', 'hi')
      await tick()

      expect(authCards(store)).toHaveLength(0)
      expect(sessionStates(events).at(-1)).toBe('exited')
      expect(clients[0].killCalls).toBe(1)
      expect(runtime.hasSession('s1')).toBe(false)
    })
  })

  describe('authenticate', () => {
    it('rejects an unknown session without touching any client', async () => {
      const { runtime, clients } = seedAuth()
      await expect(runtime.authenticate('nope', 'chat-gpt')).resolves.toEqual({
        ok: false,
        error: expect.any(String)
      })
      expect(clients).toHaveLength(0)
    })

    it('rejects a method the agent did not advertise without sending authenticate', async () => {
      const { runtime, clients } = await seedParked()
      await expect(runtime.authenticate('s1', 'made-up')).resolves.toEqual({
        ok: false,
        error: expect.stringContaining('made-up')
      })
      expect(clients[0].requests.map((r) => r.method)).not.toContain('authenticate')
    })

    it('refuses a terminal-only method without sending authenticate', async () => {
      const { store, runtime, clients } = await seedParked()
      const res = await runtime.authenticate('s1', 'opencode-login')
      expect(res.ok).toBe(false)
      expect(res.error).toBeTruthy()
      await tick()
      expect(clients).toHaveLength(1)
      expect(clients[0].requests.map((r) => r.method)).not.toContain('authenticate')
      expect(clients[0].requests.map((r) => r.method)).not.toContain('session/prompt')
      expect(authCards(store)).toHaveLength(1)
    })

    it('an in-agent login authenticates on the live subprocess and retries the parked prompt', async () => {
      const { store, runtime, clients, loggedIn } = await seedParked()
      clients[0].responders['authenticate'] = () => {
        loggedIn.value = true
        return Promise.resolve({})
      }
      const before = clients[0].requests.length

      await expect(runtime.authenticate('s1', 'chat-gpt')).resolves.toEqual({ ok: true })
      await tick()

      expect(clients).toHaveLength(1)
      expect(clients[0].killCalls).toBe(0)
      const after = clients[0].requests.slice(before)
      expect(after.map((r) => r.method)).toEqual(['authenticate', 'session/new', 'session/prompt'])
      expect(after[0].params).toEqual({ methodId: 'chat-gpt' })
      expect(after[2].params.prompt).toEqual([{ type: 'text', text: 'fix the bug' }])
      expect(userEntries(store)).toHaveLength(1)
      expect(slice(store).state).toBe('running')
    })

    it('api-key restarts the subprocess (ignoring the old exit) and re-initializes before authenticating', async () => {
      const { store, events, runtime, clients, loggedIn, launches } = await seedParked({
        configure: (fake) => {
          fake.responders['authenticate'] = () => {
            loggedIn.value = true
            return Promise.resolve({})
          }
        }
      })
      expect(launches()).toBe(1)

      await expect(runtime.authenticate('s1', 'api-key')).resolves.toEqual({ ok: true })
      await tick()

      expect(launches()).toBe(2)
      expect(clients).toHaveLength(2)
      expect(clients[0].killCalls).toBe(1)
      expect(clients[0].requests.map((r) => r.method)).not.toContain('authenticate')
      const fresh = clients[1].requests
      expect(fresh.map((r) => r.method)).toEqual([
        'initialize',
        'authenticate',
        'session/new',
        'session/prompt'
      ])
      expect(fresh[1].params).toEqual({ methodId: 'api-key' })
      expect(fresh[3].params.prompt).toEqual([{ type: 'text', text: 'fix the bug' }])

      // The deliberately killed subprocess exiting must not look like a crash.
      clients[0].onExitCb?.(null, 'SIGTERM')
      expect(sessionStates(events)).not.toContain('exited')
      expect(runtime.hasSession('s1')).toBe(true)
      expect(slice(store).entries.filter((e) => e.errorKind === 'subprocess-exit')).toHaveLength(0)
    })

    it('an agent-rejected login reports the error and keeps the prompt parked for the next attempt', async () => {
      const { store, runtime, clients, loggedIn } = await seedParked()
      clients[0].responders['authenticate'] = () =>
        Promise.reject(new AcpRequestError('browser login was cancelled', -32603))
      const before = clients[0].requests.length

      await expect(runtime.authenticate('s1', 'chat-gpt')).resolves.toEqual({
        ok: false,
        error: 'browser login was cancelled'
      })
      await tick()
      expect(clients[0].requests.slice(before).map((r) => r.method)).toEqual(['authenticate'])
      expect(slice(store).state).toBe('idle')

      clients[0].responders['authenticate'] = () => {
        loggedIn.value = true
        return Promise.resolve({})
      }
      await expect(runtime.authenticate('s1', 'chat-gpt')).resolves.toEqual({ ok: true })
      await tick()
      const prompts = clients[0].requests.filter((r) => r.method === 'session/prompt')
      expect(prompts).toHaveLength(1)
      expect(prompts[0].params.prompt).toEqual([{ type: 'text', text: 'fix the bug' }])
    })

    it('a message sent while parked runs normally and leaves the login card in place', async () => {
      const { store, runtime, clients } = await seedParked()
      runtime.send('s1', 'second try')
      await tick()

      expect(userEntries(store).map((e) => e.text)).toEqual(['fix the bug', 'second try'])
      expect(authCards(store).length).toBeGreaterThanOrEqual(1)
      expect(slice(store).state).toBe('idle')
      expect(slice(store).busy).toBe(false)
      expect(clients).toHaveLength(1)
      expect(clients[0].killCalls).toBe(0)
    })
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import { AcpStdioClient } from './acp-stdio-client'

/** Build a fake ChildProcess whose stdout we control, so framing behavior
 *  (split frames, multiple frames per chunk, malformed lines) is deterministic. */
function createFakeChild() {
  const out = new EventEmitter()
  const stdin = {
    written: '',
    write: vi.fn((d: string) => {
      stdin.written += d
      return true
    }),
    end: vi.fn(),
    on: vi.fn()
  }
  const child = new EventEmitter() as any
  child.stdout = out
  child.stderr = new EventEmitter()
  child.stdin = stdin
  child.pid = 4242
  child.kill = vi.fn(() => {
    child.emit('exit', null, 'SIGTERM')
  })
  return { out, stdin, child }
}

function makeClient(overrides: { spawn?: any } = {}) {
  const fake = createFakeChild()
  const client = new AcpStdioClient({
    command: ['fake-agent'],
    spawn: overrides.spawn ?? (() => fake.child)
  })
  return { client, fake }
}

/** Extract the id of the most recent JSON-RPC request written to stdin. */
function lastRequestId(fake: ReturnType<typeof createFakeChild>): number {
  const lines = fake.stdin.written.trim().split('\n')
  const last = JSON.parse(lines[lines.length - 1])
  return last.id
}

function pushFrame(fake: ReturnType<typeof createFakeChild>, obj: unknown): void {
  fake.out.emit('data', JSON.stringify(obj) + '\n')
}

describe('AcpStdioClient NDJSON framing', () => {
  it('parses multiple frames delivered in a single chunk', async () => {
    const { client, fake } = makeClient()
    const p1 = client.request('m1', {})
    const id1 = lastRequestId(fake)
    const p2 = client.request('m2', {})
    const id2 = lastRequestId(fake)
    // Two frames in one data event.
    fake.out.emit(
      'data',
      JSON.stringify({ jsonrpc: '2.0', id: id1, result: 'one' }) +
        '\n' +
        JSON.stringify({ jsonrpc: '2.0', id: id2, result: 'two' }) +
        '\n'
    )
    await expect(p1).resolves.toBe('one')
    await expect(p2).resolves.toBe('two')
  })

  it('handles a frame split across multiple chunks', async () => {
    const { client, fake } = makeClient()
    const p = client.request('m', {})
    const id = lastRequestId(fake)
    const frame = JSON.stringify({ jsonrpc: '2.0', id, result: 'split-ok' })
    // Deliver the frame in three partial writes, no newline until the end.
    fake.out.emit('data', frame.slice(0, 5))
    fake.out.emit('data', frame.slice(5, 20))
    fake.out.emit('data', frame.slice(20) + '\n')
    await expect(p).resolves.toBe('split-ok')
  })

  it('tolerates malformed JSON frames without crashing and keeps working', async () => {
    const { client, fake } = makeClient()
    const malformed: string[] = []
    client.onMalformedFrame((raw) => malformed.push(raw))
    const p = client.request('m', {})
    const id = lastRequestId(fake)
    fake.out.emit('data', 'this is not json\n')
    fake.out.emit('data', '{"broken": \n')
    pushFrame(fake, { jsonrpc: '2.0', id, result: 'still-works' })
    await expect(p).resolves.toBe('still-works')
    expect(malformed).toHaveLength(2)
  })

  it('ignores blank lines', async () => {
    const { client, fake } = makeClient()
    const p = client.request('m', {})
    const id = lastRequestId(fake)
    fake.out.emit('data', '\n\n')
    pushFrame(fake, { jsonrpc: '2.0', id, result: 'ok' })
    await expect(p).resolves.toBe('ok')
  })
})

describe('AcpStdioClient request/response', () => {
  it('resolves a request with its matching response', async () => {
    const { client, fake } = makeClient()
    const p = client.request('ping', { x: 1 })
    const id = lastRequestId(fake)
    pushFrame(fake, { jsonrpc: '2.0', id, result: { pong: true } })
    await expect(p).resolves.toEqual({ pong: true })
  })

  it('rejects a request when the agent returns a JSON-RPC error', async () => {
    const { client, fake } = makeClient()
    const p = client.request('boom', {})
    const id = lastRequestId(fake)
    pushFrame(fake, {
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: 'nope' }
    })
    await expect(p).rejects.toThrow(/nope/)
  })

  it('rejects a request that never receives a response after the configured timeout', async () => {
    const fake = createFakeChild()
    const client = new AcpStdioClient({
      command: ['fake-agent'],
      requestTimeoutMs: 20,
      spawn: () => fake.child
    })
    const p = client.request('never-answered', {})
    await expect(p).rejects.toThrow(/timed out/)
  })

  it('a per-request timeout overrides the instance default', async () => {
    const fake = createFakeChild()
    const client = new AcpStdioClient({
      command: ['fake-agent'],
      requestTimeoutMs: 500,
      spawn: () => fake.child
    })
    // Instance default (500ms) would not fire; the 20ms override should.
    const p = client.request('never', {}, 20)
    await expect(p).rejects.toThrow(/timed out/)
  })

  it('a per-request timeout of 0 disables the timeout even when the instance sets one', async () => {
    const fake = createFakeChild()
    const client = new AcpStdioClient({
      command: ['fake-agent'],
      requestTimeoutMs: 20,
      spawn: () => fake.child
    })
    // No timeout override (0) → never settles within the window, unlike the
    // 20ms instance default.
    const p = client.request('long-prompt', {}, 0)
    let settled = false
    p.then(
      () => (settled = true),
      () => (settled = true)
    )
    await new Promise((r) => setTimeout(r, 60))
    expect(settled).toBe(false)
  })

  it('dispatches notifications to the notification handler', async () => {
    const { client, fake } = makeClient()
    const seen: Array<{ method: string; params: unknown }> = []
    client.onNotification((method, params) => seen.push({ method, params }))
    pushFrame(fake, {
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 's', update: { sessionUpdate: 'plan' } }
    })
    expect(seen).toHaveLength(1)
    expect(seen[0].method).toBe('session/update')
  })
})

describe('AcpStdioClient server→client requests', () => {
  it('calls the request handler and writes the returned result', async () => {
    const { client, fake } = makeClient()
    client.onRequest((method, params) => {
      expect(method).toBe('session/request_permission')
      return { outcome: { outcome: 'cancelled' } }
    })
    pushFrame(fake, {
      jsonrpc: '2.0',
      id: 99,
      method: 'session/request_permission',
      params: { sessionId: 's' }
    })
    await new Promise((r) => setTimeout(r, 0))
    const written = JSON.parse(fake.stdin.written.trim().split('\n').pop()!)
    expect(written.id).toBe(99)
    expect(written.result).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('replies -32601 for an unknown server request method', async () => {
    const { client, fake } = makeClient()
    pushFrame(fake, {
      jsonrpc: '2.0',
      id: 7,
      method: 'some/unknown_method',
      params: {}
    })
    await new Promise((r) => setTimeout(r, 0))
    const written = JSON.parse(fake.stdin.written.trim().split('\n').pop()!)
    expect(written.id).toBe(7)
    expect(written.error.code).toBe(-32601)
  })
})

describe('AcpStdioClient lifecycle', () => {
  it('kill() terminates the subprocess and marks the client dead', async () => {
    const { client, fake } = makeClient()
    expect(client.isDead).toBe(false)
    client.kill()
    expect(fake.child.kill).toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 0))
    expect(client.isDead).toBe(true)
  })

  it('waitForExit resolves with the exit code/signal', async () => {
    const { client, fake } = makeClient()
    const exitP = client.waitForExit()
    fake.child.emit('exit', 3, null)
    await expect(exitP).resolves.toEqual({ code: 3, signal: null })
  })

  it('rejects in-flight requests when the subprocess exits', async () => {
    const { client, fake } = makeClient()
    const p = client.request('m', {})
    fake.child.emit('exit', 1, null)
    await expect(p).rejects.toThrow(/exited/)
  })
})

describe('AcpStdioClient real subprocess (behavior)', () => {
  it('round-trips NDJSON over real pipes with a node subprocess', async () => {
    const script = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }) + '\\n');
        } else if (msg.method === 'notify-me') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { hi: true } }) + '\\n');
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: 'done' }) + '\\n');
        }
      });
    `
    const client = new AcpStdioClient({
      command: ['node', '-e', script]
    })
    const notifications: unknown[] = []
    client.onNotification((method, params) => notifications.push({ method, params }))

    const init = await client.request('initialize', { protocolVersion: 1 })
    expect(init).toEqual({ protocolVersion: 1 })

    const res = await client.request('notify-me', {})
    expect(res).toBe('done')
    expect(notifications).toHaveLength(1)
    expect((notifications[0] as any).method).toBe('session/update')

    client.kill()
    await client.waitForExit()
  })
})
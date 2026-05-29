import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { spawn } from 'child_process'

function makeFakeProc() {
  const stdout = new EventEmitter() as EventEmitter & { on: typeof EventEmitter.prototype.on }
  const stderr = new EventEmitter()
  const stdin = { write: vi.fn(), end: vi.fn() }
  const proc = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout
    stderr: typeof stderr
    stdin: typeof stdin
    kill: ReturnType<typeof vi.fn>
  }
  Object.assign(proc, { stdout, stderr, stdin, kill: vi.fn() })
  return proc
}

const spawnedProcs: ReturnType<typeof makeFakeProc>[] = []
const spawnCalls: Array<{ command: string; args: string[] }> = []

vi.mock('child_process', () => ({
  spawn: vi.fn((command: string, args: string[]) => {
    spawnCalls.push({ command, args })
    const proc = makeFakeProc()
    spawnedProcs.push(proc)
    return proc
  })
}))

vi.mock('./debug', () => ({
  log: vi.fn()
}))

import { AcpClient } from './opencode-acp-client'

describe('AcpClient', () => {
  beforeEach(() => {
    spawnedProcs.length = 0
    spawnCalls.length = 0
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  function makeClient(): AcpClient {
    return new AcpClient('/wt/test', () => 'opencode')
  }

  function lastProc(): ReturnType<typeof makeFakeProc> {
    return spawnedProcs[spawnedProcs.length - 1]
  }

  it('start spawns opencode acp in the worktree directory', () => {
    const client = makeClient()
    client.start()
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].command).toBe('opencode')
    expect(spawnCalls[0].args).toEqual(['acp'])
  })

  it('start is a no-op when already started', () => {
    const client = makeClient()
    client.start()
    client.start()
    expect(spawnCalls).toHaveLength(1)
  })

  it('sendRequest writes a JSON-RPC request with auto-incrementing id', async () => {
    const client = makeClient()
    client.start()
    const promise = client.sendRequest('initialize', { protocolVersion: 1 })
    const proc = lastProc()
    expect(proc.stdin.write).toHaveBeenCalledTimes(1)
    const written = JSON.parse((proc.stdin.write as ReturnType<typeof vi.fn>).mock.calls[0][0])
    expect(written.jsonrpc).toBe('2.0')
    expect(written.id).toBe(0)
    expect(written.method).toBe('initialize')
    expect(written.params).toEqual({ protocolVersion: 1 })

    // Simulate response
    proc.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 0, result: { ok: true } }) + '\n')
    const result = await promise
    expect(result).toEqual({ ok: true })
  })

  it('sendRequest resolves with undefined on timeout', async () => {
    vi.useFakeTimers()
    const client = makeClient()
    client.start()
    const promise = client.sendRequest('initialize', {})
    vi.advanceTimersByTime(30_001)
    const result = await promise
    expect(result).toBeUndefined()
    vi.useRealTimers()
  })

  it('sendResponse writes a JSON-RPC response with the given id', () => {
    const client = makeClient()
    client.start()
    client.sendResponse('req-1', { outcome: { outcome: 'selected', optionId: 'allow' } })
    const proc = lastProc()
    expect(proc.stdin.write).toHaveBeenCalledTimes(1)
    const written = JSON.parse((proc.stdin.write as ReturnType<typeof vi.fn>).mock.calls[0][0])
    expect(written.jsonrpc).toBe('2.0')
    expect(written.id).toBe('req-1')
    expect(written.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
    expect(written.method).toBeUndefined()
  })

  it('sendNotification writes without id', () => {
    const client = makeClient()
    client.start()
    client.sendNotification('session/cancel', { sessionId: 's1' })
    const proc = lastProc()
    expect(proc.stdin.write).toHaveBeenCalledTimes(1)
    const written = JSON.parse((proc.stdin.write as ReturnType<typeof vi.fn>).mock.calls[0][0])
    expect(written.jsonrpc).toBe('2.0')
    expect(written.id).toBeUndefined()
    expect(written.method).toBe('session/cancel')
  })

  it('onEvent receives inbound messages that are not responses', () => {
    const client = makeClient()
    const events: unknown[] = []
    client.onEvent((msg) => events.push(msg))
    client.start()
    const proc = lastProc()
    proc.stdout.emit(
      'data',
      JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1' } }) + '\n'
    )
    expect(events).toHaveLength(1)
    expect((events[0] as any).method).toBe('session/update')
  })

  it('handles multiple NDJSON lines in one chunk', () => {
    const client = makeClient()
    const events: unknown[] = []
    client.onEvent((msg) => events.push(msg))
    client.start()
    const proc = lastProc()
    const line1 = JSON.stringify({ jsonrpc: '2.0', method: 'a', params: {} })
    const line2 = JSON.stringify({ jsonrpc: '2.0', method: 'b', params: {} })
    proc.stdout.emit('data', line1 + '\n' + line2 + '\n')
    expect(events).toHaveLength(2)
    expect((events[0] as any).method).toBe('a')
    expect((events[1] as any).method).toBe('b')
  })

  it('emits error event when spawn throws', () => {
    const client = new AcpClient('/wt/test', () => 'opencode')
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw new Error('ENOENT')
    })
    const events: unknown[] = []
    client.onEvent((msg) => events.push(msg))
    client.start()
    expect(events).toHaveLength(1)
    expect((events[0] as any).method).toBe('error')
    expect((events[0] as any).params.message).toBe('ENOENT')
  })

  it('emits error event on process error', () => {
    const client = makeClient()
    const events: unknown[] = []
    client.onEvent((msg) => events.push(msg))
    client.start()
    const proc = lastProc()
    proc.emit('error', new Error('ENOENT'))
    expect(events).toHaveLength(1)
    expect((events[0] as any).method).toBe('error')
    expect((events[0] as any).params.message).toBe('ENOENT')
  })

  it('emits session/exit on process exit', () => {
    const client = makeClient()
    const events: unknown[] = []
    client.onEvent((msg) => events.push(msg))
    client.start()
    const proc = lastProc()
    proc.emit('exit', 0, null)
    expect(events).toHaveLength(1)
    expect((events[0] as any).method).toBe('session/exit')
    expect((events[0] as any).params.code).toBe(0)
  })

  it('kill ends stdin and sends SIGTERM', () => {
    const client = makeClient()
    client.start()
    const proc = lastProc()
    client.kill()
    expect(proc.stdin.end).toHaveBeenCalled()
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('kill is a no-op when not started', () => {
    const client = makeClient()
    expect(() => client.kill()).not.toThrow()
  })
})

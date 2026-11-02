import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { WebSocket as WSClient } from 'ws'
import { WebSocketClientTransport } from '../../shared/transport/transport-websocket'
import type { WebSocketClientTransportOptions } from '../../shared/transport/transport-websocket/types'
import { mergeWireSnapshot, type StateEvent, type StateSnapshot } from '../../shared/state'
import { BackendsRegistry } from '.'
import type { BackendConnection } from '../types'
import { buildTestServer, startTestServer, type TestServer } from '../../../scripts/core/testserver'

const NodeWebSocket = WSClient as unknown as typeof WebSocket
const SERVER_TIMEOUT_MS = 600_000

const open: WebSocketClientTransport[] = []

function client(server: TestServer, opts: Partial<WebSocketClientTransportOptions> = {}): WebSocketClientTransport {
  const t = new WebSocketClientTransport({
    url: server.url,
    token: server.token,
    WebSocketCtor: NodeWebSocket,
    initialBackoffMs: 20,
    maxBackoffMs: 100,
    ...opts
  })
  open.push(t)
  return t
}

async function waitFor(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

function themeDark(payload: string): StateEvent {
  return { type: 'settings/themeDarkChanged', payload } as StateEvent
}

function nested(n: number): StateEvent {
  return { type: 'settings/themeLightChanged', payload: `nested:${n}` } as StateEvent
}

beforeAll(() => {
  buildTestServer()
}, SERVER_TIMEOUT_MS)

afterEach(() => {
  for (const t of open.splice(0)) t.close()
})

describe('core parity: wire contract with the shipped TS client', () => {
  let server: TestServer
  beforeAll(async () => {
    server = await startTestServer()
  }, SERVER_TIMEOUT_MS)
  afterAll(async () => {
    await server?.stop()
  })

  it('auth reject: a wrong token fails to open', async () => {
    const changes: Array<[boolean, string | undefined]> = []
    const t = client(server, {
      token: 'wrong-token',
      onConnectionChange: (connected, reason) => changes.push([connected, reason])
    })
    await expect(t.connect()).rejects.toThrow('websocket failed to open')
    expect(changes[0]).toEqual([false, 'failed to connect'])
  })

  it('stripped snapshot: chat entries are removed from the snapshot', async () => {
    const writer = client(server)
    await writer.connect()
    const seen: StateEvent[] = []
    writer.onStateEvent((event) => seen.push(event as StateEvent))
    const sessionId = 'parity-session'
    await writer.request('test:dispatch', {
      type: 'jsonClaude/sessionStarted',
      payload: { sessionId, worktreePath: '/tmp/parity', agentKind: 'claude', runtimeId: 'claude' }
    })
    await writer.request('test:dispatch', {
      type: 'jsonClaude/entryAppended',
      payload: { sessionId, entry: { entryId: 'e1', kind: 'user', text: 'hello', timestamp: 1 } }
    })
    await waitFor(() => seen.some((e) => e.type === 'jsonClaude/entryAppended'), 'entryAppended frame')

    const snap = await client(server).getStateSnapshot()
    const session = snap.state.jsonClaude.sessions[sessionId]
    expect(session).toBeDefined()
    expect(session.entries).toEqual([])
    expect(session.entriesHydrated).toBe(false)
  })

  it('request with value resolves the value', async () => {
    const t = client(server)
    const id = await t.request('transport:getClientId')
    expect(typeof id).toBe('string')
    expect(id).not.toBe('')
  })

  it('request with no value resolves undefined', async () => {
    const t = client(server)
    await expect(t.request('test:dispatch', themeDark('no-value'))).resolves.toBeUndefined()
  })

  it('request replying null resolves null', async () => {
    const t = client(server)
    await expect(t.request('test:null')).resolves.toBe(null)
  })

  it('request error rejects with the handler message', async () => {
    const t = client(server)
    await expect(t.request('test:fail')).rejects.toThrow(/^test failure$/)
  })

  it('unknown channel error text', async () => {
    const t = client(server)
    await expect(t.request('nope:missing')).rejects.toThrow(/^no handler registered for 'nope:missing'$/)
  })

  it('client signals reach the server and server signals reach every client', async () => {
    const a = client(server)
    const b = client(server)
    await Promise.all([a.connect(), b.connect()])
    const gotA: unknown[][] = []
    const gotB: unknown[][] = []
    a.onSignal('test:echo', (...args) => gotA.push(args))
    b.onSignal('test:echo', (...args) => gotB.push(args))
    const args = [1, 'two', { three: null, four: [true] }]
    a.send('test:echo', ...args)
    await waitFor(() => gotA.length > 0 && gotB.length > 0, 'echoed signal')
    expect(gotA).toEqual([args])
    expect(gotB).toEqual([args])
  })

  it('disconnect and reconnect with a new client id', async () => {
    const sockets: WSClient[] = []
    class RecordingWebSocket extends WSClient {
      constructor(...args: ConstructorParameters<typeof WSClient>) {
        super(...args)
        sockets.push(this)
      }
    }
    const changes: boolean[] = []
    const snapshots: StateSnapshot[] = []
    const reconnectIds: string[] = []
    const t = client(server, {
      WebSocketCtor: RecordingWebSocket as unknown as typeof WebSocket,
      onConnectionChange: (connected) => changes.push(connected),
      onSnapshot: (s) => snapshots.push(s)
    })
    t.onReconnect((id) => reconnectIds.push(id))
    await t.connect()
    await waitFor(() => reconnectIds.length === 1 && snapshots.length === 1, 'first connect')
    const firstId = await t.getClientId()
    expect(reconnectIds[0]).toBe(firstId)

    sockets[0].terminate()
    await waitFor(() => reconnectIds.length === 2 && snapshots.length === 2, 'reconnect')

    expect(changes).toEqual([true, false, true])
    expect(sockets).toHaveLength(2)
    const secondId = await t.getClientId()
    expect(reconnectIds[1]).toBe(secondId)
    expect(secondId).not.toBe(firstId)
  })
})

describe('core parity: nested dispatch order and mirror equality', () => {
  let server: TestServer
  beforeAll(async () => {
    server = await startTestServer()
  }, SERVER_TIMEOUT_MS)
  afterAll(async () => {
    await server?.stop()
  })

  it('every client gets contiguous seq order and its ClientStore mirror equals the server snapshot', async () => {
    const before = client(server)
    await before.request('test:dispatch', nested(2))
    await before.request('test:dispatch', { type: 'settings/nameClaudeSessionsChanged', payload: true })
    const registry = new BackendsRegistry()
    const mirrors = await Promise.all(
      [0, 1, 2].map(async (i) => {
        const conn: BackendConnection = { id: `core-${i}`, label: `core ${i}`, url: server.url, kind: 'remote', addedAt: 0 }
        let snapshot: StateSnapshot | null = null
        const t = client(server, {
          onSnapshot: (s) => {
            registry.getStore(conn.id)?.setSnapshot(s.state)
            snapshot = s
          }
        })
        const store = registry.add(conn, t)
        const seqs: number[] = []
        t.onStateEvent((_event, seq) => seqs.push(seq))
        await t.connect()
        await waitFor(() => snapshot !== null, `snapshot for ${conn.id}`)
        return { t, store, seqs, startSeq: (snapshot as unknown as StateSnapshot).seq }
      })
    )

    const counts = [3, 0, 5, 1, 4, 2]
    await Promise.all(
      counts.map((n, i) => mirrors[i % mirrors.length].t.request('test:dispatch', nested(n)))
    )
    await mirrors[1].t.request('test:dispatch', themeDark('after-nested'))
    const expectedFrames = counts.reduce((sum, n) => sum + n + 1, 0) + 1

    const final = await mirrors[0].t.getStateSnapshot()
    for (const m of mirrors) {
      await waitFor(() => m.seqs.length > 0 && m.seqs[m.seqs.length - 1] >= final.seq, 'final seq')
      expect(m.startSeq).toBe(mirrors[0].startSeq)
      expect(m.seqs).toEqual(Array.from({ length: expectedFrames }, (_, k) => m.startSeq + 1 + k))
      expect(m.seqs[m.seqs.length - 1]).toBe(final.seq)
      expect(m.store.getState()).toEqual(mergeWireSnapshot(final.state))
    }
    expect(final.state.settings.themeDark).toBe('after-nested')
    expect(final.state.settings.nameClaudeSessions).toBe(true)
  })
})

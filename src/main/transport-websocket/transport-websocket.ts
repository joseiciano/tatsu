// WebSocket implementation of ServerTransport.
//
// Lives alongside ElectronServerTransport; the two can run concurrently
// so an Electron renderer and a network client share the same store.
//
// Why a second transport at all: the whole point of the 2.0 store
// refactor is that shared world state is already transport-agnostic
// (see comment block atop `transport-electron.ts`). Serving the exact
// same StateEvents + RPC + signals over WS is how a remote browser
// frontend — or a future SSH stdio shim — drives the app without any
// call site above this layer needing to know the difference.
//
// Wire protocol (all frames JSON, one frame per WS message):
//
//   server → client
//     { t: 'state', event, seq }        — every store mutation
//     { t: 'snapres', id, ok, snapshot? | error? }
//     { t: 'res',    id, ok, value?   | error? }
//     { t: 'sig',    name, args }       — fire-and-forget push
//
//   client → server
//     { t: 'snapreq', id }              — initial / post-reconnect fetch
//     { t: 'req',     id, name, args }  — RPC
//     { t: 'send',    name, args }      — fire-and-forget signal
//
// Seq gap handling is delegated to the client: on reconnect it always
// re-requests the snapshot, which is simpler than replaying a bounded
// history buffer server-side.
//
// Auth: a random 32-byte hex token is generated at start() and required
// via Authorization: Bearer <token> on the WS upgrade.  Browsers use
// short-lived one-time session tokens via ?session=<session_token>,
// obtained by exchanging the root token over same-origin HTTP
// (POST /_harness/session on the web-client-server).  The root token
// in ?token= is NOT accepted for WS — browsers must exchange it first.
// No TLS, token rotation yet.  Per-client frames use a small
// token-bucket rate limit.

import { randomBytes, randomUUID } from 'crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import type { IncomingMessage } from 'http'
import { stripSnapshotForWire, type StateEvent } from '../../shared/state'
import type {
  ConnectionContext,
  RequestHandler,
  ServerTransport,
  SignalHandler
} from '../../shared/transport/transport'
import type { Store } from '../store'
import type { PerfMonitor } from '../perf-monitor'
import { log } from '../debug'
import { perfLog } from '../perf-log'
import { consumeToken, createTokenBucket, type TokenBucket } from '../rate-limit'
import { safeEqualToken, consumeSessionToken } from '../ws-token'
import type { ServerFrame, ClientFrame, WebSocketServerTransportOptions } from './types'
import { SLOW_IPC_MS } from './constants'

const WS_RATE_LIMIT_CAPACITY = 100
const WS_RATE_LIMIT_REFILL_PER_SECOND = 100
const WS_SIGNAL_RATE_LIMIT_CAPACITY = 1_000
const WS_SIGNAL_RATE_LIMIT_REFILL_PER_SECOND = 1_000


export class WebSocketServerTransport implements ServerTransport {
  private wss: WebSocketServer | null = null
  private unsubscribeStore: (() => void) | null = null
  private readonly sockets = new Set<WebSocket>()
  private readonly clientIdBySocket = new WeakMap<WebSocket, string>()
  private readonly requestHandlers = new Map<string, RequestHandler>()
  private readonly rateLimitBuckets = new WeakMap<WebSocket, TokenBucket>()
  private readonly signalRateLimitBuckets = new WeakMap<WebSocket, TokenBucket>()
  private readonly signalHandlers = new Map<string, SignalHandler>()
  private readonly disconnectCallbacks: Array<(id: string) => void> = []
  private readonly token: string

  constructor(
    private readonly store: Store,
    private readonly opts: WebSocketServerTransportOptions,
    private readonly perfMonitor?: PerfMonitor
  ) {
    this.token = opts.token ?? randomBytes(32).toString('hex')
    // Built-in request handler so web clients can learn their own
    // identity without an extra roundtrip design.
    this.requestHandlers.set('transport:getClientId', async (ctx) => ctx.clientId)
  }

  getToken(): string {
    return this.token
  }

  getPort(): number {
    if (this.opts.port != null) return this.opts.port
    const addr = this.opts.server?.address()
    if (addr && typeof addr === 'object') return addr.port
    return 0
  }

  getHost(): string {
    return this.opts.host ?? '127.0.0.1'
  }

  start(): void {
    const host = this.opts.host ?? '127.0.0.1'
    if (this.opts.server) {
      this.wss = new WebSocketServer({
        server: this.opts.server,
        verifyClient: (info, cb) => this.verify(info.req, cb)
      })
    } else {
      this.wss = new WebSocketServer({
        host,
        port: this.opts.port,
        verifyClient: (info, cb) => this.verify(info.req, cb)
      })
    }

    this.wss.on('connection', (ws) => this.handleConnection(ws))
    this.wss.on('error', (err) => {
      log('ws-transport', 'server error', err.message)
    })
    this.wss.on('listening', () => {
      log(
        'ws-transport',
        `listening on ws://${host}:${this.getPort()} (token=<redacted>)`
      )
    })

    this.unsubscribeStore = this.store.subscribe((event, seq) => {
      this.broadcastStateEvent(event, seq)
    })
  }

  stop(): void {
    this.unsubscribeStore?.()
    this.unsubscribeStore = null
    for (const ws of this.sockets) {
      try {
        ws.close(1001, 'server shutting down')
      } catch {
        // ignore
      }
    }
    this.sockets.clear()
    this.wss?.close()
    this.wss = null
  }

  broadcastStateEvent(event: StateEvent, seq: number): void {
    const frame: ServerFrame = { t: 'state', event, seq }
    const data = JSON.stringify(frame)
    for (const ws of this.sockets) {
      if (ws.readyState === ws.OPEN) {
        this.perfMonitor?.recordIpcMessage()
        ws.send(data)
      }
    }
  }

  onRequest(name: string, handler: RequestHandler): void {
    this.requestHandlers.set(name, handler)
  }

  onSignal(name: string, handler: SignalHandler): void {
    this.signalHandlers.set(name, handler)
  }

  sendSignal(name: string, ...args: unknown[]): void {
    const frame: ServerFrame = { t: 'sig', name, args }
    const data = JSON.stringify(frame)
    for (const ws of this.sockets) {
      if (ws.readyState === ws.OPEN) ws.send(data)
    }
  }

  onClientDisconnect(callback: (clientId: string) => void): void {
    this.disconnectCallbacks.push(callback)
  }

  private verify(
    req: IncomingMessage,
    cb: (ok: boolean, code?: number, message?: string) => void
  ): void {
    const url = new URL(req.url ?? '/', 'http://localhost')

    // 1. One-time browser session tokens via ?session=<session_token>.
    const sessionParam = url.searchParams.get('session')
    if (sessionParam && consumeSessionToken(sessionParam)) {
      cb(true)
      return
    }

    // 2. Root auth token via Authorization: Bearer <token>
    // (programmatic clients — CLI, curl, etc.).
    const authHeader = req.headers['authorization']
    const headerToken =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : null
    if (safeEqualToken(headerToken, this.token)) {
      cb(true)
      return
    }

    log('ws-transport', 'rejected unauth ws handshake')
    cb(false, 401, 'unauthorized')
  }

  private handleConnection(ws: WebSocket): void {
    const clientId = randomUUID()
    this.clientIdBySocket.set(ws, clientId)
    this.rateLimitBuckets.set(ws, createTokenBucket(WS_RATE_LIMIT_CAPACITY))
    this.signalRateLimitBuckets.set(ws, createTokenBucket(WS_SIGNAL_RATE_LIMIT_CAPACITY))
    this.sockets.add(ws)
    log('ws-transport', `client connected id=${clientId} (total=${this.sockets.size})`)

    ws.on('message', (raw) => {
      let frame: ClientFrame
      try {
        frame = JSON.parse(raw.toString()) as ClientFrame
      } catch {
        log('ws-transport', 'dropped malformed frame')
        return
      }
      if (!this.allowFrame(ws, frame)) return
      void this.handleClientFrame(ws, frame)
    })

    ws.on('close', () => {
      this.sockets.delete(ws)
      log('ws-transport', `client disconnected id=${clientId} (total=${this.sockets.size})`)
      for (const cb of this.disconnectCallbacks) cb(clientId)
    })

    ws.on('error', (err) => {
      log('ws-transport', 'socket error', err.message)
    })
  }

  private allowFrame(ws: WebSocket, frame: ClientFrame): boolean {
    const isSignal = frame.t === 'send'
    const bucket = isSignal
      ? this.signalRateLimitBuckets.get(ws)
      : this.rateLimitBuckets.get(ws)
    if (!bucket) return false
    const capacity = isSignal ? WS_SIGNAL_RATE_LIMIT_CAPACITY : WS_RATE_LIMIT_CAPACITY
    const refill = isSignal
      ? WS_SIGNAL_RATE_LIMIT_REFILL_PER_SECOND
      : WS_RATE_LIMIT_REFILL_PER_SECOND
    if (consumeToken(bucket, capacity, refill)) {
      return true
    }
    const frameName = frame.t === 'req' || frame.t === 'send' ? ` name=${frame.name}` : ''
    log('ws-transport', `rate limited client frame type=${frame.t}${frameName}`)
    if (frame.t === 'req') {
      this.sendFrame(ws, { t: 'res', id: frame.id, ok: false, error: 'rate limit exceeded' })
    } else if (frame.t === 'snapreq') {
      this.sendFrame(ws, { t: 'snapres', id: frame.id, ok: false, error: 'rate limit exceeded' })
    }
    return false
  }

  private async handleClientFrame(ws: WebSocket, frame: ClientFrame): Promise<void> {
    const clientId = this.clientIdBySocket.get(ws)
    if (!clientId) {
      log('ws-transport', 'frame arrived for unknown socket — dropping')
      return
    }
    const ctx: ConnectionContext = { clientId }
    if (frame.t === 'snapreq') {
      const snapshot = stripSnapshotForWire(this.store.getSnapshot())
      this.sendFrame(ws, { t: 'snapres', id: frame.id, ok: true, snapshot })
      return
    }
    if (frame.t === 'req') {
      const handler = this.requestHandlers.get(frame.name)
      if (!handler) {
        this.sendFrame(ws, {
          t: 'res',
          id: frame.id,
          ok: false,
          error: `no handler registered for '${frame.name}'`
        })
        return
      }
      const args = frame.args ?? []
      const t0 = performance.now()
      try {
        const value = await handler(ctx, ...args)
        this.sendFrame(ws, { t: 'res', id: frame.id, ok: true, value })
      } catch (err) {
        this.sendFrame(ws, {
          t: 'res',
          id: frame.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        })
      } finally {
        const ms = performance.now() - t0
        if (ms >= SLOW_IPC_MS) {
          perfLog('ipc-slow', `${frame.name} ${ms.toFixed(0)}ms`, {
            name: frame.name,
            ms: +ms.toFixed(1),
            argCount: args.length
          })
        }
      }
      return
    }
    if (frame.t === 'send') {
      const handler = this.signalHandlers.get(frame.name)
      if (!handler) return
      const args = frame.args ?? []
      const t0 = performance.now()
      try {
        handler(ctx, ...args)
      } catch (err) {
        log(
          'ws-transport',
          `signal handler '${frame.name}' threw`,
          err instanceof Error ? err.message : String(err)
        )
      } finally {
        const ms = performance.now() - t0
        if (ms >= SLOW_IPC_MS) {
          perfLog('ipc-slow', `${frame.name} ${ms.toFixed(0)}ms (signal)`, {
            name: frame.name,
            ms: +ms.toFixed(1),
            argCount: args.length,
            signal: true
          })
        }
      }
      return
    }
  }

  private sendFrame(ws: WebSocket, frame: ServerFrame): void {
    if (ws.readyState !== ws.OPEN) return
    ws.send(JSON.stringify(frame))
  }
}

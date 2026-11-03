import { WebSocket, type RawData } from 'ws'
import type { IncomingMessage } from 'node:http'
import { mergeWireSnapshot, type AppState, type WireSnapshotState } from '../../shared/state'
import type { ServerFrame } from '../../shared/transport/transport-websocket'
import { describeSource, type ResolvedEndpoint } from '../endpoint'
import { CliError } from '../errors'

export const DEFAULT_TIMEOUT_MS = 30_000

export interface TatsuClient {
  readonly endpoint: { url: string; source: string }
  snapshot(): Promise<AppState>
  request<T = unknown>(name: string, ...args: unknown[]): Promise<T>
  close(): void
}

export interface ConnectOptions {
  timeoutMs?: number
}

type ClientFrame = { t: 'snapreq'; id: string } | { t: 'req'; id: string; name: string; args: unknown[] }

type ReplyFrame = Extract<ServerFrame, { t: 'snapres' | 'res' }>

interface Pending {
  resolve(frame: ReplyFrame): void
  reject(err: CliError): void
  timer: NodeJS.Timeout
}

function redact(text: string, token: string): string {
  return text.split(token).join('<redacted>')
}

function tokenizedUrl(endpoint: ResolvedEndpoint): URL {
  let url: URL
  try {
    url = new URL(endpoint.url)
  } catch {
    throw new CliError('usage', 'the endpoint URL is not a valid URL')
  }
  url.searchParams.set('token', endpoint.token)
  return url
}

function parseReply(data: RawData): ReplyFrame | undefined {
  let frame: unknown
  try {
    frame = JSON.parse(data.toString())
  } catch {
    return undefined
  }
  if (typeof frame !== 'object' || frame === null) return undefined
  if (!('t' in frame) || (frame.t !== 'res' && frame.t !== 'snapres')) return undefined
  if (!('id' in frame) || typeof frame.id !== 'string') return undefined
  return frame as ReplyFrame
}

function isWireSnapshot(value: unknown): value is { state: WireSnapshotState } {
  return typeof value === 'object' && value !== null && 'state' in value && typeof value.state === 'object' && value.state !== null
}

function open(endpoint: ResolvedEndpoint, timeoutMs: number): Promise<WebSocket> {
  const target = tokenizedUrl(endpoint)
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target)
    let settled = false
    const settle = (err?: CliError): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ws.removeAllListeners()
      if (!err) return resolve(ws)
      ws.on('error', () => {})
      ws.terminate()
      reject(err)
    }
    const timer = setTimeout(
      () => settle(new CliError('timeout', `timed out after ${timeoutMs} ms connecting to ${endpoint.url}`)),
      timeoutMs
    )
    ws.once('open', () => settle())
    ws.once('unexpected-response', (_req, res: IncomingMessage) => {
      res.resume()
      const status = res.statusCode ?? 0
      settle(
        status === 401 || status === 403
          ? new CliError(
              'unauthorized',
              `authentication failed for ${endpoint.url} (token from ${describeSource(endpoint.source)})`
            )
          : new CliError('unreachable', `${endpoint.url} answered the WebSocket upgrade with HTTP ${status}`)
      )
    })
    ws.once('error', (err) =>
      settle(new CliError('unreachable', `cannot connect to ${endpoint.url}: ${redact(err.message, endpoint.token)}`))
    )
    ws.once('close', () => settle(new CliError('unreachable', `${endpoint.url} closed the connection before it opened`)))
  })
}

class WsTatsuClient implements TatsuClient {
  readonly endpoint: { url: string; source: string }
  private nextId = 1
  private readonly pending = new Map<string, Pending>()
  private closed = false

  constructor(
    private readonly ws: WebSocket,
    endpoint: ResolvedEndpoint,
    private readonly timeoutMs: number
  ) {
    this.endpoint = { url: endpoint.url, source: endpoint.source }
    ws.on('message', (data) => this.onMessage(data))
    ws.on('error', () => {})
    ws.on('close', () => {
      this.closed = true
      this.rejectAll(new CliError('unreachable', `connection to ${this.endpoint.url} closed`))
    })
  }

  async snapshot(): Promise<AppState> {
    const frame = await this.send((id) => ({ t: 'snapreq', id }), 'snapshot')
    if (!frame.ok) throw new CliError('request-failed', frame.error ?? 'snapshot failed')
    if (frame.t !== 'snapres' || !isWireSnapshot(frame.snapshot)) {
      throw new CliError('request-failed', 'backend sent a malformed snapshot')
    }
    return mergeWireSnapshot(frame.snapshot.state)
  }

  async request<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
    const frame = await this.send((id) => ({ t: 'req', id, name, args }), `request '${name}'`)
    if (!frame.ok) throw new CliError('request-failed', frame.error ?? `request '${name}' failed`)
    if (frame.t !== 'res') throw new CliError('request-failed', `backend sent a malformed reply to '${name}'`)
    return frame.value as T
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.rejectAll(new CliError('unreachable', 'client closed'))
    this.ws.terminate()
  }

  private send(build: (id: string) => ClientFrame, label: string): Promise<ReplyFrame> {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new CliError('unreachable', `connection to ${this.endpoint.url} closed`))
    }
    const id = String(this.nextId++)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CliError('timeout', `${label} timed out after ${this.timeoutMs} ms`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify(build(id)))
    })
  }

  private onMessage(data: RawData): void {
    const frame = parseReply(data)
    if (!frame) return
    const pending = this.pending.get(frame.id)
    if (!pending) return
    this.pending.delete(frame.id)
    clearTimeout(pending.timer)
    pending.resolve(frame)
  }

  private rejectAll(err: CliError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pending.clear()
  }
}

export async function connect(endpoint: ResolvedEndpoint, opts: ConnectOptions = {}): Promise<TatsuClient> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const ws = await open(endpoint, timeoutMs)
  return new WsTatsuClient(ws, endpoint, timeoutMs)
}

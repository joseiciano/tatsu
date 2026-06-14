import type { StateEvent, StateSnapshot } from '../../state'

export interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

export type ServerFrame =
  | { t: 'state'; event: StateEvent; seq: number }
  | { t: 'snapres'; id: string; ok: boolean; snapshot?: StateSnapshot; error?: string }
  | { t: 'res'; id: string; ok: boolean; value?: unknown; error?: string }
  | { t: 'sig'; name: string; args: unknown[] }

export interface WebSocketClientTransportOptions {
  url: string
  token: string
  /** Callback fired after each successful (re)connect, once the client
   *  has finished refetching the snapshot. The callee is expected to
   *  reset its local mirror to `snapshot`. */
  onSnapshot?: (snapshot: StateSnapshot) => void
  /** Backoff starting delay in ms; doubles up to `maxBackoffMs`. */
  initialBackoffMs?: number
  maxBackoffMs?: number
  /** Inject a custom WebSocket constructor (tests / non-browser runtimes). */
  WebSocketCtor?: typeof WebSocket
  /** Fires whenever the underlying socket transitions between
   *  open and closed. Used by the multi-backend chip strip to grey
   *  disconnected chips without changing what the slice hooks read.
   *  Tier 1 only distinguishes connected vs disconnected per design
   *  §I; the optional `reason` is surfaced in the chip's tooltip. */
  onConnectionChange?: (connected: boolean, reason?: string) => void
}

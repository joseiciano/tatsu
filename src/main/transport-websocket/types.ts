import type { StateEvent } from '../../shared/state'

export type ServerFrame =
  | { t: 'state'; event: StateEvent; seq: number }
  | { t: 'snapres'; id: string; ok: true; snapshot: unknown }
  | { t: 'snapres'; id: string; ok: false; error: string }
  | { t: 'res'; id: string; ok: true; value: unknown }
  | { t: 'res'; id: string; ok: false; error: string }
  | { t: 'sig'; name: string; args: unknown[] }

export type ClientFrame =
  | { t: 'snapreq'; id: string }
  | { t: 'req'; id: string; name: string; args: unknown[] }
  | { t: 'send'; name: string; args: unknown[] }

export interface WebSocketServerTransportOptions {
  port?: number
  token?: string
  host?: string
  server?: import('http').Server
}
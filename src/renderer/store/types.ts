export interface BackendStatus {
  state: 'connected' | 'disconnected'
  reason?: string
}

export type ReconnectSubscriber = (backendId: string, clientId: string) => void

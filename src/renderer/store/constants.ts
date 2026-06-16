import type { BackendConnection } from '../types'
import type { BackendStatus } from './types'

export const LOCAL_BACKEND_ID = 'local'

export const DEFAULT_BACKEND_STATUS: BackendStatus = { state: 'connected' }

export const EMPTY_CONNECTIONS: readonly BackendConnection[] = []

export const FALLBACK_ACTIVE_BACKEND: BackendConnection = {
  id: LOCAL_BACKEND_ID,
  label: 'Local',
  url: '',
  kind: 'local',
  addedAt: 0
}

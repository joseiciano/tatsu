import type { TerminalsState } from './types'

export const initialTerminals: TerminalsState = {
  statuses: {},
  pendingTools: {},
  shellActivity: {},
  progress: {},
  panes: {},
  lastActive: {},
  sessions: {}
}

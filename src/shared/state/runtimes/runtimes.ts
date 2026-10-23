import type { RuntimesEvent, RuntimesState } from './types'

export const initialRuntimes: RuntimesState = {
  byAgent: {}
}

export function runtimesReducer(state: RuntimesState, event: RuntimesEvent): RuntimesState {
  switch (event.type) {
    case 'runtimes/statusChanged': {
      const { agentKind, status } = event.payload
      return { ...state, byAgent: { ...state.byAgent, [agentKind]: status } }
    }
    default: {
      const _exhaustive: never = event.type
      void _exhaustive
      return state
    }
  }
}

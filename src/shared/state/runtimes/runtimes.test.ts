import { describe, it, expect } from 'vitest'
import { initialRuntimes, runtimesReducer, type RuntimesState } from '.'
import { initialState, rootReducer } from '..'

describe('runtimesReducer', () => {
  it('statusChanged sets one agent without touching the others', () => {
    const seeded: RuntimesState = {
      byAgent: { codex: { state: 'ready', version: '0.146.1-darwin-arm64' } }
    }
    const next = runtimesReducer(seeded, {
      type: 'runtimes/statusChanged',
      payload: {
        agentKind: 'opencode',
        status: { state: 'missing', version: '1.18.14', sizeBytes: 139830770 }
      }
    })
    expect(next.byAgent).toEqual({
      codex: { state: 'ready', version: '0.146.1-darwin-arm64' },
      opencode: { state: 'missing', version: '1.18.14', sizeBytes: 139830770 }
    })
    expect(seeded.byAgent.opencode).toBeUndefined()
  })

  it('statusChanged replaces the previous status for the same agent', () => {
    let state = runtimesReducer(initialRuntimes, {
      type: 'runtimes/statusChanged',
      payload: {
        agentKind: 'opencode',
        status: { state: 'downloading', version: '1.18.14', receivedBytes: 10, totalBytes: 100 }
      }
    })
    state = runtimesReducer(state, {
      type: 'runtimes/statusChanged',
      payload: {
        agentKind: 'opencode',
        status: { state: 'error', version: '1.18.14', error: 'HTTP 503' }
      }
    })
    expect(state.byAgent.opencode).toEqual({ state: 'error', version: '1.18.14', error: 'HTTP 503' })
  })

  it('rootReducer routes runtimes events into the runtimes slice', () => {
    const next = rootReducer(initialState, {
      type: 'runtimes/statusChanged',
      payload: { agentKind: 'codex', status: { state: 'bundled' } }
    })
    expect(next.runtimes.byAgent.codex).toEqual({ state: 'bundled' })
    expect(next.settings).toBe(initialState.settings)
  })
})

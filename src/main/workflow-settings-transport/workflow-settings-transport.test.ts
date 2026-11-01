import { beforeEach, describe, expect, it } from 'vitest'

import { registerWorkflowSettingsRequestHandlers } from '.'
import type { Config } from '../persistence'
import {
  initialSettings,
  settingsReducer,
  type SettingsEvent,
  type SettingsState
} from '../../shared/state/settings'

type Handler = (ctx: unknown, payload: unknown) => unknown

class FakeTransport {
  readonly handlers = new Map<string, Handler>()

  onRequest(name: string, handler: Handler): void {
    this.handlers.set(name, handler)
  }

  call(name: string, payload?: unknown): unknown {
    const handler = this.handlers.get(name)
    if (!handler) throw new Error(`no handler for ${name}`)
    return handler({ clientId: 'client-1' }, payload)
  }
}

let transport: FakeTransport
let config: Config
let saves: Config[]
let dispatched: SettingsEvent[]
let settings: SettingsState

beforeEach(() => {
  transport = new FakeTransport()
  config = { windowBounds: null, repoRoots: [] }
  saves = []
  dispatched = []
  settings = initialSettings
  registerWorkflowSettingsRequestHandlers({
    transport,
    config,
    saveConfig: (c) => {
      saves.push(structuredClone(c))
    },
    getSettings: () => settings,
    dispatch: (event) => {
      dispatched.push(event)
      settings = settingsReducer(settings, event)
    }
  })
})

describe('settings:setWorkflowSettings', () => {
  it.each([
    [0, 1],
    [99, 16],
    [2.5, 2]
  ])('clamps maxConcurrentAgents %s to %s, persists it and dispatches it', (input, expected) => {
    expect(transport.call('settings:setWorkflowSettings', { maxConcurrentAgents: input })).toBe(true)
    expect(dispatched).toEqual([
      { type: 'settings/workflowSettingsChanged', payload: { maxConcurrentAgents: expected } }
    ])
    expect(settings.workflows.maxConcurrentAgents).toBe(expected)
    expect(saves.at(-1)?.workflowSettings).toEqual({ maxConcurrentAgents: expected })
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, '8', null])(
    'rejects maxConcurrentAgents %s without saving or dispatching',
    (input) => {
      expect(transport.call('settings:setWorkflowSettings', { maxConcurrentAgents: input })).toBe(false)
      expect(dispatched).toEqual([])
      expect(saves).toEqual([])
    }
  )

  it('rejects a payload that is not an object', () => {
    expect(transport.call('settings:setWorkflowSettings', 4)).toBe(false)
    expect(transport.call('settings:setWorkflowSettings', null)).toBe(false)
    expect(dispatched).toEqual([])
    expect(saves).toEqual([])
  })
})

describe('settings:setLabs', () => {
  it('persists and dispatches the workflows flag', () => {
    expect(transport.call('settings:setLabs', { workflows: true })).toBe(true)
    expect(dispatched).toEqual([{ type: 'settings/labsChanged', payload: { workflows: true } }])
    expect(settings.labs.workflows).toBe(true)
    expect(saves.at(-1)?.labs).toEqual({ workflows: true })

    expect(transport.call('settings:setLabs', { workflows: false })).toBe(true)
    expect(settings.labs.workflows).toBe(false)
    expect(saves.at(-1)?.labs).toEqual({ workflows: false })
  })

  it.each([{ workflows: 'yes' }, { workflows: 1 }, null, true])(
    'rejects %j without saving or dispatching',
    (input) => {
      expect(transport.call('settings:setLabs', input)).toBe(false)
      expect(dispatched).toEqual([])
      expect(saves).toEqual([])
    }
  )
})

import { describe, it, expect } from 'vitest'
import { ChatRuntimeRegistry } from './index'
import { Store } from '../store'

describe('ChatRuntimeRegistry.getRuntimeById', () => {
  function createMockRuntime(): import('./types').ChatRuntime {
    return {
      hasSession: () => false,
      start: () => {},
      send: () => {},
      interrupt: () => {},
      kill: () => {},
      killAll: () => {},
      rewindTo: () => ({ ok: false }),
      setPermissionMode: () => {},
      cancelQueued: () => {},
      getCapabilities: () => ({
        canInterrupt: false,
        canRewind: false,
        canSetPermissionMode: false,
        canApproveTools: false,
        canResume: false,
        canOpenAuthLogin: false,
        hasSlashCommands: false,
        hasCostTracking: false
      })
    }
  }

  it('returns the registered runtime for acp', () => {
    const registry = new ChatRuntimeRegistry(new Store())
    const acp = createMockRuntime()
    registry.register('acp', acp)
    expect(registry.getRuntimeById('acp')).toBe(acp)
  })

  it('returns default runtime id for session lookups', () => {
    const registry = new ChatRuntimeRegistry(new Store())
    expect(registry.getDefaultRuntimeId()).toBe('acp')
  })

  it('returns ACP runtime for session lookups', () => {
    const registry = new ChatRuntimeRegistry(new Store())
    const acp = createMockRuntime()
    registry.register('acp', acp)
    expect(registry.getRuntime('any-session-id')).toBe(acp)
  })
})

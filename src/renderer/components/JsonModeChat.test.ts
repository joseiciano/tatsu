import { describe, it, expect } from 'vitest'
import type { ChatRuntimeCapabilities } from '../../shared/state/json-claude'
import { getRuntimeLabel, isCapabilityEnabled } from './JsonModeChat'

describe('getRuntimeLabel', () => {
  it('returns "Claude (legacy)" for undefined runtime', () => {
    expect(getRuntimeLabel(undefined)).toBe('Claude (legacy)')
  })

  it('returns "Claude (legacy)" for legacy runtime', () => {
    expect(getRuntimeLabel('legacy')).toBe('Claude (legacy)')
  })

  it('returns "Claude (ACP)" for acp runtime', () => {
    expect(getRuntimeLabel('acp')).toBe('Claude (ACP)')
  })
})

describe('isCapabilityEnabled', () => {
  it('defaults to true when capabilities are omitted', () => {
    expect(isCapabilityEnabled(undefined, 'hasSlashCommands')).toBe(true)
    expect(isCapabilityEnabled(undefined, 'canRewind')).toBe(true)
    expect(isCapabilityEnabled(undefined, 'canSetPermissionMode')).toBe(true)
    expect(isCapabilityEnabled(undefined, 'canOpenAuthLogin')).toBe(true)
  })

  it('returns false when the capability is explicitly false', () => {
    const caps: ChatRuntimeCapabilities = {
      canInterrupt: true,
      canRewind: false,
      canSetPermissionMode: true,
      canApproveTools: true,
      canResume: true,
      canOpenAuthLogin: true,
      hasSlashCommands: false,
      hasCostTracking: true
    }
    expect(isCapabilityEnabled(caps, 'canRewind')).toBe(false)
    expect(isCapabilityEnabled(caps, 'hasSlashCommands')).toBe(false)
  })

  it('returns true when the capability is explicitly true', () => {
    const caps: ChatRuntimeCapabilities = {
      canInterrupt: true,
      canRewind: true,
      canSetPermissionMode: true,
      canApproveTools: true,
      canResume: true,
      canOpenAuthLogin: true,
      hasSlashCommands: true,
      hasCostTracking: true
    }
    expect(isCapabilityEnabled(caps, 'canRewind')).toBe(true)
    expect(isCapabilityEnabled(caps, 'hasSlashCommands')).toBe(true)
    expect(isCapabilityEnabled(caps, 'canSetPermissionMode')).toBe(true)
  })

  it('returns true for missing keys (treats undefined as enabled)', () => {
    // Simulate a partial capabilities object that might come from an
    // older runtime that doesn't advertise every flag.
    const partial = {
      canInterrupt: true,
      canRewind: true
    } as ChatRuntimeCapabilities

    expect(isCapabilityEnabled(partial, 'hasSlashCommands')).toBe(true)
    expect(isCapabilityEnabled(partial, 'canSetPermissionMode')).toBe(true)
  })
})

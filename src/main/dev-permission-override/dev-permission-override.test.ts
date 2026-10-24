import { describe, it, expect } from 'vitest'
import { devPermissionOverride } from '.'
import type { Runtime } from '../paths'

describe('devPermissionOverride', () => {
  it.each([
    { name: 'empty env', env: {} },
    { name: 'valid level', env: { HARNESS_DEV_PERMISSION_LEVEL: 'full' } },
    {
      name: 'valid level and bash allow',
      env: { HARNESS_DEV_PERMISSION_LEVEL: 'edit', HARNESS_DEV_BASH_ALLOW: 'npm test' }
    }
  ])('ignores the env outside dev ($name)', ({ env }) => {
    expect(devPermissionOverride(false, env)).toEqual({})
  })

  it('returns the level and the trimmed, non-empty bash allow entries in dev', () => {
    expect(
      devPermissionOverride(true, {
        HARNESS_DEV_PERMISSION_LEVEL: 'edit',
        HARNESS_DEV_BASH_ALLOW: 'npm test; git diff ;'
      })
    ).toEqual({ permissionLevel: 'edit', bashAllow: ['npm test', 'git diff'] })
  })

  it('returns an empty bash allow list when HARNESS_DEV_BASH_ALLOW is unset', () => {
    expect(devPermissionOverride(true, { HARNESS_DEV_PERMISSION_LEVEL: 'read-only' })).toEqual({
      permissionLevel: 'read-only',
      bashAllow: []
    })
  })

  it.each([
    { name: 'unset level', env: { HARNESS_DEV_BASH_ALLOW: 'npm test' } },
    { name: 'wrong case', env: { HARNESS_DEV_PERMISSION_LEVEL: 'Full' } },
    { name: 'empty string', env: { HARNESS_DEV_PERMISSION_LEVEL: '' } },
    { name: 'unknown level', env: { HARNESS_DEV_PERMISSION_LEVEL: 'admin' } }
  ])('returns {} in dev for an invalid level ($name)', ({ env }) => {
    expect(devPermissionOverride(true, env)).toEqual({})
  })

  it('gives headless builds no override even though isPackaged() is false under Node', () => {
    const isDevAtCallSite = (runtime: Runtime, packaged: boolean): boolean =>
      runtime === 'electron' && !packaged
    const isDev = isDevAtCallSite('node', false)

    expect(isDev).toBe(false)
    expect(devPermissionOverride(isDev, { HARNESS_DEV_PERMISSION_LEVEL: 'full' })).toEqual({})
  })
})

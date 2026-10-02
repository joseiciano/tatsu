import { describe, it, expect } from 'vitest'
import {
  initialState,
  mergeWireSnapshot,
  type AppState,
  type WireSnapshotState
} from './index'
import { EMPTY_CUSTOM_THEMES } from './settings'

describe('mergeWireSnapshot', () => {
  it('fills in a recently-added field missing from older server settings', () => {
    // Repro of the v2.9.3 server skew: commit 99262b2 added
    // `customThemes`, so a v2.9.3 snapshot's `settings` object lacks the
    // field. A top-level shallow merge would clobber initial.settings
    // wholesale and leave customThemes undefined; the per-slice merge
    // backfills the default array.
    const wire: WireSnapshotState = {
      settings: {
        themeMode: 'system',
        themeLight: 'solarized-light',
        themeDark: 'dark'
        // no customThemes
      }
    }
    const merged = mergeWireSnapshot(wire)
    expect(merged.settings.customThemes).toBe(EMPTY_CUSTOM_THEMES)
    expect(merged.settings.themeMode).toBe('system')
    expect(merged.settings.themeLight).toBe('solarized-light')
    expect(merged.settings.themeDark).toBe('dark')
  })

  it('backfills missing enableWorktreeContainers from older servers settings', () => {
    const wire: WireSnapshotState = {
      settings: {
        themeMode: 'dark'
      }
    }
    const merged = mergeWireSnapshot(wire)
    expect(merged.settings.enableWorktreeContainers).toBe(false)
    expect(merged.settings.themeMode).toBe('dark')
  })

  it('fills in an entirely-missing slice from initialState', () => {
    const wire: WireSnapshotState = {}
    const merged = mergeWireSnapshot(wire)
    expect(merged.snooze).toEqual(initialState.snooze)
    expect(merged.repoConfigs).toEqual(initialState.repoConfigs)
    expect(merged.jsonClaude).toEqual(initialState.jsonClaude)
    expect(merged.settings).toEqual(initialState.settings)
    expect(merged.harnessConfig).toEqual(initialState.harnessConfig)
  })

  it('preserves partial harness config snapshots while filling omitted fields', () => {
    const serverResources = {
      agents: [],
      skills: [
        {
          id: 'wire:skill',
          agentKind: 'claude' as const,
          resourceType: 'skills' as const,
          canonicalResourceType: 'skills' as const,
          aliasResourceTypes: [],
          label: 'Wire skill',
          relativePath: 'skills/wire.md',
          absolutePath: '/workspace/.claude/skills/wire.md',
          hash: 'sha256:wire',
          existsOnDisk: true,
          managed: true,
          updatedAt: 700
        }
      ],
      commands: []
    }
    const serverComparison = {
      scope: { agentKind: 'claude' as const, resourceType: 'skills' as const },
      status: 'synced' as const,
      diskOnly: [],
      configOnly: [],
      changed: [],
      comparedAt: 701
    }
    const wire: WireSnapshotState = {
      harnessConfig: {
        resources: serverResources,
        comparisons: { 'claude:skills': serverComparison },
        loading: true,
        error: 'wire error',
        lastScannedAt: 702
        // Older server omits lastSyncedAt.
      }
    }

    const merged = mergeWireSnapshot(wire)

    expect(merged.harnessConfig.resources).toBe(serverResources)
    expect(merged.harnessConfig.comparisons).toBe(wire.harnessConfig?.comparisons)
    expect(merged.harnessConfig.loading).toBe(true)
    expect(merged.harnessConfig.error).toBe('wire error')
    expect(merged.harnessConfig.lastScannedAt).toBe(702)
    expect(merged.harnessConfig.lastSyncedAt).toBe(initialState.harnessConfig.lastSyncedAt)
  })

  it('preserves server-sent values when the snapshot is complete', () => {
    const wire: AppState = {
      ...initialState,
      settings: {
        ...initialState.settings,
        themeMode: 'dark',
        customThemes: [
          { id: 'noir', name: 'Noir', mode: 'dark', colors: { bg: '#000' } }
        ]
      }
    }
    const merged = mergeWireSnapshot(wire)
    expect(merged.settings.themeMode).toBe('dark')
    expect(merged.settings.customThemes).toEqual([
      { id: 'noir', name: 'Noir', mode: 'dark', colors: { bg: '#000' } }
    ])
  })

  it('respects an explicit empty array from a mid-version server', () => {
    const wire: WireSnapshotState = {
      settings: {
        themeMode: 'light',
        themeLight: 'solarized-light',
        themeDark: 'dark',
        customThemes: []
      }
    }
    const merged = mergeWireSnapshot(wire)
    expect(merged.settings.customThemes).toEqual([])
  })
})

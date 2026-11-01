import { describe, it, expect } from 'vitest'
import {
  initialState,
  mergeWireSnapshot,
  type AppState,
  type WireSnapshotState
} from './index'
import { EMPTY_CUSTOM_THEMES } from './settings'

describe('mergeWireSnapshot', () => {
  it('fills in a recently-added field missing from an older servers settings', () => {
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

  it('fills labs and workflow settings from defaults for an old server snapshot that lacks them', () => {
    const wire: WireSnapshotState = { settings: { themeMode: 'dark' } }
    const merged = mergeWireSnapshot(wire)
    expect(merged.settings.themeMode).toBe('dark')
    expect(merged.settings.labs).toEqual({ workflows: false })
    expect(merged.settings.workflows).toEqual({ maxConcurrentAgents: 4 })
  })

  it('fills each missing nested labs and workflow settings field from defaults', () => {
    const wire: WireSnapshotState = { settings: { labs: {}, workflows: {} } }
    const merged = mergeWireSnapshot(wire)
    expect(merged.settings.labs).toEqual({ workflows: false })
    expect(merged.settings.workflows).toEqual({ maxConcurrentAgents: 4 })
  })

  it('keeps server-sent labs and workflow settings', () => {
    const wire: WireSnapshotState = {
      settings: { labs: { workflows: true }, workflows: { maxConcurrentAgents: 9 } }
    }
    const merged = mergeWireSnapshot(wire)
    expect(merged.settings.labs).toEqual({ workflows: true })
    expect(merged.settings.workflows).toEqual({ maxConcurrentAgents: 9 })
  })

  it('backfills hooks.codexTrust for an old server snapshot that only sends consent', () => {
    const wire: WireSnapshotState = { hooks: { consent: 'accepted' } }
    const merged = mergeWireSnapshot(wire)
    expect(merged.hooks.consent).toBe('accepted')
    expect(merged.hooks).toHaveProperty('codexTrust', initialState.hooks.codexTrust)
  })

  it('fills in an entirely-missing slice from initialState', () => {
    const wire: WireSnapshotState = {}
    const merged = mergeWireSnapshot(wire)
    expect(merged.snooze).toEqual(initialState.snooze)
    expect(merged.repoConfigs).toEqual(initialState.repoConfigs)
    expect(merged.jsonClaude).toEqual(initialState.jsonClaude)
    expect(merged.settings).toEqual(initialState.settings)
    expect(merged.harnessConfig).toEqual(initialState.harnessConfig)
    expect(merged.workflows).toEqual(initialState.workflows)
  })

  it('preserves the definitions of an old-server workflows snapshot and fills runs and attempts', () => {
    const definitions = {
      'personal:a': {
        id: 'personal:a',
        name: 'a',
        scope: 'personal' as const,
        path: '/home/u/.tatsu/workflows/a.yaml',
        hash: 'hash-a',
        stepIds: ['plan'],
        issues: []
      }
    }
    const merged = mergeWireSnapshot({ workflows: { definitions } })
    expect(merged.workflows.definitions).toBe(definitions)
    expect(merged.workflows.runs).toEqual({})
    expect(merged.workflows.attempts).toEqual({})
  })

  it('keeps a workflow step tab tag in the panes and leaves untagged tabs untagged', () => {
    const workflow = { runId: 'run-1', stepId: 'plan', attemptId: 'att-1' }
    const merged = mergeWireSnapshot({
      terminals: {
        panes: {
          '/wt': {
            type: 'leaf',
            id: 'pane-1',
            tabs: [
              { id: 'step-tab', type: 'agent', label: 'Claude', workflow },
              { id: 'user-tab', type: 'shell', label: 'Shell' }
            ],
            activeTabId: 'step-tab'
          }
        }
      }
    })
    const leaf = merged.terminals.panes['/wt']
    expect(leaf.type === 'leaf' && leaf.tabs.map((t) => t.workflow)).toEqual([workflow, undefined])
    expect(merged.terminals.sessions).toEqual(initialState.terminals.sessions)
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

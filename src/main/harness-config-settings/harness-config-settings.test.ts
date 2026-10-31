import { describe, expect, it, vi } from 'vitest'

import {
  HARNESS_CONFIG_SETTINGS_CHANNEL,
  registerHarnessConfigSettingsHandlers,
  type HarnessConfigSettingsConfigLike,
  type RegisterHarnessConfigSettingsHandlersDeps
} from '.'
import { HarnessConfigError } from '../harness-config'
import type {
  HarnessConfigComparison,
  HarnessConfigEvent,
  HarnessConfigFileRef,
  HarnessConfigRootKey,
  HarnessConfigScope
} from '../../shared/state/harness-config'
import type { SettingsEvent } from '../../shared/state/settings'

type Handler = (ctx: unknown, payload: unknown) => unknown

const DEFAULT_ROOTS: Record<HarnessConfigRootKey, string> = {
  claudeAgents: '/home/.claude/agents',
  claudeSkills: '/home/.claude/skills',
  claudeCommands: '/home/.claude/commands',
  codexHome: '/home/.codex',
  codexSkills: '/home/.agents/skills',
  opencodeAgents: '/home/.config/opencode/agents',
  opencodeSkills: '/home/.config/opencode/skills',
  opencodeCommands: '/home/.config/opencode/commands'
}

const SCOPE_ROOTS: Array<[HarnessConfigScope, HarnessConfigRootKey]> = [
  [{ agentKind: 'claude', resourceType: 'agents' }, 'claudeAgents'],
  [{ agentKind: 'claude', resourceType: 'skills' }, 'claudeSkills'],
  [{ agentKind: 'claude', resourceType: 'commands' }, 'claudeCommands'],
  [{ agentKind: 'codex', resourceType: 'agents' }, 'codexHome'],
  [{ agentKind: 'codex', resourceType: 'skills' }, 'codexSkills'],
  [{ agentKind: 'opencode', resourceType: 'agents' }, 'opencodeAgents'],
  [{ agentKind: 'opencode', resourceType: 'skills' }, 'opencodeSkills'],
  [{ agentKind: 'opencode', resourceType: 'commands' }, 'opencodeCommands']
]

function makeComparison(scope: HarnessConfigScope): HarnessConfigComparison {
  return { scope, status: 'synced', configOnly: [], changed: [], comparedAt: 5 }
}

function setup(
  config: HarnessConfigSettingsConfigLike = {},
  serviceOverrides: Partial<RegisterHarnessConfigSettingsHandlersDeps<HarnessConfigSettingsConfigLike>['service']> = {}
) {
  const handlers = new Map<string, Handler>()
  const events: Array<SettingsEvent | HarnessConfigEvent> = []
  const saveConfig = vi.fn()
  const service = {
    scan: vi.fn((_scope: HarnessConfigScope) => [] as HarnessConfigFileRef[]),
    planSync: vi.fn((scope: HarnessConfigScope) => makeComparison(scope)),
    scopesForRootKeys: vi.fn((keys: readonly HarnessConfigRootKey[]) =>
      SCOPE_ROOTS.filter(([, key]) => keys.includes(key)).map(([scope]) => scope)
    ),
    defaultRoots: vi.fn(() => DEFAULT_ROOTS),
    ...serviceOverrides
  }
  registerHarnessConfigSettingsHandlers({
    transport: { onRequest: (name, handler) => void handlers.set(name, handler) },
    store: { dispatch: (event) => void events.push(event) },
    config,
    saveConfig,
    service,
    defaultSourceDir: () => '/userData/harness-config-source',
    now: () => 42,
    log: vi.fn()
  })
  function call(name: string, payload?: unknown): unknown {
    const handler = handlers.get(name)
    if (!handler) throw new Error(`no handler for ${name}`)
    return handler({}, payload)
  }
  return { call, events, saveConfig, service, config }
}

describe('settings:setHarnessConfigRoot', () => {
  it('rejects a relative path and dispatches nothing', () => {
    const { call, events, saveConfig, service, config } = setup()
    const result = call(HARNESS_CONFIG_SETTINGS_CHANNEL.setRoot, { key: 'claudeSkills', path: 'dotfiles/skills' })
    expect(result).toEqual({ ok: false, message: 'Choose an absolute folder path' })
    expect(events).toEqual([])
    expect(saveConfig).not.toHaveBeenCalled()
    expect(service.scan).not.toHaveBeenCalled()
    expect(config.harnessConfigRoots).toBeUndefined()
  })

  it('rejects an unknown root key and dispatches nothing', () => {
    const { call, events, saveConfig } = setup()
    const result = call(HARNESS_CONFIG_SETTINGS_CHANNEL.setRoot, { key: 'piSkills', path: '/x' })
    expect(result).toMatchObject({ ok: false })
    expect(events).toEqual([])
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('persists, dispatches, and rescans every scope of the affected harness', () => {
    const { call, events, saveConfig, service, config } = setup()
    const result = call(HARNESS_CONFIG_SETTINGS_CHANNEL.setRoot, {
      key: 'claudeSkills',
      path: '/dotfiles/claude/skills/'
    })
    expect(result).toEqual({ ok: true })
    expect(config.harnessConfigRoots).toEqual({ claudeSkills: '/dotfiles/claude/skills' })
    expect(saveConfig).toHaveBeenCalledTimes(1)
    expect(events[0]).toEqual({
      type: 'settings/harnessConfigRootsChanged',
      payload: { key: 'claudeSkills', path: '/dotfiles/claude/skills' }
    })
    const scanned = vi.mocked(service.scan).mock.calls.map(([scope]) => `${scope.agentKind}:${scope.resourceType}`)
    expect(scanned).toEqual(['claude:agents', 'claude:skills', 'claude:commands'])
    const loaded = events.filter((e) => e.type === 'harnessConfig/resourcesLoaded')
    expect(loaded).toHaveLength(3)
    expect(events.filter((e) => e.type === 'harnessConfig/comparisonLoaded')).toHaveLength(3)
  })

  it('clears an override when the path is empty and restores the default', () => {
    const { call, events, config } = setup({ harnessConfigRoots: { codexHome: '/custom/codex' } })
    const result = call(HARNESS_CONFIG_SETTINGS_CHANNEL.setRoot, { key: 'codexHome', path: '  ' })
    expect(result).toEqual({ ok: true })
    expect(config.harnessConfigRoots).toBeUndefined()
    expect(events[0]).toEqual({
      type: 'settings/harnessConfigRootsChanged',
      payload: { key: 'codexHome', path: null }
    })
  })

  it('clears stale inventory when the new root cannot be scanned', () => {
    const { call, events } = setup({}, {
      scan: vi.fn(() => {
        throw new HarnessConfigError('unsupported-scope', 'The resolver known root is unavailable')
      })
    })
    call(HARNESS_CONFIG_SETTINGS_CHANNEL.setRoot, { key: 'opencodeSkills', path: '/missing' })
    const loaded = events.filter((e) => e.type === 'harnessConfig/resourcesLoaded')
    expect(loaded).toHaveLength(3)
    for (const event of loaded) {
      expect(event.type === 'harnessConfig/resourcesLoaded' && event.payload.resources).toEqual([])
    }
    expect(events.some((e) => e.type === 'harnessConfig/comparisonLoaded')).toBe(false)
  })

  it('skips persistence and rescan when the value is unchanged', () => {
    const { call, events, saveConfig } = setup({ harnessConfigRoots: { claudeAgents: '/a' } })
    expect(call(HARNESS_CONFIG_SETTINGS_CHANNEL.setRoot, { key: 'claudeAgents', path: '/a' })).toEqual({ ok: true })
    expect(events).toEqual([])
    expect(saveConfig).not.toHaveBeenCalled()
  })
})

describe('settings:setHarnessConfigSourceDir', () => {
  it('rejects a relative path and dispatches nothing', () => {
    const { call, events, saveConfig } = setup()
    expect(call(HARNESS_CONFIG_SETTINGS_CHANNEL.setSourceDir, 'templates')).toMatchObject({ ok: false })
    expect(events).toEqual([])
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('sets and clears the template source folder', () => {
    const { call, events, config } = setup()
    expect(call(HARNESS_CONFIG_SETTINGS_CHANNEL.setSourceDir, '/templates')).toEqual({ ok: true })
    expect(config.harnessConfigSourceDir).toBe('/templates')
    expect(call(HARNESS_CONFIG_SETTINGS_CHANNEL.setSourceDir, null)).toEqual({ ok: true })
    expect(config.harnessConfigSourceDir).toBeUndefined()
    expect(events).toEqual([
      { type: 'settings/harnessConfigSourceDirChanged', payload: '/templates' },
      { type: 'settings/harnessConfigSourceDirChanged', payload: null }
    ])
  })
})

describe('settings:getHarnessConfigFolderDefaults', () => {
  it('returns the service defaults and the default source folder', () => {
    const { call } = setup()
    expect(call(HARNESS_CONFIG_SETTINGS_CHANNEL.getDefaults)).toEqual({
      roots: DEFAULT_ROOTS,
      sourceDir: '/userData/harness-config-source'
    })
  })
})

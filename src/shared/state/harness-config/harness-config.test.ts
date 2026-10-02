import { describe, expect, it } from 'vitest'
import {
  harnessConfigReducer,
  harnessConfigScopeKey,
  initialHarnessConfig,
  type HarnessConfigChangedRef,
  type HarnessConfigComparison,
  type HarnessConfigEvent,
  type HarnessConfigFileRef,
  type HarnessConfigScope,
  type HarnessConfigState,
  type HarnessConfigSyncDirection,
  type HarnessConfigSyncPlan,
  type HarnessConfigSyncStatus
} from '.'

function apply(state: HarnessConfigState, event: HarnessConfigEvent): HarnessConfigState {
  return harnessConfigReducer(state, event)
}

function scope(overrides: Partial<HarnessConfigScope> = {}): HarnessConfigScope {
  return {
    agentKind: 'claude',
    resourceType: 'skills',
    ...overrides
  }
}

function fileRef(overrides: Partial<HarnessConfigFileRef> = {}): HarnessConfigFileRef {
  return {
    id: 'ref:claude:skills:one',
    agentKind: 'claude',
    resourceType: 'skills',
    canonicalResourceType: 'skills',
    aliasResourceTypes: [],
    label: 'One',
    relativePath: 'skills/one.md',
    absolutePath: '/workspace/.claude/skills/one.md',
    hash: 'sha256:one',
    existsOnDisk: true,
    managed: true,
    updatedAt: 100,
    ...overrides
  }
}

function changedRef(overrides: Partial<HarnessConfigChangedRef> = {}): HarnessConfigChangedRef {
  return {
    disk: fileRef({ id: 'disk:one', hash: 'sha256:disk' }),
    config: fileRef({ id: 'config:one', hash: 'sha256:config' }),
    ...overrides
  }
}

function comparison(overrides: Partial<HarnessConfigComparison> = {}): HarnessConfigComparison {
  return {
    scope: scope(),
    status: 'conflict',
    diskOnly: [],
    configOnly: [],
    changed: [changedRef()],
    comparedAt: 200,
    ...overrides
  }
}

function syncPlan(overrides: Partial<HarnessConfigSyncPlan> = {}): HarnessConfigSyncPlan {
  return {
    planId: 'plan:one',
    scope: scope(),
    direction: 'sync-to-disk',
    status: 'conflict',
    diskOnly: [],
    configOnly: [],
    changed: [changedRef()],
    generatedAt: 300,
    fingerprint: 'fingerprint:one',
    ...overrides
  }
}

type StateOverrides = Omit<Partial<HarnessConfigState>, 'resources'> & {
  resources?: Partial<HarnessConfigState['resources']>
}

function state(overrides: StateOverrides = {}): HarnessConfigState {
  const base: HarnessConfigState = {
    resources: { agents: [], skills: [], commands: [] },
    comparisons: {},
    loading: false,
    error: null,
    lastScannedAt: null,
    lastSyncedAt: null
  }

  return {
    ...base,
    ...overrides,
    resources: { ...base.resources, ...(overrides.resources ?? {}) },
    comparisons: { ...base.comparisons, ...(overrides.comparisons ?? {}) }
  }
}

describe('harnessConfigReducer', () => {
  it('initializes the exact browser-safe slice shape', () => {
    expect(Object.keys(initialHarnessConfig).sort()).toEqual([
      'comparisons',
      'error',
      'lastScannedAt',
      'lastSyncedAt',
      'loading',
      'resources'
    ])
    expect(initialHarnessConfig.resources).toEqual({ agents: [], skills: [], commands: [] })
    expect(Object.keys(initialHarnessConfig.resources).sort()).toEqual([
      'agents',
      'commands',
      'skills'
    ])
    expect(initialHarnessConfig.comparisons).toEqual({})
    expect(initialHarnessConfig.loading).toBe(false)
    expect(initialHarnessConfig.error).toBeNull()
    expect(initialHarnessConfig.lastScannedAt).toBeNull()
    expect(initialHarnessConfig.lastSyncedAt).toBeNull()
  })

  it('loadingChanged changes only loading and preserves slice references', () => {
    const skill = fileRef()
    const comparisonEntry = comparison()
    const start = state({
      resources: { skills: [skill] },
      comparisons: { [harnessConfigScopeKey(comparisonEntry.scope)]: comparisonEntry },
      loading: false,
      error: 'previous failure',
      lastScannedAt: 100,
      lastSyncedAt: 150
    })

    const next = apply(start, { type: 'harnessConfig/loadingChanged', payload: true })

    expect(next.loading).toBe(true)
    expect(next.resources).toBe(start.resources)
    expect(next.comparisons).toBe(start.comparisons)
    expect(next.error).toBe(start.error)
    expect(next.lastScannedAt).toBe(start.lastScannedAt)
    expect(next.lastSyncedAt).toBe(start.lastSyncedAt)
  })

  it('resourcesLoaded replaces only the selected harness in one logical view', () => {
    const claudeSkill = fileRef({ id: 'claude:skill', label: 'Claude skill' })
    const codexSkill = fileRef({
      id: 'codex:skill',
      agentKind: 'codex',
      absolutePath: '/workspace/.codex/skills/skill.md'
    })
    const opencodeSkill = fileRef({
      id: 'opencode:skill',
      agentKind: 'opencode',
      absolutePath: '/workspace/.opencode/skills/skill.md'
    })
    const agent = fileRef({
      id: 'claude:agent',
      resourceType: 'agents',
      canonicalResourceType: 'agents',
      relativePath: 'agents/one.md',
      absolutePath: '/workspace/.claude/agents/one.md'
    })
    const command = fileRef({
      id: 'claude:command',
      resourceType: 'commands',
      canonicalResourceType: 'commands',
      relativePath: 'commands/one.md',
      absolutePath: '/workspace/.claude/commands/one.md'
    })
    const start = state({
      resources: {
        agents: [agent],
        skills: [claudeSkill, codexSkill, opencodeSkill],
        commands: [command]
      },
      error: 'scan warning',
      lastScannedAt: 100,
      lastSyncedAt: 90
    })
    const replacement = fileRef({ id: 'claude:replacement', label: 'Replacement' })

    const next = apply(start, {
      type: 'harnessConfig/resourcesLoaded',
      payload: {
        scope: scope({ agentKind: 'claude', resourceType: 'skills' }),
        resources: [replacement],
        scannedAt: 400
      }
    })

    expect(next.resources.skills).toEqual([replacement, codexSkill, opencodeSkill])
    expect(next.resources.skills).not.toContain(claudeSkill)
    expect(next.resources.agents).toBe(start.resources.agents)
    expect(next.resources.commands).toBe(start.resources.commands)
    expect(next.resources.skills[1]).toBe(codexSkill)
    expect(next.resources.skills[2]).toBe(opencodeSkill)
    expect(next.lastScannedAt).toBe(400)
    expect(next.error).toBe(start.error)
    expect(next.lastSyncedAt).toBe(start.lastSyncedAt)
  })

  it('comparisonLoaded stores comparison by full scope key without recording sync success', () => {
    const oldComparison = comparison({ scope: scope({ resourceType: 'commands' }) })
    const loaded = comparison({ scope: scope({ resourceType: 'skills' }), comparedAt: 401 })
    const start = state({
      comparisons: { [harnessConfigScopeKey(oldComparison.scope)]: oldComparison },
      lastSyncedAt: 350
    })

    const next = apply(start, { type: 'harnessConfig/comparisonLoaded', payload: loaded })

    expect(next.comparisons).not.toBe(start.comparisons)
    expect(next.comparisons[harnessConfigScopeKey(loaded.scope)]).toBe(loaded)
    expect(next.comparisons[harnessConfigScopeKey(oldComparison.scope)]).toBe(oldComparison)
    expect(next.lastSyncedAt).toBe(350)
    expect(next.resources).toBe(start.resources)
    expect(next.lastScannedAt).toBe(start.lastScannedAt)
  })

  it('syncApplied records only confirmed application time', () => {
    const skill = fileRef()
    const comparisonEntry = comparison()
    const start = state({
      resources: { skills: [skill] },
      comparisons: { [harnessConfigScopeKey(comparisonEntry.scope)]: comparisonEntry },
      loading: true,
      error: 'existing error',
      lastScannedAt: 410,
      lastSyncedAt: 420
    })

    const next = apply(start, {
      type: 'harnessConfig/syncApplied',
      payload: { scope: scope({ agentKind: 'codex', resourceType: 'skills' }), syncedAt: 500 }
    })

    expect(next.lastSyncedAt).toBe(500)
    expect(next.resources).toBe(start.resources)
    expect(next.comparisons).toBe(start.comparisons)
    expect(next.loading).toBe(start.loading)
    expect(next.error).toBe(start.error)
    expect(next.lastScannedAt).toBe(start.lastScannedAt)
  })

  it('resourceUpserted replaces matching harness and id while preserving siblings', () => {
    const existing = fileRef({ id: 'shared-id', label: 'before' })
    const sibling = fileRef({ id: 'sibling', relativePath: 'skills/sibling.md' })
    const otherView = fileRef({
      id: 'shared-id',
      resourceType: 'commands',
      canonicalResourceType: 'commands',
      relativePath: 'commands/shared-id.md',
      absolutePath: '/workspace/.claude/commands/shared-id.md'
    })
    const start = state({ resources: { skills: [existing, sibling], commands: [otherView] } })
    const replacement = fileRef({ id: 'shared-id', label: 'after' })

    const next = apply(start, { type: 'harnessConfig/resourceUpserted', payload: replacement })

    expect(next.resources.skills[0]).toBe(replacement)
    expect(next.resources.skills[1]).toBe(sibling)
    expect(next.resources.commands).toBe(start.resources.commands)
    expect(next.resources.commands[0]).toBe(otherView)
    expect(next.resources.agents).toBe(start.resources.agents)
    expect(next.resources.skills).not.toBe(start.resources.skills)
  })

  it('resourceDeleted removes only matching harness, logical view, and id', () => {
    const claudeSkill = fileRef({ id: 'alias-id' })
    const codexSkill = fileRef({
      id: 'alias-id',
      agentKind: 'codex',
      absolutePath: '/workspace/.codex/skills/alias-id.md'
    })
    const claudeCommandAlias = fileRef({
      id: 'alias-id',
      resourceType: 'commands',
      canonicalResourceType: 'skills',
      aliasResourceTypes: ['commands'],
      relativePath: 'commands/alias-id.md',
      absolutePath: '/workspace/.claude/commands/alias-id.md'
    })
    const start = state({
      resources: {
        skills: [claudeSkill, codexSkill],
        commands: [claudeCommandAlias]
      }
    })

    const next = apply(start, {
      type: 'harnessConfig/resourceDeleted',
      payload: { agentKind: 'claude', resourceType: 'skills', id: 'alias-id' }
    })

    expect(next.resources.skills).toEqual([codexSkill])
    expect(next.resources.skills[0]).toBe(codexSkill)
    expect(next.resources.commands).toBe(start.resources.commands)
    expect(next.resources.commands[0]).toBe(claudeCommandAlias)
    expect(next.resources.agents).toBe(start.resources.agents)
  })

  it('errorChanged changes only the explicit error value', () => {
    const skill = fileRef()
    const comparisonEntry = comparison()
    const start = state({
      resources: { skills: [skill] },
      comparisons: { [harnessConfigScopeKey(comparisonEntry.scope)]: comparisonEntry },
      loading: true,
      error: 'failure',
      lastScannedAt: 600,
      lastSyncedAt: 601
    })

    const next = apply(start, { type: 'harnessConfig/errorChanged', payload: null })

    expect(next.error).toBeNull()
    expect(next.resources).toBe(start.resources)
    expect(next.comparisons).toBe(start.comparisons)
    expect(next.loading).toBe(start.loading)
    expect(next.lastScannedAt).toBe(start.lastScannedAt)
    expect(next.lastSyncedAt).toBe(start.lastSyncedAt)
  })

  it('isolates comparisons by both harness and logical resource type', () => {
    const claudeSkills = comparison({ scope: scope({ agentKind: 'claude', resourceType: 'skills' }) })
    const claudeCommands = comparison({
      scope: scope({ agentKind: 'claude', resourceType: 'commands' }),
      comparedAt: 701
    })
    const codexSkills = comparison({
      scope: scope({ agentKind: 'codex', resourceType: 'skills' }),
      comparedAt: 702
    })
    let current = state()

    for (const loaded of [claudeSkills, claudeCommands, codexSkills]) {
      current = apply(current, { type: 'harnessConfig/comparisonLoaded', payload: loaded })
    }

    expect(Object.keys(current.comparisons).sort()).toEqual([
      'claude:commands',
      'claude:skills',
      'codex:skills'
    ])
    expect(current.comparisons['claude:skills']).toBe(claudeSkills)
    expect(current.comparisons['claude:commands']).toBe(claudeCommands)
    expect(current.comparisons['codex:skills']).toBe(codexSkills)
  })

  it('keeps comparison data non-authorizing and sync plans request-scoped', () => {
    const loaded = comparison()
    const plan = syncPlan()
    const next = apply(state(), { type: 'harnessConfig/comparisonLoaded', payload: loaded })

    expect(Object.keys(loaded).sort()).toEqual([
      'changed',
      'comparedAt',
      'configOnly',
      'diskOnly',
      'scope',
      'status'
    ])
    expect(Object.keys(plan).sort()).toEqual([
      'changed',
      'configOnly',
      'direction',
      'diskOnly',
      'fingerprint',
      'generatedAt',
      'planId',
      'scope',
      'status'
    ])
    expect(plan.direction).toBe('sync-to-disk' satisfies HarnessConfigSyncDirection)
    expect(plan.status).toBe('conflict' satisfies HarnessConfigSyncStatus)
    expect(next.comparisons[harnessConfigScopeKey(loaded.scope)]).toBe(loaded)
    expect(next.comparisons[harnessConfigScopeKey(loaded.scope)]).not.toHaveProperty('planId')
    expect(next.comparisons[harnessConfigScopeKey(loaded.scope)]).not.toHaveProperty('direction')
    expect(next.comparisons[harnessConfigScopeKey(loaded.scope)]).not.toHaveProperty('fingerprint')
  })

  it('returns the original state for primitive and object semantic no-ops', () => {
    const comparisonEntry = comparison()
    const resource = fileRef()
    const start = state({
      resources: { skills: [resource] },
      comparisons: { [harnessConfigScopeKey(comparisonEntry.scope)]: comparisonEntry },
      loading: false,
      error: null,
      lastSyncedAt: 800
    })

    expect(apply(start, { type: 'harnessConfig/loadingChanged', payload: false })).toBe(start)
    expect(apply(start, { type: 'harnessConfig/errorChanged', payload: null })).toBe(start)
    expect(apply(start, { type: 'harnessConfig/comparisonLoaded', payload: comparisonEntry })).toBe(start)
    expect(
      apply(start, {
        type: 'harnessConfig/syncApplied',
        payload: { scope: comparisonEntry.scope, syncedAt: 800 }
      })
    ).toBe(start)
    expect(apply(start, { type: 'harnessConfig/resourceUpserted', payload: resource })).toBe(start)
    expect(
      apply(start, {
        type: 'harnessConfig/resourceDeleted',
        payload: { agentKind: 'claude', resourceType: 'skills', id: 'missing' }
      })
    ).toBe(start)
  })

  it('preserves a scoped array when object sequence is unchanged while advancing scan time', () => {
    const resource = fileRef()
    const start = state({ resources: { skills: [resource] }, lastScannedAt: 900 })
    const next = apply(start, {
      type: 'harnessConfig/resourcesLoaded',
      payload: { scope: scope(), resources: [resource], scannedAt: 901 }
    })

    expect(next).not.toBe(start)
    expect(next.resources.skills).toBe(start.resources.skills)
    expect(next.lastScannedAt).toBe(901)
    expect(next.resources.agents).toBe(start.resources.agents)
    expect(next.resources.commands).toBe(start.resources.commands)
  })

  it('orders loaded resources by harness, relative path, then id', () => {
    const claudeB = fileRef({ id: 'b', relativePath: 'shared/path.md' })
    const codex = fileRef({
      id: 'codex',
      agentKind: 'codex',
      relativePath: 'shared/path.md',
      absolutePath: '/workspace/.codex/skills/shared/path.md'
    })
    const opencode = fileRef({
      id: 'opencode',
      agentKind: 'opencode',
      relativePath: 'shared/path.md',
      absolutePath: '/workspace/.opencode/skills/shared/path.md'
    })
    const start = state({ resources: { skills: [opencode, codex, claudeB] } })
    const claudeA = fileRef({ id: 'a', relativePath: 'shared/path.md' })

    const next = apply(start, {
      type: 'harnessConfig/resourcesLoaded',
      payload: { scope: scope(), resources: [claudeB, claudeA], scannedAt: 1000 }
    })

    expect(next.resources.skills.map((resource) => resource.id)).toEqual([
      'a',
      'b',
      'codex',
      'opencode'
    ])
  })

  it('inserts an upsert at deterministic position without rebuilding untouched entries', () => {
    const claude = fileRef({ id: 'claude', relativePath: 'z.md' })
    const codexLate = fileRef({
      id: 'codex-late',
      agentKind: 'codex',
      relativePath: 'z.md',
      absolutePath: '/workspace/.codex/skills/z.md'
    })
    const opencode = fileRef({
      id: 'opencode',
      agentKind: 'opencode',
      relativePath: 'a.md',
      absolutePath: '/workspace/.opencode/skills/a.md'
    })
    const start = state({ resources: { skills: [claude, codexLate, opencode] } })
    const codexEarly = fileRef({
      id: 'codex-early',
      agentKind: 'codex',
      relativePath: 'a.md',
      absolutePath: '/workspace/.codex/skills/a.md'
    })

    const next = apply(start, { type: 'harnessConfig/resourceUpserted', payload: codexEarly })

    expect(next.resources.skills.map((resource) => resource.id)).toEqual([
      'claude',
      'codex-early',
      'codex-late',
      'opencode'
    ])
    expect(next.resources.skills[0]).toBe(claude)
    expect(next.resources.skills[2]).toBe(codexLate)
    expect(next.resources.skills[3]).toBe(opencode)
    expect(next.resources.agents).toBe(start.resources.agents)
    expect(next.resources.commands).toBe(start.resources.commands)
  })

  it('deletes one sorted entry while preserving sibling and unrelated references', () => {
    const first = fileRef({ id: 'first', relativePath: 'a.md' })
    const second = fileRef({ id: 'second', relativePath: 'b.md' })
    const third = fileRef({ id: 'third', relativePath: 'c.md' })
    const agent = fileRef({
      id: 'agent',
      resourceType: 'agents',
      canonicalResourceType: 'agents',
      relativePath: 'agent.md',
      absolutePath: '/workspace/.claude/agents/agent.md'
    })
    const start = state({ resources: { agents: [agent], skills: [first, second, third] } })

    const next = apply(start, {
      type: 'harnessConfig/resourceDeleted',
      payload: { agentKind: 'claude', resourceType: 'skills', id: 'second' }
    })

    expect(next.resources.skills).toEqual([first, third])
    expect(next.resources.skills[0]).toBe(first)
    expect(next.resources.skills[1]).toBe(third)
    expect(next.resources.agents).toBe(start.resources.agents)
    expect(next.resources.commands).toBe(start.resources.commands)
  })
})

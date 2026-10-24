import { describe, expect, it, vi } from 'vitest'

import { createTemplateSyncDeriver, type TemplateSyncDeriverStore } from '.'
import type { StateEvent } from '../../shared/state'
import {
  harnessConfigReducer,
  harnessConfigScopeKey,
  initialHarnessConfig,
  type HarnessConfigComparison,
  type HarnessConfigEvent,
  type HarnessConfigScope,
  type HarnessConfigState,
  type HarnessConfigSyncStatus,
  type HarnessTemplate
} from '../../shared/state/harness-config'

function template(name: string, overrides: Partial<HarnessTemplate> = {}): HarnessTemplate {
  return {
    kind: 'agent',
    name,
    description: '',
    fragments: [],
    body: 'Body',
    harnesses: { claude: { frontmatter: {} } },
    references: [],
    relativePath: `agents/${name}.md`,
    hash: `${name}-1`,
    ...overrides
  }
}

function comparison(scope: HarnessConfigScope, status: HarnessConfigSyncStatus, comparedAt = 1): HarnessConfigComparison {
  return { scope, status, diskOnly: [], configOnly: [], changed: [], comparedAt }
}

class FakeStore implements TemplateSyncDeriverStore {
  state: HarnessConfigState = initialHarnessConfig
  listeners: Array<(event: StateEvent) => void> = []
  dispatched: HarnessConfigEvent[] = []

  subscribe(listener: (event: StateEvent) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener)
    }
  }

  getSnapshot(): { state: { harnessConfig: HarnessConfigState } } {
    return { state: { harnessConfig: this.state } }
  }

  dispatch(event: HarnessConfigEvent): void {
    this.dispatched.push(event)
    this.state = harnessConfigReducer(this.state, event)
  }

  emit(event: HarnessConfigEvent): void {
    this.state = harnessConfigReducer(this.state, event)
    for (const listener of this.listeners) listener(event)
  }

  ofType(type: HarnessConfigEvent['type']): HarnessConfigEvent[] {
    return this.dispatched.filter((event) => event.type === type)
  }
}

function setup(statuses: Record<string, HarnessConfigSyncStatus> = {}) {
  const store = new FakeStore()
  const tasks: Array<() => void> = []
  const service = {
    planSync: vi.fn((scope: HarnessConfigScope) =>
      comparison(scope, statuses[harnessConfigScopeKey(scope)] ?? 'synced', service.planSync.mock.calls.length)
    ),
    scopesForTemplates: vi.fn((templates: readonly Pick<HarnessTemplate, 'kind' | 'harnesses'>[]) => {
      const scopes = new Map<string, HarnessConfigScope>()
      for (const entry of templates) {
        for (const [agentKind, block] of Object.entries(entry.harnesses)) {
          if (!block) continue
          const scope = { agentKind, resourceType: `${entry.kind}s` } as HarnessConfigScope
          scopes.set(harnessConfigScopeKey(scope), scope)
        }
      }
      return [...scopes.values()]
    }),
    scopesForFragment: vi.fn((_name?: string): HarnessConfigScope[] => [])
  }
  const deriver = createTemplateSyncDeriver({
    store,
    service,
    schedule: (run) => tasks.push(run),
    now: () => 500,
    log: vi.fn(),
    formatErr: String
  })
  deriver.start()
  const flush = (): void => {
    while (tasks.length > 0) tasks.shift()!()
  }
  return { store, service, flush }
}

describe('TemplateSyncDeriver', () => {
  it('rescans only the scopes a template change touches and lists the ones now out of sync', () => {
    const { store, service, flush } = setup({ 'claude:agents': 'config-only', 'opencode:agents': 'config-only' })
    store.emit({
      type: 'harnessConfig/templateChanged',
      payload: template('reviewer', { harnesses: { claude: { frontmatter: {} }, opencode: { frontmatter: {} } } })
    })
    store.emit({ type: 'harnessConfig/templateChanged', payload: template('other', { kind: 'skill' }) })
    expect(service.planSync).not.toHaveBeenCalled()
    flush()
    expect(service.planSync.mock.calls.map(([scope]) => harnessConfigScopeKey(scope)).sort()).toEqual([
      'claude:agents',
      'claude:skills',
      'opencode:agents'
    ])
    expect(store.ofType('harnessConfig/comparisonLoaded')).toHaveLength(3)
    expect(store.state.templateSyncNotice).toEqual({ scopes: ['claude:agents', 'opencode:agents'], changedAt: 500 })
  })

  it('includes the targets a template dropped and skips identity comparison dispatches', () => {
    const { store, service, flush } = setup()
    const both = template('reviewer', { harnesses: { claude: { frontmatter: {} }, opencode: { frontmatter: {} } } })
    store.emit({ type: 'harnessConfig/templatesLoaded', payload: { templates: [both], errors: [], loadedAt: 1 } })
    flush()
    expect(store.ofType('harnessConfig/comparisonLoaded')).toHaveLength(2)
    expect(store.ofType('harnessConfig/templateSyncNoticeChanged')).toHaveLength(0)

    service.planSync.mockClear()
    store.emit({ type: 'harnessConfig/templateChanged', payload: { ...both, harnesses: { claude: { frontmatter: {} } } } })
    flush()
    expect(service.planSync.mock.calls.map(([scope]) => harnessConfigScopeKey(scope)).sort()).toEqual([
      'claude:agents',
      'opencode:agents'
    ])
    expect(store.ofType('harnessConfig/comparisonLoaded')).toHaveLength(2)
  })

  it('rescans the last known scopes of a template whose file stops parsing', () => {
    const { store, service, flush } = setup({ 'opencode:agents': 'conflict' })
    store.emit({
      type: 'harnessConfig/templateChanged',
      payload: template('reviewer', { harnesses: { opencode: { frontmatter: {} } } })
    })
    flush()
    service.planSync.mockClear()

    store.emit({ type: 'harnessConfig/templateRemoved', payload: { kind: 'agent', name: 'reviewer' } })
    store.emit({
      type: 'harnessConfig/templateSourceErrorChanged',
      payload: { relativePath: 'agents/reviewer.md', message: 'Invalid frontmatter' }
    })
    flush()
    expect(service.planSync.mock.calls.map(([scope]) => harnessConfigScopeKey(scope))).toEqual(['opencode:agents'])

    service.planSync.mockClear()
    store.emit({
      type: 'harnessConfig/templateSourceErrorChanged',
      payload: { relativePath: 'agents/reviewer.md', message: 'Another typo' }
    })
    flush()
    expect(service.planSync.mock.calls.map(([scope]) => harnessConfigScopeKey(scope))).toEqual(['opencode:agents'])
  })

  it('rescans every harness for a template that never parsed', () => {
    const { store, service, flush } = setup()
    store.emit({
      type: 'harnessConfig/templatesLoaded',
      payload: { templates: [], errors: [{ relativePath: 'skills/deploy/TEMPLATE.md', message: 'bad' }], loadedAt: 1 }
    })
    flush()
    expect(service.planSync.mock.calls.map(([scope]) => harnessConfigScopeKey(scope)).sort()).toEqual([
      'claude:skills',
      'codex:skills',
      'opencode:skills'
    ])

    service.planSync.mockClear()
    store.emit({
      type: 'harnessConfig/templateSourceErrorChanged',
      payload: { relativePath: 'fragments/tone.md', message: 'bad' }
    })
    flush()
    expect(service.planSync).not.toHaveBeenCalled()
  })

  it('rescans scopes of templates that use a changed fragment only', () => {
    const { store, service, flush } = setup({ 'opencode:agents': 'conflict' })
    const users = template('user', { fragments: ['tone'], harnesses: { opencode: { frontmatter: {} } } })
    const blockUser = template('block-user', { kind: 'command', harnesses: { claude: { frontmatter: {}, fragments: ['tone'] } } })
    const other = template('other', { kind: 'skill' })
    store.emit({
      type: 'harnessConfig/templatesLoaded',
      payload: { templates: [users, blockUser, other], errors: [], loadedAt: 1 }
    })
    flush()
    service.planSync.mockClear()

    store.emit({ type: 'harnessConfig/fragmentChanged', payload: { name: 'tone', content: 'x', relativePath: 'fragments/tone.md', hash: 'h' } })
    flush()
    expect(service.planSync.mock.calls.map(([scope]) => harnessConfigScopeKey(scope)).sort()).toEqual([
      'claude:commands',
      'opencode:agents'
    ])
    expect(store.state.templateSyncNotice?.scopes).toEqual(['opencode:agents'])
  })

  it('rescans scopes of a template that uses a changed fragment only through a body placeholder', () => {
    const { store, service, flush } = setup()
    const inlineUser = template('inline-user', {
      kind: 'command',
      body: 'Intro\n{{fragment:tone}}\n',
      harnesses: { opencode: { frontmatter: {} } }
    })
    const fenced = template('fenced', { kind: 'skill', body: '```\n{{fragment:tone}}\n```\n' })
    store.emit({
      type: 'harnessConfig/templatesLoaded',
      payload: { templates: [inlineUser, fenced], errors: [], loadedAt: 1 }
    })
    flush()
    service.planSync.mockClear()

    store.emit({ type: 'harnessConfig/fragmentChanged', payload: { name: 'tone', content: 'x', relativePath: 'fragments/tone.md', hash: 'h' } })
    flush()
    expect(service.planSync.mock.calls.map(([scope]) => harnessConfigScopeKey(scope))).toEqual(['opencode:commands'])
  })

  it('rescans a removed template’s scopes and clears the notice once everything is in sync', () => {
    const statuses: Record<string, HarnessConfigSyncStatus> = { 'claude:agents': 'config-only' }
    const { store, flush } = setup(statuses)
    store.emit({ type: 'harnessConfig/templateChanged', payload: template('reviewer') })
    flush()
    expect(store.state.templateSyncNotice?.scopes).toEqual(['claude:agents'])

    statuses['claude:agents'] = 'synced'
    store.emit({ type: 'harnessConfig/templateRemoved', payload: { kind: 'agent', name: 'reviewer' } })
    flush()
    expect(store.state.templateSyncNotice).toBeNull()
  })

  describe('stored files with inline fragments', () => {
    const tone = { name: 'tone', content: 'x', relativePath: 'fragments/tone.md', hash: 'h' }
    const keys = (calls: Array<[HarnessConfigScope]>): string[] => calls.map(([scope]) => harnessConfigScopeKey(scope)).sort()

    function storedUsers(statuses: Record<string, HarnessConfigSyncStatus> = {}) {
      const context = setup(statuses)
      context.service.scopesForFragment.mockImplementation((name?: string): HarnessConfigScope[] => {
        if (name === 'tone') return [{ agentKind: 'opencode', resourceType: 'skills' }]
        if (name === undefined) {
          return [
            { agentKind: 'opencode', resourceType: 'skills' },
            { agentKind: 'claude', resourceType: 'agents' }
          ]
        }
        return []
      })
      return context
    }

    it.each([
      ['fragmentChanged', { type: 'harnessConfig/fragmentChanged', payload: tone }],
      ['fragmentRemoved', { type: 'harnessConfig/fragmentRemoved', payload: { name: 'tone' } }]
    ] as const)('%s rescans the scopes of stored files using the fragment and lists the out-of-sync ones', (_label, event) => {
      const { store, service, flush } = storedUsers({ 'opencode:skills': 'conflict' })
      store.emit(event as HarnessConfigEvent)
      flush()
      expect(keys(service.planSync.mock.calls)).toEqual(['opencode:skills'])
      expect(store.state.templateSyncNotice).toEqual({ scopes: ['opencode:skills'], changedAt: 500 })
    })

    it('does not rescan anything for a fragment no template or stored file uses', () => {
      const { store, service, flush } = storedUsers()
      store.emit({ type: 'harnessConfig/fragmentChanged', payload: { ...tone, name: 'style' } })
      flush()
      expect(service.planSync).not.toHaveBeenCalled()
    })

    it('fragmentsLoaded rescans every scope with a stored inline fragment without raising a notice', () => {
      const { store, service, flush } = storedUsers({ 'opencode:skills': 'conflict' })
      store.emit({ type: 'harnessConfig/fragmentsLoaded', payload: { fragments: [tone], errors: [], loadedAt: 1 } })
      flush()
      expect(keys(service.planSync.mock.calls)).toEqual(['claude:agents', 'opencode:skills'])
      expect(store.state.templateSyncNotice).toBeNull()
    })

    it('compares a scope once when a template and a stored file both use the fragment', () => {
      const { store, service, flush } = storedUsers()
      const user = template('user', { kind: 'skill', fragments: ['tone'], harnesses: { opencode: { frontmatter: {} } } })
      store.emit({ type: 'harnessConfig/templatesLoaded', payload: { templates: [user], errors: [], loadedAt: 1 } })
      flush()
      service.planSync.mockClear()

      store.emit({ type: 'harnessConfig/fragmentChanged', payload: tone })
      flush()
      expect(keys(service.planSync.mock.calls)).toEqual(['opencode:skills'])
    })

    it('still rescans template scopes when listing stored-file scopes fails', () => {
      const { store, service, flush } = storedUsers()
      const user = template('user', { fragments: ['tone'] })
      store.emit({ type: 'harnessConfig/templatesLoaded', payload: { templates: [user], errors: [], loadedAt: 1 } })
      flush()
      service.planSync.mockClear()
      service.scopesForFragment.mockImplementation(() => {
        throw new Error('desired state unreadable')
      })

      store.emit({ type: 'harnessConfig/fragmentChanged', payload: tone })
      flush()
      expect(keys(service.planSync.mock.calls)).toEqual(['claude:agents'])
    })
  })
})

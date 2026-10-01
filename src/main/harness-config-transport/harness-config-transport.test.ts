import { describe, expect, it, vi } from 'vitest'

import { registerHarnessConfigRequestHandlers } from '.'
import { HarnessConfigError } from '../harness-config'
import type { HarnessConfigService } from '../harness-config'
import type {
  HarnessConfigApplyResult,
  HarnessConfigComparison,
  HarnessConfigConversionResult,
  HarnessConfigEvent,
  HarnessConfigFileRef,
  HarnessConfigMutationPlan,
  HarnessConfigReadFileResult,
  HarnessConfigScope,
  HarnessConfigSyncPlan
} from '../../shared/state/harness-config'
import type { HarnessConfigConnectionContext } from './harness-config-transport'

type Handler = (ctx: HarnessConfigConnectionContext, payload: unknown) => unknown | Promise<unknown>

const CTX: HarnessConfigConnectionContext = { clientId: 'client-1' }

function makeRef(overrides: Partial<HarnessConfigFileRef> = {}): HarnessConfigFileRef {
  return {
    id: 'ref-1',
    agentKind: 'claude',
    resourceType: 'skills',
    canonicalResourceType: 'skills',
    aliasResourceTypes: ['commands'],
    label: 'foo',
    relativePath: 'foo/SKILL.md',
    absolutePath: '/home/.claude/skills/foo/SKILL.md',
    hash: 'hash-1',
    existsOnDisk: true,
    managed: true,
    updatedAt: 1,
    ...overrides
  }
}

function makeComparison(overrides: Partial<HarnessConfigComparison> = {}): HarnessConfigComparison {
  return {
    scope: { agentKind: 'claude', resourceType: 'skills' },
    status: 'synced',
    diskOnly: [],
    configOnly: [],
    changed: [],
    comparedAt: 100,
    ...overrides
  }
}

function makeMutationPlan(overrides: Partial<HarnessConfigMutationPlan> = {}): HarnessConfigMutationPlan {
  return {
    planId: 'plan-1',
    scope: { agentKind: 'claude', resourceType: 'skills' },
    direction: 'create',
    resource: makeRef(),
    generatedAt: 10,
    fingerprint: 'fp-1',
    ...overrides
  }
}

function makeSyncPlan(overrides: Partial<HarnessConfigSyncPlan> = {}): HarnessConfigSyncPlan {
  return {
    planId: 'sync-plan-1',
    scope: { agentKind: 'claude', resourceType: 'skills' },
    direction: 'sync-to-disk',
    status: 'conflict',
    diskOnly: [],
    configOnly: [],
    changed: [],
    generatedAt: 10,
    fingerprint: 'fp-2',
    ...overrides
  }
}

function makeApplyResult(overrides: Partial<HarnessConfigApplyResult> = {}): HarnessConfigApplyResult {
  return {
    scope: { agentKind: 'claude', resourceType: 'skills' },
    planId: 'plan-1',
    applied: [{ type: 'create', id: 'ref-1', relativePath: 'foo/SKILL.md' }],
    resultingRefs: [],
    requiresRescan: true,
    ...overrides
  }
}

class FakeTransport {
  handlers = new Map<string, Handler>()
  onRequest(name: string, handler: Handler): void {
    this.handlers.set(name, handler)
  }
  async call(name: string, payload: unknown): Promise<unknown> {
    const handler = this.handlers.get(name)
    if (!handler) throw new Error(`no handler registered for ${name}`)
    return handler(CTX, payload)
  }
}

class FakeStore {
  events: HarnessConfigEvent[] = []
  dispatch(event: HarnessConfigEvent): void {
    this.events.push(event)
  }
  eventsOfType(type: HarnessConfigEvent['type']): HarnessConfigEvent[] {
    return this.events.filter((e) => e.type === type)
  }
}

function createFakeService(overrides: Partial<HarnessConfigService> = {}): HarnessConfigService {
  return {
    scan: vi.fn((_scope: HarnessConfigScope) => [] as HarnessConfigFileRef[]),
    readFile: vi.fn((): HarnessConfigReadFileResult => ({ ref: makeRef(), content: 'secret content', hash: 'hash-1' })),
    planSync: vi.fn((scope: HarnessConfigScope) => makeComparison({ scope })),
    planSyncToDisk: vi.fn((scope: HarnessConfigScope) => makeSyncPlan({ scope })),
    planAdoptFromDisk: vi.fn((scope: HarnessConfigScope) =>
      makeSyncPlan({ scope, planId: 'adopt-plan-1', direction: 'adopt-from-disk' })
    ),
    prepareCreate: vi.fn((scope: HarnessConfigScope) => makeMutationPlan({ scope, direction: 'create' })),
    prepareUpdate: vi.fn((scope: HarnessConfigScope) =>
      makeMutationPlan({ scope, direction: 'update', planId: 'plan-update-1' })
    ),
    prepareDelete: vi.fn((scope: HarnessConfigScope) =>
      makeMutationPlan({ scope, direction: 'delete', planId: 'plan-delete-1' })
    ),
    prepareCommandFromSkill: vi.fn((): HarnessConfigConversionResult => ({ status: 'draft', agentKind: 'claude', resourceType: 'commands', name: 'foo', relativePath: 'foo.md', label: 'foo', content: 'c' })),
    prepareSkillFromCommand: vi.fn((): HarnessConfigConversionResult => ({ status: 'draft', agentKind: 'claude', resourceType: 'skills', name: 'foo', relativePath: 'foo/SKILL.md', label: 'foo', content: 'c' })),
    applyPlan: vi.fn(async () => makeApplyResult()),
    ...overrides
  }
}

function setup(serviceOverrides: Partial<HarnessConfigService> = {}, nowStart = 1000) {
  const transport = new FakeTransport()
  const store = new FakeStore()
  const service = createFakeService(serviceOverrides)
  let clock = nowStart
  const now = () => clock++
  const log = vi.fn()
  const formatErr = vi.fn((e: unknown) => String(e))
  registerHarnessConfigRequestHandlers({ transport, store, service, now, log, formatErr })
  return { transport, store, service, now: () => clock, log, formatErr }
}

const SKILLS_SCOPE: HarnessConfigScope = { agentKind: 'claude', resourceType: 'skills' }

describe('registerHarnessConfigRequestHandlers', () => {
  describe('observation channels (TEST-001)', () => {
    it('scan dispatches resourcesLoaded after a successful scan and returns the same data', async () => {
      const refs = [makeRef()]
      const { transport, store, service } = setup({ scan: vi.fn(() => refs) })
      const result = (await transport.call('harnessConfig:scan', { scope: SKILLS_SCOPE })) as {
        ok: true
        value: { resources: HarnessConfigFileRef[]; scannedAt: number }
      }
      expect(result.ok).toBe(true)
      expect(result.value.resources).toBe(refs)
      expect(service.scan).toHaveBeenCalledWith(SKILLS_SCOPE)
      const loaded = store.eventsOfType('harnessConfig/resourcesLoaded')
      expect(loaded).toHaveLength(1)
      expect(loaded[0]).toMatchObject({
        payload: { scope: SKILLS_SCOPE, resources: refs, scannedAt: result.value.scannedAt }
      })
    })

    it('failed scan dispatches no resourcesLoaded', async () => {
      const { transport, store } = setup({
        scan: vi.fn(() => {
          throw new HarnessConfigError('unsupported-scope', 'nope')
        })
      })
      const result = (await transport.call('harnessConfig:scan', { scope: SKILLS_SCOPE })) as {
        ok: false
        error: { code: string }
      }
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('unsupported-scope')
      expect(store.eventsOfType('harnessConfig/resourcesLoaded')).toHaveLength(0)
    })

    it('readFile returns content only through the response and verifies scope membership', async () => {
      const ref = makeRef({ resourceType: 'commands', canonicalResourceType: 'skills', aliasResourceTypes: [] })
      const { transport, store } = setup({
        readFile: vi.fn(() => ({ ref, content: 'top secret', hash: ref.hash }))
      })
      const result = (await transport.call('harnessConfig:readFile', {
        scope: SKILLS_SCOPE,
        id: ref.id
      })) as { ok: true; value: HarnessConfigReadFileResult }
      expect(result.ok).toBe(true)
      expect(result.value.content).toBe('top secret')
      for (const event of store.events) {
        expect(JSON.stringify(event)).not.toContain('top secret')
      }
    })

    it('readFile rejects a ref outside the requested logical view', async () => {
      const ref = makeRef({ resourceType: 'agents', canonicalResourceType: 'agents', aliasResourceTypes: [] })
      const { transport } = setup({ readFile: vi.fn(() => ({ ref, content: 'x', hash: ref.hash })) })
      const result = (await transport.call('harnessConfig:readFile', {
        scope: SKILLS_SCOPE,
        id: ref.id
      })) as { ok: false; error: { code: string } }
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('unknown-resource')
    })

    it('compare calls only planSync, dispatches comparisonLoaded with no syncedAt, and creates no binding', async () => {
      const comparison = makeComparison()
      const { transport, store, service } = setup({ planSync: vi.fn(() => comparison) })
      const result = (await transport.call('harnessConfig:compare', { scope: SKILLS_SCOPE })) as {
        ok: true
        value: HarnessConfigComparison
      }
      expect(result.ok).toBe(true)
      expect(result.value).toBe(comparison)
      expect(service.scan).not.toHaveBeenCalled()
      expect(service.applyPlan).not.toHaveBeenCalled()
      const loaded = store.eventsOfType('harnessConfig/comparisonLoaded')
      expect(loaded).toHaveLength(1)
      expect(loaded[0]).toEqual({ type: 'harnessConfig/comparisonLoaded', payload: comparison })
      expect('syncedAt' in (loaded[0] as { payload: object }).payload).toBe(false)
    })

    it('failed compare dispatches no comparisonLoaded', async () => {
      const { transport, store } = setup({
        planSync: vi.fn(() => {
          throw new HarnessConfigError('unsupported-scope', 'nope')
        })
      })
      const result = (await transport.call('harnessConfig:compare', { scope: SKILLS_SCOPE })) as { ok: false }
      expect(result.ok).toBe(false)
      expect(store.eventsOfType('harnessConfig/comparisonLoaded')).toHaveLength(0)
    })
  })

  describe('validation (TEST-003)', () => {
    it.each([
      ['missing resourceType', { scope: { agentKind: 'claude' } }],
      ['unknown agentKind', { scope: { agentKind: 'bogus', resourceType: 'skills' } }],
      ['pi is never authorized', { scope: { agentKind: 'pi', resourceType: 'skills' } }],
      ['unknown resourceType', { scope: { agentKind: 'claude', resourceType: 'plugins' } }],
      ['array instead of object', []],
      ['null body', null],
      ['extra authority-bearing field', { scope: SKILLS_SCOPE, path: '/etc/passwd' }]
    ])('rejects scan request: %s', async (_label, payload) => {
      const { transport, service } = setup()
      const result = (await transport.call('harnessConfig:scan', payload)) as { ok: false; error: { code: string } }
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('invalid-request')
      expect(service.scan).not.toHaveBeenCalled()
    })

    it('rejects obsolete direction field on a directional plan request', async () => {
      const { transport, service } = setup()
      const result = (await transport.call('harnessConfig:planSyncToDisk', {
        scope: SKILLS_SCOPE,
        direction: 'adopt-from-disk'
      })) as { ok: false; error: { code: string } }
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('invalid-request')
      expect(service.planSyncToDisk).not.toHaveBeenCalled()
    })

    it('rejects a mutation request carrying draft fields instead of planId/confirmed', async () => {
      const { transport, service } = setup()
      const result = (await transport.call('harnessConfig:createFile', {
        scope: SKILLS_SCOPE,
        name: 'foo',
        content: 'bar'
      })) as { ok: false; error: { code: string } }
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('invalid-request')
      expect(service.applyPlan).not.toHaveBeenCalled()
    })

    it('rejects a non-boolean confirmed value', async () => {
      const { transport, service } = setup()
      const result = (await transport.call('harnessConfig:createFile', {
        scope: SKILLS_SCOPE,
        planId: 'plan-1',
        confirmed: 'true'
      })) as { ok: false; error: { code: string } }
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('invalid-request')
      expect(service.applyPlan).not.toHaveBeenCalled()
    })

    it('rejects a conversion request carrying a destination harness', async () => {
      const { transport, service } = setup()
      const result = (await transport.call('harnessConfig:prepareCommandFromSkill', {
        scope: SKILLS_SCOPE,
        id: 'ref-1',
        destinationAgentKind: 'codex'
      })) as { ok: false; error: { code: string } }
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('invalid-request')
      expect(service.prepareCommandFromSkill).not.toHaveBeenCalled()
    })
  })

  describe('plan generation is non-mutating (TEST-002)', () => {
    it.each([
      ['harnessConfig:prepareCreate', { scope: SKILLS_SCOPE, name: 'foo', content: 'c' }],
      ['harnessConfig:prepareUpdate', { scope: SKILLS_SCOPE, id: 'ref-1', content: 'c' }],
      ['harnessConfig:prepareDelete', { scope: SKILLS_SCOPE, id: 'ref-1' }],
      ['harnessConfig:planSyncToDisk', { scope: SKILLS_SCOPE }],
      ['harnessConfig:planAdoptFromDisk', { scope: SKILLS_SCOPE }],
      ['harnessConfig:prepareCommandFromSkill', { scope: SKILLS_SCOPE, id: 'ref-1' }],
      ['harnessConfig:prepareSkillFromCommand', { scope: { agentKind: 'claude', resourceType: 'commands' }, id: 'ref-1' }]
    ])('%s never calls applyPlan and dispatches no resource/comparison/sync events', async (channel, payload) => {
      const { transport, store, service } = setup()
      const result = (await transport.call(channel, payload)) as { ok: true }
      expect(result.ok).toBe(true)
      expect(service.applyPlan).not.toHaveBeenCalled()
      expect(store.eventsOfType('harnessConfig/resourcesLoaded')).toHaveLength(0)
      expect(store.eventsOfType('harnessConfig/comparisonLoaded')).toHaveLength(0)
      expect(store.eventsOfType('harnessConfig/syncApplied')).toHaveLength(0)
    })
  })

  describe('direct mutation bound-plan authority (TEST-002/TEST-004)', () => {
    it('applies a confirmed, matching createFile plan and refreshes canonical/alias scopes', async () => {
      const resource = makeRef({ resourceType: 'skills', canonicalResourceType: 'skills', aliasResourceTypes: ['commands'] })
      const plan = makeMutationPlan({ resource })
      const { transport, store, service } = setup({
        prepareCreate: vi.fn(() => plan),
        scan: vi.fn(() => [])
      })

      const prepared = (await transport.call('harnessConfig:prepareCreate', {
        scope: SKILLS_SCOPE,
        name: 'foo',
        content: 'c'
      })) as { ok: true; value: HarnessConfigMutationPlan }
      expect(prepared.value.planId).toBe(plan.planId)

      const applied = (await transport.call('harnessConfig:createFile', {
        scope: SKILLS_SCOPE,
        planId: plan.planId,
        confirmed: true
      })) as { ok: true; value: HarnessConfigApplyResult }

      expect(applied.ok).toBe(true)
      expect(service.applyPlan).toHaveBeenCalledWith({ scope: SKILLS_SCOPE, planId: plan.planId, confirmed: true })
      const scannedScopes = (service.scan as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0])
      expect(scannedScopes).toContainEqual({ agentKind: 'claude', resourceType: 'skills' })
      expect(scannedScopes).toContainEqual({ agentKind: 'claude', resourceType: 'commands' })
      // createFile is not directional: no comparison/syncApplied.
      expect(store.eventsOfType('harnessConfig/comparisonLoaded')).toHaveLength(0)
      expect(store.eventsOfType('harnessConfig/syncApplied')).toHaveLength(0)
    })

    it('rejects an unconfirmed plan and invalidates it against replay', async () => {
      const plan = makeMutationPlan()
      const { transport, service } = setup({ prepareCreate: vi.fn(() => plan) })
      await transport.call('harnessConfig:prepareCreate', { scope: SKILLS_SCOPE, name: 'foo', content: 'c' })

      const first = (await transport.call('harnessConfig:createFile', {
        scope: SKILLS_SCOPE,
        planId: plan.planId,
        confirmed: false
      })) as { ok: false; error: { code: string } }
      expect(first.error.code).toBe('unconfirmed-plan')
      expect(service.applyPlan).not.toHaveBeenCalled()

      const replay = (await transport.call('harnessConfig:createFile', {
        scope: SKILLS_SCOPE,
        planId: plan.planId,
        confirmed: true
      })) as { ok: false; error: { code: string } }
      expect(replay.error.code).toBe('unknown-plan')
      expect(service.applyPlan).not.toHaveBeenCalled()
    })

    it('rejects a plan submitted to the wrong mutation channel', async () => {
      const plan = makeMutationPlan({ direction: 'update', planId: 'plan-update-1' })
      const { transport, service } = setup({ prepareUpdate: vi.fn(() => plan) })
      await transport.call('harnessConfig:prepareUpdate', { scope: SKILLS_SCOPE, id: 'ref-1', content: 'c' })

      const result = (await transport.call('harnessConfig:createFile', {
        scope: SKILLS_SCOPE,
        planId: plan.planId,
        confirmed: true
      })) as { ok: false; error: { code: string } }
      expect(result.error.code).toBe('unknown-plan')
      expect(service.applyPlan).not.toHaveBeenCalled()

      // The plan remains usable on its correct, matching channel.
      const correct = (await transport.call('harnessConfig:updateFile', {
        scope: SKILLS_SCOPE,
        planId: plan.planId,
        confirmed: true
      })) as { ok: true }
      expect(correct.ok).toBe(true)
      expect(service.applyPlan).toHaveBeenCalledTimes(1)
    })

    it('rejects a plan submitted with a mismatched scope', async () => {
      const plan = makeMutationPlan()
      const { transport, service } = setup({ prepareCreate: vi.fn(() => plan) })
      await transport.call('harnessConfig:prepareCreate', { scope: SKILLS_SCOPE, name: 'foo', content: 'c' })

      const result = (await transport.call('harnessConfig:createFile', {
        scope: { agentKind: 'claude', resourceType: 'agents' },
        planId: plan.planId,
        confirmed: true
      })) as { ok: false; error: { code: string } }
      expect(result.error.code).toBe('unknown-plan')
      expect(service.applyPlan).not.toHaveBeenCalled()
    })

    it('rejects an unknown planId', async () => {
      const { transport, service } = setup()
      const result = (await transport.call('harnessConfig:deleteFile', {
        scope: SKILLS_SCOPE,
        planId: 'never-issued',
        confirmed: true
      })) as { ok: false; error: { code: string } }
      expect(result.error.code).toBe('unknown-plan')
      expect(service.applyPlan).not.toHaveBeenCalled()
    })

    it('consumes the plan on a failed apply so it cannot be replayed', async () => {
      const plan = makeMutationPlan()
      const { transport, service } = setup({
        prepareCreate: vi.fn(() => plan),
        applyPlan: vi.fn(async () => {
          throw new HarnessConfigError('stale-plan', 'no longer current')
        })
      })
      await transport.call('harnessConfig:prepareCreate', { scope: SKILLS_SCOPE, name: 'foo', content: 'c' })

      const first = (await transport.call('harnessConfig:createFile', {
        scope: SKILLS_SCOPE,
        planId: plan.planId,
        confirmed: true
      })) as { ok: false; error: { code: string } }
      expect(first.error.code).toBe('stale-plan')

      const replay = (await transport.call('harnessConfig:createFile', {
        scope: SKILLS_SCOPE,
        planId: plan.planId,
        confirmed: true
      })) as { ok: false; error: { code: string } }
      expect(replay.error.code).toBe('unknown-plan')
      expect(service.applyPlan).toHaveBeenCalledTimes(1)
    })
  })

  describe('sync/adopt directional mutations (TEST-005/TEST-007)', () => {
    it('confirmed syncToDisk refreshes inventory, dispatches a fresh comparison, and dispatches syncApplied', async () => {
      const plan = makeSyncPlan()
      const freshComparison = makeComparison({ status: 'synced' })
      const { transport, store, service } = setup({
        planSyncToDisk: vi.fn(() => plan),
        planSync: vi.fn(() => freshComparison),
        scan: vi.fn(() => [])
      })
      await transport.call('harnessConfig:planSyncToDisk', { scope: SKILLS_SCOPE })

      const result = (await transport.call('harnessConfig:syncToDisk', {
        scope: SKILLS_SCOPE,
        planId: plan.planId,
        confirmed: true
      })) as { ok: true }

      expect(result.ok).toBe(true)
      expect(service.applyPlan).toHaveBeenCalledWith({ scope: SKILLS_SCOPE, planId: plan.planId, confirmed: true })
      const comparisons = store.eventsOfType('harnessConfig/comparisonLoaded')
      expect(comparisons).toHaveLength(1)
      expect((comparisons[0] as { payload: HarnessConfigComparison }).payload).toBe(freshComparison)
      const applied = store.eventsOfType('harnessConfig/syncApplied')
      expect(applied).toHaveLength(1)
      expect((applied[0] as { payload: { scope: HarnessConfigScope } }).payload.scope).toEqual(SKILLS_SCOPE)
    })

    it('a sync-to-disk plan cannot be applied through adoptFromDisk', async () => {
      const plan = makeSyncPlan()
      const { transport, service } = setup({ planSyncToDisk: vi.fn(() => plan) })
      await transport.call('harnessConfig:planSyncToDisk', { scope: SKILLS_SCOPE })

      const result = (await transport.call('harnessConfig:adoptFromDisk', {
        scope: SKILLS_SCOPE,
        planId: plan.planId,
        confirmed: true
      })) as { ok: false; error: { code: string } }
      expect(result.error.code).toBe('unknown-plan')
      expect(service.applyPlan).not.toHaveBeenCalled()
    })

    it('a partial apply failure still rescans and may refresh comparison, but withholds syncApplied and keeps the original error', async () => {
      const plan = makeSyncPlan()
      const freshComparison = makeComparison()
      const partialError = new HarnessConfigError('write-failed', 'disk write failed partway', {
        applied: [{ type: 'overwrite', id: 'ref-1', relativePath: 'foo/SKILL.md' }],
        requiresRescan: true
      })
      const { transport, store, service } = setup({
        planSyncToDisk: vi.fn(() => plan),
        planSync: vi.fn(() => freshComparison),
        scan: vi.fn(() => [makeRef()]),
        applyPlan: vi.fn(async () => {
          throw partialError
        })
      })
      await transport.call('harnessConfig:planSyncToDisk', { scope: SKILLS_SCOPE })

      const result = (await transport.call('harnessConfig:syncToDisk', {
        scope: SKILLS_SCOPE,
        planId: plan.planId,
        confirmed: true
      })) as { ok: false; error: { code: string; message: string } }

      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('write-failed')
      expect(result.error.message).toBe('disk write failed partway')
      expect(service.scan).toHaveBeenCalled()
      expect(store.eventsOfType('harnessConfig/resourcesLoaded').length).toBeGreaterThan(0)
      expect(store.eventsOfType('harnessConfig/comparisonLoaded')).toHaveLength(1)
      expect(store.eventsOfType('harnessConfig/syncApplied')).toHaveLength(0)
    })

    it('a refresh scan failure does not hide a successful apply result', async () => {
      const plan = makeSyncPlan({
        configOnly: [makeRef({ id: 'a', canonicalResourceType: 'agents', aliasResourceTypes: [] })]
      })
      const { transport, store, service } = setup({
        planSyncToDisk: vi.fn(() => plan),
        scan: vi.fn((scope: HarnessConfigScope) => {
          if (scope.resourceType === 'agents') throw new Error('boom')
          return []
        })
      })
      await transport.call('harnessConfig:planSyncToDisk', { scope: SKILLS_SCOPE })

      const result = (await transport.call('harnessConfig:syncToDisk', {
        scope: SKILLS_SCOPE,
        planId: plan.planId,
        confirmed: true
      })) as { ok: true; value: HarnessConfigApplyResult }

      expect(result.ok).toBe(true)
      // The skills scope scan succeeded and should still be dispatched.
      const loaded = store.eventsOfType('harnessConfig/resourcesLoaded')
      expect(loaded.some((e) => (e as { payload: { scope: HarnessConfigScope } }).payload.scope.resourceType === 'skills')).toBe(true)
      expect(service.applyPlan).toHaveBeenCalledTimes(1)
    })
  })

  describe('conversion channels (TEST-004)', () => {
    it('prepareCommandFromSkill never creates an apply binding', async () => {
      const { transport, service } = setup()
      const result = (await transport.call('harnessConfig:prepareCommandFromSkill', {
        scope: SKILLS_SCOPE,
        id: 'ref-1'
      })) as { ok: true; value: HarnessConfigConversionResult }
      expect(result.ok).toBe(true)
      expect(service.prepareCommandFromSkill).toHaveBeenCalledWith(SKILLS_SCOPE, 'ref-1')
    })
  })

  describe('error coverage (TEST-009)', () => {
    it('maps an unknown thrown error to internal-error without leaking its message, and logs it', async () => {
      const { transport, log } = setup({
        scan: vi.fn(() => {
          throw new Error('raw node stack trace with secrets')
        })
      })
      const result = (await transport.call('harnessConfig:scan', { scope: SKILLS_SCOPE })) as {
        ok: false
        error: { code: string; message: string }
      }
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('internal-error')
      expect(result.error.message).not.toContain('raw node stack trace')
      expect(log).toHaveBeenCalled()
    })

    it('preserves a known HarnessConfigError code and safe message unchanged', async () => {
      const { transport } = setup({
        scan: vi.fn(() => {
          throw new HarnessConfigError('unsafe-path', 'The harness resource path is unsafe')
        })
      })
      const result = (await transport.call('harnessConfig:scan', { scope: SKILLS_SCOPE })) as {
        ok: false
        error: { code: string; message: string }
      }
      expect(result.error).toEqual({ code: 'unsafe-path', message: 'The harness resource path is unsafe' })
    })
  })

  describe('lifecycle (TEST-008 concurrency, REQ-019/REQ-020)', () => {
    it('keeps loading true until the last of two overlapping requests settles', async () => {
      let resolveFirst!: (value: HarnessConfigApplyResult) => void
      let resolveSecond!: (value: HarnessConfigApplyResult) => void
      const firstPromise = new Promise<HarnessConfigApplyResult>((resolve) => {
        resolveFirst = resolve
      })
      const secondPromise = new Promise<HarnessConfigApplyResult>((resolve) => {
        resolveSecond = resolve
      })
      let prepareCall = 0
      let applyCall = 0
      const planA = makeMutationPlan({ planId: 'plan-a' })
      const planB = makeMutationPlan({ planId: 'plan-b' })
      const { transport, store } = setup({
        prepareCreate: vi.fn(() => (prepareCall++ === 0 ? planA : planB)),
        applyPlan: vi.fn(async () => (applyCall++ === 0 ? firstPromise : secondPromise))
      })
      await transport.call('harnessConfig:prepareCreate', { scope: SKILLS_SCOPE, name: 'a', content: 'c' })
      await transport.call('harnessConfig:prepareCreate', { scope: SKILLS_SCOPE, name: 'b', content: 'c' })
      const baseline = store.events.length

      const firstCall = transport.call('harnessConfig:createFile', {
        scope: SKILLS_SCOPE,
        planId: 'plan-a',
        confirmed: true
      })
      const secondCall = transport.call('harnessConfig:createFile', {
        scope: SKILLS_SCOPE,
        planId: 'plan-b',
        confirmed: true
      })

      await Promise.resolve()
      await Promise.resolve()
      const eventsSince = () => store.events.slice(baseline)
      const loadingSince = () =>
        eventsSince().filter((e): e is HarnessConfigEvent & { type: 'harnessConfig/loadingChanged' } =>
          e.type === 'harnessConfig/loadingChanged'
        )
      expect(loadingSince().some((e) => e.payload === true)).toBe(true)
      expect(loadingSince().some((e) => e.payload === false)).toBe(false)

      resolveFirst(makeApplyResult({ planId: 'plan-a' }))
      await firstCall
      expect(loadingSince().filter((e) => e.payload === false)).toHaveLength(0)

      resolveSecond(makeApplyResult({ planId: 'plan-b' }))
      await secondCall
      expect(loadingSince().filter((e) => e.payload === false)).toHaveLength(1)
    })

    it('clears the error at the start of each request', async () => {
      const { transport, store } = setup({
        scan: vi.fn(() => {
          throw new HarnessConfigError('unsupported-scope', 'bad scope')
        })
      })
      await transport.call('harnessConfig:scan', { scope: SKILLS_SCOPE })
      const errorEvents = store.eventsOfType('harnessConfig/errorChanged')
      expect(errorEvents[0]).toEqual({ type: 'harnessConfig/errorChanged', payload: null })
      expect(errorEvents[errorEvents.length - 1]).toEqual({
        type: 'harnessConfig/errorChanged',
        payload: 'bad scope'
      })
    })
  })

  describe('cancel/dismiss is a no-op (TEST-013)', () => {
    it('never calling the mutation channel after a prepare leaves no trace beyond the generated plan', async () => {
      const { transport, store, service } = setup()
      await transport.call('harnessConfig:prepareCreate', { scope: SKILLS_SCOPE, name: 'foo', content: 'c' })
      expect(service.applyPlan).not.toHaveBeenCalled()
      expect(store.eventsOfType('harnessConfig/resourcesLoaded')).toHaveLength(0)
      expect(store.eventsOfType('harnessConfig/syncApplied')).toHaveLength(0)
    })
  })
})

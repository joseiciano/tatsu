import { describe, expect, it } from 'vitest'
import {
  buildReviewSections,
  configSyncReviewKey,
  decideFreshPlanOutcome,
  formatHash,
  formatUpdatedAt,
  toConfigSyncReview
} from './config-sync-review'
import type {
  HarnessConfigChangedRef,
  HarnessConfigComparison,
  HarnessConfigFileRef,
  HarnessConfigSyncPlan
} from '../../../shared/state/harness-config'

function ref(overrides: Partial<HarnessConfigFileRef> = {}): HarnessConfigFileRef {
  return {
    id: 'ref:claude:skills:one',
    agentKind: 'claude',
    resourceType: 'skills',
    canonicalResourceType: 'skills',
    aliasResourceTypes: [],
    label: 'One',
    relativePath: 'skills/one.md',
    absolutePath: '/workspace/.claude/skills/one.md',
    hash: 'a1b2c3d4e5f60708090a0b0c0d0e0f10',
    existsOnDisk: true,
    managed: true,
    updatedAt: 1_700_000_000_000,
    ...overrides
  }
}

function changedPair(
  overrides: { disk?: Partial<HarnessConfigFileRef>; config?: Partial<HarnessConfigFileRef> } = {}
): HarnessConfigChangedRef {
  return {
    disk: ref({ id: 'ref:changed', hash: 'disk-hash-aaaaaaaaaaaaaaaa', ...overrides.disk }),
    config: ref({ id: 'ref:changed', hash: 'config-hash-bbbbbbbbbbbbbbb', ...overrides.config })
  }
}

function comparison(overrides: Partial<HarnessConfigComparison> = {}): HarnessConfigComparison {
  return {
    scope: { agentKind: 'claude', resourceType: 'skills' },
    status: 'conflict',
    diskOnly: [],
    configOnly: [],
    changed: [],
    comparedAt: 1,
    ...overrides
  }
}

function plan(overrides: Partial<HarnessConfigSyncPlan> = {}): HarnessConfigSyncPlan {
  return {
    planId: 'plan-1',
    scope: { agentKind: 'claude', resourceType: 'skills' },
    direction: 'sync-to-disk',
    status: 'conflict',
    diskOnly: [],
    configOnly: [],
    changed: [],
    generatedAt: 2,
    fingerprint: 'fingerprint-1',
    ...overrides
  }
}

describe('formatUpdatedAt', () => {
  it('formats a finite non-negative timestamp', () => {
    expect(formatUpdatedAt(1_700_000_000_000)).toBe(new Date(1_700_000_000_000).toLocaleString())
  })

  it('reports unavailable for NaN, negative, and non-finite timestamps', () => {
    expect(formatUpdatedAt(Number.NaN)).toBe('Modified time unavailable')
    expect(formatUpdatedAt(-1)).toBe('Modified time unavailable')
    expect(formatUpdatedAt(Number.POSITIVE_INFINITY)).toBe('Modified time unavailable')
  })
})

describe('formatHash', () => {
  it('shows the first 12 characters visually and the full hash separately', () => {
    const { shortLabel, fullLabel } = formatHash('abcdefghijklmnopqrstuvwxyz')
    expect(shortLabel).toBe('sha256:abcdefghijkl')
    expect(fullLabel).toBe('sha256:abcdefghijklmnopqrstuvwxyz')
  })
})

describe('buildReviewSections', () => {
  it('sorts disk-only and config-only rows by relativePath then id', () => {
    const diskOnly = [
      ref({ id: 'b', relativePath: 'skills/b.md' }),
      ref({ id: 'a', relativePath: 'skills/a.md' }),
      ref({ id: 'a2', relativePath: 'skills/a.md' })
    ]
    const configOnly = [
      ref({ id: 'y', relativePath: 'skills/y.md' }),
      ref({ id: 'x', relativePath: 'skills/x.md' })
    ]

    const sections = buildReviewSections(diskOnly, configOnly, [])

    expect(sections.diskOnly.map((row) => row.ref.id)).toEqual(['a', 'a2', 'b'])
    expect(sections.configOnly.map((row) => row.ref.id)).toEqual(['x', 'y'])
    expect(sections.diskOnly.every((row) => row.sourceLabel === 'Disk')).toBe(true)
    expect(sections.configOnly.every((row) => row.sourceLabel === 'Tatsu config')).toBe(true)
  })

  it('sorts content-changed pairs by disk relativePath, then config relativePath, then physical id', () => {
    const pairs = [
      changedPair({ disk: { id: 'z', relativePath: 'skills/z.md' }, config: { id: 'z', relativePath: 'skills/z.md' } }),
      changedPair({ disk: { id: 'a', relativePath: 'skills/a.md' }, config: { id: 'a', relativePath: 'skills/b.md' } }),
      changedPair({ disk: { id: 'a', relativePath: 'skills/a.md' }, config: { id: 'a', relativePath: 'skills/a.md' } })
    ]

    const sections = buildReviewSections([], [], pairs)

    expect(sections.changed.map((row) => [row.disk.ref.relativePath, row.config.ref.relativePath])).toEqual([
      ['skills/a.md', 'skills/a.md'],
      ['skills/a.md', 'skills/b.md'],
      ['skills/z.md', 'skills/z.md']
    ])
  })

  it('attributes the originating harness and logical resource type on every entry', () => {
    const diskOnly = [ref({ agentKind: 'codex', resourceType: 'commands' })]
    const sections = buildReviewSections(diskOnly, [], [])
    expect(sections.diskOnly[0].ref.agentKind).toBe('codex')
    expect(sections.diskOnly[0].ref.resourceType).toBe('commands')
  })

  it('formats updatedAt and hash metadata on every row', () => {
    const diskOnly = [ref({ updatedAt: 1_700_000_000_000, hash: 'deadbeefdeadbeefcafe' })]
    const sections = buildReviewSections(diskOnly, [], [])
    const row = sections.diskOnly[0]
    expect(row.updatedAtLabel).toBe(new Date(1_700_000_000_000).toLocaleString())
    expect(row.hashShortLabel).toBe('sha256:deadbeefdead')
    expect(row.hashFullLabel).toBe('sha256:deadbeefdeadbeefcafe')
  })

  it('never mutates or re-sorts the input arrays', () => {
    const diskOnly = [ref({ id: 'b', relativePath: 'skills/b.md' }), ref({ id: 'a', relativePath: 'skills/a.md' })]
    const configOnly = [ref({ id: 'y', relativePath: 'skills/y.md' })]
    const changed = [changedPair()]
    const diskOnlySnapshot = [...diskOnly]
    const configOnlySnapshot = [...configOnly]
    const changedSnapshot = [...changed]

    buildReviewSections(diskOnly, configOnly, changed)

    expect(diskOnly).toEqual(diskOnlySnapshot)
    expect(diskOnly[0]).toBe(diskOnlySnapshot[0])
    expect(diskOnly[1]).toBe(diskOnlySnapshot[1])
    expect(configOnly).toEqual(configOnlySnapshot)
    expect(changed).toEqual(changedSnapshot)
  })
})

describe('toConfigSyncReview', () => {
  it('converts a comparison into a non-authorizing review with no plan fields', () => {
    const cmp = comparison({ diskOnly: [ref({ id: 'd' })] })
    const review = toConfigSyncReview(cmp)
    expect(review.scope).toEqual(cmp.scope)
    expect(review.scopeKey).toBe('claude:skills')
    expect(review.status).toBe('conflict')
    expect(review.sections.diskOnly).toHaveLength(1)
    expect(review).not.toHaveProperty('planId')
    expect(review).not.toHaveProperty('direction')
    expect(review).not.toHaveProperty('fingerprint')
  })

  it('converts a plan into the same shape, also discarding its apply authority', () => {
    const p = plan({ configOnly: [ref({ id: 'c' })] })
    const review = toConfigSyncReview(p)
    expect(review.scope).toEqual(p.scope)
    expect(review.sections.configOnly).toHaveLength(1)
    expect(review).not.toHaveProperty('planId')
  })
})

describe('configSyncReviewKey', () => {
  it('stays equal across comparedAt/direction/planId/generatedAt/fingerprint-only changes', () => {
    const cmp = comparison({ diskOnly: [ref()], comparedAt: 1 })
    const laterCmp = comparison({ diskOnly: [ref()], comparedAt: 999 })
    const p1 = plan({ diskOnly: [ref()], planId: 'plan-a', fingerprint: 'fp-a', generatedAt: 10 })
    const p2 = plan({ diskOnly: [ref()], planId: 'plan-b', fingerprint: 'fp-b', generatedAt: 20 })

    const key = configSyncReviewKey(cmp)
    expect(configSyncReviewKey(laterCmp)).toBe(key)
    expect(configSyncReviewKey(p1)).toBe(key)
    expect(configSyncReviewKey(p2)).toBe(key)
  })

  it('is insensitive to the input array order (post-sort equivalence)', () => {
    const a = ref({ id: 'a', relativePath: 'skills/a.md' })
    const b = ref({ id: 'b', relativePath: 'skills/b.md' })
    const forward = comparison({ diskOnly: [a, b] })
    const backward = comparison({ diskOnly: [b, a] })
    expect(configSyncReviewKey(forward)).toBe(configSyncReviewKey(backward))
  })

  it('changes when the scope changes', () => {
    const base = comparison()
    const other = comparison({ scope: { agentKind: 'codex', resourceType: 'skills' } })
    expect(configSyncReviewKey(base)).not.toBe(configSyncReviewKey(other))
  })

  it('changes when the status changes', () => {
    const base = comparison({ status: 'conflict' })
    const other = comparison({ status: 'disk-only' })
    expect(configSyncReviewKey(base)).not.toBe(configSyncReviewKey(other))
  })

  it('changes when category membership changes (a disk-only ref becomes config-only)', () => {
    const r = ref()
    const base = comparison({ diskOnly: [r], configOnly: [] })
    const moved = comparison({ diskOnly: [], configOnly: [r] })
    expect(configSyncReviewKey(base)).not.toBe(configSyncReviewKey(moved))
  })

  it.each([
    ['id', { id: 'different-id' }],
    ['relativePath', { relativePath: 'skills/different.md' }],
    ['absolutePath', { absolutePath: '/different/path.md' }],
    ['hash', { hash: 'different-hash-value' }],
    ['updatedAt', { updatedAt: 1 }],
    ['managed', { managed: false }],
    ['existsOnDisk', { existsOnDisk: false }],
    ['canonicalResourceType', { canonicalResourceType: 'commands' as const }],
    ['label', { label: 'Different label' }]
  ])('changes when a ref field (%s) changes', (_name, patch) => {
    const base = comparison({ diskOnly: [ref()] })
    const changedCmp = comparison({ diskOnly: [ref(patch)] })
    expect(configSyncReviewKey(base)).not.toBe(configSyncReviewKey(changedCmp))
  })

  it('changes when aliasResourceTypes changes but is insensitive to alias ordering', () => {
    const base = comparison({ diskOnly: [ref({ aliasResourceTypes: ['commands'] })] })
    const same = comparison({ diskOnly: [ref({ aliasResourceTypes: ['commands'] })] })
    const differentOrder = comparison({
      diskOnly: [ref({ aliasResourceTypes: ['commands', 'agents'] })]
    })
    const reordered = comparison({
      diskOnly: [ref({ aliasResourceTypes: ['agents', 'commands'] })]
    })
    const noAlias = comparison({ diskOnly: [ref({ aliasResourceTypes: [] })] })

    expect(configSyncReviewKey(base)).toBe(configSyncReviewKey(same))
    expect(configSyncReviewKey(differentOrder)).toBe(configSyncReviewKey(reordered))
    expect(configSyncReviewKey(base)).not.toBe(configSyncReviewKey(differentOrder))
    expect(configSyncReviewKey(base)).not.toBe(configSyncReviewKey(noAlias))
  })

  it('changes when a content-changed pair side changes', () => {
    const base = comparison({ changed: [changedPair()] })
    const changedHash = comparison({
      changed: [changedPair({ disk: { hash: 'totally-different-hash' } })]
    })
    expect(configSyncReviewKey(base)).not.toBe(configSyncReviewKey(changedHash))
  })

  it('never mutates the input comparison or plan', () => {
    const cmp = comparison({ diskOnly: [ref({ id: 'b' }), ref({ id: 'a' })] })
    const snapshot = JSON.parse(JSON.stringify(cmp))
    configSyncReviewKey(cmp)
    expect(cmp).toEqual(snapshot)
  })
})

describe('decideFreshPlanOutcome', () => {
  it('blocks apply for a synced fresh plan regardless of review key', () => {
    const syncedPlan = plan({ status: 'synced', diskOnly: [], configOnly: [], changed: [] })
    expect(decideFreshPlanOutcome('any-key', syncedPlan)).toBe('already-synced')
  })

  it('blocks apply and discards authority for a review-different (stale) fresh plan', () => {
    const displayed = comparison({ diskOnly: [ref({ id: 'a' })] })
    const displayedKey = configSyncReviewKey(displayed)
    const staleFreshPlan = plan({ diskOnly: [ref({ id: 'b' })] })
    expect(decideFreshPlanOutcome(displayedKey, staleFreshPlan)).toBe('review-refreshed-plan')
  })

  it('returns apply-fresh-plan only when the fresh plan has drift and matches the displayed review key', () => {
    const displayed = comparison({ diskOnly: [ref({ id: 'a' })] })
    const displayedKey = configSyncReviewKey(displayed)
    const matchingPlan = plan({ diskOnly: [ref({ id: 'a' })] })
    expect(decideFreshPlanOutcome(displayedKey, matchingPlan)).toBe('apply-fresh-plan')
  })
})

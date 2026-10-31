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
  it('sorts config-only rows by relativePath then id and labels them as the after-sync side', () => {
    const configOnly = [
      ref({ id: 'b', relativePath: 'skills/b.md' }),
      ref({ id: 'a', relativePath: 'skills/a.md' }),
      ref({ id: 'a2', relativePath: 'skills/a.md' })
    ]

    const sections = buildReviewSections(configOnly, [])

    expect(sections.configOnly.map((row) => row.ref.id)).toEqual(['a', 'a2', 'b'])
    expect(sections.configOnly.every((row) => row.sourceLabel === 'After sync')).toBe(true)
  })

  it('sorts content-changed pairs by disk relativePath, then config relativePath, then physical id', () => {
    const pairs = [
      changedPair({ disk: { id: 'z', relativePath: 'skills/z.md' }, config: { id: 'z', relativePath: 'skills/z.md' } }),
      changedPair({ disk: { id: 'a', relativePath: 'skills/a.md' }, config: { id: 'a', relativePath: 'skills/b.md' } }),
      changedPair({ disk: { id: 'a', relativePath: 'skills/a.md' }, config: { id: 'a', relativePath: 'skills/a.md' } })
    ]

    const sections = buildReviewSections([], pairs)

    expect(sections.changed.map((row) => [row.disk.ref.relativePath, row.config.ref.relativePath])).toEqual([
      ['skills/a.md', 'skills/a.md'],
      ['skills/a.md', 'skills/b.md'],
      ['skills/z.md', 'skills/z.md']
    ])
    expect(sections.changed[0].disk.sourceLabel).toBe('Disk')
    expect(sections.changed[0].config.sourceLabel).toBe('After sync')
  })

  it('attributes the originating harness and logical resource type on every entry', () => {
    const configOnly = [ref({ agentKind: 'codex', resourceType: 'commands' })]
    const sections = buildReviewSections(configOnly, [])
    expect(sections.configOnly[0].ref.agentKind).toBe('codex')
    expect(sections.configOnly[0].ref.resourceType).toBe('commands')
  })

  it('formats updatedAt and hash metadata on every row', () => {
    const configOnly = [ref({ updatedAt: 1_700_000_000_000, hash: 'deadbeefdeadbeefcafe' })]
    const sections = buildReviewSections(configOnly, [])
    const row = sections.configOnly[0]
    expect(row.updatedAtLabel).toBe(new Date(1_700_000_000_000).toLocaleString())
    expect(row.hashShortLabel).toBe('sha256:deadbeefdead')
    expect(row.hashFullLabel).toBe('sha256:deadbeefdeadbeefcafe')
  })

  it('never mutates or re-sorts the input arrays', () => {
    const configOnly = [ref({ id: 'b', relativePath: 'skills/b.md' }), ref({ id: 'a', relativePath: 'skills/a.md' })]
    const changed = [changedPair()]
    const configOnlySnapshot = [...configOnly]
    const changedSnapshot = [...changed]

    buildReviewSections(configOnly, changed)

    expect(configOnly).toEqual(configOnlySnapshot)
    expect(configOnly[0]).toBe(configOnlySnapshot[0])
    expect(configOnly[1]).toBe(configOnlySnapshot[1])
    expect(changed).toEqual(changedSnapshot)
  })
})

describe('toConfigSyncReview', () => {
  it('converts a comparison into a non-authorizing review with no plan fields', () => {
    const cmp = comparison({ configOnly: [ref({ id: 'd' })] })
    const review = toConfigSyncReview(cmp)
    expect(review.scope).toEqual(cmp.scope)
    expect(review.scopeKey).toBe('claude:skills')
    expect(review.status).toBe('conflict')
    expect(review.sections.configOnly).toHaveLength(1)
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
    const cmp = comparison({ configOnly: [ref()], comparedAt: 1 })
    const laterCmp = comparison({ configOnly: [ref()], comparedAt: 999 })
    const p1 = plan({ configOnly: [ref()], planId: 'plan-a', fingerprint: 'fp-a', generatedAt: 10 })
    const p2 = plan({ configOnly: [ref()], planId: 'plan-b', fingerprint: 'fp-b', generatedAt: 20 })

    const key = configSyncReviewKey(cmp)
    expect(configSyncReviewKey(laterCmp)).toBe(key)
    expect(configSyncReviewKey(p1)).toBe(key)
    expect(configSyncReviewKey(p2)).toBe(key)
  })

  it('is insensitive to the input array order (post-sort equivalence)', () => {
    const a = ref({ id: 'a', relativePath: 'skills/a.md' })
    const b = ref({ id: 'b', relativePath: 'skills/b.md' })
    const forward = comparison({ configOnly: [a, b] })
    const backward = comparison({ configOnly: [b, a] })
    expect(configSyncReviewKey(forward)).toBe(configSyncReviewKey(backward))
  })

  it('changes when the scope changes', () => {
    const base = comparison()
    const other = comparison({ scope: { agentKind: 'codex', resourceType: 'skills' } })
    expect(configSyncReviewKey(base)).not.toBe(configSyncReviewKey(other))
  })

  it('changes when the status changes', () => {
    const base = comparison({ status: 'conflict' })
    const other = comparison({ status: 'config-only' })
    expect(configSyncReviewKey(base)).not.toBe(configSyncReviewKey(other))
  })

  it('changes when category membership changes (a config-only ref becomes content-changed)', () => {
    const r = ref()
    const base = comparison({ configOnly: [r], changed: [] })
    const moved = comparison({ configOnly: [], changed: [{ disk: r, config: r }] })
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
    const base = comparison({ configOnly: [ref()] })
    const changedCmp = comparison({ configOnly: [ref(patch)] })
    expect(configSyncReviewKey(base)).not.toBe(configSyncReviewKey(changedCmp))
  })

  it('changes when aliasResourceTypes changes but is insensitive to alias ordering', () => {
    const base = comparison({ configOnly: [ref({ aliasResourceTypes: ['commands'] })] })
    const same = comparison({ configOnly: [ref({ aliasResourceTypes: ['commands'] })] })
    const differentOrder = comparison({
      configOnly: [ref({ aliasResourceTypes: ['commands', 'agents'] })]
    })
    const reordered = comparison({
      configOnly: [ref({ aliasResourceTypes: ['agents', 'commands'] })]
    })
    const noAlias = comparison({ configOnly: [ref({ aliasResourceTypes: [] })] })

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
    const cmp = comparison({ configOnly: [ref({ id: 'b' }), ref({ id: 'a' })] })
    const snapshot = JSON.parse(JSON.stringify(cmp))
    configSyncReviewKey(cmp)
    expect(cmp).toEqual(snapshot)
  })
})

describe('decideFreshPlanOutcome', () => {
  it('blocks apply for a synced fresh plan regardless of review key', () => {
    const syncedPlan = plan({ status: 'synced', configOnly: [], changed: [] })
    expect(decideFreshPlanOutcome('any-key', syncedPlan)).toBe('already-synced')
  })

  it('blocks apply and discards authority for a review-different (stale) fresh plan', () => {
    const displayed = comparison({ configOnly: [ref({ id: 'a' })] })
    const displayedKey = configSyncReviewKey(displayed)
    const staleFreshPlan = plan({ configOnly: [ref({ id: 'b' })] })
    expect(decideFreshPlanOutcome(displayedKey, staleFreshPlan)).toBe('review-refreshed-plan')
  })

  it('returns apply-fresh-plan only when the fresh plan has drift and matches the displayed review key', () => {
    const displayed = comparison({ configOnly: [ref({ id: 'a' })] })
    const displayedKey = configSyncReviewKey(displayed)
    const matchingPlan = plan({ configOnly: [ref({ id: 'a' })] })
    expect(decideFreshPlanOutcome(displayedKey, matchingPlan)).toBe('apply-fresh-plan')
  })
})

describe('template sync review fields (Step 20)', () => {
  it('keys on template source and render errors but not the detach list', () => {
    const base = comparison({ configOnly: [ref({ id: 'a', source: 'template', templateRef: 'skill/one' })] })
    const baseKey = configSyncReviewKey(base)
    expect(configSyncReviewKey(comparison({ configOnly: [ref({ id: 'a' })] }))).not.toBe(baseKey)
    expect(
      configSyncReviewKey({ ...base, renderErrors: [{ templateRef: 'skill/two', message: 'x', held: [] }] })
    ).not.toBe(baseKey)
    expect(configSyncReviewKey(plan({ ...base, detach: ['a'] }))).toBe(baseKey)
  })

  it('labels template rows by their template instead of a modified time', () => {
    const sections = buildReviewSections(
      [ref({ id: 'a', source: 'template', templateRef: 'skill/one', updatedAt: 0 })],
      [],
      [{ templateRef: 'skill/two', message: 'Unknown fragment: x', held: [ref({ id: 'held' })] }]
    )
    expect(sections.configOnly[0]).toMatchObject({ sourceLabel: 'Template', updatedAtLabel: 'Built from skill/one' })
    expect(sections.renderErrors[0]).toMatchObject({ templateRef: 'skill/two', message: 'Unknown fragment: x' })
    expect(sections.renderErrors[0].held[0].sourceLabel).toBe('Disk')
  })
})

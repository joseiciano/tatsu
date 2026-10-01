import { harnessConfigScopeKey } from '../../../shared/state/harness-config'
import type {
  HarnessConfigChangedRef,
  HarnessConfigComparison,
  HarnessConfigFileRef,
  HarnessConfigSyncPlan
} from '../../../shared/state/harness-config'
import type {
  ConfigSyncFileRow,
  ConfigSyncFreshPlanDecision,
  ConfigSyncReview,
  ConfigSyncReviewSections
} from './types'

type ReviewLike = HarnessConfigComparison | HarnessConfigSyncPlan

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareRefByPathThenId(left: HarnessConfigFileRef, right: HarnessConfigFileRef): number {
  return compareText(left.relativePath, right.relativePath) || compareText(left.id, right.id)
}

function compareChangedPair(left: HarnessConfigChangedRef, right: HarnessConfigChangedRef): number {
  return (
    compareText(left.disk.relativePath, right.disk.relativePath) ||
    compareText(left.config.relativePath, right.config.relativePath) ||
    compareText(left.disk.id, right.disk.id)
  )
}

/** Deterministic, order-independent serialization of every public ref
 *  field (REQ-013). `aliasResourceTypes` is sorted before serializing so
 *  two refs that differ only in alias array order still compare equal. */
function serializeRef(ref: HarnessConfigFileRef): string {
  return JSON.stringify({
    id: ref.id,
    agentKind: ref.agentKind,
    resourceType: ref.resourceType,
    canonicalResourceType: ref.canonicalResourceType,
    aliasResourceTypes: [...ref.aliasResourceTypes].sort(),
    label: ref.label,
    relativePath: ref.relativePath,
    absolutePath: ref.absolutePath,
    hash: ref.hash,
    existsOnDisk: ref.existsOnDisk,
    managed: ref.managed,
    updatedAt: ref.updatedAt
  })
}

/** REQ-013: one deterministic review key from a comparison's or plan's
 *  `${agentKind}:${resourceType}` scope, status, and sorted public
 *  difference refs. Deliberately excludes every envelope-only field —
 *  `comparedAt`, `planId`, `direction`, `generatedAt`, `fingerprint` —
 *  so a direction-bound plan can be recognized as review-equivalent to
 *  the non-authorizing comparison the user reviewed. Never mutates the
 *  input arrays. */
export function configSyncReviewKey(review: ReviewLike): string {
  const diskOnly = [...review.diskOnly].sort(compareRefByPathThenId).map(serializeRef)
  const configOnly = [...review.configOnly].sort(compareRefByPathThenId).map(serializeRef)
  const changed = [...review.changed]
    .sort(compareChangedPair)
    .map((pair) => `${serializeRef(pair.disk)}|${serializeRef(pair.config)}`)

  return JSON.stringify({
    scope: review.scope,
    status: review.status,
    diskOnly,
    configOnly,
    changed
  })
}

export function formatUpdatedAt(updatedAt: number): string {
  if (!Number.isFinite(updatedAt) || updatedAt < 0) return 'Modified time unavailable'
  return new Date(updatedAt).toLocaleString()
}

/** REQ-007: visual label is `sha256:<first 12 chars>`; the full hash is
 *  exposed separately for `title`/accessible-label use so it's never
 *  lost, only de-emphasized in the default row display. */
export function formatHash(hash: string): { shortLabel: string; fullLabel: string } {
  return { shortLabel: `sha256:${hash.slice(0, 12)}`, fullLabel: `sha256:${hash}` }
}

function toFileRow(ref: HarnessConfigFileRef, sourceLabel: 'Disk' | 'Tatsu config'): ConfigSyncFileRow {
  const hash = formatHash(ref.hash)
  return {
    key: `${sourceLabel}:${ref.agentKind}:${ref.id}`,
    ref,
    sourceLabel,
    updatedAtLabel: formatUpdatedAt(ref.updatedAt),
    hashShortLabel: hash.shortLabel,
    hashFullLabel: hash.fullLabel
  }
}

/** REQ-004/REQ-005/REQ-008: immutable category sort + render-ready row
 *  construction. Reads the input arrays but never mutates or re-sorts
 *  them in place — every sort operates on a shallow copy. */
export function buildReviewSections(
  diskOnly: readonly HarnessConfigFileRef[],
  configOnly: readonly HarnessConfigFileRef[],
  changed: readonly HarnessConfigChangedRef[]
): ConfigSyncReviewSections {
  const sortedDiskOnly = [...diskOnly].sort(compareRefByPathThenId)
  const sortedConfigOnly = [...configOnly].sort(compareRefByPathThenId)
  const sortedChanged = [...changed].sort(compareChangedPair)

  return {
    diskOnly: sortedDiskOnly.map((ref) => toFileRow(ref, 'Disk')),
    configOnly: sortedConfigOnly.map((ref) => toFileRow(ref, 'Tatsu config')),
    changed: sortedChanged.map((pair) => ({
      key: `${pair.disk.agentKind}:${pair.disk.id}`,
      disk: toFileRow(pair.disk, 'Disk'),
      config: toFileRow(pair.config, 'Tatsu config')
    }))
  }
}

function reviewTimestamp(review: ReviewLike): number {
  return 'comparedAt' in review ? review.comparedAt : review.generatedAt
}

/** Converts either a non-authorizing `HarnessConfigComparison` or the
 *  discarded public comparison data of a `HarnessConfigSyncPlan` into
 *  the renderer-local, non-authorizing `ConfigSyncReview` the dialog
 *  renders. Never carries `planId`, `direction`, or `fingerprint` —
 *  callers that need apply authority keep the original plan object in
 *  their own request-scoped closure, never inside this projection. */
export function toConfigSyncReview(review: ReviewLike): ConfigSyncReview {
  return {
    scope: review.scope,
    scopeKey: harnessConfigScopeKey(review.scope),
    status: review.status,
    sections: buildReviewSections(review.diskOnly, review.configOnly, review.changed),
    reviewKey: configSyncReviewKey(review),
    timestampLabel: formatUpdatedAt(reviewTimestamp(review))
  }
}

/** TASK-002's pure decision function. `apply-fresh-plan` is reachable
 *  only when the fresh plan has drift (non-`synced` status) AND its
 *  review key equals the currently displayed review's key — i.e. the
 *  visible conflict is unchanged since the user reviewed it. */
export function decideFreshPlanOutcome(
  displayedReviewKey: string,
  freshPlan: HarnessConfigSyncPlan
): ConfigSyncFreshPlanDecision {
  if (freshPlan.status === 'synced') return 'already-synced'
  if (configSyncReviewKey(freshPlan) !== displayedReviewKey) return 'review-refreshed-plan'
  return 'apply-fresh-plan'
}

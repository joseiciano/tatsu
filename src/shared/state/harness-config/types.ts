import type { HarnessConfigResourceType } from '../../agent-registry'
import type { AgentKind } from '../terminals'

export type { HarnessConfigResourceType } from '../../agent-registry'

export type ManagedHarnessKind = Extract<AgentKind, 'claude' | 'codex' | 'opencode'>

export interface HarnessConfigScope {
  agentKind: ManagedHarnessKind
  resourceType: HarnessConfigResourceType
}

export type HarnessConfigScopeKey = `${ManagedHarnessKind}:${HarnessConfigResourceType}`

export interface HarnessConfigFileRef {
  id: string
  agentKind: ManagedHarnessKind
  resourceType: HarnessConfigResourceType
  canonicalResourceType: HarnessConfigResourceType
  aliasResourceTypes: HarnessConfigResourceType[]
  label: string
  relativePath: string
  absolutePath: string
  hash: string
  existsOnDisk: boolean
  managed: boolean
  updatedAt: number
}

export type HarnessConfigSyncDirection = 'sync-to-disk' | 'adopt-from-disk'

export type HarnessConfigSyncStatus = 'synced' | 'disk-only' | 'config-only' | 'conflict'

export interface HarnessConfigChangedRef {
  disk: HarnessConfigFileRef
  config: HarnessConfigFileRef
}

export interface HarnessConfigComparison {
  scope: HarnessConfigScope
  status: HarnessConfigSyncStatus
  diskOnly: HarnessConfigFileRef[]
  configOnly: HarnessConfigFileRef[]
  changed: HarnessConfigChangedRef[]
  comparedAt: number
}

export interface HarnessConfigSyncPlan {
  planId: string
  scope: HarnessConfigScope
  direction: HarnessConfigSyncDirection
  status: HarnessConfigSyncStatus
  diskOnly: HarnessConfigFileRef[]
  configOnly: HarnessConfigFileRef[]
  changed: HarnessConfigChangedRef[]
  generatedAt: number
  fingerprint: string
}

// --- Main-process service contracts, shared so main and renderer (via
// the transport layer) compile against one declaration instead of
// structurally duplicated copies. See Step 6's REQ-004/REQ-006. ---

/** Stable, safe error codes the main-process `HarnessConfigService` can
 *  throw. Never includes Node error text, stacks, or file content. */
export type HarnessConfigErrorCode =
  | 'unsupported-scope'
  | 'invalid-name'
  | 'unsafe-path'
  | 'unknown-resource'
  | 'unconfirmed-plan'
  | 'unknown-plan'
  | 'stale-plan'
  | 'scope-mismatch'
  | 'collision'
  | 'backup-failed'
  | 'read-failed'
  | 'write-failed'
  | 'delete-failed'
  | 'desired-state-failed'

export interface HarnessConfigAppliedOperation {
  type: 'create' | 'overwrite' | 'delete' | 'adopt'
  id?: string
  relativePath?: string
}

export type HarnessConfigMutationDirection = 'create' | 'update' | 'delete'

export interface HarnessConfigMutationPlan {
  planId: string
  scope: HarnessConfigScope
  direction: HarnessConfigMutationDirection
  resource: HarnessConfigFileRef
  generatedAt: number
  fingerprint: string
}

export interface HarnessConfigApplyRequest {
  scope: HarnessConfigScope
  planId: string
  confirmed: boolean
}

export interface HarnessConfigApplyResult {
  scope: HarnessConfigScope
  planId: string
  applied: HarnessConfigAppliedOperation[]
  resultingRefs: HarnessConfigFileRef[]
  requiresRescan: true
}

export type HarnessConfigConversionResult =
  | { status: 'alias'; ref: HarnessConfigFileRef }
  | { status: 'existing'; ref: HarnessConfigFileRef }
  | {
      status: 'draft'
      agentKind: ManagedHarnessKind
      resourceType: HarnessConfigResourceType
      name: string
      relativePath: string
      label: string
      content: string
    }

/** Content-bearing read result. Returned ONLY through the `readFile`
 *  request's response — never entered into `AppState`, a state event,
 *  a plan, or a log (REQ-014). */
export interface HarnessConfigReadFileResult {
  ref: HarnessConfigFileRef
  content: string
  hash: string
}

// --- Transport request/response envelope (Step 6) ---

/** Transport-owned error codes layered on top of the service's stable
 *  codes: `invalid-request` for boundary validation failures,
 *  `internal-error` for anything unexpected. */
export type HarnessConfigRequestErrorCode = HarnessConfigErrorCode | 'invalid-request' | 'internal-error'

export interface HarnessConfigRequestError {
  code: HarnessConfigRequestErrorCode
  message: string
}

export type HarnessConfigRequestResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: HarnessConfigRequestError }

/** Shared by `scan`, `compare`, and the two directional plan-generation
 *  channels — each accepts exactly `{ scope }` and nothing else. */
export interface HarnessConfigScopeRequest {
  scope: HarnessConfigScope
}

export interface HarnessConfigReadRequest {
  scope: HarnessConfigScope
  id: string
}

export interface HarnessConfigPrepareCreateRequest {
  scope: HarnessConfigScope
  name: string
  content: string
}

export interface HarnessConfigPrepareUpdateRequest {
  scope: HarnessConfigScope
  id: string
  content: string
}

export interface HarnessConfigPrepareDeleteRequest {
  scope: HarnessConfigScope
  id: string
}

export interface HarnessConfigConversionRequest {
  scope: HarnessConfigScope
  id: string
}

export interface HarnessConfigScanResult {
  resources: HarnessConfigFileRef[]
  scannedAt: number
}

export interface HarnessConfigState {
  resources: Record<HarnessConfigResourceType, HarnessConfigFileRef[]>
  comparisons: Partial<Record<HarnessConfigScopeKey, HarnessConfigComparison>>
  loading: boolean
  error: string | null
  lastScannedAt: number | null
  lastSyncedAt: number | null
}

export type HarnessConfigEvent =
  | { type: 'harnessConfig/loadingChanged'; payload: boolean }
  | {
      type: 'harnessConfig/resourcesLoaded'
      payload: {
        scope: HarnessConfigScope
        resources: HarnessConfigFileRef[]
        scannedAt: number
      }
    }
  | { type: 'harnessConfig/comparisonLoaded'; payload: HarnessConfigComparison }
  | {
      type: 'harnessConfig/syncApplied'
      payload: { scope: HarnessConfigScope; syncedAt: number }
    }
  | { type: 'harnessConfig/resourceUpserted'; payload: HarnessConfigFileRef }
  | {
      type: 'harnessConfig/resourceDeleted'
      payload: {
        agentKind: ManagedHarnessKind
        resourceType: HarnessConfigResourceType
        id: string
      }
    }
  | { type: 'harnessConfig/errorChanged'; payload: string | null }

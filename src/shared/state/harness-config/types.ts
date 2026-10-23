import type { HarnessConfigResourceType } from '../../agent-registry'
import type { AgentKind } from '../terminals'

export type { HarnessConfigResourceType } from '../../agent-registry'

export type ManagedHarnessKind = Extract<AgentKind, 'claude' | 'codex' | 'opencode'>

export type HarnessConfigRootKey =
  | 'claudeAgents'
  | 'claudeSkills'
  | 'claudeCommands'
  | 'codexHome'
  | 'codexSkills'
  | 'opencodeAgents'
  | 'opencodeSkills'
  | 'opencodeCommands'

export type HarnessConfigRoots = Partial<Record<HarnessConfigRootKey, string>>

export interface HarnessConfigFolderDefaults {
  roots: Record<HarnessConfigRootKey, string>
  sourceDir: string
}

export interface HarnessConfigSetRootRequest {
  key: HarnessConfigRootKey
  path: string | null
}

export type HarnessConfigFolderSettingResult = { ok: true } | { ok: false; message: string }

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
  /** Real path of the symlink that makes this resource managed elsewhere
   *  (Step 17). Display-only; never trusted as a write target. */
  linkedFrom?: string
  /** `<kind>/<name>` of the template that rendered this file, read from
   *  its provenance marker (Step 19). Absent for hand-written files. */
  templateRef?: string
  /** `'template'` when this Tatsu config entry is built from a template
   *  (Step 20); absent for stored entries and disk refs. */
  source?: 'template'
}

/** A template whose render failed. It contributes nothing to Tatsu
 *  config, and `held` lists its earlier disk output, which sync to disk
 *  leaves alone instead of deleting (Step 20 REQ-007). */
export interface HarnessConfigRenderErrorEntry {
  templateRef: string
  message: string
  held: HarnessConfigFileRef[]
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
  /** Stored entries hidden by a template that renders to the same path. */
  shadowed?: HarnessConfigFileRef[]
  renderErrors?: HarnessConfigRenderErrorEntry[]
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
  shadowed?: HarnessConfigFileRef[]
  renderErrors?: HarnessConfigRenderErrorEntry[]
  /** Adopt only: template-built ids whose disk content is stored as a
   *  plain entry while that harness is removed from the template. */
  detach?: string[]
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
  | 'linked-resource'
  | 'invalid-template'
  | 'invalid-target'
  | 'template-shadows'

export interface HarnessConfigAppliedOperation {
  type: 'create' | 'overwrite' | 'delete' | 'adopt' | 'detach'
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
  applied?: HarnessConfigAppliedOperation[]
  requiresRescan?: true
}

export type HarnessConfigRequestResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: HarnessConfigRequestError }

/** Shared by `scan`, `compare`, and the two directional plan-generation
 *  channels — each accepts exactly `{ scope }` and nothing else. */
export interface HarnessConfigScopeRequest {
  scope: HarnessConfigScope
}

export interface HarnessConfigAdoptRequest {
  scope: HarnessConfigScope
  /** Template-built ids to detach; every other template-built id keeps
   *  its template and is skipped (Step 20 REQ-006). */
  detach?: string[]
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

// --- Template source model (Step 18) ---

export type HarnessTemplateKind = 'agent' | 'skill' | 'command'

/** One harness's block in a template. `frontmatter` is that harness's
 *  native frontmatter, kept as written; `name` and `fragments` are the
 *  only keys Tatsu reads, as per-harness overrides. */
export interface HarnessTemplateHarnessBlock {
  name?: string
  fragments?: string[]
  frontmatter: Record<string, unknown>
}

export type HarnessTemplateHarnesses = Partial<Record<ManagedHarnessKind, HarnessTemplateHarnessBlock | false>>

export interface HarnessTemplateReference {
  fileName: string
  content: string
}

export interface HarnessTemplate {
  kind: HarnessTemplateKind
  name: string
  description: string
  fragments: string[]
  body: string
  harnesses: HarnessTemplateHarnesses
  references: HarnessTemplateReference[]
  relativePath: string
  hash: string
}

export interface HarnessFragment {
  name: string
  content: string
  relativePath: string
  hash: string
}

export interface HarnessTemplateParseError {
  relativePath: string
  message: string
}

export interface HarnessTemplateTargetError {
  agentKind: ManagedHarnessKind
  message: string
}

export interface HarnessTemplateSourceState {
  templates: HarnessTemplate[]
  fragments: HarnessFragment[]
  errors: HarnessTemplateParseError[]
  loadedAt: number | null
}

export interface HarnessTemplateSaveRequest {
  template: {
    kind: HarnessTemplateKind
    name: string
    description: string
    fragments: string[]
    body: string
    harnesses: HarnessTemplateHarnesses
    references: HarnessTemplateReference[]
  }
  confirmed: boolean
  /** Set after the user saw the `template-shadows` warning. */
  allowShadowing?: boolean
}

export interface HarnessTemplateDeleteRequest {
  kind: HarnessTemplateKind
  name: string
  confirmed: boolean
}

export interface HarnessFragmentSaveRequest {
  name: string
  content: string
  confirmed: boolean
}

export interface HarnessFragmentDeleteRequest {
  name: string
  confirmed: boolean
}

export interface HarnessConfigState {
  resources: Record<HarnessConfigResourceType, HarnessConfigFileRef[]>
  comparisons: Partial<Record<HarnessConfigScopeKey, HarnessConfigComparison>>
  loading: boolean
  error: string | null
  lastScannedAt: number | null
  lastSyncedAt: number | null
  templates: HarnessTemplateSourceState
  templateSyncNotice: HarnessConfigTemplateSyncNotice | null
}

/** Scopes a template or fragment save put out of sync with disk
 *  (Step 20 REQ-005). */
export interface HarnessConfigTemplateSyncNotice {
  scopes: HarnessConfigScopeKey[]
  changedAt: number
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
  | {
      type: 'harnessConfig/templatesLoaded'
      payload: { templates: HarnessTemplate[]; errors: HarnessTemplateParseError[]; loadedAt: number }
    }
  | { type: 'harnessConfig/templateChanged'; payload: HarnessTemplate }
  | {
      type: 'harnessConfig/templateRemoved'
      payload: { kind: HarnessTemplateKind; name: string }
    }
  | {
      type: 'harnessConfig/fragmentsLoaded'
      payload: { fragments: HarnessFragment[]; errors: HarnessTemplateParseError[]; loadedAt: number }
    }
  | { type: 'harnessConfig/fragmentChanged'; payload: HarnessFragment }
  | { type: 'harnessConfig/fragmentRemoved'; payload: { name: string } }
  | { type: 'harnessConfig/templateSyncNoticeChanged'; payload: HarnessConfigTemplateSyncNotice | null }
  | {
      type: 'harnessConfig/templateSourceErrorChanged'
      payload: { relativePath: string; message: string | null }
    }

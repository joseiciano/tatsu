import type { Dirent, Stats } from 'fs'
import type { AgentKind } from '../../shared/state/terminals'

export type HarnessConfigResourceType = 'agents' | 'skills' | 'commands'
export type ManagedHarnessKind = Extract<AgentKind, 'claude' | 'codex' | 'opencode'>

export interface HarnessConfigScope {
  agentKind: ManagedHarnessKind
  resourceType: HarnessConfigResourceType
}

export function harnessConfigScopeKey(scope: HarnessConfigScope): string {
  return `${scope.agentKind}:${scope.resourceType}`
}

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

export class HarnessConfigError extends Error {
  readonly code: HarnessConfigErrorCode
  readonly applied?: HarnessConfigAppliedOperation[]
  readonly requiresRescan?: boolean

  constructor(
    code: HarnessConfigErrorCode,
    message: string,
    options: {
      cause?: unknown
      applied?: HarnessConfigAppliedOperation[]
      requiresRescan?: boolean
    } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'HarnessConfigError'
    this.code = code
    this.applied = options.applied
    this.requiresRescan = options.requiresRescan
  }
}

export interface HarnessConfigResolverAlias {
  resourceType: HarnessConfigResourceType
  canonicalResourceType: HarnessConfigResourceType
}

export interface HarnessConfigResourceResolver {
  supported: boolean
  reason?: string
  rootKey?: string
  identity: string
  verificationSource?: string
  canonicalResourceType?: HarnessConfigResourceType
  aliasResourceTypes?: HarnessConfigResourceType[]
  aliasSourceResourceTypes?: HarnessConfigResourceType[]
  aliases?: HarnessConfigResolverAlias[]
  maxDepth?: number
  pattern?: RegExp
  matches?: (relativePath: string) => boolean
  nameToRelativePath?: (name: string) => string
}

export interface HarnessResolver {
  agentKind: ManagedHarnessKind
  identity: string
  resources: Partial<Record<HarnessConfigResourceType, HarnessConfigResourceResolver>>
}

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

export interface HarnessConfigDesiredResource {
  id: string
  agentKind: ManagedHarnessKind
  resourceType: HarnessConfigResourceType
  canonicalResourceType?: HarnessConfigResourceType
  aliasResourceTypes?: HarnessConfigResourceType[]
  relativePath: string
  label: string
  content: string
  hash: string
  updatedAt: number
}

export type HarnessConfigComparisonStatus = 'synced' | 'disk-only' | 'config-only' | 'conflict'
export interface HarnessConfigChangedRef {
  disk: HarnessConfigFileRef
  config: HarnessConfigFileRef
}

export interface HarnessConfigComparison {
  scope: HarnessConfigScope
  status: HarnessConfigComparisonStatus
  diskOnly: HarnessConfigFileRef[]
  configOnly: HarnessConfigFileRef[]
  changed: HarnessConfigChangedRef[]
  comparedAt: number
}

export type HarnessConfigPlanDirection =
  | 'sync-to-disk'
  | 'adopt-from-disk'
  | 'create'
  | 'update'
  | 'delete'

export interface HarnessConfigSyncPlan {
  planId: string
  scope: HarnessConfigScope
  direction: 'sync-to-disk' | 'adopt-from-disk'
  status: HarnessConfigComparisonStatus
  diskOnly: HarnessConfigFileRef[]
  configOnly: HarnessConfigFileRef[]
  changed: HarnessConfigChangedRef[]
  generatedAt: number
  fingerprint: string
}

export interface HarnessConfigMutationPlan {
  planId: string
  scope: HarnessConfigScope
  direction: 'create' | 'update' | 'delete'
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

export interface HarnessConfigReadResult {
  ref: HarnessConfigFileRef
  content: string
  hash: string
}

export interface HarnessConfigFilesystem {
  readdirSync(path: string, options: { withFileTypes: true }): Dirent[]
  lstatSync(path: string): Stats
  readFileSync(path: string): Buffer
  writeFileSync(path: string, data: string | Uint8Array, options?: { flag?: string }): void
  renameSync(oldPath: string, newPath: string): void
  unlinkSync(path: string): void
  mkdirSync(path: string, options: { recursive: true }): unknown
  existsSync(path: string): boolean
  realpathSync(path: string): string
}

export interface HarnessConfigServiceDeps {
  knownRoots?: Record<string, string | undefined>
  resolvers?: Partial<Record<ManagedHarnessKind, HarnessResolver>>
  homeDir?: string
  env?: Record<string, string | undefined>
  clock?: () => number
  uuid?: () => string
  loadDesiredResources?: () => HarnessConfigDesiredResource[]
  replaceDesiredScope?: (
    scope: HarnessConfigScope,
    resources: HarnessConfigDesiredResource[]
  ) => void | Promise<void>
  filesystem?: HarnessConfigFilesystem
  fs?: HarnessConfigFilesystem
  log?: (category: string, message: string, data?: unknown) => void
  formatErr?: (error: unknown) => string
}

export interface HarnessConfigService {
  scan(scope: HarnessConfigScope): HarnessConfigFileRef[]
  readFile(id: string): HarnessConfigReadResult
  planSync(scope: HarnessConfigScope): HarnessConfigComparison
  planSyncToDisk(scope: HarnessConfigScope): HarnessConfigSyncPlan
  planAdoptFromDisk(scope: HarnessConfigScope): HarnessConfigSyncPlan
  prepareCreate(scope: HarnessConfigScope, name: string, content: string): HarnessConfigMutationPlan
  prepareUpdate(scope: HarnessConfigScope, id: string, content: string): HarnessConfigMutationPlan
  prepareDelete(scope: HarnessConfigScope, id: string): HarnessConfigMutationPlan
  prepareCommandFromSkill(scope: HarnessConfigScope, id: string): HarnessConfigConversionResult
  prepareSkillFromCommand(scope: HarnessConfigScope, id: string): HarnessConfigConversionResult
  applyPlan(request: HarnessConfigApplyRequest): Promise<HarnessConfigApplyResult>
}

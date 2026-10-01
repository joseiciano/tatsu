import type { Dirent, Stats } from 'fs'
import type { HarnessConfigResourceType } from '../../shared/agent-registry'
import type {
  HarnessConfigAppliedOperation,
  HarnessConfigApplyRequest,
  HarnessConfigApplyResult,
  HarnessConfigComparison,
  HarnessConfigConversionResult,
  HarnessConfigErrorCode,
  HarnessConfigFileRef,
  HarnessConfigMutationDirection,
  HarnessConfigMutationPlan,
  HarnessConfigReadFileResult,
  HarnessConfigScope,
  HarnessConfigSyncPlan,
  ManagedHarnessKind
} from '../../shared/state/harness-config'

// Re-exported so main-side consumers keep importing these through the
// `src/main/harness-config` barrel. The canonical declarations live in
// `src/shared/state/harness-config/types.ts` (REQ-006) so main and the
// transport layer compile against one union/shape instead of two.
export type {
  HarnessConfigAppliedOperation,
  HarnessConfigApplyRequest,
  HarnessConfigApplyResult,
  HarnessConfigConversionResult,
  HarnessConfigErrorCode,
  HarnessConfigMutationDirection,
  HarnessConfigMutationPlan
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

/** Local alias kept so existing main-side call sites don't need to
 *  rename; the canonical shape is the shared `HarnessConfigReadFileResult`. */
export type HarnessConfigReadResult = HarnessConfigReadFileResult

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

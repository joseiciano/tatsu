import type { Dirent, Stats } from 'fs'
import type { HarnessConfigResourceType } from '../../shared/agent-registry'
import type {
  RenderableFragment,
  RenderableTemplate,
  TemplateRenderResult
} from '../../shared/harness-template-render'
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
  HarnessConfigRootKey,
  HarnessConfigScope,
  HarnessConfigSyncPlan,
  HarnessTemplate,
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

/** Input to the pure skill/command content generators in `./conversion`
 *  (REQ-002). `resourceType` is the SOURCE resource type — `skills` for
 *  `createCommandFromSkill`, `commands` for `createSkillFromCommand` —
 *  not the destination the generator produces. */
export interface HarnessConfigConversionSource {
  agentKind: ManagedHarnessKind
  resourceType: Extract<HarnessConfigResourceType, 'skills' | 'commands'>
  name: string
  label: string
  relativePath: string
  content: string
}

/** Pure generator output (REQ-004/REQ-005). Request-scoped only — never
 *  entered into `AppState`, a plan, or persisted config (REQ-018). */
export interface HarnessConfigConversionDraft {
  destinationResourceType: Extract<HarnessConfigResourceType, 'skills' | 'commands'>
  destinationName: string
  content: string
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
  /** Set only on entries rendered from a template; never persisted. */
  source?: 'template'
  templateRef?: string
}

export interface HarnessConfigTemplateSource {
  templates: readonly (RenderableTemplate & { hash?: string })[]
  fragments: readonly (RenderableFragment & { hash?: string })[]
  errors?: readonly { relativePath: string; message: string }[]
}

export interface HarnessConfigShadowedEntry {
  agentKind: ManagedHarnessKind
  resourceType: HarnessConfigResourceType
  relativePath: string
}

export interface HarnessConfigAdoptOptions {
  detach?: readonly string[]
}

/** Local alias kept so existing main-side call sites don't need to
 *  rename; the canonical shape is the shared `HarnessConfigReadFileResult`. */
export type HarnessConfigReadResult = HarnessConfigReadFileResult

export interface HarnessConfigFilesystem {
  readdirSync(path: string, options: { withFileTypes: true }): Dirent[]
  lstatSync(path: string): Stats
  statSync(path: string): Stats
  readFileSync(path: string): Buffer
  writeFileSync(path: string, data: string | Uint8Array, options?: { flag?: string }): void
  renameSync(oldPath: string, newPath: string): void
  unlinkSync(path: string): void
  mkdirSync(path: string, options: { recursive: true }): unknown
  existsSync(path: string): boolean
  realpathSync(path: string): string
}

export interface HarnessConfigServiceDeps {
  knownRoots?: () => Partial<Record<HarnessConfigRootKey, string>>
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
  loadTemplateSource?: () => HarnessConfigTemplateSource
  render?: (
    templates: readonly RenderableTemplate[],
    fragments: readonly RenderableFragment[]
  ) => TemplateRenderResult
  /** Removes `agentKind` from the template's targets (adopt "Detach"). */
  detachTemplateTarget?: (templateRef: string, agentKind: ManagedHarnessKind) => void | Promise<void>
  filesystem?: HarnessConfigFilesystem
  log?: (category: string, message: string, data?: unknown) => void
  formatErr?: (error: unknown) => string
}

export interface HarnessConfigService {
  scan(scope: HarnessConfigScope): HarnessConfigFileRef[]
  readFile(id: string): HarnessConfigReadResult
  planSync(scope: HarnessConfigScope): HarnessConfigComparison
  planSyncToDisk(scope: HarnessConfigScope): HarnessConfigSyncPlan
  planAdoptFromDisk(scope: HarnessConfigScope, options?: HarnessConfigAdoptOptions): HarnessConfigSyncPlan
  prepareCreate(scope: HarnessConfigScope, name: string, content: string): HarnessConfigMutationPlan
  prepareUpdate(scope: HarnessConfigScope, id: string, content: string): HarnessConfigMutationPlan
  prepareDelete(scope: HarnessConfigScope, id: string): HarnessConfigMutationPlan
  prepareCommandFromSkill(scope: HarnessConfigScope, id: string): HarnessConfigConversionResult
  prepareSkillFromCommand(scope: HarnessConfigScope, id: string): HarnessConfigConversionResult
  applyPlan(request: HarnessConfigApplyRequest): Promise<HarnessConfigApplyResult>
  defaultRoots(): Record<HarnessConfigRootKey, string>
  scopesForRootKeys(keys: readonly HarnessConfigRootKey[]): HarnessConfigScope[]
  /** Supported scopes that a template's output lands in, aliases included. */
  scopesForTemplates(templates: readonly Pick<HarnessTemplate, 'kind' | 'harnesses'>[]): HarnessConfigScope[]
  /** Stored entries this template would hide if saved (REQ-002). */
  templateShadows(template: RenderableTemplate): HarnessConfigShadowedEntry[]
}

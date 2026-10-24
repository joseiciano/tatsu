import { toAgentKind } from '../agent-kind'
import { HarnessConfigError, harnessConfigScopeKey, type HarnessConfigService } from '../harness-config'
import { formatErr as defaultFormatErr, log as defaultLog } from '../debug'
import type { HarnessTemplateDraft } from '../../shared/harness-templates'
import {
  planTemplateImport,
  TemplateImportReadError,
  type TemplateImportListing,
  type TemplateImportPlan
} from '../template-import'
import type {
  HarnessConfigAdoptRequest,
  HarnessFragment,
  HarnessTemplate,
  HarnessTemplateHarnessBlock,
  HarnessTemplateHarnesses,
  HarnessTemplateKind,
  HarnessTemplateReference,
  HarnessTemplateImportApplyResult,
  HarnessTemplateImportChoices,
  HarnessTemplateImportConflictChoice,
  HarnessTemplateImportFolders,
  HarnessTemplateImportPreview,
  HarnessConfigApplyRequest,
  HarnessConfigApplyResult,
  HarnessConfigComparison,
  HarnessConfigConversionResult,
  HarnessConfigEvent,
  HarnessConfigFileRef,
  HarnessConfigFragmentResolution,
  HarnessConfigMutationPlan,
  HarnessConfigPrepareCreateRequest,
  HarnessConfigPrepareUpdateRequest,
  HarnessConfigReadFileResult,
  HarnessConfigReadRequest,
  HarnessConfigRequestError,
  HarnessConfigRequestResult,
  HarnessConfigResolveFragmentEditResult,
  HarnessConfigResourceType,
  HarnessConfigScanResult,
  HarnessConfigScope,
  HarnessConfigScopeRequest,
  HarnessConfigSyncPlan,
  HarnessFragmentUsageResult,
  ManagedHarnessKind
} from '../../shared/state/harness-config'

export interface HarnessConfigConnectionContext {
  clientId: string
}

export interface HarnessConfigTransportLike {
  onRequest(
    name: string,
    handler: (ctx: HarnessConfigConnectionContext, payload: unknown) => unknown | Promise<unknown>
  ): void
}

export interface HarnessConfigStoreLike {
  dispatch(event: HarnessConfigEvent): void
}

export interface HarnessTemplateSourceLike {
  saveTemplate(draft: HarnessTemplateDraft): HarnessTemplate
  deleteTemplate(kind: HarnessTemplateKind, name: string): void
  saveFragment(name: string, content: string): HarnessFragment
  deleteFragment(name: string): void
}

export interface HarnessTemplateImportLike {
  /** Reads the picked folders; never writes to them (Step 22 CON-001). */
  readListing(folders: HarnessTemplateImportFolders): TemplateImportListing
  existing(): {
    templates: readonly HarnessTemplate[]
    fragments: readonly HarnessFragment[]
    errors?: readonly { relativePath: string }[]
  }
}

export interface RegisterHarnessConfigRequestHandlersDeps {
  transport: HarnessConfigTransportLike
  store: HarnessConfigStoreLike
  service: HarnessConfigService
  templateSource?: HarnessTemplateSourceLike
  templateImport?: HarnessTemplateImportLike
  now?: () => number
  log?: (category: string, message: string, data?: unknown) => void
  formatErr?: (error: unknown) => string
}

const MAX_LIVE_BINDINGS = 64

const MANAGED_AGENT_KINDS: readonly ManagedHarnessKind[] = ['claude', 'codex', 'opencode']
const RESOURCE_TYPES: readonly HarnessConfigResourceType[] = ['agents', 'skills', 'commands']
const TEMPLATE_KINDS: readonly HarnessTemplateKind[] = ['agent', 'skill', 'command']

const CHANNEL = {
  scan: 'harnessConfig:scan',
  readFile: 'harnessConfig:readFile',
  compare: 'harnessConfig:compare',
  prepareCreate: 'harnessConfig:prepareCreate',
  prepareUpdate: 'harnessConfig:prepareUpdate',
  prepareDelete: 'harnessConfig:prepareDelete',
  planSyncToDisk: 'harnessConfig:planSyncToDisk',
  planAdoptFromDisk: 'harnessConfig:planAdoptFromDisk',
  createFile: 'harnessConfig:createFile',
  updateFile: 'harnessConfig:updateFile',
  deleteFile: 'harnessConfig:deleteFile',
  syncToDisk: 'harnessConfig:syncToDisk',
  adoptFromDisk: 'harnessConfig:adoptFromDisk',
  prepareCommandFromSkill: 'harnessConfig:prepareCommandFromSkill',
  prepareSkillFromCommand: 'harnessConfig:prepareSkillFromCommand',
  saveTemplate: 'harnessConfig:saveTemplate',
  deleteTemplate: 'harnessConfig:deleteTemplate',
  saveFragment: 'harnessConfig:saveFragment',
  deleteFragment: 'harnessConfig:deleteFragment',
  previewImport: 'harnessConfig:previewImport',
  applyImport: 'harnessConfig:applyImport',
  resolveFragmentEdit: 'harnessConfig:resolveFragmentEdit',
  fragmentUsage: 'harnessConfig:fragmentUsage'
} as const

type MutationChannel =
  | typeof CHANNEL.createFile
  | typeof CHANNEL.updateFile
  | typeof CHANNEL.deleteFile
  | typeof CHANNEL.syncToDisk
  | typeof CHANNEL.adoptFromDisk

class HarnessConfigValidationError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertExactKeys(raw: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(raw)
  if (actual.length !== keys.length || !keys.every((key) => actual.includes(key))) {
    throw new HarnessConfigValidationError('The request has missing or unexpected fields')
  }
}

function parseManagedScope(raw: unknown): HarnessConfigScope {
  if (!isPlainObject(raw)) throw new HarnessConfigValidationError('scope must be an object')
  assertExactKeys(raw, ['agentKind', 'resourceType'])
  const { agentKind, resourceType } = raw
  if (
    typeof agentKind !== 'string' ||
    toAgentKind(agentKind) !== agentKind ||
    !MANAGED_AGENT_KINDS.includes(agentKind as ManagedHarnessKind)
  ) {
    throw new HarnessConfigValidationError('scope.agentKind is unknown or unsupported')
  }
  if (typeof resourceType !== 'string' || !RESOURCE_TYPES.includes(resourceType as HarnessConfigResourceType)) {
    throw new HarnessConfigValidationError('scope.resourceType is unknown or unsupported')
  }
  return { agentKind: agentKind as ManagedHarnessKind, resourceType: resourceType as HarnessConfigResourceType }
}

function parseNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HarnessConfigValidationError(`${field} must be a non-empty string`)
  }
  return value
}

function parseContentString(value: unknown): string {
  if (typeof value !== 'string') throw new HarnessConfigValidationError('content must be a string')
  return value
}

function parseBooleanFlag(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new HarnessConfigValidationError(`${field} must be a boolean`)
  return value
}

function parseConfirmedFlag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new HarnessConfigValidationError('confirmed must be a boolean')
  return value
}

function requireObject(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) throw new HarnessConfigValidationError('The request body must be an object')
  return raw
}

function parseScopeOnlyRequest(raw: unknown): HarnessConfigScopeRequest {
  const obj = requireObject(raw)
  assertExactKeys(obj, ['scope'])
  return { scope: parseManagedScope(obj.scope) }
}

function parseAdoptRequest(raw: unknown): HarnessConfigAdoptRequest {
  const obj = requireObject(raw)
  if (!('detach' in obj)) {
    assertExactKeys(obj, ['scope'])
    return { scope: parseManagedScope(obj.scope) }
  }
  assertExactKeys(obj, ['scope', 'detach'])
  const detach = parseStringList(obj.detach, 'detach')
  if (detach.some((id) => id.length === 0)) throw new HarnessConfigValidationError('detach ids must be non-empty')
  return { scope: parseManagedScope(obj.scope), detach }
}

function parseScopeIdRequest(raw: unknown): HarnessConfigReadRequest {
  const obj = requireObject(raw)
  assertExactKeys(obj, ['scope', 'id'])
  return { scope: parseManagedScope(obj.scope), id: parseNonEmptyString(obj.id, 'id') }
}

function parsePrepareCreateRequest(raw: unknown): HarnessConfigPrepareCreateRequest {
  const obj = requireObject(raw)
  assertExactKeys(obj, ['scope', 'name', 'content'])
  return {
    scope: parseManagedScope(obj.scope),
    name: parseNonEmptyString(obj.name, 'name'),
    content: parseContentString(obj.content)
  }
}

function parsePrepareUpdateRequest(raw: unknown): HarnessConfigPrepareUpdateRequest {
  const obj = requireObject(raw)
  assertExactKeys(obj, ['scope', 'id', 'content'])
  return {
    scope: parseManagedScope(obj.scope),
    id: parseNonEmptyString(obj.id, 'id'),
    content: parseContentString(obj.content)
  }
}

function parseMutationRequest(raw: unknown): HarnessConfigApplyRequest {
  const obj = requireObject(raw)
  assertExactKeys(obj, ['scope', 'planId', 'confirmed'])
  return {
    scope: parseManagedScope(obj.scope),
    planId: parseNonEmptyString(obj.planId, 'planId'),
    confirmed: parseConfirmedFlag(obj.confirmed)
  }
}

function parseStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new HarnessConfigValidationError(`${field} must be a list of names`)
  }
  return [...value]
}

function parseTemplateKind(value: unknown): HarnessTemplateKind {
  if (typeof value !== 'string' || !TEMPLATE_KINDS.includes(value as HarnessTemplateKind)) {
    throw new HarnessConfigValidationError('kind must be agent, skill, or command')
  }
  return value as HarnessTemplateKind
}

function parseHarnessBlock(value: unknown, harness: string): HarnessTemplateHarnessBlock | false {
  if (value === false) return false
  if (!isPlainObject(value)) throw new HarnessConfigValidationError(`harnesses.${harness} must be an object or false`)
  const allowed = ['frontmatter', 'name', 'fragments']
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new HarnessConfigValidationError(`harnesses.${harness} has unexpected fields`)
  }
  if (!isPlainObject(value.frontmatter)) {
    throw new HarnessConfigValidationError(`harnesses.${harness}.frontmatter must be an object`)
  }
  const block: HarnessTemplateHarnessBlock = { frontmatter: { ...value.frontmatter } }
  if (value.name !== undefined) block.name = parseNonEmptyString(value.name, `harnesses.${harness}.name`)
  if (value.fragments !== undefined) block.fragments = parseStringList(value.fragments, `harnesses.${harness}.fragments`)
  return block
}

function parseHarnesses(value: unknown): HarnessTemplateHarnesses {
  if (!isPlainObject(value)) throw new HarnessConfigValidationError('harnesses must be an object')
  const harnesses: HarnessTemplateHarnesses = {}
  for (const [key, block] of Object.entries(value)) {
    if (!MANAGED_AGENT_KINDS.includes(key as ManagedHarnessKind)) {
      throw new HarnessConfigValidationError(`harnesses.${key} is not a managed harness`)
    }
    harnesses[key as ManagedHarnessKind] = parseHarnessBlock(block, key)
  }
  return harnesses
}

function parseReferences(value: unknown): HarnessTemplateReference[] {
  if (!Array.isArray(value)) throw new HarnessConfigValidationError('references must be a list')
  return value.map((entry) => {
    if (!isPlainObject(entry)) throw new HarnessConfigValidationError('Each reference must be an object')
    assertExactKeys(entry, ['fileName', 'content'])
    return { fileName: parseNonEmptyString(entry.fileName, 'fileName'), content: parseContentString(entry.content) }
  })
}

function parseTemplateDraft(raw: unknown): HarnessTemplateDraft {
  if (!isPlainObject(raw)) throw new HarnessConfigValidationError('template must be an object')
  assertExactKeys(raw, ['kind', 'name', 'description', 'fragments', 'body', 'harnesses', 'references'])
  if (typeof raw.description !== 'string') throw new HarnessConfigValidationError('description must be a string')
  if (typeof raw.body !== 'string') throw new HarnessConfigValidationError('body must be a string')
  return {
    kind: parseTemplateKind(raw.kind),
    name: parseNonEmptyString(raw.name, 'name'),
    description: raw.description,
    fragments: parseStringList(raw.fragments, 'fragments'),
    body: raw.body,
    harnesses: parseHarnesses(raw.harnesses),
    references: parseReferences(raw.references)
  }
}

function parseOptionalPath(value: unknown, field: string): string | null {
  if (value === null) return null
  return parseNonEmptyString(value, field)
}

function parseImportFolders(raw: unknown): HarnessTemplateImportFolders {
  if (!isPlainObject(raw)) throw new HarnessConfigValidationError('folders must be an object')
  assertExactKeys(raw, ['agents', 'agentFragments', 'skills', 'references', 'commands'])
  const skills = parseStringList(raw.skills, 'folders.skills')
  if (skills.some((path) => path.length === 0)) throw new HarnessConfigValidationError('folders.skills has an empty path')
  return {
    agents: parseOptionalPath(raw.agents, 'folders.agents'),
    agentFragments: parseOptionalPath(raw.agentFragments, 'folders.agentFragments'),
    skills,
    references: parseOptionalPath(raw.references, 'folders.references'),
    commands: parseOptionalPath(raw.commands, 'folders.commands')
  }
}

function parseStringRecord<T extends string>(raw: unknown, field: string, allowed?: readonly T[]): Record<string, T> {
  if (!isPlainObject(raw)) throw new HarnessConfigValidationError(`${field} must be an object`)
  const out: Record<string, T> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string' || (allowed && !allowed.includes(value as T))) {
      throw new HarnessConfigValidationError(`${field}.${key} is invalid`)
    }
    out[key] = value as T
  }
  return out
}

function parseImportChoices(raw: unknown): HarnessTemplateImportChoices {
  if (!isPlainObject(raw)) throw new HarnessConfigValidationError('choices must be an object')
  assertExactKeys(raw, ['harnesses', 'duplicateChoices', 'conflictChoices'])
  const harnesses = parseStringList(raw.harnesses, 'choices.harnesses')
  if (harnesses.some((harness) => !MANAGED_AGENT_KINDS.includes(harness as ManagedHarnessKind))) {
    throw new HarnessConfigValidationError('choices.harnesses has an unmanaged harness')
  }
  return {
    harnesses: [...new Set(harnesses)] as ManagedHarnessKind[],
    duplicateChoices: parseStringRecord(raw.duplicateChoices, 'choices.duplicateChoices'),
    conflictChoices: parseStringRecord<HarnessTemplateImportConflictChoice>(
      raw.conflictChoices,
      'choices.conflictChoices',
      ['skip', 'replace']
    )
  }
}

const FRAGMENT_RESOLUTIONS: readonly HarnessConfigFragmentResolution[] = ['overwrite', 'detach', 'keep-edit']

function parseFragmentResolution(value: unknown): HarnessConfigFragmentResolution {
  if (typeof value !== 'string' || !(FRAGMENT_RESOLUTIONS as readonly string[]).includes(value)) {
    throw new HarnessConfigValidationError('resolution must be overwrite, detach, or keep-edit')
  }
  return value as HarnessConfigFragmentResolution
}

function requireConfirmed(value: unknown): void {
  if (parseConfirmedFlag(value) !== true) {
    throw new HarnessConfigError('unconfirmed-plan', 'The change was not explicitly confirmed')
  }
}

function toRequestError(error: unknown): HarnessConfigRequestError {
  if (error instanceof HarnessConfigValidationError) {
    return { code: 'invalid-request', message: error.message }
  }
  if (error instanceof HarnessConfigError) {
    const requestError: HarnessConfigRequestError = { code: error.code, message: error.message }
    if (error.applied) requestError.applied = error.applied.map((op) => ({ ...op }))
    if (error.requiresRescan) requestError.requiresRescan = true
    return requestError
  }
  return { code: 'internal-error', message: 'The harness configuration request failed unexpectedly' }
}

interface PlanBinding {
  mutationChannel: MutationChannel
  scopeKey: string
  refreshScopes: HarnessConfigScope[]
}

function collectRefreshScopes(scope: HarnessConfigScope, refs: readonly HarnessConfigFileRef[]): HarnessConfigScope[] {
  const resourceTypes = new Set<HarnessConfigResourceType>([scope.resourceType])
  for (const ref of refs) {
    resourceTypes.add(ref.canonicalResourceType)
    for (const alias of ref.aliasResourceTypes) resourceTypes.add(alias)
  }
  return [...resourceTypes].map((resourceType) => ({ agentKind: scope.agentKind, resourceType }))
}

function syncPlanRefs(plan: HarnessConfigSyncPlan): HarnessConfigFileRef[] {
  return [...plan.diskOnly, ...plan.configOnly, ...plan.changed.flatMap((entry) => [entry.disk, entry.config])]
}

function isDirectionalChannel(channel: MutationChannel): boolean {
  return channel === CHANNEL.syncToDisk || channel === CHANNEL.adoptFromDisk
}

export function registerHarnessConfigRequestHandlers(deps: RegisterHarnessConfigRequestHandlersDeps): void {
  const { transport, store, service } = deps
  const now = deps.now ?? Date.now
  const log = deps.log ?? defaultLog
  const formatErr = deps.formatErr ?? defaultFormatErr

  const bindings = new Map<string, PlanBinding>()
  let inFlight = 0

  function bindPlan(planId: string, binding: PlanBinding): void {
    bindings.delete(planId)
    while (bindings.size >= MAX_LIVE_BINDINGS) {
      const oldest = bindings.keys().next().value
      if (oldest === undefined) break
      bindings.delete(oldest)
    }
    bindings.set(planId, binding)
  }

  function logUnexpected(error: unknown): void {
    log('harness-config', 'transport request failed unexpectedly', formatErr(error))
  }

  // In-flight counter so overlapping requests can't clear loading early.
  async function withLifecycle<T>(action: () => Promise<T> | T): Promise<HarnessConfigRequestResult<T>> {
    store.dispatch({ type: 'harnessConfig/errorChanged', payload: null })
    if (inFlight === 0) store.dispatch({ type: 'harnessConfig/loadingChanged', payload: true })
    inFlight += 1
    try {
      const value = await action()
      return { ok: true, value }
    } catch (error) {
      if (!(error instanceof HarnessConfigValidationError) && !(error instanceof HarnessConfigError)) {
        logUnexpected(error)
      }
      const requestError = toRequestError(error)
      store.dispatch({ type: 'harnessConfig/errorChanged', payload: requestError.message })
      return { ok: false, error: requestError }
    } finally {
      inFlight -= 1
      if (inFlight === 0) store.dispatch({ type: 'harnessConfig/loadingChanged', payload: false })
    }
  }

  function tryCompareAfterApply(scope: HarnessConfigScope): HarnessConfigComparison | null {
    try {
      return service.planSync(scope)
    } catch (error) {
      logUnexpected(error)
      return null
    }
  }

  // Scan failures are swallowed so they never hide the apply result
  // that triggered this refresh.
  async function refreshAfterApply(agentKind: ManagedHarnessKind, initialScopes: HarnessConfigScope[]): Promise<void> {
    const scannedAt = now()
    const seen = new Set<string>()
    const pending: HarnessConfigScope[] = [...initialScopes]
    while (pending.length > 0) {
      const next = pending.shift() as HarnessConfigScope
      if (next.agentKind !== agentKind) continue
      const key = harnessConfigScopeKey(next)
      if (seen.has(key)) continue
      seen.add(key)
      let resources: HarnessConfigFileRef[]
      try {
        resources = service.scan(next)
      } catch (error) {
        logUnexpected(error)
        continue
      }
      store.dispatch({
        type: 'harnessConfig/resourcesLoaded',
        payload: { scope: next, resources, scannedAt }
      })
      for (const ref of resources) {
        const discovered = [ref.canonicalResourceType, ...ref.aliasResourceTypes]
        for (const resourceType of discovered) {
          const discoveredScope = { agentKind, resourceType }
          if (!seen.has(harnessConfigScopeKey(discoveredScope))) pending.push(discoveredScope)
        }
      }
    }
  }

  function dispatchPostApplyComparison(scope: HarnessConfigScope, syncedAt: number | null): void {
    const comparison = tryCompareAfterApply(scope)
    if (comparison) store.dispatch({ type: 'harnessConfig/comparisonLoaded', payload: comparison })
    if (syncedAt !== null) {
      store.dispatch({ type: 'harnessConfig/syncApplied', payload: { scope, syncedAt } })
    }
  }

  async function handleScan(raw: unknown): Promise<HarnessConfigScanResult> {
    const { scope } = parseScopeOnlyRequest(raw)
    const resources = service.scan(scope)
    const scannedAt = now()
    store.dispatch({ type: 'harnessConfig/resourcesLoaded', payload: { scope, resources, scannedAt } })
    return { resources, scannedAt }
  }

  async function handleRead(raw: unknown): Promise<HarnessConfigReadFileResult> {
    const { scope, id } = parseScopeIdRequest(raw)
    const result = service.readFile(id)
    const belongsToScope =
      result.ref.agentKind === scope.agentKind &&
      (result.ref.resourceType === scope.resourceType ||
        result.ref.canonicalResourceType === scope.resourceType ||
        result.ref.aliasResourceTypes.includes(scope.resourceType))
    if (!belongsToScope) {
      throw new HarnessConfigError('unknown-resource', 'The requested harness resource is unknown')
    }
    return { ref: result.ref, content: result.content, hash: result.hash }
  }

  async function handleCompare(raw: unknown): Promise<HarnessConfigComparison> {
    const { scope } = parseScopeOnlyRequest(raw)
    const comparison = service.planSync(scope)
    store.dispatch({ type: 'harnessConfig/comparisonLoaded', payload: comparison })
    return comparison
  }

  async function handlePrepareCreate(raw: unknown): Promise<HarnessConfigMutationPlan> {
    const { scope, name, content } = parsePrepareCreateRequest(raw)
    const plan = service.prepareCreate(scope, name, content)
    bindPlan(plan.planId, {
      mutationChannel: CHANNEL.createFile,
      scopeKey: harnessConfigScopeKey(scope),
      refreshScopes: collectRefreshScopes(scope, [plan.resource])
    })
    return plan
  }

  async function handlePrepareUpdate(raw: unknown): Promise<HarnessConfigMutationPlan> {
    const { scope, id, content } = parsePrepareUpdateRequest(raw)
    const plan = service.prepareUpdate(scope, id, content)
    bindPlan(plan.planId, {
      mutationChannel: CHANNEL.updateFile,
      scopeKey: harnessConfigScopeKey(scope),
      refreshScopes: collectRefreshScopes(scope, [plan.resource])
    })
    return plan
  }

  async function handlePrepareDelete(raw: unknown): Promise<HarnessConfigMutationPlan> {
    const { scope, id } = parseScopeIdRequest(raw)
    const plan = service.prepareDelete(scope, id)
    bindPlan(plan.planId, {
      mutationChannel: CHANNEL.deleteFile,
      scopeKey: harnessConfigScopeKey(scope),
      refreshScopes: collectRefreshScopes(scope, [plan.resource])
    })
    return plan
  }

  async function handlePlanSyncToDisk(raw: unknown): Promise<HarnessConfigSyncPlan> {
    const { scope } = parseScopeOnlyRequest(raw)
    const plan = service.planSyncToDisk(scope)
    bindPlan(plan.planId, {
      mutationChannel: CHANNEL.syncToDisk,
      scopeKey: harnessConfigScopeKey(scope),
      refreshScopes: collectRefreshScopes(scope, syncPlanRefs(plan))
    })
    return plan
  }

  async function handlePlanAdoptFromDisk(raw: unknown): Promise<HarnessConfigSyncPlan> {
    const { scope, detach } = parseAdoptRequest(raw)
    const plan = detach ? service.planAdoptFromDisk(scope, { detach }) : service.planAdoptFromDisk(scope)
    bindPlan(plan.planId, {
      mutationChannel: CHANNEL.adoptFromDisk,
      scopeKey: harnessConfigScopeKey(scope),
      refreshScopes: collectRefreshScopes(scope, syncPlanRefs(plan))
    })
    return plan
  }

  async function handlePrepareCommandFromSkill(raw: unknown): Promise<HarnessConfigConversionResult> {
    const { scope, id } = parseScopeIdRequest(raw)
    return service.prepareCommandFromSkill(scope, id)
  }

  async function handlePrepareSkillFromCommand(raw: unknown): Promise<HarnessConfigConversionResult> {
    const { scope, id } = parseScopeIdRequest(raw)
    return service.prepareSkillFromCommand(scope, id)
  }

  // A matching-but-unconfirmed binding is invalidated so it cannot be
  // replayed later with `confirmed: true`.
  function makeApplyHandler(mutationChannel: MutationChannel): (raw: unknown) => Promise<HarnessConfigApplyResult> {
    return async (raw: unknown) => {
      const { scope, planId, confirmed } = parseMutationRequest(raw)
      const scopeKey = harnessConfigScopeKey(scope)
      const binding = bindings.get(planId)
      if (!binding || binding.mutationChannel !== mutationChannel || binding.scopeKey !== scopeKey) {
        throw new HarnessConfigError('unknown-plan', 'The plan is unavailable')
      }
      if (confirmed !== true) {
        bindings.delete(planId)
        throw new HarnessConfigError('unconfirmed-plan', 'The plan was not explicitly confirmed')
      }
      bindings.delete(planId)
      const { refreshScopes } = binding
      let result: HarnessConfigApplyResult
      try {
        result = await service.applyPlan({ scope, planId, confirmed: true })
      } catch (error) {
        await refreshAfterApply(scope.agentKind, refreshScopes)
        if (isDirectionalChannel(mutationChannel)) dispatchPostApplyComparison(scope, null)
        throw error
      }
      const syncedAt = now()
      await refreshAfterApply(scope.agentKind, refreshScopes)
      if (isDirectionalChannel(mutationChannel)) dispatchPostApplyComparison(scope, syncedAt)
      return result
    }
  }

  function requireTemplateSource(): HarnessTemplateSourceLike {
    if (!deps.templateSource) {
      throw new HarnessConfigError('unsupported-scope', 'The template source folder is unavailable')
    }
    return deps.templateSource
  }

  async function handleSaveTemplate(raw: unknown): Promise<HarnessTemplate> {
    const obj = requireObject(raw)
    assertExactKeys(obj, 'allowShadowing' in obj ? ['template', 'confirmed', 'allowShadowing'] : ['template', 'confirmed'])
    const draft = parseTemplateDraft(obj.template)
    requireConfirmed(obj.confirmed)
    const allowShadowing = 'allowShadowing' in obj ? parseBooleanFlag(obj.allowShadowing, 'allowShadowing') : false
    const templateSource = requireTemplateSource()
    // REQ-002: warn before a template hides stored entries at its paths.
    const shadows = service.templateShadows(draft)
    if (shadows.length > 0 && !allowShadowing) {
      const paths = shadows.map((entry) => `${entry.agentKind} ${entry.resourceType} ${entry.relativePath}`)
      throw new HarnessConfigError(
        'template-shadows',
        `This template replaces stored Tatsu config at ${paths.join(', ')}. Save again to confirm.`
      )
    }
    return templateSource.saveTemplate(draft)
  }

  async function handleDeleteTemplate(raw: unknown): Promise<{ deleted: true }> {
    const obj = requireObject(raw)
    assertExactKeys(obj, ['kind', 'name', 'confirmed'])
    const kind = parseTemplateKind(obj.kind)
    const name = parseNonEmptyString(obj.name, 'name')
    requireConfirmed(obj.confirmed)
    requireTemplateSource().deleteTemplate(kind, name)
    return { deleted: true }
  }

  async function handleSaveFragment(raw: unknown): Promise<HarnessFragment> {
    const obj = requireObject(raw)
    assertExactKeys(obj, ['name', 'content', 'confirmed'])
    const name = parseNonEmptyString(obj.name, 'name')
    const content = parseContentString(obj.content)
    requireConfirmed(obj.confirmed)
    return requireTemplateSource().saveFragment(name, content)
  }

  async function handleDeleteFragment(raw: unknown): Promise<{ deleted: true }> {
    const obj = requireObject(raw)
    assertExactKeys(obj, ['name', 'confirmed'])
    const name = parseNonEmptyString(obj.name, 'name')
    requireConfirmed(obj.confirmed)
    requireTemplateSource().deleteFragment(name)
    return { deleted: true }
  }

  async function handleResolveFragmentEdit(raw: unknown): Promise<HarnessConfigResolveFragmentEditResult> {
    const obj = requireObject(raw)
    assertExactKeys(obj, ['scope', 'id', 'fragment', 'resolution', 'confirmed'])
    const scope = parseManagedScope(obj.scope)
    const id = parseNonEmptyString(obj.id, 'id')
    const fragment = parseNonEmptyString(obj.fragment, 'fragment')
    const resolution = parseFragmentResolution(obj.resolution)
    requireConfirmed(obj.confirmed)
    const result = await service.resolveFragmentEdit(scope, id, fragment, resolution)
    dispatchPostApplyComparison(scope, null)
    return result
  }

  async function handleFragmentUsage(raw: unknown): Promise<HarnessFragmentUsageResult> {
    const obj = requireObject(raw)
    assertExactKeys(obj, ['name'])
    return { files: service.filesUsingFragment(parseNonEmptyString(obj.name, 'name')) }
  }

  function requireTemplateImport(): HarnessTemplateImportLike {
    if (!deps.templateImport) {
      throw new HarnessConfigError('unsupported-scope', 'Importing templates is unavailable')
    }
    return deps.templateImport
  }

  function planImport(folders: HarnessTemplateImportFolders, choices: HarnessTemplateImportChoices): TemplateImportPlan {
    const templateImport = requireTemplateImport()
    let listing: TemplateImportListing
    try {
      listing = templateImport.readListing(folders)
    } catch (error) {
      if (error instanceof TemplateImportReadError) throw new HarnessConfigError('read-failed', error.message)
      throw error
    }
    const existing = templateImport.existing()
    const scans = new Map<string, HarnessConfigFileRef[]>()
    return planTemplateImport(listing, choices, {
      existingTemplates: existing.templates,
      existingFragments: existing.fragments,
      existingErrors: existing.errors,
      templateShadows: (draft) =>
        service.templateShadows(draft).map((entry) => `${entry.agentKind} ${entry.resourceType} ${entry.relativePath}`),
      currentContent: (agentKind, resourceType, relativePath) => {
        const key = harnessConfigScopeKey({ agentKind, resourceType })
        try {
          let refs = scans.get(key)
          if (!refs) {
            refs = service.scan({ agentKind, resourceType })
            scans.set(key, refs)
          }
          const ref = refs.find((entry) => entry.existsOnDisk && entry.relativePath === relativePath)
          return ref ? service.readFile(ref.id).content : null
        } catch {
          return null
        }
      }
    })
  }

  async function handlePreviewImport(raw: unknown): Promise<HarnessTemplateImportPreview> {
    const obj = requireObject(raw)
    assertExactKeys(obj, ['folders', 'choices'])
    return planImport(parseImportFolders(obj.folders), parseImportChoices(obj.choices)).preview
  }

  // Re-reads the folders instead of trusting content from the client,
  // and refuses when anything changed since the confirmed preview.
  async function handleApplyImport(raw: unknown): Promise<HarnessTemplateImportApplyResult> {
    const obj = requireObject(raw)
    const keys = ['folders', 'choices', 'fingerprint', 'confirmed']
    assertExactKeys(obj, 'allowShadowing' in obj ? [...keys, 'allowShadowing'] : keys)
    const folders = parseImportFolders(obj.folders)
    const choices = parseImportChoices(obj.choices)
    const fingerprint = parseNonEmptyString(obj.fingerprint, 'fingerprint')
    requireConfirmed(obj.confirmed)
    const allowShadowing = 'allowShadowing' in obj ? parseBooleanFlag(obj.allowShadowing, 'allowShadowing') : false
    const templateSource = requireTemplateSource()

    const plan = planImport(folders, choices)
    if (plan.preview.fingerprint !== fingerprint) {
      throw new HarnessConfigError('stale-plan', 'The source folders changed since the preview. Preview again.')
    }
    if (plan.preview.blockingReasons.length > 0) {
      throw new HarnessConfigError('invalid-template', plan.preview.blockingReasons.join('. '))
    }
    if (plan.preview.shadows.length > 0 && !allowShadowing) {
      throw new HarnessConfigError(
        'template-shadows',
        `The import replaces stored Tatsu config at ${plan.preview.shadows.join(', ')}. Import again to confirm.`
      )
    }

    const written: string[] = []
    try {
      for (const fragment of plan.fragments) {
        templateSource.saveFragment(fragment.name, fragment.content)
        written.push(`fragment/${fragment.name}`)
      }
      for (const draft of plan.templates) {
        templateSource.saveTemplate(draft)
        written.push(`${draft.kind}/${draft.name}`)
      }
    } catch (error) {
      const done = written.length > 0 ? ` Imported before the failure: ${written.join(', ')}.` : ''
      if (error instanceof HarnessConfigError) {
        throw new HarnessConfigError(error.code, `${error.message}${done}`, { cause: error })
      }
      throw error
    }
    return { written, skipped: plan.skipped, scopes: service.scopesForTemplates(plan.templates) }
  }

  const register = (name: string, handler: (raw: unknown) => Promise<unknown>): void => {
    transport.onRequest(name, (_ctx, payload) => withLifecycle(() => handler(payload)))
  }

  register(CHANNEL.scan, handleScan)
  register(CHANNEL.readFile, handleRead)
  register(CHANNEL.compare, handleCompare)
  register(CHANNEL.prepareCreate, handlePrepareCreate)
  register(CHANNEL.prepareUpdate, handlePrepareUpdate)
  register(CHANNEL.prepareDelete, handlePrepareDelete)
  register(CHANNEL.planSyncToDisk, handlePlanSyncToDisk)
  register(CHANNEL.planAdoptFromDisk, handlePlanAdoptFromDisk)
  register(CHANNEL.createFile, makeApplyHandler(CHANNEL.createFile))
  register(CHANNEL.updateFile, makeApplyHandler(CHANNEL.updateFile))
  register(CHANNEL.deleteFile, makeApplyHandler(CHANNEL.deleteFile))
  register(CHANNEL.syncToDisk, makeApplyHandler(CHANNEL.syncToDisk))
  register(CHANNEL.adoptFromDisk, makeApplyHandler(CHANNEL.adoptFromDisk))
  register(CHANNEL.prepareCommandFromSkill, handlePrepareCommandFromSkill)
  register(CHANNEL.prepareSkillFromCommand, handlePrepareSkillFromCommand)
  register(CHANNEL.saveTemplate, handleSaveTemplate)
  register(CHANNEL.deleteTemplate, handleDeleteTemplate)
  register(CHANNEL.saveFragment, handleSaveFragment)
  register(CHANNEL.deleteFragment, handleDeleteFragment)
  register(CHANNEL.previewImport, handlePreviewImport)
  register(CHANNEL.applyImport, handleApplyImport)
  register(CHANNEL.resolveFragmentEdit, handleResolveFragmentEdit)
  register(CHANNEL.fragmentUsage, handleFragmentUsage)
}

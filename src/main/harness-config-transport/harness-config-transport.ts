// Transport adapter for the harness configuration feature (Step 6 of
// plans/skills-agents-command-center). Registers exactly fifteen
// request channels on the shared compound transport, translating
// untrusted renderer payloads into validated calls against the
// main-only `HarnessConfigService`, and mirroring successful disk
// inventory / comparison results into the shared store.
//
// Authority model (see implementation-details.md's operation matrix):
// read-only observation and non-mutating plan-generation channels never
// reach `service.applyPlan`. Every mutation channel requires a
// previously generated, still-current plan recorded in the private
// `bindings` map below, keyed by `planId` and carrying the one
// mutation channel and exact `${agentKind}:${resourceType}` scope it is
// allowed to apply through. A plan is consumed (deleted) the moment a
// matching, confirmed apply attempt is made, so it can never be
// replayed — success, failure, or partial failure all leave it gone.
//
// Dependencies are typed by the narrow methods this file actually
// calls (`HarnessConfigTransportLike`, `HarnessConfigStoreLike`) so
// `harness-config-transport.test.ts` can supply deterministic fakes
// without importing Electron or starting a server.

import { toAgentKind } from '../agent-kind'
import { HarnessConfigError, harnessConfigScopeKey, type HarnessConfigService } from '../harness-config'
import { formatErr as defaultFormatErr, log as defaultLog } from '../debug'
import type {
  HarnessConfigApplyResult,
  HarnessConfigComparison,
  HarnessConfigConversionRequest,
  HarnessConfigConversionResult,
  HarnessConfigEvent,
  HarnessConfigFileRef,
  HarnessConfigMutationPlan,
  HarnessConfigPrepareCreateRequest,
  HarnessConfigPrepareDeleteRequest,
  HarnessConfigPrepareUpdateRequest,
  HarnessConfigReadFileResult,
  HarnessConfigReadRequest,
  HarnessConfigRequestError,
  HarnessConfigRequestErrorCode,
  HarnessConfigRequestResult,
  HarnessConfigResourceType,
  HarnessConfigScanResult,
  HarnessConfigScope,
  HarnessConfigScopeRequest,
  HarnessConfigSyncPlan,
  ManagedHarnessKind
} from '../../shared/state/harness-config'

// --- Narrow adapter dependency contracts (TASK-004) ---

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

export interface RegisterHarnessConfigRequestHandlersDeps {
  transport: HarnessConfigTransportLike
  store: HarnessConfigStoreLike
  service: HarnessConfigService
  /** Deterministic clock for scan/sync timestamps; defaults to `Date.now`. */
  now?: () => number
  /** Test seam for SEC-003 logging; defaults to the shared debug logger. */
  log?: (category: string, message: string, data?: unknown) => void
  formatErr?: (error: unknown) => string
}

const MANAGED_AGENT_KINDS: readonly ManagedHarnessKind[] = ['claude', 'codex', 'opencode']
const RESOURCE_TYPES: readonly HarnessConfigResourceType[] = ['agents', 'skills', 'commands']

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
  prepareSkillFromCommand: 'harnessConfig:prepareSkillFromCommand'
} as const

type MutationChannel =
  | typeof CHANNEL.createFile
  | typeof CHANNEL.updateFile
  | typeof CHANNEL.deleteFile
  | typeof CHANNEL.syncToDisk
  | typeof CHANNEL.adoptFromDisk

// --- Boundary validation (TASK-005) ---

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

function parseReadRequest(raw: unknown): HarnessConfigReadRequest {
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

function parsePrepareDeleteRequest(raw: unknown): HarnessConfigPrepareDeleteRequest {
  const obj = requireObject(raw)
  assertExactKeys(obj, ['scope', 'id'])
  return { scope: parseManagedScope(obj.scope), id: parseNonEmptyString(obj.id, 'id') }
}

function parseMutationRequest(raw: unknown): { scope: HarnessConfigScope; planId: string; confirmed: boolean } {
  const obj = requireObject(raw)
  assertExactKeys(obj, ['scope', 'planId', 'confirmed'])
  return {
    scope: parseManagedScope(obj.scope),
    planId: parseNonEmptyString(obj.planId, 'planId'),
    confirmed: parseConfirmedFlag(obj.confirmed)
  }
}

function parseConversionRequest(raw: unknown): HarnessConfigConversionRequest {
  const obj = requireObject(raw)
  assertExactKeys(obj, ['scope', 'id'])
  return { scope: parseManagedScope(obj.scope), id: parseNonEmptyString(obj.id, 'id') }
}

function toRequestError(error: unknown): HarnessConfigRequestError {
  if (error instanceof HarnessConfigValidationError) {
    return { code: 'invalid-request', message: error.message }
  }
  if (error instanceof HarnessConfigError) {
    return { code: error.code as HarnessConfigRequestErrorCode, message: error.message }
  }
  return { code: 'internal-error', message: 'The harness configuration request failed unexpectedly' }
}

// --- Plan bindings (REQ-009/REQ-010) ---

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

  function logUnexpected(error: unknown): void {
    log('harness-config', 'transport request failed unexpectedly', formatErr(error))
  }

  // One lifecycle wrapper for all fifteen handlers (TASK-006): clears
  // the slice error at request start, tracks the in-flight counter so
  // overlapping requests can't clear loading early (REQ-019), and maps
  // every thrown error to the structured response envelope.
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

  // REQ-015/TASK-012: rescan every logical scope the binding captured
  // (selected + canonical + alias), following any further aliases the
  // rescan itself turns up, each scope at most once, never crossing
  // `agentKind`, and never letting a scan failure throw (it must not
  // hide the apply result that triggered this refresh).
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

  function dispatchPostApplyComparison(scope: HarnessConfigScope, succeeded: boolean): void {
    const comparison = tryCompareAfterApply(scope)
    if (!comparison) return
    store.dispatch({ type: 'harnessConfig/comparisonLoaded', payload: comparison })
    if (succeeded) {
      store.dispatch({ type: 'harnessConfig/syncApplied', payload: { scope, syncedAt: now() } })
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
    const { scope, id } = parseReadRequest(raw)
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
    bindings.set(plan.planId, {
      mutationChannel: CHANNEL.createFile,
      scopeKey: harnessConfigScopeKey(scope),
      refreshScopes: collectRefreshScopes(scope, [plan.resource])
    })
    return plan
  }

  async function handlePrepareUpdate(raw: unknown): Promise<HarnessConfigMutationPlan> {
    const { scope, id, content } = parsePrepareUpdateRequest(raw)
    const plan = service.prepareUpdate(scope, id, content)
    bindings.set(plan.planId, {
      mutationChannel: CHANNEL.updateFile,
      scopeKey: harnessConfigScopeKey(scope),
      refreshScopes: collectRefreshScopes(scope, [plan.resource])
    })
    return plan
  }

  async function handlePrepareDelete(raw: unknown): Promise<HarnessConfigMutationPlan> {
    const { scope, id } = parsePrepareDeleteRequest(raw)
    const plan = service.prepareDelete(scope, id)
    bindings.set(plan.planId, {
      mutationChannel: CHANNEL.deleteFile,
      scopeKey: harnessConfigScopeKey(scope),
      refreshScopes: collectRefreshScopes(scope, [plan.resource])
    })
    return plan
  }

  async function handlePlanSyncToDisk(raw: unknown): Promise<HarnessConfigSyncPlan> {
    const { scope } = parseScopeOnlyRequest(raw)
    const plan = service.planSyncToDisk(scope)
    bindings.set(plan.planId, {
      mutationChannel: CHANNEL.syncToDisk,
      scopeKey: harnessConfigScopeKey(scope),
      refreshScopes: collectRefreshScopes(scope, syncPlanRefs(plan))
    })
    return plan
  }

  async function handlePlanAdoptFromDisk(raw: unknown): Promise<HarnessConfigSyncPlan> {
    const { scope } = parseScopeOnlyRequest(raw)
    const plan = service.planAdoptFromDisk(scope)
    bindings.set(plan.planId, {
      mutationChannel: CHANNEL.adoptFromDisk,
      scopeKey: harnessConfigScopeKey(scope),
      refreshScopes: collectRefreshScopes(scope, syncPlanRefs(plan))
    })
    return plan
  }

  async function handlePrepareCommandFromSkill(raw: unknown): Promise<HarnessConfigConversionResult> {
    const { scope, id } = parseConversionRequest(raw)
    return service.prepareCommandFromSkill(scope, id)
  }

  async function handlePrepareSkillFromCommand(raw: unknown): Promise<HarnessConfigConversionResult> {
    const { scope, id } = parseConversionRequest(raw)
    return service.prepareSkillFromCommand(scope, id)
  }

  // Shared bound-plan apply path for all five mutation channels
  // (TASK-010/TASK-011). A plan is usable only through the exact
  // channel and scope it was bound to; any mismatch — or a bare
  // `confirmed: false` — is rejected before `applyPlan` is ever
  // reached, and a matching-but-unconfirmed binding is invalidated so
  // it cannot be replayed with `confirmed: true` later.
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
        if (isDirectionalChannel(mutationChannel)) dispatchPostApplyComparison(scope, false)
        throw error
      }
      await refreshAfterApply(scope.agentKind, refreshScopes)
      if (isDirectionalChannel(mutationChannel)) dispatchPostApplyComparison(scope, true)
      return result
    }
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
}

import { createHash } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'fs'
import { join } from 'path'
import { userDataDir } from '../paths'
import {
  runMigrations,
  SCHEMA_VERSION,
  type AnyConfig
} from '../persistence-migrations'
import type { HarnessConfigResourceType } from '../../shared/agent-registry'
import type { HarnessConfigScope, ManagedHarnessKind } from '../../shared/state/harness-config'
import type { Config, PersistedHarnessConfig, PersistedHarnessConfigResource } from './types'
import {
  LOCAL_BACKEND_ID,
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_SIZE
} from './constants'

export type {
  Config,
  QuestStep,
  BackendConnection,
  PersistedPane,
  PersistedPaneNode,
  PersistedTab,
  PersistedHarnessConfig,
  PersistedHarnessConfigResource
} from './types'
export {
  LOCAL_BACKEND_ID,
  DEFAULT_WORKTREE_BASE,
  DEFAULT_MERGE_STRATEGY,
  DEFAULT_WORKTREE_DETAIL,
  AVAILABLE_THEMES,
  THEME_APP_BG,
  DEFAULT_CLAUDE_COMMAND,
  DEFAULT_HARNESS_SYSTEM_PROMPT,
  DEFAULT_HARNESS_SYSTEM_PROMPT_MAIN,
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_SIZE
} from './constants'

const DEFAULT_CONFIG: Config = {
  schemaVersion: 0,
  windowBounds: null,
  repoRoots: []
}

function getConfigPath(): string {
  return join(userDataDir(), 'config.json')
}

export function loadConfig(): Config {
  let config: Config
  try {
    const data = readFileSync(getConfigPath(), 'utf-8')
    const parsed = JSON.parse(data) as AnyConfig
    runMigrations(parsed)
    config = { ...DEFAULT_CONFIG, ...(parsed as Partial<Config>), schemaVersion: SCHEMA_VERSION }
  } catch {
    config = { ...DEFAULT_CONFIG, schemaVersion: SCHEMA_VERSION }
  }
  if (config.harnessConfig === undefined) {
    config = { ...config, harnessConfig: emptyPersistedHarnessConfig() }
  }
  return applyConnectionDefaults(config)
}

// ---------------------------------------------------------------------------
// Tatsu config (harness-managed agents/skills/commands) persistence.
//
// `getPersistedHarnessConfigResources` / `replacePersistedHarnessConfigScope`
// are the read/write seam the harness-config service (src/main/harness-config)
// is dependency-injected with as `loadDesiredResources` / `replaceDesiredScope`.
// They operate only on Tatsu config — never disk inventory or a live re-scan.
// See plans/skills-agents-command-center/step-05-persist-tatsu-managed-config.md.
// ---------------------------------------------------------------------------

const MANAGED_HARNESS_ORDER: readonly ManagedHarnessKind[] = ['claude', 'codex', 'opencode']
const RESOURCE_TYPE_ORDER: readonly HarnessConfigResourceType[] = ['agents', 'skills', 'commands']
const MANAGED_HARNESS_SET: ReadonlySet<string> = new Set(MANAGED_HARNESS_ORDER)
const RESOURCE_TYPE_SET: ReadonlySet<string> = new Set(RESOURCE_TYPE_ORDER)
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/

function emptyPersistedHarnessConfig(): PersistedHarnessConfig {
  return { version: 1, resources: [] }
}

function harnessConfigResourceHash(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')
}

/** Throws a content-free, deterministic validation error. `resource` is only
 *  used to attach identifying (never content) fields for diagnosis. */
function invalidHarnessConfig(
  reason: string,
  resource?: { id?: unknown; agentKind?: unknown; resourceType?: unknown; relativePath?: unknown }
): never {
  const detail = resource
    ? ` (id=${String(resource.id)} agentKind=${String(resource.agentKind)} resourceType=${String(resource.resourceType)} relativePath=${String(resource.relativePath)})`
    : ''
  throw new Error(`Invalid Tatsu config: ${reason}${detail}`)
}

function isValidRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/')) return false
  const segments = value.split('/')
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function isValidAliasResourceTypes(
  resourceType: HarnessConfigResourceType,
  value: unknown
): value is HarnessConfigResourceType[] | undefined {
  // `aliasResourceTypes` is optional on the canonical HarnessConfigDesiredResource
  // contract this type reuses verbatim — absent means "no aliases", not malformed.
  if (value === undefined) return true
  if (!Array.isArray(value)) return false
  if (!value.every((type) => typeof type === 'string' && RESOURCE_TYPE_SET.has(type))) return false
  if (value.includes(resourceType)) return false
  return new Set(value).size === value.length
}

function validatePersistedHarnessConfigResource(raw: unknown): PersistedHarnessConfigResource {
  if (!raw || typeof raw !== 'object') invalidHarnessConfig('resource is not an object')
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id.length === 0) invalidHarnessConfig('invalid id', r)
  if (typeof r.agentKind !== 'string' || !MANAGED_HARNESS_SET.has(r.agentKind)) invalidHarnessConfig('invalid agentKind', r)
  if (typeof r.resourceType !== 'string' || !RESOURCE_TYPE_SET.has(r.resourceType)) invalidHarnessConfig('invalid resourceType', r)
  const resourceType = r.resourceType as HarnessConfigResourceType
  if (!isValidAliasResourceTypes(resourceType, r.aliasResourceTypes)) invalidHarnessConfig('invalid aliasResourceTypes', r)
  // `canonicalResourceType` is optional on the reused contract too. `resourceType`
  // is already required to be canonical (REQ-002), so when present it must agree —
  // preserved through the round trip rather than silently dropped.
  if (r.canonicalResourceType !== undefined) {
    if (typeof r.canonicalResourceType !== 'string' || !RESOURCE_TYPE_SET.has(r.canonicalResourceType)) {
      invalidHarnessConfig('invalid canonicalResourceType', r)
    }
    if (r.canonicalResourceType !== resourceType) {
      invalidHarnessConfig('canonicalResourceType does not match the canonical resourceType', r)
    }
  }
  if (!isValidRelativePath(r.relativePath)) invalidHarnessConfig('invalid relativePath', r)
  if (typeof r.label !== 'string') invalidHarnessConfig('invalid label', r)
  if (typeof r.content !== 'string') invalidHarnessConfig('invalid content', r)
  if (typeof r.hash !== 'string' || !CONTENT_HASH_PATTERN.test(r.hash)) invalidHarnessConfig('invalid hash', r)
  if (r.hash !== harnessConfigResourceHash(r.content)) invalidHarnessConfig('content does not match hash', r)
  if (typeof r.updatedAt !== 'number' || !Number.isFinite(r.updatedAt) || r.updatedAt < 0) {
    invalidHarnessConfig('invalid updatedAt', r)
  }
  return {
    id: r.id,
    agentKind: r.agentKind as ManagedHarnessKind,
    resourceType,
    ...(r.canonicalResourceType !== undefined ? { canonicalResourceType: resourceType } : {}),
    aliasResourceTypes: [...((r.aliasResourceTypes as HarnessConfigResourceType[] | undefined) ?? [])],
    relativePath: r.relativePath as string,
    label: r.label as string,
    content: r.content as string,
    hash: r.hash,
    updatedAt: r.updatedAt as number
  }
}

function compareHarnessConfigResources(a: PersistedHarnessConfigResource, b: PersistedHarnessConfigResource): number {
  const harnessDelta = MANAGED_HARNESS_ORDER.indexOf(a.agentKind) - MANAGED_HARNESS_ORDER.indexOf(b.agentKind)
  if (harnessDelta !== 0) return harnessDelta
  const typeDelta = RESOURCE_TYPE_ORDER.indexOf(a.resourceType) - RESOURCE_TYPE_ORDER.indexOf(b.resourceType)
  if (typeDelta !== 0) return typeDelta
  if (a.relativePath !== b.relativePath) return a.relativePath < b.relativePath ? -1 : 1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}

/** Validates a persisted Tatsu config container and returns a fresh,
 *  deterministically-ordered copy. Throws on malformed data or an
 *  unsupported nested version rather than silently discarding it. */
function validatePersistedHarnessConfigContainer(raw: unknown): PersistedHarnessConfig {
  if (!raw || typeof raw !== 'object') invalidHarnessConfig('harnessConfig is not an object')
  const container = raw as Record<string, unknown>
  if (container.version !== 1) invalidHarnessConfig('unsupported harnessConfig.version')
  if (!Array.isArray(container.resources)) invalidHarnessConfig('harnessConfig.resources is not an array')
  const seenIds = new Set<string>()
  const resources = container.resources.map((item) => {
    const resource = validatePersistedHarnessConfigResource(item)
    if (seenIds.has(resource.id)) invalidHarnessConfig('duplicate resource id', resource)
    seenIds.add(resource.id)
    return resource
  })
  resources.sort(compareHarnessConfigResources)
  return { version: 1, resources }
}

/** Synchronous, throwing config write used only by Tatsu config scope
 *  replacement — distinct from the best-effort `saveConfig`/`saveConfigSync`
 *  so a persistence failure can propagate to the caller for rollback. */
function writeHarnessConfigOrThrow(nextConfig: Config): void {
  let serialized: string
  try {
    serialized = JSON.stringify(nextConfig, null, 2)
  } catch (e) {
    console.error('Failed to persist Tatsu config: serialization failed')
    throw e
  }
  try {
    writeFileSync(getConfigPath(), serialized)
  } catch (e) {
    console.error('Failed to persist Tatsu config: write failed')
    throw e
  }
}

/** Read side of sync to disk / compare: returns the persisted Tatsu config
 *  snapshot, never disk inventory and never a live disk re-scan. Missing
 *  config reads as an empty version-1 resource set. */
export function getPersistedHarnessConfigResources(config: Config): PersistedHarnessConfigResource[] {
  return validatePersistedHarnessConfigContainer(config.harnessConfig ?? emptyPersistedHarnessConfig()).resources
}

/** Persistence side of adopt from disk: replaces exactly one
 *  `${agentKind}:${resourceType}` logical view with the caller-supplied
 *  canonical resources, preserving every record outside that view. The
 *  caller (harness-config service, via Step 2/6) is solely responsible for
 *  confirming the plan is current before invoking this. Persists
 *  synchronously and throws on failure, leaving `config.harnessConfig`
 *  unchanged until the write succeeds. */
export function replacePersistedHarnessConfigScope(
  config: Config,
  scope: HarnessConfigScope,
  resources: PersistedHarnessConfigResource[]
): void {
  if (!scope || !MANAGED_HARNESS_SET.has(scope.agentKind) || !RESOURCE_TYPE_SET.has(scope.resourceType)) {
    invalidHarnessConfig('invalid scope')
  }
  if (!Array.isArray(resources)) invalidHarnessConfig('resources is not an array')

  const current = validatePersistedHarnessConfigContainer(config.harnessConfig ?? emptyPersistedHarnessConfig())

  const belongsToScope = (resource: PersistedHarnessConfigResource): boolean =>
    resource.agentKind === scope.agentKind &&
    (resource.resourceType === scope.resourceType || (resource.aliasResourceTypes ?? []).includes(scope.resourceType))

  const retained = current.resources.filter((resource) => !belongsToScope(resource))

  const seenIncomingIds = new Set<string>()
  const incoming = resources.map((raw) => {
    const resource = validatePersistedHarnessConfigResource(raw)
    if (resource.agentKind !== scope.agentKind) {
      invalidHarnessConfig('incoming resource does not match the replacement scope agentKind', resource)
    }
    if (!belongsToScope(resource)) {
      invalidHarnessConfig('incoming resource is outside the requested logical view', resource)
    }
    if (seenIncomingIds.has(resource.id)) {
      invalidHarnessConfig('duplicate resource id in replacement', resource)
    }
    seenIncomingIds.add(resource.id)
    return resource
  })

  const nextResources = [...retained, ...incoming].sort(compareHarnessConfigResources)
  const nextHarnessConfig: PersistedHarnessConfig = { version: 1, resources: nextResources }
  const nextConfig: Config = { ...config, harnessConfig: nextHarnessConfig }

  writeHarnessConfigOrThrow(nextConfig)

  config.harnessConfig = nextHarnessConfig
}

export function applyConnectionDefaults(config: Config, now: number = Date.now()): Config {
  const next: Config = { ...config }
  if (!next.connections || next.connections.length === 0) {
    next.connections = [
      {
        id: LOCAL_BACKEND_ID,
        label: 'Local',
        url: '',
        kind: 'local',
        addedAt: now
      }
    ]
  }
  if (!next.activeBackendId) {
    next.activeBackendId = LOCAL_BACKEND_ID
  }
  return next
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null

export function saveConfig(config: Config): void {
  if (saveTimeout) clearTimeout(saveTimeout)
  saveTimeout = setTimeout(() => {
    try {
      writeFileSync(getConfigPath(), JSON.stringify(config, null, 2))
    } catch (e) {
      console.error('Failed to save config:', e)
    }
  }, 500)
}

export function saveConfigSync(config: Config): void {
  try {
    writeFileSync(getConfigPath(), JSON.stringify(config, null, 2))
  } catch (e) {
    console.error('Failed to save config:', e)
  }
}

function getHistoryDir(): string {
  const dir = join(userDataDir(), 'terminal-history')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function historyPath(id: string): string {
  return join(getHistoryDir(), `${sanitizeId(id)}.txt`)
}

export function saveTerminalHistory(id: string, content: string): void {
  try {
    writeFileSync(historyPath(id), content)
  } catch (e) {
    console.error('Failed to save terminal history:', e)
  }
}

export function loadTerminalHistory(id: string): string | null {
  try {
    return readFileSync(historyPath(id), 'utf-8')
  } catch {
    return null
  }
}

export function clearTerminalHistory(id: string): void {
  try {
    unlinkSync(historyPath(id))
  } catch {
    // ignore missing file
  }
}

export function pruneTerminalHistory(keepIds: Set<string>): void {
  try {
    const dir = getHistoryDir()
    const keep = new Set(Array.from(keepIds).map((id) => `${sanitizeId(id)}.txt`))
    for (const file of readdirSync(dir)) {
      if (!keep.has(file)) {
        try { unlinkSync(join(dir, file)) } catch { /* ignore */ }
      }
    }
  } catch {
    // ignore
  }
}

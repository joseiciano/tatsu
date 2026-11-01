import { HarnessConfigError, normalizeConfigFolder, type HarnessConfigService } from '../harness-config'
import { formatErr as defaultFormatErr, log as defaultLog } from '../debug'
import {
  HARNESS_CONFIG_ROOT_KEYS,
  isHarnessConfigRootKey,
  type HarnessConfigEvent,
  type HarnessConfigFileRef,
  type HarnessConfigFolderDefaults,
  type HarnessConfigFolderSettingResult,
  type HarnessConfigRootKey,
  type HarnessConfigRoots,
  type HarnessConfigScope,
  type ManagedHarnessKind
} from '../../shared/state/harness-config'
import type { SettingsEvent } from '../../shared/state/settings'

export const HARNESS_CONFIG_SETTINGS_CHANNEL = {
  setRoot: 'settings:setHarnessConfigRoot',
  setSourceDir: 'settings:setHarnessConfigSourceDir',
  getDefaults: 'settings:getHarnessConfigFolderDefaults'
} as const

export interface HarnessConfigSettingsTransportLike {
  onRequest(name: string, handler: (ctx: unknown, payload: unknown) => unknown | Promise<unknown>): void
}

export interface HarnessConfigSettingsStoreLike {
  dispatch(event: SettingsEvent | HarnessConfigEvent): void
}

export interface HarnessConfigSettingsConfigLike {
  harnessConfigRoots?: HarnessConfigRoots
  harnessConfigSourceDir?: string
}

export interface RegisterHarnessConfigSettingsHandlersDeps<C extends HarnessConfigSettingsConfigLike> {
  transport: HarnessConfigSettingsTransportLike
  store: HarnessConfigSettingsStoreLike
  config: C
  saveConfig: (config: C) => void
  service: Pick<HarnessConfigService, 'scan' | 'planSync' | 'scopesForRootKeys' | 'defaultRoots'>
  defaultSourceDir: () => string
  now?: () => number
  log?: (category: string, message: string, data?: unknown) => void
  formatErr?: (error: unknown) => string
}

const NOT_ABSOLUTE = 'Choose an absolute folder path'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isClearValue(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
}

export function registerHarnessConfigSettingsHandlers<C extends HarnessConfigSettingsConfigLike>(
  deps: RegisterHarnessConfigSettingsHandlersDeps<C>
): void {
  const { transport, store, config, saveConfig, service } = deps
  const now = deps.now ?? Date.now
  const log = deps.log ?? defaultLog
  const formatErr = deps.formatErr ?? defaultFormatErr

  function scopesForAgentKinds(kinds: ReadonlySet<ManagedHarnessKind>): HarnessConfigScope[] {
    return service.scopesForRootKeys(HARNESS_CONFIG_ROOT_KEYS).filter((scope) => kinds.has(scope.agentKind))
  }

  // Alias views (skills <-> commands) surface refs from a sibling root, so
  // every scope of an affected harness is rescanned, not just the one whose
  // root key changed.
  function rescanAfterRootChange(key: HarnessConfigRootKey): void {
    const kinds = new Set(service.scopesForRootKeys([key]).map((scope) => scope.agentKind))
    if (kinds.size === 0) return
    const scannedAt = now()
    for (const scope of scopesForAgentKinds(kinds)) {
      let resources: HarnessConfigFileRef[] = []
      let scanned = false
      try {
        resources = service.scan(scope)
        scanned = true
      } catch (error) {
        if (!(error instanceof HarnessConfigError)) {
          log('harness-config', 'rescan after root change failed', formatErr(error))
        }
      }
      store.dispatch({ type: 'harnessConfig/resourcesLoaded', payload: { scope, resources, scannedAt } })
      if (!scanned) continue
      try {
        store.dispatch({ type: 'harnessConfig/comparisonLoaded', payload: service.planSync(scope) })
      } catch (error) {
        if (!(error instanceof HarnessConfigError)) {
          log('harness-config', 'compare after root change failed', formatErr(error))
        }
      }
    }
  }

  function setRoot(raw: unknown): HarnessConfigFolderSettingResult {
    if (!isPlainObject(raw) || !isHarnessConfigRootKey(raw.key)) {
      return { ok: false, message: 'Unknown configuration folder' }
    }
    const key = raw.key
    let path: string | null = null
    if (!isClearValue(raw.path)) {
      path = normalizeConfigFolder(raw.path)
      if (path === null) return { ok: false, message: NOT_ABSOLUTE }
    }
    const current = config.harnessConfigRoots?.[key]
    if ((current ?? null) === path) return { ok: true }
    const nextRoots: HarnessConfigRoots = { ...config.harnessConfigRoots }
    if (path === null) delete nextRoots[key]
    else nextRoots[key] = path
    if (Object.keys(nextRoots).length === 0) delete config.harnessConfigRoots
    else config.harnessConfigRoots = nextRoots
    saveConfig(config)
    store.dispatch({ type: 'settings/harnessConfigRootsChanged', payload: { key, path } })
    rescanAfterRootChange(key)
    return { ok: true }
  }

  function setSourceDir(raw: unknown): HarnessConfigFolderSettingResult {
    let path: string | null = null
    if (!isClearValue(raw)) {
      path = normalizeConfigFolder(raw)
      if (path === null) return { ok: false, message: NOT_ABSOLUTE }
    }
    if ((config.harnessConfigSourceDir ?? null) === path) return { ok: true }
    if (path === null) delete config.harnessConfigSourceDir
    else config.harnessConfigSourceDir = path
    saveConfig(config)
    store.dispatch({ type: 'settings/harnessConfigSourceDirChanged', payload: path })
    return { ok: true }
  }

  function getDefaults(): HarnessConfigFolderDefaults {
    return { roots: service.defaultRoots(), sourceDir: deps.defaultSourceDir() }
  }

  transport.onRequest(HARNESS_CONFIG_SETTINGS_CHANNEL.setRoot, (_ctx, payload) => setRoot(payload))
  transport.onRequest(HARNESS_CONFIG_SETTINGS_CHANNEL.setSourceDir, (_ctx, payload) => setSourceDir(payload))
  transport.onRequest(HARNESS_CONFIG_SETTINGS_CHANNEL.getDefaults, () => getDefaults())
}

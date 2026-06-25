import { existsSync, readFileSync, writeFileSync, unlinkSync, realpathSync } from 'fs'
import { join, resolve, sep } from 'path'
import { log } from '../debug'
import { DEFAULT_HIDDEN_RIGHT_PANELS, type RepoConfig } from '../../shared/state/repo-configs'

export type { RepoConfig }

const REPO_CONFIG_FILENAME = '.harness.json'
const cache = new Map<string, RepoConfig>()

function configPath(repoRoot: string): string {
  return join(repoRoot, REPO_CONFIG_FILENAME)
}

const UNSAFE_VOLUME_TARGETS = new Set(['/', '/workspace', '/proc', '/sys', '/dev', '/etc'])

const UNSAFE_VOLUME_SOURCES = new Set([
  '/', '/proc', '/sys', '/dev', '/etc', '/boot', '/var/run/docker.sock', '/run/docker.sock'
])

function hasUnsafePathPrefix(resolved: string): boolean {
  if (resolved.startsWith('/proc/') || resolved === '/proc') return true
  if (resolved.startsWith('/sys/') || resolved === '/sys') return true
  if (resolved.startsWith('/dev/') || resolved === '/dev') return true
  if (resolved.endsWith('/docker.sock') || resolved === '/docker.sock') return true
  return false
}

function isUnsafeVolumeTarget(target: string): boolean {
  const resolved = resolve(target)
  if (UNSAFE_VOLUME_TARGETS.has(resolved)) return true
  if (hasUnsafePathPrefix(resolved)) return true
  if (resolved.startsWith('/etc/') || resolved === '/etc') return true
  return false
}

function isUnsafeVolumeSource(source: string): boolean {
  const resolved = resolve(source)
  if (UNSAFE_VOLUME_SOURCES.has(resolved)) return true
  if (hasUnsafePathPrefix(resolved)) return true
  if (resolved.startsWith('/etc/') || resolved === '/etc') return true
  return false
}

function validateContainerConfig(container: unknown, repoRoot?: string): { valid: true; config: NonNullable<RepoConfig['container']> } | { valid: false; error: string } {
  if (!container || typeof container !== 'object') return { valid: false, error: 'Container config must be an object' }
  const c = container as Record<string, unknown>

  const disabled = c.disabled === true
  const hasImage = typeof c.image === 'string' && c.image.trim().length > 0
  const hasDockerfile = typeof c.dockerfile === 'string' && c.dockerfile.trim().length > 0

  if (disabled) {
    const result: NonNullable<RepoConfig['container']> = { disabled: true }
    if (hasImage) result.image = c.image as string
    if (hasDockerfile) result.dockerfile = c.dockerfile as string
    return { valid: true, config: result }
  }

  if (hasImage && hasDockerfile) {
    return { valid: false, error: 'Cannot specify both image and dockerfile' }
  }
  if (!hasImage && !hasDockerfile) {
    return { valid: false, error: 'Must specify either image or dockerfile' }
  }

  if (c.workdir !== undefined) {
    if (typeof c.workdir !== 'string' || !c.workdir.startsWith('/')) {
      return { valid: false, error: 'workdir must be an absolute path' }
    }
  }

  if (c.env !== undefined) {
    if (!c.env || typeof c.env !== 'object' || Array.isArray(c.env)) {
      return { valid: false, error: 'env must be an object' }
    }
    const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/
    for (const key of Object.keys(c.env)) {
      if (!envKeyPattern.test(key)) {
        return { valid: false, error: `Invalid env key: ${key}` }
      }
      if (typeof (c.env as Record<string, unknown>)[key] !== 'string') {
        return { valid: false, error: `Env value for ${key} must be a string` }
      }
    }
  }

  if (c.volumes !== undefined) {
    if (!Array.isArray(c.volumes)) {
      return { valid: false, error: 'volumes must be an array' }
    }
    for (const vol of c.volumes) {
      if (!vol || typeof vol !== 'object' || Array.isArray(vol)) {
        return { valid: false, error: 'Each volume must be an object' }
      }
      const v = vol as Record<string, unknown>
      if (typeof v.source !== 'string' || typeof v.target !== 'string') {
        return { valid: false, error: 'Volume source and target must be strings' }
      }
      if (v.source.includes(':')) {
        return { valid: false, error: `Volume source must not contain colons (Docker options not allowed): ${v.source}` }
      }
      if (!v.target.startsWith('/')) {
        return { valid: false, error: `Volume target must be absolute: ${v.target}` }
      }
      if (v.target.includes(':')) {
        return { valid: false, error: `Volume target must not contain colons (Docker options not allowed): ${v.target}` }
      }
      if (isUnsafeVolumeTarget(v.target as string)) {
        return { valid: false, error: `Unsafe volume target: ${v.target}` }
      }
    }
  }

  if (c.ports !== undefined) {
    if (!Array.isArray(c.ports) || !c.ports.every((p) => typeof p === 'number' && Number.isInteger(p) && p > 0)) {
      return { valid: false, error: 'ports must be an array of positive integers' }
    }
  }

  if (c.shell !== undefined && typeof c.shell !== 'string') {
    return { valid: false, error: 'shell must be a string' }
  }

  const result: NonNullable<RepoConfig['container']> = {}
  if (hasImage) result.image = c.image as string
  if (hasDockerfile) {
    let dockerfile = (c.dockerfile as string).trim()
    if (repoRoot && !dockerfile.startsWith('/')) {
      dockerfile = join(repoRoot, dockerfile)
      if (!dockerfile.startsWith(repoRoot + sep) && dockerfile !== repoRoot) {
        return { valid: false, error: `Dockerfile path escapes repo root: ${dockerfile}` }
      }
    }
    result.dockerfile = dockerfile
  }
  if (c.workdir) result.workdir = c.workdir as string
  if (c.shell) result.shell = c.shell as string
  if (c.env) result.env = c.env as Record<string, string>
  if (c.ports) result.ports = c.ports as number[]
  if (c.volumes) {
    const normalizedVolumes: Array<{ source: string; target: string }> = []
    for (const v of c.volumes as Array<{ source: string; target: string }>) {
      let source = v.source
      if (repoRoot && !source.startsWith('/')) {
        source = join(repoRoot, source)
        try {
          source = realpathSync(source)
        } catch (err) {
          const e = err as NodeJS.ErrnoException
          if (e.code !== 'ENOENT') throw err
        }
        if (!source.startsWith(repoRoot + sep) && source !== repoRoot) {
          return { valid: false, error: `Volume source escapes repo root: ${source}` }
        }
      } else if (source.startsWith('/')) {
        if (isUnsafeVolumeSource(source)) {
          return { valid: false, error: `Unsafe volume source path: ${source}` }
        }
      }
      normalizedVolumes.push({ source, target: v.target })
    }
    result.volumes = normalizedVolumes
  }

  return { valid: true, config: result }
}

export function loadRepoConfig(repoRoot: string): RepoConfig {
  if (!repoRoot) return {}
  const cached = cache.get(repoRoot)
  if (cached) return cached
  const path = configPath(repoRoot)
  if (!existsSync(path)) {
    cache.set(repoRoot, {})
    return {}
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as RepoConfig
    const clean = parsed && typeof parsed === 'object' ? parsed : {}
    if (clean.container) {
      const validation = validateContainerConfig(clean.container, repoRoot)
      if (validation.valid) {
        clean.container = validation.config
      } else {
        log('repo-config', `Invalid container config in ${path}: ${validation.error}`)
        delete clean.container
      }
    }
    cache.set(repoRoot, clean)
    return clean
  } catch (err) {
    log('repo-config', `failed to load ${path}: ${(err as Error).message}`)
    cache.set(repoRoot, {})
    return {}
  }
}

export function saveRepoConfig(repoRoot: string, next: RepoConfig): RepoConfig {
  const cleaned: RepoConfig = { version: 1 }
  const setup = next.setupCommand?.trim()
  const teardown = next.teardownCommand?.trim()
  if (setup) cleaned.setupCommand = setup
  if (teardown) cleaned.teardownCommand = teardown
  if (next.mergeStrategy) cleaned.mergeStrategy = next.mergeStrategy
  // Migrate legacy hideMergePanel / hidePrPanel into hiddenRightPanels
  // on write. Only the new field is persisted going forward.
  const hidden: Record<string, boolean> = { ...(next.hiddenRightPanels || {}) }
  if (next.hideMergePanel && hidden.merge === undefined) hidden.merge = true
  if (next.hidePrPanel && hidden.pr === undefined) hidden.pr = true
  // Compact: drop `false` entries that match the default visibility
  // (i.e. NOT in DEFAULT_HIDDEN_RIGHT_PANELS). For keys that default to
  // hidden, `false` is a meaningful opt-in signal — keep it.
  for (const k of Object.keys(hidden)) {
    if (hidden[k] === false && !DEFAULT_HIDDEN_RIGHT_PANELS[k as keyof typeof DEFAULT_HIDDEN_RIGHT_PANELS]) {
      delete hidden[k]
    }
  }
  if (Object.keys(hidden).length > 0) cleaned.hiddenRightPanels = hidden
  if (Array.isArray(next.rightPanelOrder) && next.rightPanelOrder.length > 0) {
    cleaned.rightPanelOrder = [...next.rightPanelOrder]
  }

  if (next.container) {
    const validation = validateContainerConfig(next.container, repoRoot)
    if (validation.valid) {
      cleaned.container = validation.config
    } else {
      log('repo-config', `Invalid container config: ${validation.error}`)
    }
  }

  const hasAny = Object.keys(cleaned).some((k) => k !== 'version')
  const path = configPath(repoRoot)
  try {
    if (!hasAny) {
      if (existsSync(path)) unlinkSync(path)
      cache.set(repoRoot, {})
      return {}
    }
    writeFileSync(path, JSON.stringify(cleaned, null, 2) + '\n')
    cache.set(repoRoot, cleaned)
    return cleaned
  } catch (err) {
    log('repo-config', `failed to save ${path}: ${(err as Error).message}`)
    return cache.get(repoRoot) || {}
  }
}

export function invalidateRepoConfigCache(repoRoot?: string): void {
  if (repoRoot) cache.delete(repoRoot)
  else cache.clear()
}

import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync, realpathSync } from 'fs'
import { isAbsolute, join, resolve, sep } from 'path'
import { log } from '../debug'
import { DEFAULT_HIDDEN_RIGHT_PANELS, type RepoConfig } from '../../shared/state/repo-configs'

export type { RepoConfig }

const REPO_CONFIG_FILENAME = '.harness.json'
const cache = new Map<string, RepoConfig>()

const VALID_MERGE_STRATEGIES = new Set(['squash', 'merge-commit', 'fast-forward'])

function configPath(repoRoot: string): string {
  return join(repoRoot, REPO_CONFIG_FILENAME)
}

const UNSAFE_VOLUME_TARGETS = new Set(['/', '/proc', '/sys', '/dev', '/etc', '/tmp/harness-status', '/workspace'])

const UNSAFE_VOLUME_SOURCES = new Set([
  '/', '/proc', '/sys', '/dev', '/etc', '/boot', '/var/run/docker.sock', '/run/docker.sock'
])

function hasUnsafePathPrefix(resolved: string): boolean {
  if (resolved.startsWith('/proc/') || resolved === '/proc') return true
  if (resolved.startsWith('/sys/') || resolved === '/sys') return true
  if (resolved.startsWith('/dev/') || resolved === '/dev') return true
  if (resolved.startsWith('/private/etc/') || resolved === '/private/etc') return true
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

function isUnsafeWorkdir(workdir: string): boolean {
  const resolved = resolve(workdir)
  if (resolved === '/') return true
  if (hasUnsafePathPrefix(resolved)) return true
  if (resolved.startsWith('/etc/') || resolved === '/etc') return true
  if (resolved === '/tmp/harness-status') return true
  return false
}

function isUnsafeVolumeSource(source: string): boolean {
  const resolved = resolve(source)
  if (UNSAFE_VOLUME_SOURCES.has(resolved)) return true
  if (hasUnsafePathPrefix(resolved)) return true
  if (resolved.startsWith('/etc/') || resolved === '/etc') return true
  return false
}

const SAFE_CONTAINER_IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/

function validateContainerImage(image: string): string | undefined {
  if (!SAFE_CONTAINER_IMAGE_PATTERN.test(image.trim())) {
    return `Invalid container image: ${image}`
  }
  return undefined
}

function validateNonContainerFields(clean: RepoConfig, path: string): void {
  if (clean.setupCommand !== undefined) {
    if (typeof clean.setupCommand !== 'string') {
      log('repo-config', `Invalid setupCommand in ${path}: must be a string, dropping`)
      delete clean.setupCommand
    }
  }
  if (clean.teardownCommand !== undefined) {
    if (typeof clean.teardownCommand !== 'string') {
      log('repo-config', `Invalid teardownCommand in ${path}: must be a string, dropping`)
      delete clean.teardownCommand
    }
  }
  if (clean.mergeStrategy !== undefined) {
    if (!VALID_MERGE_STRATEGIES.has(clean.mergeStrategy)) {
      log('repo-config', `Invalid mergeStrategy in ${path}: "${clean.mergeStrategy}" is not valid, dropping`)
      delete clean.mergeStrategy
    }
  }
}

function realpathIfExists(path: string): string {
  try {
    return realpathSync(path)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code !== 'ENOENT') throw err
    return path
  }
}

function resolveRepoPath(repoRoot: string | undefined, value: string, label: string): { valid: true; path: string } | { valid: false; error: string } {
  let path = value.trim()
  if (repoRoot && !isAbsolute(path)) path = join(repoRoot, path)
  if (!repoRoot) return { valid: true, path }

  const resolvedRepoRoot = realpathIfExists(repoRoot)
  const resolvedPath = realpathIfExists(path)
  if (!resolvedPath.startsWith(resolvedRepoRoot + sep) && resolvedPath !== resolvedRepoRoot && !resolvedPath.startsWith(repoRoot + sep) && resolvedPath !== repoRoot) {
    return { valid: false, error: `${label} path escapes repo root: ${resolvedPath}` }
  }
  return { valid: true, path: resolvedPath }
}

function validateContainerConfig(container: unknown, repoRoot?: string): { valid: true; config: NonNullable<RepoConfig['container']> } | { valid: false; error: string } {
  if (!container || typeof container !== 'object') return { valid: false, error: 'Container config must be an object' }
  const c = container as Record<string, unknown>

  const disabled = c.disabled === true
  const hasImage = typeof c.image === 'string' && c.image.trim().length > 0
  const hasDockerfile = typeof c.dockerfile === 'string' && c.dockerfile.trim().length > 0
  const hasBuildContext = typeof c.buildContext === 'string' && c.buildContext.trim().length > 0

  if (hasImage) {
    const imageError = validateContainerImage(c.image as string)
    if (imageError) return { valid: false, error: imageError }
  }

  if (disabled) {
    const result: NonNullable<RepoConfig['container']> = { disabled: true }
    if (hasImage) result.image = (c.image as string).trim()
    if (hasDockerfile) {
      const resolved = resolveRepoPath(repoRoot, c.dockerfile as string, 'Dockerfile')
      if (!resolved.valid) return resolved
      result.dockerfile = resolved.path
    }
    if (hasBuildContext) {
      const resolved = resolveRepoPath(repoRoot, c.buildContext as string, 'Build context')
      if (!resolved.valid) return resolved
      result.buildContext = resolved.path
    }
    return { valid: true, config: result }
  }

  if (hasImage && hasDockerfile) {
    return { valid: false, error: 'Cannot specify both image and dockerfile' }
  }

  if (c.workdir !== undefined) {
    if (typeof c.workdir !== 'string' || !c.workdir.startsWith('/')) {
      return { valid: false, error: 'workdir must be an absolute path' }
    }
    if (isUnsafeWorkdir(c.workdir as string)) {
      return { valid: false, error: `Unsafe container workdir: ${c.workdir}` }
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
      if (v.source.includes(',')) {
        return { valid: false, error: `Volume source must not contain commas (Docker mount separators not allowed): ${v.source}` }
      }
      if (v.source.includes('=')) {
        return { valid: false, error: `Volume source must not contain equals signs (Docker mount separators not allowed): ${v.source}` }
      }
      if (!v.target.startsWith('/')) {
        return { valid: false, error: `Volume target must be absolute: ${v.target}` }
      }
      if (v.target.includes(':')) {
        return { valid: false, error: `Volume target must not contain colons (Docker options not allowed): ${v.target}` }
      }
      if (v.target.includes(',')) {
        return { valid: false, error: `Volume target must not contain commas (Docker mount separators not allowed): ${v.target}` }
      }
      if (v.target.includes('=')) {
        return { valid: false, error: `Volume target must not contain equals signs (Docker mount separators not allowed): ${v.target}` }
      }
      if (isUnsafeVolumeTarget(v.target as string)) {
        return { valid: false, error: `Unsafe volume target: ${v.target}` }
      }
    }
  }

  if (c.ports !== undefined) {
    if (!Array.isArray(c.ports) || !c.ports.every((p) => typeof p === 'number' && Number.isInteger(p) && p > 0 && p <= 65535)) {
      return { valid: false, error: 'ports must be an array of integers between 1 and 65535' }
    }
  }

  if (c.shell !== undefined && typeof c.shell !== 'string') {
    return { valid: false, error: 'shell must be a string' }
  }

  if (c.buildContext !== undefined && !hasBuildContext) {
    return { valid: false, error: 'buildContext must be a non-empty string' }
  }

  const result: NonNullable<RepoConfig['container']> = {}
  if (hasImage) result.image = (c.image as string).trim()
  if (hasDockerfile) {
    const resolved = resolveRepoPath(repoRoot, c.dockerfile as string, 'Dockerfile')
    if (!resolved.valid) return resolved
    result.dockerfile = resolved.path
  }
  if (hasBuildContext) {
    const resolved = resolveRepoPath(repoRoot, c.buildContext as string, 'Build context')
    if (!resolved.valid) return resolved
    result.buildContext = resolved.path
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
        source = realpathIfExists(source)
        const resolvedRepoRoot = realpathIfExists(repoRoot)
        if (!source.startsWith(resolvedRepoRoot + sep) && source !== resolvedRepoRoot && !source.startsWith(repoRoot + sep) && source !== repoRoot) {
          return { valid: false, error: `Volume source escapes repo root: ${source}` }
        }
      } else if (isAbsolute(source)) {
        source = realpathIfExists(source)
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
    validateNonContainerFields(clean, path)
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
  // Validate non-container fields first (drop non-string setupCommand/teardownCommand, invalid mergeStrategy)
  const validated: RepoConfig = { ...next }
  validateNonContainerFields(validated, configPath(repoRoot))

  const cleaned: RepoConfig = { version: 1 }
  const setup = validated.setupCommand?.trim()
  const teardown = validated.teardownCommand?.trim()
  if (setup) cleaned.setupCommand = setup
  if (teardown) cleaned.teardownCommand = teardown
  if (validated.mergeStrategy) cleaned.mergeStrategy = validated.mergeStrategy
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
    const tmpPath = `${path}.tmp.${process.pid}`
    writeFileSync(tmpPath, JSON.stringify(cleaned, null, 2) + '\n')
    renameSync(tmpPath, path)
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

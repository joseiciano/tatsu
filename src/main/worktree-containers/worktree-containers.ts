import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { log } from '../debug'
import { commandArgsForShell } from '../shell-quote'
import { WORKTREE_CONTAINER_NATIVE_TMPDIR } from './constants'
import type { DockerRunner, DockerRunResult, DockerRunOptions, ResolvedWorktreeContainerConfig, CreatedWorktreeContainer, WorktreeContainers } from './types'
import type { RepoContainerConfig } from '../../shared/state/repo-configs'

const MAX_DOCKER_OUTPUT_BYTES = 1024 * 1024
const MANAGED_WORKTREE_DOCKERFILE = `FROM node:20-alpine

RUN apk add --no-cache bash git ripgrep ca-certificates curl
RUN npm install -g opencode-ai@latest && opencode --version

WORKDIR /workspace
CMD ["tail", "-f", "/dev/null"]
`
const MANAGED_WORKTREE_IMAGE = `tatsu-worktree:${createHash('sha256').update(MANAGED_WORKTREE_DOCKERFILE).digest('hex').slice(0, 12)}`

/**
 * Sanitize Docker stderr output by redacting sensitive tokens and
 * environment variable values, then truncating to a safe length.
 *
 * @param stderr - Raw stderr output from a Docker command.
 * @returns Redacted and truncated string safe for user-facing display.
 */
export function sanitizeStderr(stderr: string): string {
  // Redact first so tokens spanning any boundary are fully removed
  // before truncation, preventing partial token leaks.
  const withSpecificPatterns = stderr
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/g, 'Bearer [redacted]')
    .replace(/\b(ghp_[A-Za-z0-9]{36})\b/g, '[redacted]')
    .replace(/\b(github_pat_[A-Za-z0-9_]+)\b/g, '[redacted]')
    .replace(/\b(sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/g, '[redacted]')
    .replace(/\b(AKIA[0-9A-Z]{16})\b/g, '[redacted]')
    .replace(/\bxox[abprs]-[A-Za-z0-9-]+\b/g, '[redacted]')
    .replace(/\bAIza[0-9A-Za-z_-]{10,}\b/g, '[redacted]')

  // Phase 2a: same-line env assignments (existing behavior).
  // Sensitive keys get VALUE redacted; non-sensitive keys are kept.
  const withSameLineEnv = withSpecificPatterns.replace(
    /\b([A-Za-z_][A-Za-z0-9_]*=)\S+(?:\s+(?![A-Za-z_][A-Za-z0-9_]*=)\S+)*/g,
    (match, prefix: string) => {
      const key = prefix.slice(0, -1)
      if (/token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key/i.test(key)) {
        return `${prefix}[redacted]`
      }
      return match
    }
  )

  // Phase 2b: multiline continuation for sensitive keys.
  // After phase 2a, sensitive keys look like `KEY=[redacted]\n...continuation...`.
  // Consume continuation lines that don't start with a real env assignment
  // (KEY=value with non-empty value). Lines like `MIIEpA=` (PEM body) lack
  // a value after `=`, so they continue to be consumed.
  const lines = withSameLineEnv.split('\n')
  const result: string[] = []
  let inSensitiveContinuation = false
  for (const line of lines) {
    if (inSensitiveContinuation) {
      // Stop at a real env assignment (key=value with non-empty value)
      if (/^[A-Za-z_][A-Za-z0-9_]*=.+/.test(line)) {
        inSensitiveContinuation = false
        result.push(line)
      }
      // Otherwise skip this continuation line (part of the redacted value)
    } else {
      result.push(line)
      // Entering sensitive continuation mode if this line has a redacted env value
      if (/\b[A-Za-z_][A-Za-z0-9_]*=\[redacted\]/.test(line)) {
        inSensitiveContinuation = true
      }
    }
  }
  const redacted = result.join('\n')
  return redacted.length > 500 ? redacted.slice(0, 500) + '...(truncated)' : redacted
}

/**
 * Create a default {@link DockerRunner} that spawns `docker` CLI
 * subprocesses. Output is capped at 1 MiB per stream and commands
 * time out after the caller-specified (or default 60 s) deadline.
 */
export function defaultDockerRunner(): DockerRunner {
  return {
    run(args: string[], opts?: DockerRunOptions): Promise<DockerRunResult> {
      return new Promise((resolve, reject) => {
        const child = spawn('docker', args, {
          cwd: opts?.cwd,
          env: { ...process.env, ...opts?.env },
          stdio: ['ignore', 'pipe', 'pipe']
        })
        const stdoutChunks: Buffer[] = []
        const stderrChunks: Buffer[] = []
        let stdoutBytes = 0
        let stderrBytes = 0
        let settled = false
        const timeoutMs = opts?.timeoutMs ?? 60000
        let timer: ReturnType<typeof setTimeout> | undefined
        const clearTimer = () => {
          if (timer) clearTimeout(timer)
        }
        const capture = (chunks: Buffer[], bytes: number, chunk: Buffer): number => {
          if (bytes >= MAX_DOCKER_OUTPUT_BYTES) return bytes
          const remaining = MAX_DOCKER_OUTPUT_BYTES - bytes
          const captured = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
          chunks.push(captured)
          return bytes + captured.length
        }
        child.stdout?.on('data', (d: Buffer) => { stdoutBytes = capture(stdoutChunks, stdoutBytes, d); opts?.onOutput?.(d.toString()) })
        child.stderr?.on('data', (d: Buffer) => { stderrBytes = capture(stderrChunks, stderrBytes, d); opts?.onOutput?.(d.toString()) })
        child.on('error', (err) => {
          clearTimer()
          if (settled) return
          settled = true
          reject(err)
        })
        child.on('close', (code) => {
          clearTimer()
          if (settled) return
          settled = true
          resolve({ stdout: Buffer.concat(stdoutChunks).toString(), stderr: Buffer.concat(stderrChunks).toString(), exitCode: code ?? -1 })
        })
        timer = setTimeout(() => {
          if (settled) return
          settled = true
          try { child.kill('SIGKILL') } catch { /* ignore */ }
          reject(new Error(`Docker command timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      })
    }
  }
}

/**
 * Create a {@link WorktreeContainers} manager backed by the given
 * (or default) Docker runner. Provides container lifecycle operations
 * (create, exec, stop) and configuration resolution for per-worktree
 * companion containers.
 *
 * @param runner - Optional custom {@link DockerRunner} for testability.
 */
export function createWorktreeContainers(runner?: DockerRunner): WorktreeContainers {
  const docker = runner || defaultDockerRunner()

  function getWorktreeId(absPath: string): string {
    return createHash('sha256').update(absPath).digest('hex').slice(0, 12)
  }

  function getDockerfileImageId(dockerfile: string, buildContext: string, workdir: string): string {
    const hash = createHash('sha256').update(dockerfile).update('\0').update(buildContext).update('\0').update(workdir)
    try {
      hash.update('\0').update(readFileSync(dockerfile))
    } catch {
      hash.update('\0missing')
    }
    return hash.digest('hex').slice(0, 12)
  }

  function normalizeMountTarget(target: string): string {
    return target.length > 1 ? target.replace(/\/+$/g, '') : target
  }

  function sanitizeContainerName(input: string): string {
    const base = basename(input) || 'wt'
    const sanitized = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    return sanitized || 'wt'
  }

  function makeContainerName(worktreePath: string): string {
    const id = getWorktreeId(worktreePath)
    const base = sanitizeContainerName(worktreePath)
    const prefix = 'tatsu-wt-'
    const suffix = `-${id}`
    const maxBase = 63 - prefix.length - suffix.length
    return `${prefix}${base.slice(0, maxBase)}${suffix}`
  }

  function escapeMountValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/=/g, '\\=')
  }

  function bindMountArg(source: string, target: string, readOnly?: boolean): string {
    return `type=bind,source=${escapeMountValue(source)},target=${escapeMountValue(target)}${readOnly ? ',readonly' : ''}`
  }

  function addExistingVolume(volumes: ResolvedWorktreeContainerConfig['volumes'], source: string, target: string, readOnly: boolean): void {
    if (!existsSync(source)) return
    const normalizedTarget = normalizeMountTarget(target)
    if (volumes.some((v) => normalizeMountTarget(v.target) === normalizedTarget)) return
    volumes.push({ source, target, readOnly })
  }

  function authTargetBase(value: string | undefined, fallback: string, workdir: string): string {
    if (!value || !isAbsolute(value)) return fallback
    const target = normalizeMountTarget(value)
    const root = normalizeMountTarget(workdir)
    return target === root || target.startsWith(`${root}/`) ? target : fallback
  }

  function addOpencodeFileReferenceVolumes(volumes: ResolvedWorktreeContainerConfig['volumes'], configPath: string, home: string, containerHome: string): void {
    let configText = ''
    try {
      configText = readFileSync(configPath, 'utf8')
    } catch {
      return
    }
    const refs = configText.matchAll(/\{file:~\/([^}]+)\}/g)
    const normalizedHome = normalizeMountTarget(resolve(home))
    const normalizedContainerHome = normalizeMountTarget(containerHome)
    for (const ref of refs) {
      const relativePath = ref[1]
      if (!relativePath || relativePath.includes('\0') || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) continue
      const source = resolve(home, relativePath)
      if (source !== normalizedHome && !source.startsWith(`${normalizedHome}/`)) continue
      if (!existsSync(source)) continue
      const realSource = realpathSync(source)
      const sourceParent = dirname(realSource)
      const targetParent = normalizeMountTarget(resolve(containerHome, relativePath.split('/').slice(0, -1).join('/')))
      if (targetParent !== normalizedContainerHome && !targetParent.startsWith(`${normalizedContainerHome}/`)) continue
      addExistingVolume(volumes, sourceParent, targetParent, true)
    }
  }

  function addAgentAuthVolumes(volumes: ResolvedWorktreeContainerConfig['volumes'], env: Record<string, string>, workdir: string): void {
    const home = homedir()
    const hostConfigHome = process.env.XDG_CONFIG_HOME || join(home, '.config')
    const hostDataHome = process.env.XDG_DATA_HOME || join(home, '.local', 'share')
    const hostCacheHome = process.env.XDG_CACHE_HOME || join(home, '.cache')
    const containerHome = authTargetBase(env.HOME, `${workdir}/.home`, workdir)
    const containerConfigHome = authTargetBase(env.XDG_CONFIG_HOME, `${workdir}/.config`, workdir)
    const containerDataHome = authTargetBase(env.XDG_DATA_HOME, `${workdir}/.local/share`, workdir)
    const containerCacheHome = authTargetBase(env.XDG_CACHE_HOME, `${workdir}/.cache`, workdir)

    const macOpencodeHome = join(home, 'Library', 'Application Support', 'opencode')
    const macOpencodeCache = join(home, 'Library', 'Caches', 'opencode')
    const opencodeConfig = join(hostConfigHome, 'opencode')
    const opencodeData = join(hostDataHome, 'opencode')
    const opencodeCache = join(hostCacheHome, 'opencode')
    if (existsSync(opencodeConfig)) {
      addExistingVolume(volumes, opencodeConfig, `${containerConfigHome}/opencode`, true)
      addExistingVolume(volumes, opencodeConfig, `${containerHome}/.config/opencode`, true)
      if (!env.OPENCODE_CONFIG_DIR) {
        env.OPENCODE_CONFIG_DIR = `${containerConfigHome}/opencode`
      }
      if (!env.OPENCODE_CONFIG) {
        const hostJson = join(opencodeConfig, 'opencode.json')
        const hostJsonc = join(opencodeConfig, 'opencode.jsonc')
        if (existsSync(hostJson)) {
          env.OPENCODE_CONFIG = `${containerConfigHome}/opencode/opencode.json`
        } else if (existsSync(hostJsonc)) {
          env.OPENCODE_CONFIG = `${containerConfigHome}/opencode/opencode.jsonc`
        }
      }
    }
    addOpencodeFileReferenceVolumes(volumes, join(opencodeConfig, 'opencode.json'), home, containerHome)
    addExistingVolume(volumes, existsSync(opencodeData) ? opencodeData : macOpencodeHome, `${containerDataHome}/opencode`, false)
    addExistingVolume(volumes, existsSync(opencodeCache) ? opencodeCache : macOpencodeCache, `${containerCacheHome}/opencode`, false)
    addExistingVolume(volumes, join(home, '.claude'), `${containerHome}/.claude`, false)
    addExistingVolume(volumes, join(home, '.codex'), `${containerHome}/.codex`, false)
  }

  function encodeLabelValue(value: string): string {
    return 'b64:' + Buffer.from(value, 'utf8').toString('base64url')
  }

  function validateLabelValue(value: string): string {
    if (Buffer.byteLength(value, 'utf8') > 4096) {
      throw new Error('Label value exceeds 4096 byte limit')
    }
    if (!/^[A-Za-z0-9_:/-]+$/.test(value)) {
      throw new Error('Label value contains invalid character')
    }
    return value
  }

  function encodeAndValidateLabelValue(value: string): string {
    const encoded = encodeLabelValue(value)
    return validateLabelValue(encoded)
  }

  function isNoSuchContainer(stderr: string): boolean {
    return /no such container/i.test(stderr)
  }

  let dockerAvailableCache: { ok: boolean; error?: string; ts: number } | null = null
  const DOCKER_CACHE_TTL = 30_000

  async function checkDockerAvailable(): Promise<{ ok: boolean; error?: string }> {
    if (dockerAvailableCache && Date.now() - dockerAvailableCache.ts < DOCKER_CACHE_TTL) {
      return { ok: dockerAvailableCache.ok, error: dockerAvailableCache.error }
    }
    try {
      const result = await docker.run(['version'], { timeoutMs: 10000 })
      if (result.exitCode !== 0) {
        const failure = { ok: false, error: `Docker daemon unavailable: ${result.stderr || 'unknown error'}` }
        dockerAvailableCache = { ...failure, ts: Date.now() }
        return failure
      }
      dockerAvailableCache = { ok: true, ts: Date.now() }
      return { ok: true }
    } catch (err) {
      const e = err as Error & { code?: string }
      if (e.code === 'ENOENT') {
        const result = { ok: false, error: 'Docker CLI not found. Install Docker or ensure it is on your PATH.' }
        dockerAvailableCache = { ...result, ts: Date.now() }
        return result
      }
      const result = { ok: false, error: `Docker check failed: ${e.message}` }
      dockerAvailableCache = { ...result, ts: Date.now() }
      return result
    }
  }

  function resolveContainerConfig(repoRoot: string, worktreePath: string, repoConfig?: RepoContainerConfig): ResolvedWorktreeContainerConfig {
    const workdir = repoConfig?.workdir || '/workspace'
    const worktreeMountTarget = normalizeMountTarget(workdir)
    const defaultEnv: Record<string, string> = {
      HOME: `${workdir}/.home`,
      XDG_CACHE_HOME: `${workdir}/.cache`,
      XDG_CONFIG_HOME: `${workdir}/.config`,
      XDG_DATA_HOME: `${workdir}/.local/share`,
      TMPDIR: WORKTREE_CONTAINER_NATIVE_TMPDIR,
      BUN_TMPDIR: WORKTREE_CONTAINER_NATIVE_TMPDIR
    }
    const mergedEnv: Record<string, string> = { ...defaultEnv, ...(repoConfig?.env || {}) }
    const volumes: ResolvedWorktreeContainerConfig['volumes'] = [
      { source: worktreePath, target: workdir }
    ]
    const harnessStatusDir = '/tmp/harness-status'
    volumes.push({ source: harnessStatusDir, target: harnessStatusDir })
    if (repoConfig?.volumes) {
      for (const vol of repoConfig.volumes) {
        if (normalizeMountTarget(vol.target) === worktreeMountTarget) {
          throw new Error(`Volume target ${vol.target} conflicts with worktree mount ${workdir}`)
        }
        // Harden: reject user-provided volume sources that resolve outside the repo root.
        // Built-in mounts (worktree bind, /tmp/harness-status) are always safe.
        // Use resolve() to normalize traversal (e.g. ../outside, /repo/../etc) before comparison.
        const resolvedSource = vol.source.startsWith('/') ? resolve(vol.source) : resolve(repoRoot, vol.source)
        const normalizedRoot = resolve(repoRoot)
        if (resolvedSource !== normalizedRoot && !resolvedSource.startsWith(normalizedRoot + '/')) {
          throw new Error(`Volume source '${vol.source}' resolves outside repo root: ${resolvedSource}`)
        }
        volumes.push({ source: resolvedSource, target: vol.target })
      }
    }
    addAgentAuthVolumes(volumes, mergedEnv, workdir)
    const dockerfile = repoConfig?.dockerfile
    const image = dockerfile ? `tatsu-worktree:${getDockerfileImageId(dockerfile, repoConfig?.buildContext || repoRoot, workdir)}` : (repoConfig?.image || MANAGED_WORKTREE_IMAGE)

    return {
      image,
      ...(dockerfile ? { dockerfile } : {}),
      ...(!dockerfile && !repoConfig?.image ? { managedDockerfile: MANAGED_WORKTREE_DOCKERFILE } : {}),
      ...(dockerfile ? { buildContext: repoConfig?.buildContext || repoRoot } : {}),
      workdir,
      shell: repoConfig?.shell || '/bin/sh',
      env: mergedEnv,
      ports: repoConfig?.ports || [],
      volumes
    }
  }

  async function ensureImage(config: ResolvedWorktreeContainerConfig): Promise<void> {
    const image = config.image
    if (config.managedDockerfile) {
      const inspectResult = await docker.run(['inspect', '--type=image', image]).catch((err) => ({ stdout: '', stderr: (err as Error).message, exitCode: 1 }))
      if (inspectResult.exitCode === 0) {
        log('worktree-containers', `Image ${image} already exists locally`)
        return
      }
      const buildDir = mkdtempSync(join(tmpdir(), 'tatsu-worktree-image-'))
      try {
        const dockerfilePath = join(buildDir, 'Dockerfile')
        writeFileSync(dockerfilePath, config.managedDockerfile)
        log('worktree-containers', `Building managed worktree image ${image}`)
        const result = await docker.run(['build', '-f', dockerfilePath, '-t', image, buildDir], { timeoutMs: 600000 })
        if (result.exitCode !== 0) throw new Error(`Docker build failed: ${sanitizeStderr(result.stderr)}`)
      } finally {
        rmSync(buildDir, { recursive: true, force: true })
      }
      return
    }
    if (config.dockerfile) {
      const inspectResult = await docker.run(['inspect', '--type=image', image]).catch((err) => ({ stdout: '', stderr: (err as Error).message, exitCode: 1 }))
      if (inspectResult.exitCode === 0) {
        log('worktree-containers', `Image ${image} already exists locally`)
        return
      }
      log('worktree-containers', `Building Dockerfile ${config.dockerfile} as ${image}`)
      const result = await docker.run(['build', '-f', config.dockerfile, '-t', image, '--build-arg', `WORKDIR=${config.workdir}`, config.buildContext || '.'], { timeoutMs: 600000 })
      if (result.exitCode !== 0) throw new Error(`Docker build failed: ${sanitizeStderr(result.stderr)}`)
      return
    }
    const inspectResult = await docker.run(['inspect', '--type=image', image]).catch((err) => ({ stdout: '', stderr: (err as Error).message, exitCode: 1 }))
    if (inspectResult.exitCode === 0) {
      log('worktree-containers', `Image ${image} already exists locally`)
      return
    }
    log('worktree-containers', `Pulling image ${image}`)
    const pullResult = await docker.run(['pull', image], { timeoutMs: 600000 })
    if (pullResult.exitCode !== 0) throw new Error(`Docker pull failed for ${image}: ${sanitizeStderr(pullResult.stderr)}`)
  }

  async function removeExistingContainerByName(name: string): Promise<void> {
    const psResult = await docker.run(['ps', '-aq', '--filter', `name=^/${name}$`], { timeoutMs: 30000 })
    if (psResult.exitCode !== 0) throw new Error(`Docker container lookup failed: ${sanitizeStderr(psResult.stderr)}`)
    const ids = psResult.stdout.split(/\s+/).map((id) => id.trim()).filter(Boolean)
    for (const id of ids) {
      const rmResult = await docker.run(['rm', '-f', id], { timeoutMs: 30000 })
      if (rmResult.exitCode !== 0) throw new Error(`Failed to remove existing container ${id}: ${sanitizeStderr(rmResult.stderr)}`)
    }
  }

  async function createForWorktree(repoRoot: string, worktreePath: string, config: ResolvedWorktreeContainerConfig): Promise<CreatedWorktreeContainer> {
    const dockerCheck = await checkDockerAvailable()
    if (!dockerCheck.ok) {
      throw new Error(dockerCheck.error || 'Docker is not available')
    }
    // Ensure harness-status dir exists before docker run
    try {
      mkdirSync('/tmp/harness-status', { recursive: true, mode: 0o700 })
    } catch (err) {
      throw new Error(`Failed to create /tmp/harness-status directory: ${err instanceof Error ? err.message : err}`)
    }
    await ensureImage(config)
    const id = getWorktreeId(worktreePath)
    const name = makeContainerName(worktreePath)
    await removeExistingContainerByName(name)
    const args = [
      'run', '-d', '--name', name,
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m',
      '--tmpfs', '/var/tmp:rw,noexec,nosuid,size=256m',
      '--tmpfs', `${WORKTREE_CONTAINER_NATIVE_TMPDIR}:rw,exec,nosuid,nodev,size=256m,mode=1777`,
      '--label', `tatsu.worktree.id=${validateLabelValue(id)}`,
      '--label', `tatsu.worktree.path=${encodeAndValidateLabelValue(worktreePath)}`,
      '--label', `tatsu.repo.root=${encodeAndValidateLabelValue(repoRoot)}`,
      '-w', config.workdir,
      ...config.volumes.flatMap((v) => ['--mount', bindMountArg(v.source, v.target, v.readOnly)]),
      ...Object.entries(config.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      ...config.ports.flatMap((p) => ['-p', `127.0.0.1:${p}:${p}`]),
      config.image,
      'tail', '-f', '/dev/null'
    ]
    log('worktree-containers', `Creating container for ${worktreePath}: ${name}`)
    const result = await docker.run(args)
    if (result.exitCode !== 0) throw new Error(`Docker run failed: ${sanitizeStderr(result.stderr)}`)
    const containerId = result.stdout.trim()
    return { id: containerId, name, image: config.image, workdir: config.workdir, shell: config.shell, status: 'running' }
  }

  async function execInContainer(containerId: string, command: string, opts?: { workdir?: string; env?: Record<string, string>; shell?: string; onOutput?: (chunk: string) => void }): Promise<DockerRunResult> {
    const shell = opts?.shell || '/bin/sh'
    const args = ['exec']
    if (opts?.workdir) args.push('--workdir', opts.workdir)
    if (opts?.env) {
      const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/
      for (const [k, v] of Object.entries(opts.env)) {
        if (!envKeyPattern.test(k)) throw new Error(`Invalid env key: ${k}`)
        args.push('-e', `${k}=${v}`)
      }
    }
    args.push(containerId, ...commandArgsForShell(shell, command))
    return docker.run(args, { timeoutMs: 300000, onOutput: opts?.onOutput })
  }

  async function isContainerRunning(containerId: string): Promise<boolean> {
    const result = await docker.run(['inspect', '--format', '{{.State.Running}}', containerId], { timeoutMs: 30000 })
    if (result.exitCode !== 0) return false
    return result.stdout.trim() === 'true'
  }

  async function stopContainer(containerId: string): Promise<void> {
    log('worktree-containers', `Stopping container ${containerId}`)
    try {
      const stopResult = await docker.run(['stop', containerId], { timeoutMs: 30000 })
      if (stopResult.exitCode !== 0) {
        log('worktree-containers', `docker stop failed for ${containerId}; trying rm -f`, sanitizeStderr(stopResult.stderr))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log('worktree-containers', `docker stop rejected for ${containerId}; trying rm -f`, sanitizeStderr(message))
    }
    const rmResult = await docker.run(['rm', '-f', containerId], { timeoutMs: 30000 })
    if (rmResult.exitCode !== 0 && !isNoSuchContainer(rmResult.stderr)) {
      throw new Error(`Failed to remove container ${containerId}: ${sanitizeStderr(rmResult.stderr)}`)
    }
  }

  async function restartContainer(containerId: string): Promise<void> {
    const result = await docker.run(['restart', containerId], { timeoutMs: 30000 })
    if (result.exitCode !== 0) {
      throw new Error(`Docker restart failed for ${containerId}: ${sanitizeStderr(result.stderr)}`)
    }
  }

  return { checkDockerAvailable, resolveContainerConfig, ensureImage, createForWorktree, execInContainer, isContainerRunning, restartContainer, stopContainer }
}

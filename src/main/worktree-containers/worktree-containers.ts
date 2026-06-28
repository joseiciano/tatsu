import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { basename } from 'path'
import { log } from '../debug'
import type { DockerRunner, DockerRunResult, DockerRunOptions, ResolvedWorktreeContainerConfig, CreatedWorktreeContainer, WorktreeContainers } from './types'
import type { RepoContainerConfig } from '../../shared/state/repo-configs'

const MAX_DOCKER_OUTPUT_BYTES = 1024 * 1024

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

export function createWorktreeContainers(runner?: DockerRunner): WorktreeContainers {
  const docker = runner || defaultDockerRunner()

  function getWorktreeId(absPath: string): string {
    return createHash('sha256').update(absPath).digest('hex').slice(0, 12)
  }

  function getDockerfileImageId(_worktreePath: string, dockerfile: string): string {
    const hash = createHash('sha256').update(dockerfile)
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

  function bindMountArg(source: string, target: string): string {
    return `type=bind,source=${escapeMountValue(source)},target=${escapeMountValue(target)}`
  }

  function validateLabelValue(value: string): string {
    if (Buffer.byteLength(value, 'utf8') > 4096) {
      throw new Error('Label value exceeds 4096 byte limit')
    }
    if (value.includes('\0') || value.includes('\n') || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
      throw new Error('Label value contains invalid character')
    }
    return value
  }

  function sanitizeStderr(stderr: string): string {
    const truncated = stderr.length > 500 ? stderr.slice(0, 500) + '...(truncated)' : stderr
    return truncated
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/g, 'Bearer [redacted]')
      .replace(/\b(ghp_[A-Za-z0-9]{36})\b/g, '[redacted]')
      .replace(/\b(sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/g, '[redacted]')
      .replace(/\b(AKIA[0-9A-Z]{16})\b/g, '[redacted]')
      .replace(/\bxox[abprs]-[A-Za-z0-9-]+\b/g, '[redacted]')
      .replace(/\bAIza[0-9A-Za-z_-]{10,}\b/g, '[redacted]')
      .replace(/(\bpassword=)[^\s]+/gi, '$1[redacted]')
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
      const result = await docker.run(['version', '--format', 'json'], { timeoutMs: 10000 })
      if (result.exitCode !== 0) {
        const failure = { ok: false, error: `Docker daemon unavailable: ${result.stderr || 'unknown error'}` }
        dockerAvailableCache = { ...failure, ts: Date.now() }
        return failure
      }
      try {
        const parsed = JSON.parse(result.stdout)
        if (!parsed.Server) {
          const failure = { ok: false, error: 'Docker daemon unavailable: Server section missing from docker version output' }
          dockerAvailableCache = { ...failure, ts: Date.now() }
          return failure
        }
      } catch {
        const failure = { ok: false, error: 'Docker daemon unavailable: unable to parse docker version output' }
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
    const volumes: Array<{ source: string; target: string }> = [
      { source: worktreePath, target: workdir }
    ]
    const harnessStatusDir = '/tmp/harness-status'
    volumes.push({ source: harnessStatusDir, target: harnessStatusDir })
    if (repoConfig?.volumes) {
      for (const vol of repoConfig.volumes) {
        if (normalizeMountTarget(vol.target) === worktreeMountTarget) {
          throw new Error(`Volume target ${vol.target} conflicts with worktree mount ${workdir}`)
        }
        volumes.push(vol)
      }
    }
    const dockerfile = repoConfig?.dockerfile
    const image = dockerfile ? `tatsu-worktree:${getDockerfileImageId(worktreePath, dockerfile)}` : (repoConfig?.image || 'node:20-alpine')
    return {
      image,
      ...(dockerfile ? { dockerfile } : {}),
      ...(dockerfile ? { buildContext: repoConfig?.buildContext || repoRoot } : {}),
      workdir,
      shell: repoConfig?.shell || '/bin/sh',
      env: repoConfig?.env || {},
      ports: repoConfig?.ports || [],
      volumes
    }
  }

  async function ensureImage(config: ResolvedWorktreeContainerConfig): Promise<void> {
    const image = config.image
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
    await ensureImage(config)
    const id = getWorktreeId(worktreePath)
    const name = makeContainerName(worktreePath)
    await removeExistingContainerByName(name)
    const args = [
      'run', '-d', '--name', name,
      '--label', `tatsu.worktree.id=${validateLabelValue(id)}`,
      '--label', `tatsu.worktree.path=${validateLabelValue(worktreePath)}`,
      '--label', `tatsu.repo.root=${validateLabelValue(repoRoot)}`,
      '-w', config.workdir,
      ...config.volumes.flatMap((v) => ['--mount', bindMountArg(v.source, v.target)]),
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

  function commandArgsForShell(shell: string, command: string): string[] {
    const shellName = basename(shell).toLowerCase()
    if (shellName === 'fish' || shellName === 'nu' || shellName === 'nushell') return [shell, '-c', command]
    if (shellName === 'pwsh' || shellName === 'powershell' || shellName === 'powershell.exe' || shellName === 'pwsh.exe') {
      return [shell, '-NoLogo', '-NoProfile', '-Command', command]
    }
    return [shell, '-c', command]
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

  return { checkDockerAvailable, resolveContainerConfig, ensureImage, createForWorktree, execInContainer, isContainerRunning, stopContainer }
}

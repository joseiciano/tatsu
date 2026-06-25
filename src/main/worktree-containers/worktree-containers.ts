import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { basename, dirname } from 'path'
import { log } from '../debug'
import type { DockerRunner, DockerRunResult, DockerRunOptions, ResolvedWorktreeContainerConfig, CreatedWorktreeContainer, WorktreeContainers } from './types'
import type { RepoContainerConfig } from '../../shared/state/repo-configs'

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
        let settled = false
        child.stdout?.on('data', (d: Buffer) => { stdoutChunks.push(d) })
        child.stderr?.on('data', (d: Buffer) => { stderrChunks.push(d) })
        child.on('error', (err) => {
          if (settled) return
          settled = true
          reject(err)
        })
        child.on('close', (code) => {
          if (settled) return
          settled = true
          resolve({ stdout: Buffer.concat(stdoutChunks).toString(), stderr: Buffer.concat(stderrChunks).toString(), exitCode: code ?? -1 })
        })
        const timeoutMs = opts?.timeoutMs ?? 60000
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          try { child.kill('SIGKILL') } catch { /* ignore */ }
          reject(new Error(`Docker command timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        child.on('close', () => clearTimeout(timer))
        child.on('error', () => clearTimeout(timer))
      })
    }
  }
}

export function createWorktreeContainers(runner?: DockerRunner): WorktreeContainers {
  const docker = runner || defaultDockerRunner()

  function getWorktreeId(absPath: string): string {
    return createHash('sha256').update(absPath).digest('hex').slice(0, 12)
  }

  function sanitizeContainerName(input: string): string {
    const base = basename(input) || 'wt'
    return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  }

  function makeContainerName(worktreePath: string): string {
    const id = getWorktreeId(worktreePath)
    const base = sanitizeContainerName(worktreePath)
    const prefix = 'tatsu-wt-'
    const suffix = `-${id}`
    const maxBase = 63 - prefix.length - suffix.length
    return `${prefix}${base.slice(0, maxBase)}${suffix}`
  }

  function validateLabelValue(value: string): string {
    if (value.length > 4096) {
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
      .replace(/\b(eyJ[A-Za-z0-9+/=]+)\b/g, '[redacted]')
      .replace(/\b(ghp_[A-Za-z0-9]{36})\b/g, '[redacted]')
      .replace(/\b(sk-[A-Za-z0-9]{48})\b/g, '[redacted]')
      .replace(/\b(AKIA[0-9A-Z]{16})\b/g, '[redacted]')
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
        return { ok: false, error: `Docker daemon unavailable: ${result.stderr || 'unknown error'}` }
      }
      try {
        const parsed = JSON.parse(result.stdout)
        if (!parsed.Server) {
          return { ok: false, error: 'Docker daemon unavailable: Server section missing from docker version output' }
        }
      } catch {
        return { ok: false, error: 'Docker daemon unavailable: unable to parse docker version output' }
      }
      dockerAvailableCache = { ok: true, ts: Date.now() }
      return { ok: true }
    } catch (err) {
      const e = err as Error & { code?: string }
      if (e.code === 'ENOENT') {
        const result = { ok: false, error: 'Docker CLI not found. Install Docker to use worktree containers.' }
        dockerAvailableCache = { ...result, ts: Date.now() }
        return result
      }
      const result = { ok: false, error: `Docker check failed: ${e.message}` }
      dockerAvailableCache = { ...result, ts: Date.now() }
      return result
    }
  }

  function resolveContainerConfig(_repoRoot: string, worktreePath: string, repoConfig?: RepoContainerConfig): ResolvedWorktreeContainerConfig {
    const volumes: Array<{ source: string; target: string }> = [
      { source: worktreePath, target: repoConfig?.workdir || '/workspace' }
    ]
    const harnessStatusDir = '/tmp/harness-status'
    if (existsSync(harnessStatusDir)) {
      volumes.push({ source: harnessStatusDir, target: harnessStatusDir })
    }
    if (repoConfig?.volumes) {
      for (const vol of repoConfig.volumes) {
        volumes.push(vol)
      }
    }
    const dockerfile = repoConfig?.dockerfile
    const image = dockerfile ? `tatsu-worktree:${getWorktreeId(worktreePath)}` : (repoConfig?.image || 'node:20-alpine')
    return {
      image,
      ...(dockerfile ? { dockerfile } : {}),
      workdir: repoConfig?.workdir || '/workspace',
      shell: repoConfig?.shell || '/bin/sh',
      env: repoConfig?.env || {},
      ports: repoConfig?.ports || [],
      volumes
    }
  }

  async function ensureImage(config: ResolvedWorktreeContainerConfig): Promise<void> {
    const image = config.image
    if (config.dockerfile) {
      log('worktree-containers', `Building Dockerfile ${config.dockerfile} as ${image}`)
      const result = await docker.run(['build', '-f', config.dockerfile, '-t', image, ...(config.workdir ? ['--build-arg', `WORKDIR=${config.workdir}`] : []), buildContextFromDockerfile(config.dockerfile)], { timeoutMs: 600000 })
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

  function buildContextFromDockerfile(dockerfilePath: string): string {
    return dirname(dockerfilePath) || '.'
  }

  async function createForWorktree(repoRoot: string, worktreePath: string, config: ResolvedWorktreeContainerConfig): Promise<CreatedWorktreeContainer> {
    const dockerCheck = await checkDockerAvailable()
    if (!dockerCheck.ok) {
      throw new Error(dockerCheck.error || 'Docker is not available')
    }
    await ensureImage(config)
    const id = getWorktreeId(worktreePath)
    const name = makeContainerName(worktreePath)
    const args = [
      'run', '-d', '--name', name,
      '--label', `tatsu.worktree.id=${validateLabelValue(id)}`,
      '--label', `tatsu.worktree.path=${validateLabelValue(worktreePath)}`,
      '--label', `tatsu.repo.root=${validateLabelValue(repoRoot)}`,
      '-w', config.workdir,
      ...config.volumes.flatMap((v) => ['-v', `${v.source}:${v.target}`]),
      ...Object.entries(config.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      ...config.ports.flatMap((p) => ['-p', `127.0.0.1:${p}:${p}`]),
      config.image,
      'sh', '-c', 'while true; do sleep 3600; done'
    ]
    log('worktree-containers', `Creating container for ${worktreePath}: ${name}`)
    const result = await docker.run(args)
    if (result.exitCode !== 0) throw new Error(`Docker run failed: ${sanitizeStderr(result.stderr)}`)
    const containerId = result.stdout.trim()
    return { id: containerId, name, image: config.image, workdir: config.workdir, shell: config.shell, status: 'running' }
  }

  async function execInContainer(containerId: string, command: string, opts?: { workdir?: string; env?: Record<string, string>; shell?: string }): Promise<DockerRunResult> {
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
    args.push(containerId, shell, '-lc', command)
    return docker.run(args, { timeoutMs: 300000 })
  }

  async function stopContainer(containerId: string): Promise<void> {
    log('worktree-containers', `Stopping container ${containerId}`)
    await docker.run(['stop', containerId], { timeoutMs: 30000 }).catch((err) => {
      log('worktree-containers', `Failed to stop container ${containerId}:`, err instanceof Error ? err.message : err)
    })
    await docker.run(['rm', '-f', containerId], { timeoutMs: 30000 }).catch((err) => {
      log('worktree-containers', `Failed to remove container ${containerId}:`, err instanceof Error ? err.message : err)
    })
  }

  return { checkDockerAvailable, resolveContainerConfig, ensureImage, createForWorktree, execInContainer, stopContainer }
}
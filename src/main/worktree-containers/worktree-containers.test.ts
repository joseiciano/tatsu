import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, chmodSync, symlinkSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { DockerRunner } from './types'
import type { RepoContainerConfig } from '../../shared/state/repo-configs'
import { createWorktreeContainers, defaultDockerRunner, sanitizeStderr } from './worktree-containers'

function makeRunner(): DockerRunner & { calls: Array<{ args: string[]; opts?: Record<string, unknown> }> } {
  const calls: Array<{ args: string[]; opts?: Record<string, unknown> }> = []
  return { calls, async run(args, opts) { calls.push({ args, opts: opts as any }); return { stdout: '', stderr: '', exitCode: 0 } } }
}

describe('checkDockerAvailable', () => {
  it('calls docker version without --format json', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockResolvedValue({ stdout: 'Docker version 20.10.12', stderr: '', exitCode: 0 })
    const containers = createWorktreeContainers(runner)
    await containers.checkDockerAvailable()
    expect(runner.run).toHaveBeenCalledWith(['version'], { timeoutMs: 10000 })
    const callArgs = (runner.run as any).mock.calls[0][0]
    expect(callArgs).not.toContain('--format')
    expect(callArgs).not.toContain('json')
  })

  it('returns ok on exit 0 regardless of output format', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockResolvedValue({ stdout: 'Docker version 20.10.12, build e91ed57', stderr: '', exitCode: 0 })
    const containers = createWorktreeContainers(runner)
    const result = await containers.checkDockerAvailable()
    expect(result.ok).toBe(true)
  })

  it('returns daemon-unavailable on nonzero exit', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockResolvedValue({ stdout: '', stderr: 'Cannot connect to the Docker daemon', exitCode: 1 })
    const result = await createWorktreeContainers(runner).checkDockerAvailable()
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/daemon unavailable/)
  })

  it('CLI not found error on ENOENT mentions PATH', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockRejectedValue(Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }))
    const result = await createWorktreeContainers(runner).checkDockerAvailable()
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/CLI not found/)
    expect(result.error).toMatch(/PATH/)
  })
})

describe('execInContainer', () => {
  it('default shell is /bin/sh -c', async () => {
    const runner = makeRunner()
    await createWorktreeContainers(runner).execInContainer('c1', 'pnpm install', { workdir: '/app' })
    const call = runner.calls.find((c) => c.args[0] === 'exec')
    expect(call!.args).toContain('/bin/sh')
    expect(call!.args).toContain('-c')
    expect(call!.args).toContain('pnpm install')
  })

  it('uses custom shell when provided', async () => {
    const runner = makeRunner()
    await createWorktreeContainers(runner).execInContainer('c1', 'pnpm install', { shell: '/bin/bash' })
    const call = runner.calls.find((c) => c.args[0] === 'exec')
    expect(call!.args).toContain('/bin/bash')
    expect(call!.args).toContain('-c')
  })

  it('uses shell-specific command flags for non-POSIX shells', async () => {
    const fishRunner = makeRunner()
    await createWorktreeContainers(fishRunner).execInContainer('c1', 'pnpm install', { shell: '/usr/bin/fish' })
    expect(fishRunner.calls[0].args.slice(-3)).toEqual(['/usr/bin/fish', '-c', 'pnpm install'])

    const pwshRunner = makeRunner()
    await createWorktreeContainers(pwshRunner).execInContainer('c1', 'pnpm install', { shell: 'pwsh' })
    expect(pwshRunner.calls[0].args.slice(-5)).toEqual(['pwsh', '-NoLogo', '-NoProfile', '-Command', 'pnpm install'])
  })

  it('throws on invalid env key', async () => {
    const runner = makeRunner()
    await expect(
      createWorktreeContainers(runner).execInContainer('c1', 'cmd', { env: { 'BAD KEY': 'v' } })
    ).rejects.toThrow(/Invalid env key/)
  })

  it('passes onOutput to the Docker runner', async () => {
    const runner = makeRunner()
    const onOutput = vi.fn()
    await createWorktreeContainers(runner).execInContainer('c1', 'cmd', { onOutput })
    const call = runner.calls.find((c) => c.args[0] === 'exec')
    expect(call?.opts?.onOutput).toBe(onOutput)
  })
})

describe('restartContainer', () => {
  it('uses docker restart for non-destructive container recovery', async () => {
    const runner = makeRunner()
    await createWorktreeContainers(runner).restartContainer('container-1')
    expect(runner.calls[0].args).toEqual(['restart', 'container-1'])
  })

  it('throws sanitized restart failures', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockResolvedValue({ stdout: '', stderr: 'restart failed ghp_abcdefghijklmnopqrstuvwxyz1234567890', exitCode: 1 })
    await expect(createWorktreeContainers(runner).restartContainer('container-1')).rejects.toThrow(/Docker restart failed for container-1: restart failed \[redacted\]/)
  })
})

describe('ensureImage', () => {
  it('skips Dockerfile build when tagged image exists locally', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'inspect') return { stdout: '[{}]', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/repo', '/repo/wt', { dockerfile: '/repo/Dockerfile' })
    await containers.ensureImage(config)
    const calls = (runner.run as any).mock.calls.map((c: any) => c[0][0])
    expect(calls).toContain('inspect')
    expect(calls).not.toContain('build')
  })

  it('builds Dockerfile images when tagged image is missing', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'inspect') return { stdout: '', stderr: 'No such image', exitCode: 1 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/repo', '/repo/wt', { dockerfile: '/repo/Dockerfile' })
    await containers.ensureImage(config)
    const calls = (runner.run as any).mock.calls.map((c: any) => c[0][0])
    expect(calls).toEqual(['inspect', 'build'])
  })

  it('uses a new Dockerfile image tag when Dockerfile content changes', () => {
    const runner = makeRunner()
    const containers = createWorktreeContainers(runner)
    const dir = mkdtempSync(join(tmpdir(), 'tatsu-dockerfile-'))
    try {
      const dockerfile = join(dir, 'Dockerfile')
      writeFileSync(dockerfile, 'FROM node:20-alpine\n')
      const before = containers.resolveContainerConfig('/repo', '/repo/wt', { dockerfile }).image
      writeFileSync(dockerfile, 'FROM node:22-alpine\n')
      const after = containers.resolveContainerConfig('/repo', '/repo/wt', { dockerfile }).image
      expect(after).not.toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips pull when image exists locally', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'inspect') return { stdout: '[{}]', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    await containers.ensureImage({ image: 'node:20-alpine', workdir: '/workspace', shell: '/bin/sh', env: {}, ports: [], volumes: [] })
    const calls = (runner.run as any).mock.calls.map((c: any) => c[0][0])
    expect(calls).toContain('inspect')
    expect(calls).not.toContain('pull')
  })

  it('pulls image when inspect fails', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'inspect') return { stdout: '', stderr: 'No such image', exitCode: 1 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    await containers.ensureImage({ image: 'node:20-alpine', workdir: '/workspace', shell: '/bin/sh', env: {}, ports: [], volumes: [] })
    const calls = (runner.run as any).mock.calls.map((c: any) => c[0][0])
    expect(calls).toContain('pull')
    const pullCall = (runner.run as any).mock.calls.find((c: any) => c[0][0] === 'pull')
    expect(pullCall[0]).toContain('node:20-alpine')
  })

  it('builds Dockerfile before run with deterministic tag', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'version') return { stdout: JSON.stringify({ Server: {} }), stderr: '', exitCode: 0 }
      if (args[0] === 'inspect') return { stdout: '', stderr: 'No such image', exitCode: 1 }
      if (args[0] === 'run') return { stdout: 'abc\n', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/repo', '/repo/wt', { dockerfile: '/repo/Dockerfile' })
    await containers.createForWorktree('/repo', '/repo/wt', config)
    const calls = (runner.run as any).mock.calls.map((c: any) => c[0][0])
    expect(calls).toContain('build')
    const buildCall = (runner.run as any).mock.calls.find((c: any) => c[0][0] === 'build')
    expect(buildCall[0]).toContain('-f')
    expect(buildCall[0]).toContain('/repo/Dockerfile')
    expect(buildCall[0]).toContain('-t')
    expect(buildCall[0].at(-1)).toBe('/repo')
  })

  it('uses explicit Docker build context when configured', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'inspect') return { stdout: '', stderr: 'No such image', exitCode: 1 }
      if (args[0] === 'build') return { stdout: '', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/repo', '/repo/wt', { dockerfile: '/repo/docker/Dockerfile', buildContext: '/repo/docker' })
    await containers.ensureImage(config)
    const buildCall = (runner.run as any).mock.calls.find((c: any) => c[0][0] === 'build')
    expect(buildCall[0].at(-1)).toBe('/repo/docker')
  })

  it('throws sanitized Dockerfile build failures', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'inspect') return { stdout: '', stderr: 'No such image', exitCode: 1 }
      if (args[0] === 'build') return { stdout: '', stderr: 'boom ghp_abcdefghijklmnopqrstuvwxyz1234567890', exitCode: 1 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/repo', '/repo/wt', { dockerfile: '/repo/Dockerfile' })
    await expect(containers.ensureImage(config)).rejects.toThrow(/Docker build failed: boom \[redacted\]/)
  })

  it('throws sanitized image pull failures', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'inspect') return { stdout: '', stderr: 'No such image', exitCode: 1 }
      if (args[0] === 'pull') return { stdout: '', stderr: 'pull failed sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV', exitCode: 1 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    await expect(containers.ensureImage({ image: 'missing:latest', workdir: '/workspace', shell: '/bin/sh', env: {}, ports: [], volumes: [] })).rejects.toThrow(/Docker pull failed for missing:latest: pull failed \[redacted\]/)
  })


  it('redacts sk-proj-* keys from image pull failures', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'inspect') return { stdout: '', stderr: 'No such image', exitCode: 1 }
      if (args[0] === 'pull') return { stdout: '', stderr: 'auth failed sk-proj-abcdefghijklmnopqrstuvwxyz123456', exitCode: 1 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    await expect(containers.ensureImage({ image: 'missing:latest', workdir: '/workspace', shell: '/bin/sh', env: {}, ports: [], volumes: [] })).rejects.toThrow(/auth failed \[redacted\]/)
  })

  it('redacts variable-length sk- keys from image pull failures', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'inspect') return { stdout: '', stderr: 'No such image', exitCode: 1 }
      if (args[0] === 'pull') return { stdout: '', stderr: 'auth failed sk-abcdefghij1234567890klmnop', exitCode: 1 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    await expect(containers.ensureImage({ image: 'missing:latest', workdir: '/workspace', shell: '/bin/sh', env: {}, ports: [], volumes: [] })).rejects.toThrow(/auth failed \[redacted\]/)
  })

  it('redacts common token patterns from image pull failures', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'inspect') return { stdout: '', stderr: 'No such image', exitCode: 1 }
      if (args[0] === 'pull') return { stdout: '', stderr: 'Bearer abc.def.ghi xoxb-1234567890-abcdef AIzaSyA1234567890 password=supersecret', exitCode: 1 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    await expect(containers.ensureImage({ image: 'missing:latest', workdir: '/workspace', shell: '/bin/sh', env: {}, ports: [], volumes: [] })).rejects.toThrow('Bearer [redacted] [redacted] [redacted] password=[redacted]')
  })

  it('redacts generic env assignment secrets (GITLAB_TOKEN, NPM_TOKEN, API_KEY)', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'inspect') return { stdout: '', stderr: 'No such image', exitCode: 1 }
      if (args[0] === 'pull') return { stdout: '', stderr: 'error: GITLAB_TOKEN=glpat-abc123def456 NPM_TOKEN=npm_abc123 API_KEY=sk-realkey123', exitCode: 1 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    await expect(containers.ensureImage({ image: 'missing:latest', workdir: '/workspace', shell: '/bin/sh', env: {}, ports: [], volumes: [] })).rejects.toThrow(/GITLAB_TOKEN=\[redacted\].*NPM_TOKEN=\[redacted\].*API_KEY=\[redacted\]/)
  })
})

describe('resolveContainerConfig', () => {
  it('returns different image when same dockerfile has different buildContext', () => {
    const runner = makeRunner()
    const containers = createWorktreeContainers(runner)
    const dir = mkdtempSync(join(tmpdir(), 'tatsu-df-bc-'))
    try {
      const dockerfile = join(dir, 'Dockerfile')
      writeFileSync(dockerfile, 'FROM node:20-alpine\n')
      const configA = containers.resolveContainerConfig('/repo', '/repo/wt', { dockerfile, buildContext: '/repo/ctx1' })
      const configB = containers.resolveContainerConfig('/repo', '/repo/wt', { dockerfile, buildContext: '/repo/ctx2' })
      expect(configA.image).not.toBe(configB.image)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns different image when same dockerfile has different workdir', () => {
    const runner = makeRunner()
    const containers = createWorktreeContainers(runner)
    const dir = mkdtempSync(join(tmpdir(), 'tatsu-df-wd-'))
    try {
      const dockerfile = join(dir, 'Dockerfile')
      writeFileSync(dockerfile, 'FROM node:20-alpine\n')
      const configA = containers.resolveContainerConfig('/repo', '/repo/wt', { dockerfile, workdir: '/workspace' })
      const configB = containers.resolveContainerConfig('/repo', '/repo/wt', { dockerfile, workdir: '/app' })
      expect(configA.image).not.toBe(configB.image)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns same image for same dockerfile across different worktree paths', () => {
    const runner = makeRunner()
    const containers = createWorktreeContainers(runner)
    const dir = mkdtempSync(join(tmpdir(), 'tatsu-df-same-'))
    try {
      const dockerfile = join(dir, 'Dockerfile')
      writeFileSync(dockerfile, 'FROM node:20-alpine\n')
      const configA = containers.resolveContainerConfig('/repo', '/repo/wt-a', { dockerfile })
      const configB = containers.resolveContainerConfig('/repo', '/repo/wt-b', { dockerfile })
      expect(configA.image).toBe(configB.image)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns same image for worktrees sharing the same dockerfile', () => {
    const runner = makeRunner()
    const containers = createWorktreeContainers(runner)
    const dir = mkdtempSync(join(tmpdir(), 'tatsu-shared-df-'))
    try {
      const dockerfile = join(dir, 'Dockerfile')
      writeFileSync(dockerfile, 'FROM node:20-alpine\n')
      const configA = containers.resolveContainerConfig('/repo', '/repo/wt-a', { dockerfile })
      const configB = containers.resolveContainerConfig('/repo', '/repo/wt-b', { dockerfile })
      expect(configA.image).toBe(configB.image)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns different image when dockerfile content changes', () => {
    const runner = makeRunner()
    const containers = createWorktreeContainers(runner)
    const dir = mkdtempSync(join(tmpdir(), 'tatsu-df-content-'))
    try {
      const dockerfile = join(dir, 'Dockerfile')
      writeFileSync(dockerfile, 'FROM node:20-alpine\n')
      const before = containers.resolveContainerConfig('/repo', '/repo/wt', { dockerfile }).image
      writeFileSync(dockerfile, 'FROM node:22-alpine\n')
      const after = containers.resolveContainerConfig('/repo', '/repo/wt', { dockerfile }).image
      expect(after).not.toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('includes /tmp/harness-status bind mount without creating directory', () => {
    const containers = createWorktreeContainers(makeRunner())
    const config = containers.resolveContainerConfig('/repo', '/repo/wt')
    // resolveContainerConfig should include the mount but NOT create the directory
    const harnessVol = config.volumes.find(v => v.source === '/tmp/harness-status')
    expect(harnessVol).toBeDefined()
    expect(harnessVol!.target).toBe('/tmp/harness-status')
  })

  it('rejects user volumes with source outside repoRoot', () => {
    const containers = createWorktreeContainers(makeRunner())
    expect(() => containers.resolveContainerConfig('/repo', '/repo/wt', {
      volumes: [{ source: '/etc/passwd', target: '/data' }]
    })).toThrow(/[Vv]olume source.*resolves outside repo root/)
  })

  it('allows user volumes with absolute source inside repoRoot', () => {
    const containers = createWorktreeContainers(makeRunner())
    const config = containers.resolveContainerConfig('/repo', '/repo/wt', {
      volumes: [{ source: '/repo/data', target: '/data' }]
    })
    expect(config.volumes.some(v => v.source === '/repo/data' && v.target === '/data')).toBe(true)
  })

  it('rejects relative volume source that escapes repo root via ../outside', () => {
    const containers = createWorktreeContainers(makeRunner())
    expect(() => containers.resolveContainerConfig('/repo', '/repo/wt', {
      volumes: [{ source: '../outside', target: '/data' }]
    })).toThrow(/[Vv]olume source.*resolves outside repo root/)
  })

  it('rejects absolute volume source with traversal that escapes repo root', () => {
    const containers = createWorktreeContainers(makeRunner())
    expect(() => containers.resolveContainerConfig('/repo', '/repo/wt', {
      volumes: [{ source: '/repo/../etc', target: '/data' }]
    })).toThrow(/[Vv]olume source.*resolves outside repo root/)
  })

  it('allows relative in-repo source and normalizes it in returned config', () => {
    const containers = createWorktreeContainers(makeRunner())
    const config = containers.resolveContainerConfig('/repo', '/repo/wt', {
      volumes: [{ source: 'data', target: '/data' }]
    })
    const vol = config.volumes.find(v => v.target === '/data')
    expect(vol).toBeDefined()
    expect(vol!.source).toBe('/repo/data')
  })

  it('allows absolute in-repo source and normalizes it in returned config', () => {
    const containers = createWorktreeContainers(makeRunner())
    const config = containers.resolveContainerConfig('/repo', '/repo/wt', {
      volumes: [{ source: '/repo/data', target: '/data' }]
    })
    const vol = config.volumes.find(v => v.target === '/data')
    expect(vol).toBeDefined()
    expect(vol!.source).toBe('/repo/data')
  })

  it('rejects user volumes with absolute source outside repoRoot', () => {
    const containers = createWorktreeContainers(makeRunner())
    expect(() => containers.resolveContainerConfig('/repo', '/repo/wt', {
      volumes: [{ source: '/tmp/evil', target: '/data' }]
    })).toThrow(/[Vv]olume source.*resolves outside repo root/)
  })

  it('allows /tmp/harness-status as built-in mount', () => {
    const containers = createWorktreeContainers(makeRunner())
    const config = containers.resolveContainerConfig('/repo', '/repo/wt')
    expect(config.volumes.some(v => v.source === '/tmp/harness-status')).toBe(true)
  })

  it('mounts existing local agent auth directories into default container env paths', () => {
    const home = mkdtempSync(join(tmpdir(), 'tatsu-agent-home-'))
    try {
      mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
      mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true })
      mkdirSync(join(home, '.cache', 'opencode'), { recursive: true })
      mkdirSync(join(home, '.claude'), { recursive: true })
      mkdirSync(join(home, '.codex'), { recursive: true })
      vi.stubEnv('HOME', home)
      const config = createWorktreeContainers(makeRunner()).resolveContainerConfig('/repo', '/repo/wt')
      expect(config.volumes).toEqual(expect.arrayContaining([
        { source: join(home, '.config', 'opencode'), target: '/workspace/.config/opencode', readOnly: true },
        { source: join(home, '.local', 'share', 'opencode'), target: '/workspace/.local/share/opencode', readOnly: false },
        { source: join(home, '.cache', 'opencode'), target: '/workspace/.cache/opencode', readOnly: false },
        { source: join(home, '.claude'), target: '/workspace/.home/.claude', readOnly: false },
        { source: join(home, '.codex'), target: '/workspace/.home/.codex', readOnly: false }
      ]))
    } finally {
      vi.unstubAllEnvs()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('mounts opencode config under both XDG_CONFIG_HOME and HOME paths in container', () => {
    const home = mkdtempSync(join(tmpdir(), 'tatsu-agent-home-dual-'))
    try {
      mkdirSync(join(home, '.config', 'opencode', 'agents'), { recursive: true })
      vi.stubEnv('HOME', home)
      const config = createWorktreeContainers(makeRunner()).resolveContainerConfig('/repo', '/repo/wt')
      expect(config.volumes).toEqual(expect.arrayContaining([
        { source: join(home, '.config', 'opencode'), target: '/workspace/.config/opencode', readOnly: true },
        { source: join(home, '.config', 'opencode'), target: '/workspace/.home/.config/opencode', readOnly: true }
      ]))
    } finally {
      vi.unstubAllEnvs()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('does not duplicate opencode config mount when XDG and HOME targets normalize identically', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tatsu-agent-home-nodup-'))
    try {
      mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
      vi.stubEnv('HOME', home)
      const runner = makeRunner()
      runner.run = vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'version') return { stdout: JSON.stringify({ Server: {} }), stderr: '', exitCode: 0 }
        if (args[0] === 'inspect') return { stdout: '[{}]', stderr: '', exitCode: 0 }
        if (args[0] === 'run') return { stdout: 'abc\n', stderr: '', exitCode: 0 }
        return { stdout: '', stderr: '', exitCode: 0 }
      })
      const containers = createWorktreeContainers(runner)
      const config = containers.resolveContainerConfig('/repo', '/repo/wt', {
        env: { HOME: '/workspace/.home', XDG_CONFIG_HOME: '/workspace/.home/.config' }
      })
      await containers.createForWorktree('/repo', '/repo/wt', config)
      const runArgs = ((runner.run as any).mock.calls.find((c: any) => c[0][0] === 'run'))[0]
      const opencodeBindCount = runArgs.filter((a: string) => a.includes('opencode') && a.includes('type=bind')).length
      expect(opencodeBindCount).toBe(1)
    } finally {
      vi.unstubAllEnvs()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('mounts host directories for opencode home file references under container HOME', () => {
    const home = mkdtempSync(join(tmpdir(), 'tatsu-agent-home-file-ref-'))
    try {
      const opencodeConfig = join(home, '.config', 'opencode')
      const envDir = join(home, 'dotfiles', 'opencode', '.config', 'opencode', 'envs')
      mkdirSync(opencodeConfig, { recursive: true })
      mkdirSync(envDir, { recursive: true })
      writeFileSync(join(envDir, 'neon'), 'DATABASE_URL=postgres://example')
      writeFileSync(join(opencodeConfig, 'opencode.json'), JSON.stringify({ env: ['{file:~/dotfiles/opencode/.config/opencode/envs/neon}'] }))
      vi.stubEnv('HOME', home)

      const config = createWorktreeContainers(makeRunner()).resolveContainerConfig('/repo', '/repo/wt')

      expect(config.volumes).toContainEqual({
        source: dirname(realpathSync(join(envDir, 'neon'))),
        target: '/workspace/.home/dotfiles/opencode/.config/opencode/envs',
        readOnly: true
      })
    } finally {
      vi.unstubAllEnvs()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('resolves symlinked opencode file references to real parent directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'tatsu-agent-home-symlink-'))
    try {
      const opencodeConfig = join(home, '.config', 'opencode')
      const envDir = join(home, 'dotfiles', 'opencode', '.config', 'opencode', 'envs')
      const secretsDir = join(home, 'secrets')
      mkdirSync(opencodeConfig, { recursive: true })
      mkdirSync(envDir, { recursive: true })
      mkdirSync(secretsDir, { recursive: true })
      writeFileSync(join(secretsDir, 'neon'), 'DATABASE_URL=postgres://example')
      symlinkSync(join(secretsDir, 'neon'), join(envDir, 'neon'))
      writeFileSync(join(opencodeConfig, 'opencode.json'), JSON.stringify({ env: ['{file:~/dotfiles/opencode/.config/opencode/envs/neon}'] }))
      vi.stubEnv('HOME', home)

      const config = createWorktreeContainers(makeRunner()).resolveContainerConfig('/repo', '/repo/wt')

      expect(config.volumes).toContainEqual({
        source: dirname(realpathSync(join(envDir, 'neon'))),
        target: '/workspace/.home/dotfiles/opencode/.config/opencode/envs',
        readOnly: true
      })
    } finally {
      vi.unstubAllEnvs()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('does not mount the same macOS Opencode directory with mixed read-write modes', () => {
    const home = mkdtempSync(join(tmpdir(), 'tatsu-agent-home-mac-'))
    try {
      const macOpencode = join(home, 'Library', 'Application Support', 'opencode')
      mkdirSync(macOpencode, { recursive: true })
      vi.stubEnv('HOME', home)
      const config = createWorktreeContainers(makeRunner()).resolveContainerConfig('/repo', '/repo/wt')
      const macMounts = config.volumes.filter((v) => v.source === macOpencode)
      expect(macMounts).toHaveLength(1)
      expect(macMounts[0]).toEqual({ source: macOpencode, target: '/workspace/.local/share/opencode', readOnly: false })
    } finally {
      vi.unstubAllEnvs()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('keeps automatic auth mount targets under workdir when repo env redirects XDG paths', () => {
    const home = mkdtempSync(join(tmpdir(), 'tatsu-agent-home-unsafe-env-'))
    try {
      mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
      vi.stubEnv('HOME', home)
      const config = createWorktreeContainers(makeRunner()).resolveContainerConfig('/repo', '/repo/wt', {
        env: { XDG_CONFIG_HOME: '/tmp/escape' }
      })
      expect(config.volumes).toContainEqual({ source: join(home, '.config', 'opencode'), target: '/workspace/.config/opencode', readOnly: true })
      expect(config.volumes.some((v) => v.target === '/tmp/escape/opencode')).toBe(false)
    } finally {
      vi.unstubAllEnvs()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('uses managed Tatsu image by default so opencode is present without repo Dockerfile', () => {
    const config = createWorktreeContainers(makeRunner()).resolveContainerConfig('/repo', '/repo/wt')
    expect(config.image).toMatch(/^tatsu-worktree:/)
    expect(config.managedDockerfile).toContain('npm install -g opencode-ai@latest')
  })

  it('rejects user volumes that target the worktree mount path', () => {
    const containers = createWorktreeContainers(makeRunner())
    expect(() => containers.resolveContainerConfig('/repo', '/repo/wt', {
      workdir: '/app',
      volumes: [{ source: '/tmp/cache', target: '/app' }]
    })).toThrow(/conflicts with worktree mount/)
  })
})

describe('createForWorktree docker run args', () => {
  it('includes labels, bind mounts, workdir, env, ports, security flags, and tmpfs', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'version') return { stdout: JSON.stringify({ Server: {} }), stderr: '', exitCode: 0 }
      if (args[0] === 'inspect') return { stdout: '[{}]', stderr: '', exitCode: 0 }
      if (args[0] === 'run') return { stdout: 'abc\n', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/repo', '/repo/wt', {
      image: 'node:20-alpine',
      env: { KEY: 'val' },
      ports: [3000]
    })
    await containers.createForWorktree('/repo', '/repo/wt', config)
    const runArgs = ((runner.run as any).mock.calls.find((c: any) => c[0][0] === 'run'))[0]
    expect(runArgs).toContain('-d')
    expect(runArgs).toContain('--cap-drop=ALL')
    expect(runArgs).toContain('--security-opt=no-new-privileges')
    expect(runArgs).toContain('--read-only')
    expect(runArgs).toContain('--label')
    expect(runArgs.some((a: string) => a.includes('tatsu.worktree.id'))).toBe(true)
    expect(runArgs.some((a: string) => a.includes('tatsu.worktree.path'))).toBe(true)
    expect(runArgs.some((a: string) => a.includes('tatsu.repo.root'))).toBe(true)
    expect(runArgs).toContain('--mount')
    expect(runArgs.some((a: string) => a.includes('type=bind,source=/repo/wt,target=/workspace'))).toBe(true)
    expect(runArgs).toContain('-e')
    expect(runArgs).toContain('KEY=val')
    expect(runArgs).toContain('TMPDIR=/tmp/.tatsu-native-tmp')
    expect(runArgs).toContain('BUN_TMPDIR=/tmp/.tatsu-native-tmp')
    expect(runArgs).toContain('-p')
    expect(runArgs).toContain('127.0.0.1:3000:3000')
    expect(runArgs).toContain('-w')
    expect(runArgs).toContain('/workspace')
    expect(runArgs).toContain('--tmpfs')
    expect(runArgs).toContain('/tmp:rw,noexec,nosuid,size=256m')
    expect(runArgs).toContain('/var/tmp:rw,noexec,nosuid,size=256m')
    expect(runArgs).toContain('/tmp/.tatsu-native-tmp:rw,exec,nosuid,nodev,size=256m,mode=1777')
  })


  it('includes default HOME and XDG env vars under workdir', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'version') return { stdout: JSON.stringify({ Server: {} }), stderr: '', exitCode: 0 }
      if (args[0] === 'inspect') return { stdout: '[{}]', stderr: '', exitCode: 0 }
      if (args[0] === 'run') return { stdout: 'abc\n', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/repo', '/repo/wt', { image: 'node:20-alpine' })
    await containers.createForWorktree('/repo', '/repo/wt', config)
    const runArgs = ((runner.run as any).mock.calls.find((c: any) => c[0][0] === 'run'))[0]
    expect(runArgs).toContain('HOME=/workspace/.home')
    expect(runArgs).toContain('XDG_CACHE_HOME=/workspace/.cache')
    expect(runArgs).toContain('XDG_CONFIG_HOME=/workspace/.config')
    expect(runArgs).toContain('XDG_DATA_HOME=/workspace/.local/share')
    expect(runArgs).toContain('TMPDIR=/tmp/.tatsu-native-tmp')
    expect(runArgs).toContain('BUN_TMPDIR=/tmp/.tatsu-native-tmp')
  })

  it('passes read-only mode only for read-only auth mounts', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tatsu-agent-home-run-'))
    try {
      mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
      vi.stubEnv('HOME', home)
      const runner = makeRunner()
      runner.run = vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'version') return { stdout: JSON.stringify({ Server: {} }), stderr: '', exitCode: 0 }
        if (args[0] === 'inspect') return { stdout: '[{}]', stderr: '', exitCode: 0 }
        if (args[0] === 'run') return { stdout: 'abc\n', stderr: '', exitCode: 0 }
        return { stdout: '', stderr: '', exitCode: 0 }
      })
      const containers = createWorktreeContainers(runner)
      const config = containers.resolveContainerConfig('/repo', '/repo/wt')
      await containers.createForWorktree('/repo', '/repo/wt', config)
      const runArgs = ((runner.run as any).mock.calls.find((c: any) => c[0][0] === 'run'))[0]
      expect(runArgs).toContain(`type=bind,source=${join(home, '.config', 'opencode')},target=/workspace/.config/opencode,readonly`)
      expect(runArgs).toContain('type=bind,source=/repo/wt,target=/workspace')
    } finally {
      vi.unstubAllEnvs()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('bind-mounts opencode config to both XDG and HOME paths in docker run args', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tatsu-agent-home-run-dual-'))
    try {
      mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
      vi.stubEnv('HOME', home)
      const runner = makeRunner()
      runner.run = vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'version') return { stdout: JSON.stringify({ Server: {} }), stderr: '', exitCode: 0 }
        if (args[0] === 'inspect') return { stdout: '[{}]', stderr: '', exitCode: 0 }
        if (args[0] === 'run') return { stdout: 'abc\n', stderr: '', exitCode: 0 }
        return { stdout: '', stderr: '', exitCode: 0 }
      })
      const containers = createWorktreeContainers(runner)
      const config = containers.resolveContainerConfig('/repo', '/repo/wt')
      await containers.createForWorktree('/repo', '/repo/wt', config)
      const runArgs = ((runner.run as any).mock.calls.find((c: any) => c[0][0] === 'run'))[0]
      expect(runArgs).toContain(`type=bind,source=${join(home, '.config', 'opencode')},target=/workspace/.config/opencode,readonly`)
      expect(runArgs).toContain(`type=bind,source=${join(home, '.config', 'opencode')},target=/workspace/.home/.config/opencode,readonly`)
    } finally {
      vi.unstubAllEnvs()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('user env overrides default HOME and XDG vars', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'version') return { stdout: JSON.stringify({ Server: {} }), stderr: '', exitCode: 0 }
      if (args[0] === 'inspect') return { stdout: '[{}]', stderr: '', exitCode: 0 }
      if (args[0] === 'run') return { stdout: 'abc\n', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/repo', '/repo/wt', {
      image: 'node:20-alpine',
      env: { HOME: '/custom/home', XDG_CACHE_HOME: '/custom/cache' }
    })
    await containers.createForWorktree('/repo', '/repo/wt', config)
    const runArgs = ((runner.run as any).mock.calls.find((c: any) => c[0][0] === 'run'))[0]
    expect(runArgs).toContain('HOME=/custom/home')
    expect(runArgs).toContain('XDG_CACHE_HOME=/custom/cache')
    expect(runArgs).not.toContain('HOME=/workspace/.home')
    expect(runArgs).not.toContain('XDG_CACHE_HOME=/workspace/.cache')
    // non-overridden defaults still present
    expect(runArgs).toContain('XDG_CONFIG_HOME=/workspace/.config')
    expect(runArgs).toContain('XDG_DATA_HOME=/workspace/.local/share')
    expect(runArgs).toContain('TMPDIR=/tmp/.tatsu-native-tmp')
    expect(runArgs).toContain('BUN_TMPDIR=/tmp/.tatsu-native-tmp')
  })

  it('default env vars respect custom workdir', async () => {
    const runner = makeRunner()
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/repo', '/repo/wt', { workdir: '/app' })
    expect(config.env.HOME).toBe('/app/.home')
    expect(config.env.XDG_CACHE_HOME).toBe('/app/.cache')
    expect(config.env.XDG_CONFIG_HOME).toBe('/app/.config')
    expect(config.env.XDG_DATA_HOME).toBe('/app/.local/share')
  })

  it('tmpfs mounts for noexec temp paths and executable native temp path are always present', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'version') return { stdout: JSON.stringify({ Server: {} }), stderr: '', exitCode: 0 }
      if (args[0] === 'inspect') return { stdout: '[{}]', stderr: '', exitCode: 0 }
      if (args[0] === 'run') return { stdout: 'abc\n', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/repo', '/repo/wt')
    await containers.createForWorktree('/repo', '/repo/wt', config)
    const runArgs = ((runner.run as any).mock.calls.find((c: any) => c[0][0] === 'run'))[0]
    const tmpfsIdx = runArgs.indexOf('--tmpfs')
    expect(tmpfsIdx).toBeGreaterThan(-1)
    expect(runArgs[tmpfsIdx + 1]).toBe('/tmp:rw,noexec,nosuid,size=256m')
    expect(runArgs[tmpfsIdx + 2]).toBe('--tmpfs')
    expect(runArgs[tmpfsIdx + 3]).toBe('/var/tmp:rw,noexec,nosuid,size=256m')
    expect(runArgs[tmpfsIdx + 4]).toBe('--tmpfs')
    expect(runArgs[tmpfsIdx + 5]).toBe('/tmp/.tatsu-native-tmp:rw,exec,nosuid,nodev,size=256m,mode=1777')
  })

  it('uses colon-safe bind mount args and shell-independent keepalive', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'version') return { stdout: JSON.stringify({ Server: {} }), stderr: '', exitCode: 0 }
      if (args[0] === 'inspect') return { stdout: '[{}]', stderr: '', exitCode: 0 }
      if (args[0] === 'run') return { stdout: 'abc\n', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/repo', '/repo/wt:feature', {
      image: 'node:20-alpine',
      shell: '/bin/bash'
    })
    await containers.createForWorktree('/repo', '/repo/wt:feature', config)
    const runArgs = ((runner.run as any).mock.calls.find((c: any) => c[0][0] === 'run'))[0]
    expect(runArgs).toContain('type=bind,source=/repo/wt:feature,target=/workspace')
    expect(runArgs.slice(-4)).toEqual(['node:20-alpine', 'tail', '-f', '/dev/null'])
  })

  it('escapes commas in bind mount paths', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'version') return { stdout: JSON.stringify({ Server: {} }), stderr: '', exitCode: 0 }
      if (args[0] === 'inspect') return { stdout: '[{}]', stderr: '', exitCode: 0 }
      if (args[0] === 'run') return { stdout: 'abc\n', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/repo', '/repo/wt,feature')
    await containers.createForWorktree('/repo', '/repo/wt,feature', config)
    const runArgs = ((runner.run as any).mock.calls.find((c: any) => c[0][0] === 'run'))[0]
    expect(runArgs).toContain('type=bind,source=/repo/wt\\,feature,target=/workspace')
  })

  it('escapes backslashes before commas in bind mount paths', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'version') return { stdout: JSON.stringify({ Server: {} }), stderr: '', exitCode: 0 }
      if (args[0] === 'inspect') return { stdout: '[{}]', stderr: '', exitCode: 0 }
      if (args[0] === 'run') return { stdout: 'abc\n', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/repo', '/repo/wt\\,feature')
    await containers.createForWorktree('/repo', '/repo/wt\\,feature', config)
    const runArgs = ((runner.run as any).mock.calls.find((c: any) => c[0][0] === 'run'))[0]
    expect(runArgs).toContain(String.raw`type=bind,source=/repo/wt\\\,feature,target=/workspace`)
  })

  it('escapes equals signs in bind mount paths', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'version') return { stdout: JSON.stringify({ Server: {} }), stderr: '', exitCode: 0 }
      if (args[0] === 'inspect') return { stdout: '[{}]', stderr: '', exitCode: 0 }
      if (args[0] === 'run') return { stdout: 'abc\n', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/repo', '/repo/wt=feature')
    await containers.createForWorktree('/repo', '/repo/wt=feature', config)
    const runArgs = ((runner.run as any).mock.calls.find((c: any) => c[0][0] === 'run'))[0]
    expect(runArgs).toContain('type=bind,source=/repo/wt\\=feature,target=/workspace')
  })

  it('sanitizes container name from worktree path', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'version') return { stdout: JSON.stringify({ Server: {} }), stderr: '', exitCode: 0 }
      if (args[0] === 'inspect') return { stdout: '[{}]', stderr: '', exitCode: 0 }
      if (args[0] === 'run') return { stdout: 'abc\n', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/repo', '/repo/my-branch')
    await containers.createForWorktree('/repo', '/repo/my-branch', config)
    const runArgs = ((runner.run as any).mock.calls.find((c: any) => c[0][0] === 'run'))[0]
    const nameIdx = runArgs.indexOf('--name')
    expect(nameIdx).toBeGreaterThan(-1)
    expect(runArgs[nameIdx + 1]).toMatch(/^tatsu-wt-/)
    expect(runArgs[nameIdx + 1]).toMatch(/^[a-z0-9-]+$/)
  })

  it('removes an existing deterministic container before run', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'version') return { stdout: JSON.stringify({ Server: {} }), stderr: '', exitCode: 0 }
      if (args[0] === 'inspect') return { stdout: '[{}]', stderr: '', exitCode: 0 }
      if (args[0] === 'ps') return { stdout: 'old123\n', stderr: '', exitCode: 0 }
      if (args[0] === 'rm') return { stdout: '', stderr: '', exitCode: 0 }
      if (args[0] === 'run') return { stdout: 'new123\n', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/repo', '/repo/my-branch')
    const created = await containers.createForWorktree('/repo', '/repo/my-branch', config)
    const rmCall = (runner.run as any).mock.calls.find((c: any) => c[0][0] === 'rm' && c[0][1] === '-f' && c[0][2] === 'old123')
    const runCallIndex = (runner.run as any).mock.calls.findIndex((c: any) => c[0][0] === 'run')
    const rmCallIndex = (runner.run as any).mock.calls.findIndex((c: any) => c[0][0] === 'rm')
    expect(rmCall).toBeDefined()
    expect(rmCallIndex).toBeLessThan(runCallIndex)
    expect(created.id).toBe('new123')
  })
})

describe('createForWorktree', () => {
  it('checks docker available before ensureImage', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'version') return { stdout: JSON.stringify({ Server: {} }), stderr: '', exitCode: 0 }
      if (args[0] === 'inspect') return { stdout: '[{}]', stderr: '', exitCode: 0 }
      if (args[0] === 'run') return { stdout: 'abc\n', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/r', '/r/wt', { image: 'node:20-alpine' })
    await containers.createForWorktree('/r', '/r/wt', config)
    const calls = (runner.run as any).mock.calls.map((c: any) => c[0][0])
    expect(calls.indexOf('version')).toBeLessThan(calls.indexOf('inspect'))
  })

  it('limits container name to 63 chars', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'version') return { stdout: JSON.stringify({ Server: {} }), stderr: '', exitCode: 0 }
      if (args[0] === 'inspect') return { stdout: '[{}]', stderr: '', exitCode: 0 }
      if (args[0] === 'run') return { stdout: 'abc\n', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const longPath = '/repo/' + 'a'.repeat(100)
    const config = containers.resolveContainerConfig('/repo', longPath)
    await containers.createForWorktree('/repo', longPath, config)
    const runArgs = ((runner.run as any).mock.calls.find((c: any) => c[0][0] === 'run'))[0]
    expect(runArgs[runArgs.indexOf('--name') + 1].length).toBeLessThanOrEqual(63)
  })

  it('accepts worktree path with newline (encoded in label)', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'version') return { stdout: JSON.stringify({ Server: {} }), stderr: '', exitCode: 0 }
      if (args[0] === 'inspect') return { stdout: '[{}]', stderr: '', exitCode: 0 }
      if (args[0] === 'run') return { stdout: 'abc\n', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/r', '/r/wt')
    await expect(containers.createForWorktree('/r', '/r/wt\n', config)).resolves.toBeDefined()
  })

  it('accepts worktree path with space (encoded in label)', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'version') return { stdout: JSON.stringify({ Server: {} }), stderr: '', exitCode: 0 }
      if (args[0] === 'inspect') return { stdout: '[{}]', stderr: '', exitCode: 0 }
      if (args[0] === 'run') return { stdout: 'abc\n', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/r', '/r/my worktree')
    const created = await containers.createForWorktree('/r', '/r/my worktree', config)
    expect(created).toBeDefined()
    const runArgs = ((runner.run as any).mock.calls.find((c: any) => c[0][0] === 'run'))[0]
    const pathLabel = runArgs.find((a: string) => a.startsWith('tatsu.worktree.path='))
    expect(pathLabel).toBeDefined()
    expect(pathLabel).toMatch(/^tatsu\.worktree\.path=b64:/)
    expect(pathLabel).not.toContain(' ')
  })

  it('accepts worktree path with double quote (encoded in label)', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'version') return { stdout: JSON.stringify({ Server: {} }), stderr: '', exitCode: 0 }
      if (args[0] === 'inspect') return { stdout: '[{}]', stderr: '', exitCode: 0 }
      if (args[0] === 'run') return { stdout: 'abc\n', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/r', '/r/wt"bad')
    const created = await containers.createForWorktree('/r', '/r/wt"bad', config)
    expect(created).toBeDefined()
    const runArgs = ((runner.run as any).mock.calls.find((c: any) => c[0][0] === 'run'))[0]
    const pathLabel = runArgs.find((a: string) => a.startsWith('tatsu.worktree.path='))
    expect(pathLabel).toMatch(/^tatsu\.worktree\.path=b64:/)
    expect(pathLabel).not.toContain('"')
  })

  it('accepts worktree path with single quote (encoded in label)', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'version') return { stdout: JSON.stringify({ Server: {} }), stderr: '', exitCode: 0 }
      if (args[0] === 'inspect') return { stdout: '[{}]', stderr: '', exitCode: 0 }
      if (args[0] === 'run') return { stdout: 'abc\n', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/r', "/r/wt'bad")
    const created = await containers.createForWorktree('/r', "/r/wt'bad", config)
    expect(created).toBeDefined()
    const runArgs = ((runner.run as any).mock.calls.find((c: any) => c[0][0] === 'run'))[0]
    const pathLabel = runArgs.find((a: string) => a.startsWith('tatsu.worktree.path='))
    expect(pathLabel).toMatch(/^tatsu\.worktree\.path=b64:/)
    expect(pathLabel).not.toContain("'")
  })

  it('accepts normal absolute paths in labels and encodes them', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'version') return { stdout: JSON.stringify({ Server: {} }), stderr: '', exitCode: 0 }
      if (args[0] === 'inspect') return { stdout: '[{}]', stderr: '', exitCode: 0 }
      if (args[0] === 'run') return { stdout: 'abc\n', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/repo', '/repo/wt-feature')
    await expect(containers.createForWorktree('/repo', '/repo/wt-feature', config)).resolves.toBeDefined()
    const runArgs = ((runner.run as any).mock.calls.find((c: any) => c[0][0] === 'run'))[0]
    const pathLabel = runArgs.find((a: string) => a.startsWith('tatsu.worktree.path='))
    expect(pathLabel).toMatch(/^tatsu\.worktree\.path=b64:/)
  })

  it('rejects labels over 4096 bytes', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'version') return { stdout: JSON.stringify({ Server: {} }), stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/r', '/r/wt')
    await expect(containers.createForWorktree('/r', `/r/${'é'.repeat(2100)}`, config)).rejects.toThrow(/4096 byte limit/)
  })

  it('base64url-encoded path labels contain only base64url-safe characters', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'version') return { stdout: JSON.stringify({ Server: {} }), stderr: '', exitCode: 0 }
      if (args[0] === 'inspect') return { stdout: '[{}]', stderr: '', exitCode: 0 }
      if (args[0] === 'run') return { stdout: 'abc\n', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/repo', '/repo/wt-feature')
    await containers.createForWorktree('/repo', '/repo/wt-feature', config)
    const runArgs = ((runner.run as any).mock.calls.find((c: any) => c[0][0] === 'run'))[0]
    const pathLabel = runArgs.find((a: string) => a.startsWith('tatsu.worktree.path='))
    const rootLabel = runArgs.find((a: string) => a.startsWith('tatsu.repo.root='))
    expect(pathLabel).toBeDefined()
    expect(rootLabel).toBeDefined()
    const pathValue = pathLabel.split('=', 2)[1]
    const rootValue = rootLabel.split('=', 2)[1]
    expect(pathValue).toMatch(/^b64:[A-Za-z0-9_-]+$/)
    expect(rootValue).toMatch(/^b64:[A-Za-z0-9_-]+$/)
    expect(pathValue).not.toMatch(/[.]/)
    expect(pathValue).not.toMatch(/[@]/)
    expect(pathValue).not.toMatch(/[^A-Za-z0-9_:/-]/)
  })

  it('base64url encoding round-trips path correctly', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'version') return { stdout: JSON.stringify({ Server: {} }), stderr: '', exitCode: 0 }
      if (args[0] === 'inspect') return { stdout: '[{}]', stderr: '', exitCode: 0 }
      if (args[0] === 'run') return { stdout: 'abc\n', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/repo', '/repo/wt')
    await containers.createForWorktree('/repo', '/repo/wt', config)
    const runArgs = ((runner.run as any).mock.calls.find((c: any) => c[0][0] === 'run'))[0]
    const pathLabel = runArgs.find((a: string) => a.startsWith('tatsu.worktree.path='))
    const encoded = pathLabel.split('=', 2)[1]
    const prefix = 'b64:'
    expect(encoded.startsWith(prefix)).toBe(true)
    const decoded = Buffer.from(encoded.slice(prefix.length), 'base64url').toString('utf8')
    expect(decoded).toBe('/repo/wt')
  })
})

describe('stopContainer', () => {
  it('runs docker stop then docker rm -f', async () => {
    const runner = makeRunner()
    const containers = createWorktreeContainers(runner)
    await containers.stopContainer('abc123')
    const stopCall = runner.calls.find((c) => c.args[0] === 'stop' && c.args[1] === 'abc123')
    const rmCall = runner.calls.find((c) => c.args[0] === 'rm' && c.args[1] === '-f' && c.args[2] === 'abc123')
    expect(stopCall).toBeDefined()
    expect(rmCall).toBeDefined()
  })

  it('continues to docker rm -f when docker stop fails', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'stop') return { stdout: '', stderr: 'stop failed', exitCode: 1 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    await containers.stopContainer('abc123')
    expect(runner.run).toHaveBeenCalledWith(['rm', '-f', 'abc123'], { timeoutMs: 30000 })
  })


  it('continues to docker rm -f when docker stop rejects', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'stop') throw new Error('daemon dropped')
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    await containers.stopContainer('abc123')
    expect(runner.run).toHaveBeenCalledWith(['rm', '-f', 'abc123'], { timeoutMs: 30000 })
  })

  it('treats already-removed containers as stopped', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'rm') return { stdout: '', stderr: 'Error response from daemon: No such container: abc123', exitCode: 1 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    await expect(containers.stopContainer('abc123')).resolves.toBeUndefined()
  })
  it('propagates rm errors', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'rm') return { stdout: '', stderr: 'rm failed', exitCode: 1 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    await expect(containers.stopContainer('abc123')).rejects.toThrow(/Failed to remove container/)
  })
})

describe('sanitizeContainerName edge cases', () => {
  it('falls back to wt for non-alphanumeric basenames', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'version') return { stdout: JSON.stringify({ Server: {} }), stderr: '', exitCode: 0 }
      if (args[0] === 'inspect') return { stdout: '[{}]', stderr: '', exitCode: 0 }
      if (args[0] === 'run') return { stdout: 'abc\n', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/repo', '/repo/!!!')
    await containers.createForWorktree('/repo', '/repo/!!!', config)
    const runArgs = ((runner.run as any).mock.calls.find((c: any) => c[0][0] === 'run'))[0]
    const nameIdx = runArgs.indexOf('--name')
    expect(runArgs[nameIdx + 1]).toMatch(/^tatsu-wt-wt-/)
  })
})

describe('isContainerRunning', () => {
  it('returns true only when Docker reports the container is running', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'inspect' && args.at(-1) === 'running') return { stdout: 'true\n', stderr: '', exitCode: 0 }
      if (args[0] === 'inspect' && args.at(-1) === 'stopped') return { stdout: 'false\n', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: 'No such container', exitCode: 1 }
    })
    const containers = createWorktreeContainers(runner)

    await expect(containers.isContainerRunning('running')).resolves.toBe(true)
    await expect(containers.isContainerRunning('stopped')).resolves.toBe(false)
    await expect(containers.isContainerRunning('missing')).resolves.toBe(false)
  })
})

describe('checkDockerAvailable caching', () => {
  it('caches daemon-unavailable result on nonzero exit', async () => {
    const runner = makeRunner()
    let versionCallCount = 0
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'version') {
        versionCallCount++
        return { stdout: '', stderr: 'daemon down', exitCode: 1 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const r1 = await containers.checkDockerAvailable()
    const r2 = await containers.checkDockerAvailable()
    expect(r1.ok).toBe(false)
    expect(r2.ok).toBe(false)
    expect(versionCallCount).toBe(1)
  })
})

// ─── Finding 1: defaultDockerRunner real spawn coverage ────────────

let spawnTmpDir: string
let origPath: string | undefined

beforeAll(() => {
  spawnTmpDir = mkdtempSync(join(tmpdir(), 'tatsu-spawn-test-'))
  origPath = process.env.PATH
})

afterEach(() => {
  // Restore PATH after each test
  if (origPath !== undefined) process.env.PATH = origPath
})

afterAll(() => {
  try { rmSync(spawnTmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

function writeFakeDocker(dir: string, script: string): string {
  const scriptPath = join(dir, 'docker')
  writeFileSync(scriptPath, script)
  chmodSync(scriptPath, 0o755)
  return scriptPath
}

describe('defaultDockerRunner real spawn', () => {
  it('captures stdout, stderr, and exitCode from real process', async () => {
    writeFakeDocker(spawnTmpDir, '#!/bin/sh\necho "hello out"; echo "hello err" >&2; exit 0')
    const runner = defaultDockerRunner()
    const result = await runner.run(['version'], { env: { PATH: spawnTmpDir } })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hello out')
    expect(result.stderr).toContain('hello err')
  })

  it('calls onOutput with stdout and stderr chunks', async () => {
    writeFakeDocker(spawnTmpDir, '#!/bin/sh\necho "chunk1"; echo "chunk2" >&2; exit 0')
    const runner = defaultDockerRunner()
    const chunks: string[] = []
    await runner.run(['info'], { env: { PATH: spawnTmpDir }, onOutput: (c) => chunks.push(c) })
    expect(chunks.join('')).toContain('chunk1')
    expect(chunks.join('')).toContain('chunk2')
  })

  it('returns non-zero exitCode on process failure', async () => {
    writeFakeDocker(spawnTmpDir, '#!/bin/sh\nexit 2')
    const runner = defaultDockerRunner()
    const result = await runner.run(['bad'], { env: { PATH: spawnTmpDir } })
    expect(result.exitCode).toBe(2)
  })

  it('rejects with ENOENT when docker binary not found', async () => {
    // Use a dir that has NO docker script
    const emptyDir = mkdtempSync(join(tmpdir(), 'tatsu-no-docker-'))
    try {
      const runner = defaultDockerRunner()
      await expect(
        runner.run(['version'], { env: { PATH: emptyDir } })
      ).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  it('rejects with timeout error and kills child via SIGKILL', async () => {
    writeFakeDocker(spawnTmpDir, '#!/bin/sh\nwhile true; do :; done')
    const runner = defaultDockerRunner()
    await expect(
      runner.run(['sleep'], { env: { PATH: spawnTmpDir }, timeoutMs: 100 })
    ).rejects.toThrow(/timed out after 100ms/)
  })

  it('caps output at 1 MiB', async () => {
    // Script that writes more than 1 MiB
    const bigScript = '#!/bin/sh\n' + 'echo ' + '"A'.repeat(256) + '"' + '\n' + 'repeat=true\n' + 'while $repeat; do\n' + '  echo "' + 'B'.repeat(4096) + '"\n' + 'done\nexit 0\n'
    // Simpler approach: dd or printf
    writeFakeDocker(spawnTmpDir, '#!/bin/sh\npython3 -c "print(\'X\' * (2 * 1024 * 1024))" 2>/dev/null || dd if=/dev/zero bs=1048576 count=2 2>/dev/null | tr "\\0" "X"; exit 0')
    const runner = defaultDockerRunner()
    const result = await runner.run(['big'], { env: { PATH: spawnTmpDir } })
    // Output should be capped at ~1 MiB (1024*1024 = 1048576 bytes)
    expect(result.stdout.length).toBeLessThanOrEqual(1024 * 1024 + 100) // small margin for the truncation boundary
  })

  it('passes cwd option to spawn', async () => {
    const cwdDir = mkdtempSync(join(tmpdir(), 'tatsu-cwd-'))
    try {
      writeFakeDocker(spawnTmpDir, '#!/bin/sh\npwd')
      const runner = defaultDockerRunner()
      const result = await runner.run(['version'], { env: { PATH: spawnTmpDir }, cwd: cwdDir })
      // macOS resolves /var to /private/var via symlink
      const resolved = require('fs').realpathSync(cwdDir)
      expect(result.stdout.trim()).toBe(resolved)
    } finally {
      rmSync(cwdDir, { recursive: true, force: true })
    }
  })
})

// ─── Finding 5: sanitizeStderr hardening ───────────────────────────

describe('sanitizeStderr', () => {
  it('redacts sensitive env values with spaces (not leaking trailing words)', () => {
    const input = 'Error: TOKEN=abc123 def GPG_KEY=xyz'
    const result = sanitizeStderr(input)
    expect(result).toContain('TOKEN=[redacted]')
    expect(result).not.toContain('abc123')
    expect(result).not.toContain(' def')
  })

  it('redacts multiple sensitive assignments on the same line', () => {
    const input = 'TOKEN=secret123 API_KEY=sk-realkey123'
    const result = sanitizeStderr(input)
    expect(result).toContain('TOKEN=[redacted]')
    expect(result).toContain('API_KEY=[redacted]')
    expect(result).not.toContain('secret123')
    expect(result).not.toContain('sk-realkey123')
  })

  it('preserves non-sensitive env assignments', () => {
    const input = 'NODE_ENV=development TOKEN=secret123'
    const result = sanitizeStderr(input)
    expect(result).toContain('NODE_ENV=development')
    expect(result).toContain('TOKEN=[redacted]')
  })

  it('redacts github_pat_ fine-grained PAT tokens', () => {
    const input = 'auth failed github_pat_11ABCD0E_abcdefghijklmnopqrstuvwxyz1234567890AB'
    const result = sanitizeStderr(input)
    expect(result).toContain('[redacted]')
    expect(result).not.toContain('github_pat_11ABCD0E')
  })

  it('redacts multiline/private-key-like content if env assignment', () => {
    const input = 'PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\nMIIEpA=\nEND'
    const result = sanitizeStderr(input)
    // PRIVATE_KEY is a sensitive key pattern; the first-line value should be redacted
    expect(result).toContain('PRIVATE_KEY=[redacted]')
    expect(result).not.toContain('-----BEGIN RSA PRIVATE KEY-----')
    // Continuation lines must also be redacted — PEM body and footer must not leak
    expect(result).not.toContain('MIIEpA=')
    expect(result).not.toMatch(/\bEND\b/)
  })

  it('redacts multiline PEM with -----END footer', () => {
    const input = 'PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n0aV+Z2Y=\n-----END RSA PRIVATE KEY-----'
    const result = sanitizeStderr(input)
    expect(result).toContain('PRIVATE_KEY=[redacted]')
    expect(result).not.toContain('MIIEpAIBAAKCAQEA')
    expect(result).not.toContain('0aV+Z2Y=')
    expect(result).not.toContain('-----END RSA PRIVATE KEY-----')
  })

  it('stops redaction at next line-start env assignment', () => {
    const input = 'PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\nMIIEpA=\nOTHER=value'
    const result = sanitizeStderr(input)
    expect(result).toContain('PRIVATE_KEY=[redacted]')
    expect(result).not.toContain('MIIEpA=')
    expect(result).toContain('OTHER=value')
  })

  it('truncates output at 500 chars', () => {
    const longInput = 'x'.repeat(600)
    const result = sanitizeStderr(longInput)
    expect(result.length).toBeLessThan(600)
    expect(result).toContain('...(truncated)')
  })

  it('redacts tokens that span the 500-char boundary before truncating', () => {
    // ghp_ token starts near the 500-char boundary; the token itself is 40 chars.
    // Use a prefix ending with a non-word char so \b boundary matches.
    const prefix = ' '.repeat(490)
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890'
    const input = prefix + token + ' more stuff after'
    const result = sanitizeStderr(input)
    // Must not leak any part of the token
    expect(result).not.toMatch(/ghp_/)
    expect(result).toContain('[redacted]')
    // Output should still be truncated
    expect(result).toContain('...(truncated)')
  })
})

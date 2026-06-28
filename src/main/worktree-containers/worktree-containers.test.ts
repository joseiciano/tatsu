import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DockerRunner } from './types'
import type { RepoContainerConfig } from '../../shared/state/repo-configs'
import { createWorktreeContainers } from './worktree-containers'

function makeRunner(): DockerRunner & { calls: Array<{ args: string[]; opts?: Record<string, unknown> }> } {
  const calls: Array<{ args: string[]; opts?: Record<string, unknown> }> = []
  return { calls, async run(args, opts) { calls.push({ args, opts: opts as any }); return { stdout: '', stderr: '', exitCode: 0 } } }
}

describe('checkDockerAvailable', () => {
  it('returns ok when Server present', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ Server: { Version: '24.0.0' } }), stderr: '', exitCode: 0 })
    const containers = createWorktreeContainers(runner)
    const result = await containers.checkDockerAvailable()
    expect(result.ok).toBe(true)
  })

  it('returns daemon-unavailable when Server missing', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ Client: { Version: '24.0.0' } }), stderr: '', exitCode: 0 })
    const result = await createWorktreeContainers(runner).checkDockerAvailable()
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Server section missing/)
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

describe('resolveContainerConfig', () => {
  it('rejects user volumes that target the worktree mount path', () => {
    const containers = createWorktreeContainers(makeRunner())
    expect(() => containers.resolveContainerConfig('/repo', '/repo/wt', {
      workdir: '/app',
      volumes: [{ source: '/tmp/cache', target: '/app' }]
    })).toThrow(/conflicts with worktree mount/)
  })
})

describe('createForWorktree docker run args', () => {
  it('includes labels, bind mounts, workdir, env, ports', async () => {
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
    expect(runArgs).toContain('--label')
    expect(runArgs.some((a: string) => a.includes('tatsu.worktree.id'))).toBe(true)
    expect(runArgs.some((a: string) => a.includes('tatsu.worktree.path'))).toBe(true)
    expect(runArgs.some((a: string) => a.includes('tatsu.repo.root'))).toBe(true)
    expect(runArgs).toContain('--mount')
    expect(runArgs.some((a: string) => a.includes('type=bind,source=/repo/wt,target=/workspace'))).toBe(true)
    expect(runArgs).toContain('-e')
    expect(runArgs).toContain('KEY=val')
    expect(runArgs).toContain('-p')
    expect(runArgs).toContain('127.0.0.1:3000:3000')
    expect(runArgs).toContain('-w')
    expect(runArgs).toContain('/workspace')
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
    const config = containers.resolveContainerConfig('/repo', '/repo/My Branch!')
    await containers.createForWorktree('/repo', '/repo/My Branch!', config)
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
    const config = containers.resolveContainerConfig('/repo', '/repo/My Branch!')
    const created = await containers.createForWorktree('/repo', '/repo/My Branch!', config)
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

  it('throws on invalid label with newline', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'version') return { stdout: JSON.stringify({ Server: {} }), stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    const config = containers.resolveContainerConfig('/r', '/r/wt')
    await expect(containers.createForWorktree('/r', '/r/wt\n', config)).rejects.toThrow(/invalid character/)
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

    await expect(containers.isContainerRunning!('running')).resolves.toBe(true)
    await expect(containers.isContainerRunning!('stopped')).resolves.toBe(false)
    await expect(containers.isContainerRunning!('missing')).resolves.toBe(false)
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

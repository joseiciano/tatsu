import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'crypto'
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

  it('CLI not found error on ENOENT', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockRejectedValue(Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }))
    const result = await createWorktreeContainers(runner).checkDockerAvailable()
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/CLI not found/)
  })
})

describe('execInContainer', () => {
  it('default shell is /bin/sh -lc', async () => {
    const runner = makeRunner()
    await createWorktreeContainers(runner).execInContainer('c1', 'pnpm install', { workdir: '/app' })
    const call = runner.calls.find((c) => c.args[0] === 'exec')
    expect(call!.args).toContain('/bin/sh')
    expect(call!.args).toContain('-lc')
    expect(call!.args).toContain('pnpm install')
  })

  it('uses custom shell when provided', async () => {
    const runner = makeRunner()
    await createWorktreeContainers(runner).execInContainer('c1', 'pnpm install', { shell: '/bin/bash' })
    const call = runner.calls.find((c) => c.args[0] === 'exec')
    expect(call!.args).toContain('/bin/bash')
    expect(call!.args).toContain('-lc')
  })

  it('throws on invalid env key', async () => {
    const runner = makeRunner()
    await expect(
      createWorktreeContainers(runner).execInContainer('c1', 'cmd', { env: { 'BAD KEY': 'v' } })
    ).rejects.toThrow(/Invalid env key/)
  })
})

describe('ensureImage', () => {
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
      if (args[0] === 'inspect') return { stdout: '[{}]', stderr: '', exitCode: 0 }
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
  })
})

describe('createForWorktree docker run args', () => {
  it('includes labels, mount, workdir, env, ports', async () => {
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
    expect(runArgs).toContain('-v')
    expect(runArgs.some((a: string) => a.includes('/repo/wt:/workspace'))).toBe(true)
    expect(runArgs).toContain('-e')
    expect(runArgs).toContain('KEY=val')
    expect(runArgs).toContain('-p')
    expect(runArgs).toContain('127.0.0.1:3000:3000')
    expect(runArgs).toContain('-w')
    expect(runArgs).toContain('/workspace')
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

  it('swallows errors from stop and rm', async () => {
    const runner = makeRunner()
    runner.run = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'stop') throw new Error('stop failed')
      if (args[0] === 'rm') throw new Error('rm failed')
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const containers = createWorktreeContainers(runner)
    await expect(containers.stopContainer('abc123')).resolves.toBeUndefined()
  })
})
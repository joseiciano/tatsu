import { describe, it, expect, vi } from 'vitest'
import {
  PLATFORM_PACKAGES,
  runtimeClosureForPlatform,
  resolvePackageDir,
  runtimeExecutables,
  validateStagedRuntimeClosure
} from './runtime-closure.mjs'

describe('PLATFORM_PACKAGES', () => {
  it('covers all four shipped platforms', () => {
    expect(Object.keys(PLATFORM_PACKAGES)).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-x64',
      'linux-arm64'
    ])
  })
})

describe('runtimeClosureForPlatform', () => {
  it('returns the correct packages for darwin-arm64', () => {
    const closure = runtimeClosureForPlatform('darwin-arm64')
    expect(closure.packages).toContain('node-pty')
    expect(closure.packages).toContain('ws')
    expect(closure.packages).toContain('@anthropic-ai/claude-agent-sdk')
    expect(closure.packages).toContain('@anthropic-ai/claude-agent-sdk-darwin-arm64')
    expect(closure.packages).toContain('opencode-ai')
    expect(closure.packages).toContain('opencode-darwin-arm64')
    expect(closure.packages).toContain('@agentclientprotocol/codex-acp')
    expect(closure.packages).toContain('@openai/codex')
    expect(closure.packages).toContain('@openai/codex-darwin-arm64')
  })

  it('stages codex-acp runtime deps so codex ACP resolves at run time', () => {
    const closure = runtimeClosureForPlatform('darwin-arm64')
    for (const dep of [
      '@agentclientprotocol/sdk',
      'diff',
      'open',
      'vscode-jsonrpc',
      'zod'
    ]) {
      expect(closure.packages).toContain(dep)
    }
  })

  it('stages the opencode platform package for each target', () => {
    expect(runtimeClosureForPlatform('darwin-arm64').packages).toContain(
      'opencode-darwin-arm64'
    )
    expect(runtimeClosureForPlatform('linux-x64').packages).toContain(
      'opencode-linux-x64'
    )
    expect(runtimeClosureForPlatform('linux-arm64').packages).toContain(
      'opencode-linux-arm64'
    )
  })

  it('returns the correct packages for linux-x64', () => {
    const closure = runtimeClosureForPlatform('linux-x64')
    expect(closure.packages).toContain('@openai/codex-linux-x64')
    expect(closure.packages).toContain('@anthropic-ai/claude-agent-sdk-linux-x64')
  })

  it('returns the correct packages for linux-arm64', () => {
    const closure = runtimeClosureForPlatform('linux-arm64')
    expect(closure.packages).toContain('@openai/codex-linux-arm64')
    expect(closure.packages).toContain('@anthropic-ai/claude-agent-sdk-linux-arm64')
  })

  it('throws for an unsupported platform', () => {
    expect(() => runtimeClosureForPlatform('win32-x64')).toThrow(
      /Unsupported platform/
    )
  })

  it('resolves the Intel mac packages for darwin-x64', () => {
    const closure = runtimeClosureForPlatform('darwin-x64', { target: 'desktop' })
    expect(closure.codexTriple).toBe('x86_64-apple-darwin')
    expect(closure.packages).toContain('opencode-darwin-x64')
    expect(closure.packages).toContain('@openai/codex-darwin-x64')
    expect(closure.packages).toContain('@anthropic-ai/claude-agent-sdk-darwin-x64')
    expect(closure.packages).not.toContain('opencode-darwin-arm64')
  })

  it('omits app.asar-provided packages and the opencode-ai launcher for desktop', () => {
    const desktop = runtimeClosureForPlatform('darwin-arm64', { target: 'desktop' }).packages
    for (const pkg of ['node-pty', 'ws', '@anthropic-ai/claude-agent-sdk', 'opencode-ai']) {
      expect(desktop).not.toContain(pkg)
    }
    for (const pkg of [
      '@anthropic-ai/claude-agent-sdk-darwin-arm64',
      'opencode-darwin-arm64',
      '@agentclientprotocol/codex-acp',
      '@openai/codex',
      '@openai/codex-darwin-arm64',
      '@agentclientprotocol/sdk',
      'diff',
      'open',
      'vscode-jsonrpc',
      'zod'
    ]) {
      expect(desktop).toContain(pkg)
    }
  })

  it('keeps the headless closure a superset of the desktop closure', () => {
    const desktop = runtimeClosureForPlatform('linux-x64', { target: 'desktop' }).packages
    const headless = runtimeClosureForPlatform('linux-x64', { target: 'headless' }).packages
    expect(headless.filter((p) => !desktop.includes(p)).sort()).toEqual(
      ['@anthropic-ai/claude-agent-sdk', 'node-pty', 'opencode-ai', 'ws'].sort()
    )
    expect(desktop.every((p) => headless.includes(p))).toBe(true)
  })

  it('throws for an unknown closure target', () => {
    expect(() => runtimeClosureForPlatform('linux-x64', { target: 'mobile' })).toThrow(
      /Unsupported closure target/
    )
  })
})

describe('runtimeExecutables', () => {
  it('spawns the opencode platform binary directly for desktop', () => {
    expect(runtimeExecutables('/R', 'darwin-arm64', { target: 'desktop' }).opencode).toBe(
      '/R/node_modules/opencode-darwin-arm64/bin/opencode'
    )
  })

  it('spawns the opencode-ai launcher for headless', () => {
    expect(runtimeExecutables('/R', 'darwin-arm64', { target: 'headless' }).opencode).toBe(
      '/R/node_modules/opencode-ai/bin/opencode.exe'
    )
  })

  it('places darwin-x64 native binaries under the Intel package and triple', () => {
    const exe = runtimeExecutables('/R', 'darwin-x64', { target: 'desktop' })
    expect(exe).toEqual({
      claude: '/R/node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/claude',
      opencode: '/R/node_modules/opencode-darwin-x64/bin/opencode',
      codexAcpScript: '/R/node_modules/@agentclientprotocol/codex-acp/dist/index.js',
      codex: '/R/node_modules/@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/bin/codex',
      codexCodeModeHost:
        '/R/node_modules/@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/bin/codex-code-mode-host'
    })
  })
})

describe('resolvePackageDir', () => {
  it('resolves package directory via the injected resolve function', () => {
    const mockResolve = vi.fn((id) => {
      if (id === 'opencode-ai/package.json') {
        return '/repo/node_modules/opencode-ai/package.json'
      }
      throw new Error('not found')
    })
    const dir = resolvePackageDir(
      'opencode-ai',
      '/repo/package.json',
      mockResolve
    )
    expect(dir).toBe('/repo/node_modules/opencode-ai')
    expect(mockResolve).toHaveBeenCalledWith('opencode-ai/package.json')
  })

  it('falls back to walking up from the main entry when package.json is not exported', () => {
    const mockExists = vi.fn((p) => p === '/repo/node_modules/pkg/package.json')
    const mockResolve = vi.fn((id) => {
      if (id === 'pkg/package.json') {
        const err = new Error('Package subpath not exported')
        err.code = 'ERR_PACKAGE_PATH_NOT_EXPORTED'
        throw err
      }
      if (id === 'pkg') return '/repo/node_modules/pkg/sdk.mjs'
      throw new Error('not found')
    })
    const dir = resolvePackageDir('pkg', '/repo/package.json', mockResolve, mockExists)
    expect(dir).toBe('/repo/node_modules/pkg')
    expect(mockResolve).toHaveBeenCalledWith('pkg/package.json')
    expect(mockResolve).toHaveBeenCalledWith('pkg')
  })

  it('throws when the package cannot be resolved', () => {
    const mockResolve = vi.fn(() => {
      throw new Error('not found')
    })
    expect(() =>
      resolvePackageDir('missing-pkg', '/repo/package.json', mockResolve)
    ).toThrow('not found')
  })
})

describe('validateStagedRuntimeClosure', () => {
  it('returns an empty array when all files exist and are executable', () => {
    const mockExists = vi.fn(() => true)
    const mockStat = vi.fn(() => ({ mode: 0o755 }))
    const errors = validateStagedRuntimeClosure({
      libDir: '/stage/lib',
      platform: 'darwin-arm64',
      existsSync: mockExists,
      statSync: mockStat
    })
    expect(errors).toEqual([])
    expect(mockExists).toHaveBeenCalledTimes(15)
  })

  it('reports missing files', () => {
    const mockExists = vi.fn(() => false)
    const errors = validateStagedRuntimeClosure({
      libDir: '/stage/lib',
      platform: 'darwin-arm64',
      existsSync: mockExists,
      statSync: vi.fn()
    })
    expect(errors.length).toBe(15)
    expect(errors[0]).toContain('missing')
  })

  it('reports non-executable binaries', () => {
    const mockExists = vi.fn(() => true)
    const mockStat = vi.fn(() => ({ mode: 0o644 }))
    const errors = validateStagedRuntimeClosure({
      libDir: '/stage/lib',
      platform: 'darwin-arm64',
      existsSync: mockExists,
      statSync: mockStat
    })
    expect(errors.length).toBe(4)
    expect(errors[0]).toContain('not executable')
  })

  it('throws for an unsupported platform', () => {
    expect(() =>
      validateStagedRuntimeClosure({
        libDir: '/stage/lib',
        platform: 'win32-x64',
        existsSync: vi.fn(),
        statSync: vi.fn()
      })
    ).toThrow(/Unsupported platform/)
  })
})

describe('validateStagedRuntimeClosure desktop target', () => {
  const headlessOnly = [
    '/stage/lib/node_modules/node-pty/package.json',
    '/stage/lib/node_modules/ws/package.json',
    '/stage/lib/node_modules/@anthropic-ai/claude-agent-sdk/package.json'
  ]
  const executable = () => ({ mode: 0o755 })

  it('does not require node-pty, ws, or the Claude SDK JS', () => {
    const exists = (p) => !headlessOnly.includes(p)
    const args = { libDir: '/stage/lib', platform: 'darwin-arm64', existsSync: exists, statSync: executable }
    expect(validateStagedRuntimeClosure({ ...args, target: 'desktop' })).toEqual([])
    expect(validateStagedRuntimeClosure({ ...args, target: 'headless' })).toEqual(
      headlessOnly.map((p) => expect.stringContaining(p))
    )
  })

  it('checks the opencode platform binary rather than the opencode-ai launcher', () => {
    const launcher = '/stage/lib/node_modules/opencode-ai/bin/opencode.exe'
    const platformBin = '/stage/lib/node_modules/opencode-darwin-arm64/bin/opencode'
    const base = { libDir: '/stage/lib', platform: 'darwin-arm64', target: 'desktop', statSync: executable }
    expect(
      validateStagedRuntimeClosure({ ...base, existsSync: (p) => p !== launcher })
    ).toEqual([])
    expect(
      validateStagedRuntimeClosure({ ...base, existsSync: (p) => p !== platformBin })
    ).toEqual([`missing opencode binary: ${platformBin}`])
  })

  it('reports a missing claude binary and a non-executable codex binary', () => {
    const claude = '/stage/lib/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
    const codex =
      '/stage/lib/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex'
    const errors = validateStagedRuntimeClosure({
      libDir: '/stage/lib',
      platform: 'darwin-arm64',
      target: 'desktop',
      existsSync: (p) => p !== claude,
      statSync: (p) => ({ mode: p === codex ? 0o644 : 0o755 })
    })
    expect(errors.sort()).toEqual(
      [`missing claude binary: ${claude}`, `not executable codex native binary: ${codex}`].sort()
    )
  })

  it('throws for an unknown target', () => {
    expect(() =>
      validateStagedRuntimeClosure({
        libDir: '/stage/lib',
        platform: 'darwin-arm64',
        target: 'mobile',
        existsSync: () => true,
        statSync: executable
      })
    ).toThrow(/Unsupported closure target/)
  })
})

import { describe, it, expect, vi } from 'vitest'
import {
  PLATFORM_PACKAGES,
  runtimeClosureForPlatform,
  resolvePackageDir,
  validateStagedRuntimeClosure
} from './runtime-closure.mjs'

describe('PLATFORM_PACKAGES', () => {
  it('covers all three shipped platforms', () => {
    expect(Object.keys(PLATFORM_PACKAGES)).toEqual([
      'darwin-arm64',
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
    expect(mockExists).toHaveBeenCalledTimes(14)
  })

  it('reports missing files', () => {
    const mockExists = vi.fn(() => false)
    const errors = validateStagedRuntimeClosure({
      libDir: '/stage/lib',
      platform: 'darwin-arm64',
      existsSync: mockExists,
      statSync: vi.fn()
    })
    expect(errors.length).toBe(14)
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
    expect(errors.length).toBe(3)
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

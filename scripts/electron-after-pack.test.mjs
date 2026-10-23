import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { closurePlatformForContext, stageDesktopRuntimes } from './electron-after-pack.mjs'

function makeContext({ os, arch, binaries }) {
  const platformSpecificBuildOptions = binaries === undefined ? {} : { binaries }
  return {
    electronPlatformName: os,
    arch,
    appOutDir: '/out/mac-arm64',
    packager: {
      getResourcesDir: (appOutDir) => `${appOutDir}/Harness.app/Contents/Resources`,
      platformSpecificBuildOptions
    }
  }
}

const RUNTIMES = '/out/mac-arm64/Harness.app/Contents/Resources/runtimes'

describe('closurePlatformForContext', () => {
  it.each([
    { name: 'darwin numeric x64', os: 'darwin', arch: 1, expected: 'darwin-x64' },
    { name: 'darwin numeric arm64', os: 'darwin', arch: 3, expected: 'darwin-arm64' },
    { name: 'linux numeric x64', os: 'linux', arch: 1, expected: 'linux-x64' },
    { name: 'linux string arm64', os: 'linux', arch: 'arm64', expected: 'linux-arm64' },
    { name: 'win32', os: 'win32', arch: 1, expected: null }
  ])('$name → $expected', ({ os, arch, expected }) => {
    expect(closurePlatformForContext({ electronPlatformName: os, arch })).toBe(expected)
  })

  it.each([
    { name: 'universal mac', os: 'darwin', arch: 4 },
    { name: 'ia32 linux', os: 'linux', arch: 0 },
    { name: 'string ia32', os: 'linux', arch: 'ia32' }
  ])('throws for $name instead of shipping without runtimes', ({ os, arch }) => {
    expect(() => closurePlatformForContext({ electronPlatformName: os, arch })).toThrow(
      /no bundled runtimes/
    )
  })
})

describe('stageDesktopRuntimes', () => {
  let logSpy

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  it('stages the desktop closure into <Resources>/runtimes for the packaged arch', async () => {
    const stage = vi.fn(async () => {})
    const validate = vi.fn(() => [])
    const result = await stageDesktopRuntimes(makeContext({ os: 'linux', arch: 3 }), {
      stage,
      validate
    })
    expect(result).toEqual({ platform: 'linux-arm64', libDir: RUNTIMES })
    expect(stage).toHaveBeenCalledWith(
      expect.objectContaining({ libDir: RUNTIMES, platform: 'linux-arm64', target: 'desktop' })
    )
    expect(validate).toHaveBeenCalledWith({
      libDir: RUNTIMES,
      platform: 'linux-arm64',
      target: 'desktop'
    })
  })

  it('fails the pack with the validation errors and leaves the signing list untouched', async () => {
    const context = makeContext({ os: 'darwin', arch: 3, binaries: ['/pre'] })
    await expect(
      stageDesktopRuntimes(context, {
        stage: async () => {},
        validate: () => ['missing claude binary: /x/claude', 'missing opencode binary: /x/opencode']
      })
    ).rejects.toThrow(/missing claude binary: \/x\/claude\nmissing opencode binary/)
    expect(context.packager.platformSpecificBuildOptions.binaries).toEqual(['/pre'])
  })

  it('appends the staged claude binary to existing mac binaries for signing', async () => {
    const context = makeContext({ os: 'darwin', arch: 3, binaries: ['/pre/helper'] })
    await stageDesktopRuntimes(context, { stage: async () => {}, validate: () => [] })
    expect(context.packager.platformSpecificBuildOptions.binaries).toEqual([
      '/pre/helper',
      `${RUNTIMES}/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`
    ])
  })

  it('replaces the previous arch\'s staged paths when one mac run packs both arches', async () => {
    const context = makeContext({ os: 'darwin', arch: 3, binaries: ['/pre/helper'] })
    const deps = { stage: async () => {}, validate: () => [] }
    await stageDesktopRuntimes(context, deps)
    context.appOutDir = '/out/mac'
    context.arch = 1
    await stageDesktopRuntimes(context, deps)
    expect(context.packager.platformSpecificBuildOptions.binaries).toEqual([
      '/pre/helper',
      '/out/mac/Harness.app/Contents/Resources/runtimes/node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/claude'
    ])
  })

  it('creates the mac binaries list when none was configured', async () => {
    const context = makeContext({ os: 'darwin', arch: 1 })
    await stageDesktopRuntimes(context, { stage: async () => {}, validate: () => [] })
    expect(context.packager.platformSpecificBuildOptions.binaries).toEqual([
      `${RUNTIMES}/node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/claude`
    ])
  })

  it('does not touch binaries on linux', async () => {
    const binaries = ['/pre/helper']
    const context = makeContext({ os: 'linux', arch: 1, binaries })
    await stageDesktopRuntimes(context, { stage: async () => {}, validate: () => [] })
    expect(context.packager.platformSpecificBuildOptions.binaries).toBe(binaries)
    expect(binaries).toEqual(['/pre/helper'])
  })

  it('skips staging for an unsupported platform', async () => {
    const stage = vi.fn(async () => {})
    const result = await stageDesktopRuntimes(makeContext({ os: 'win32', arch: 1 }), {
      stage,
      validate: () => []
    })
    expect(result).toBeNull()
    expect(stage).not.toHaveBeenCalled()
  })
})

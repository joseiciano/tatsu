import { describe, it, expect } from 'vitest'
import {
  BundledRuntimeResolver,
  type BundledRuntimeResolverOptions,
  codexPlatformPackageId,
  codexTargetTriple,
  defaultRuntimesRoot,
  RuntimeMissingError,
  stagedClaudeExecutablePath
} from './runtime-path-resolver'

const APP_ASAR = '/Applications/Harness.app/Contents/Resources/app.asar'

// Deterministic fake package resolver rooted inside app.asar so the
// app.asar → app.asar.unpacked rewrite is exercised end-to-end.
function makeResolver(
  platform: string,
  arch: string,
  extra: Partial<BundledRuntimeResolverOptions> = {}
) {
  const APP_UNPACKED = APP_ASAR.replace('app.asar', 'app.asar.unpacked')
  const map: Record<string, string> = {
    'opencode-ai/package.json': `${APP_ASAR}/node_modules/opencode-ai/package.json`,
    '@agentclientprotocol/codex-acp/dist/index.js': `${APP_ASAR}/node_modules/@agentclientprotocol/codex-acp/dist/index.js`,
    '@openai/codex/package.json': `${APP_ASAR}/node_modules/@openai/codex/package.json`
  }
  // resolveCodexAcpScript() unpacks, so the resolver anchors the codex require
  // at the *unpacked* codex-acp dist dir.
  const codexScriptDir = `${APP_UNPACKED}/node_modules/@agentclientprotocol/codex-acp/dist`
  const codexBaseDir = `${APP_UNPACKED}/node_modules/@openai/codex`
  const platformPkgId = `@openai/codex-${platform}-${arch}`
  return new BundledRuntimeResolver({
    platform: platform as NodeJS.Platform,
    arch,
    runtimesRoot: null,
    processExecPath: '/Applications/Harness.app/Contents/MacOS/Harness',
    resolvePackage: (id: string) => {
      const hit = map[id]
      if (!hit) throw new Error(`not found: ${id}`)
      return hit
    },
    requireFromDir: (dir: string) => {
      const req = { resolve: (id: string) => id }
      req.resolve = (id: string) => {
        if (dir === codexScriptDir && id === '@openai/codex/package.json') {
          return codexBaseDir + '/package.json'
        }
        if (dir === codexBaseDir && id === `${platformPkgId}/package.json`) {
          return `${APP_UNPACKED}/node_modules/@openai/codex/node_modules/${platformPkgId}/package.json`
        }
        throw new Error(`not found: ${id} from ${dir}`)
      }
      return req
    },
    ...extra
  })
}

describe('codexTargetTriple', () => {
  it('maps darwin/linux x64/arm64 to vendor triples', () => {
    expect(codexTargetTriple('darwin', 'arm64')).toBe('aarch64-apple-darwin')
    expect(codexTargetTriple('darwin', 'x64')).toBe('x86_64-apple-darwin')
    expect(codexTargetTriple('linux', 'arm64')).toBe('aarch64-unknown-linux-musl')
    expect(codexTargetTriple('linux', 'x64')).toBe('x86_64-unknown-linux-musl')
  })

  it('throws for an unsupported platform', () => {
    expect(() => codexTargetTriple('win32', 'x64')).toThrow(/Unsupported platform/)
  })
})

describe('codexPlatformPackageId', () => {
  it('maps platform/arch to the @openai/codex optional dep name', () => {
    expect(codexPlatformPackageId('darwin', 'arm64')).toBe('@openai/codex-darwin-arm64')
    expect(codexPlatformPackageId('linux', 'x64')).toBe('@openai/codex-linux-x64')
  })

  it('throws for an unsupported platform', () => {
    expect(() => codexPlatformPackageId('win32', 'x64')).toThrow(/Unsupported platform/)
  })
})

describe('BundledRuntimeResolver', () => {
  it('rewrites packaged app.asar paths to app.asar.unpacked', () => {
    const r = makeResolver('darwin', 'arm64')
    expect(r.resolveOpenCodeExecutable()).toBe(
      `${APP_ASAR.replace('app.asar', 'app.asar.unpacked')}/node_modules/opencode-ai/bin/opencode.exe`
    )
    expect(r.resolveCodexAcpScript()).toBe(
      `${APP_ASAR.replace('app.asar', 'app.asar.unpacked')}/node_modules/@agentclientprotocol/codex-acp/dist/index.js`
    )
  })

  it('resolves the bundled @openai/codex native binary via its platform dep', () => {
    const r = makeResolver('darwin', 'arm64')
    expect(r.resolveCodexNativeBinary()).toBe(
      `${APP_ASAR.replace('app.asar', 'app.asar.unpacked')}/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`
    )
  })

  it('builds the OpenCode ACP command as [resolvedPath, "acp"]', () => {
    const r = makeResolver('darwin', 'arm64')
    const cfg = r.buildOpenCodeConfig()
    expect(cfg.command).toEqual([
      `${APP_ASAR.replace('app.asar', 'app.asar.unpacked')}/node_modules/opencode-ai/bin/opencode.exe`,
      'acp'
    ])
  })

  it('builds the Codex ACP command via process.execPath + ELECTRON_RUN_AS_NODE + CODEX_PATH', () => {
    const r = makeResolver('linux', 'x64')
    const cfg = r.buildCodexConfig()
    expect(cfg.command).toEqual([
      '/Applications/Harness.app/Contents/MacOS/Harness',
      `${APP_ASAR.replace('app.asar', 'app.asar.unpacked')}/node_modules/@agentclientprotocol/codex-acp/dist/index.js`
    ])
    expect(cfg.env?.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(cfg.env?.CODEX_PATH).toBe(
      `${APP_ASAR.replace('app.asar', 'app.asar.unpacked')}/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`
    )
  })

  it('throws a clear error for an unsupported platform at construction', () => {
    expect(
      () =>
        new BundledRuntimeResolver({
          platform: 'win32',
          arch: 'x64'
        })
    ).toThrow(/unsupported on win32/)
  })

  it('throws a clear error for an unsupported arch at construction', () => {
    expect(
      () =>
        new BundledRuntimeResolver({
          platform: 'darwin',
          arch: 'ia32'
        })
    ).toThrow(/unsupported on darwin-ia32/)
  })
})

describe('BundledRuntimeResolver with a staged runtimes root', () => {
  const ROOT = '/Applications/Harness.app/Contents/Resources/runtimes'
  const NM = `${ROOT}/node_modules`

  // Node-style lookup over the flat staged node_modules: a require anchored
  // anywhere under ROOT finds packages in ROOT/node_modules, nothing else.
  function stagedRequireFromDir(dir: string) {
    return {
      resolve: (id: string) => {
        if (dir !== ROOT && !dir.startsWith(`${NM}/`)) {
          throw new Error(`not found: ${id} from ${dir}`)
        }
        const files: Record<string, string> = {
          '@agentclientprotocol/codex-acp/dist/index.js': `${NM}/@agentclientprotocol/codex-acp/dist/index.js`,
          '@openai/codex/package.json': `${NM}/@openai/codex/package.json`,
          '@openai/codex-linux-x64/package.json': `${NM}/@openai/codex-linux-x64/package.json`
        }
        const hit = files[id]
        if (!hit) throw new Error(`not found: ${id} from ${dir}`)
        return hit
      }
    }
  }

  const STAGED_OPENCODE = `${NM}/opencode-linux-x64/bin/opencode`
  const STAGED_CODEX = `${NM}/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`

  function makeStagedResolver(opts: Partial<BundledRuntimeResolverOptions> = {}) {
    return new BundledRuntimeResolver({
      platform: 'linux',
      arch: 'x64',
      runtimesRoot: ROOT,
      processExecPath: '/opt/Harness/harness',
      requireFromDir: stagedRequireFromDir,
      exists: (p) => p === STAGED_OPENCODE || p === STAGED_CODEX,
      ...opts
    })
  }

  it('spawns the opencode platform package binary', () => {
    expect(makeStagedResolver().resolveOpenCodeExecutable()).toBe(
      `${NM}/opencode-linux-x64/bin/opencode`
    )
  })

  it('resolves the codex-acp script and native binary through the runtimes root', () => {
    const cfg = makeStagedResolver().buildCodexConfig()
    expect(cfg.command).toEqual([
      '/opt/Harness/harness',
      `${NM}/@agentclientprotocol/codex-acp/dist/index.js`
    ])
    expect(cfg.env?.CODEX_PATH).toBe(
      `${NM}/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`
    )
  })

  const DOWNLOADED_OPENCODE = '/userData/runtimes/opencode-linux-x64@1.0.0/bin/opencode'
  const DOWNLOADED_CODEX =
    '/userData/runtimes/@openai+codex@0.1.0-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'
  const downloadedBinary = (kind: 'opencode' | 'codex') =>
    kind === 'opencode' ? DOWNLOADED_OPENCODE : DOWNLOADED_CODEX

  it('bundledBinary reports only staged binaries, never a download', () => {
    const staged = makeStagedResolver({ downloadedBinary })
    expect(staged.bundledBinary('opencode')).toBe(STAGED_OPENCODE)
    expect(staged.bundledBinary('codex')).toBe(STAGED_CODEX)

    const downloadOnly = makeStagedResolver({ downloadedBinary, exists: () => false })
    expect(downloadOnly.bundledBinary('opencode')).toBeUndefined()
    expect(downloadOnly.bundledBinary('codex')).toBeUndefined()
  })

  it('prefers a staged binary over a downloaded one', () => {
    const r = makeStagedResolver({ downloadedBinary })
    expect(r.resolveOpenCodeExecutable()).toBe(STAGED_OPENCODE)
    expect(r.buildCodexConfig().env?.CODEX_PATH).toBe(STAGED_CODEX)
  })

  it('launches the downloaded binary when the app did not stage one', () => {
    const r = makeStagedResolver({ downloadedBinary, exists: () => false })
    expect(r.buildOpenCodeConfig().command).toEqual([DOWNLOADED_OPENCODE, 'acp'])
    expect(r.buildCodexConfig().env?.CODEX_PATH).toBe(DOWNLOADED_CODEX)
  })

  it.each([
    { kind: 'opencode', build: (r: BundledRuntimeResolver) => r.buildOpenCodeConfig() },
    { kind: 'codex', build: (r: BundledRuntimeResolver) => r.buildCodexConfig() }
  ])('throws RuntimeMissingError for $kind when neither staged nor downloaded', ({ kind, build }) => {
    const r = makeStagedResolver({ exists: () => false })
    let caught: unknown
    try {
      build(r)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(RuntimeMissingError)
    expect((caught as RuntimeMissingError).agentKind).toBe(kind)
  })

  it('ignores the staged layout when runtimesRoot is null', () => {
    const r = new BundledRuntimeResolver({
      platform: 'linux',
      arch: 'x64',
      runtimesRoot: null,
      resolvePackage: (id: string) => {
        if (id === 'opencode-ai/package.json') return '/dev/node_modules/opencode-ai/package.json'
        throw new Error(`not found: ${id}`)
      },
      requireFromDir: stagedRequireFromDir
    })
    expect(r.resolveOpenCodeExecutable()).toBe('/dev/node_modules/opencode-ai/bin/opencode.exe')
  })
})

describe('BundledRuntimeResolver.bundledBinary outside a staged layout', () => {
  const UNPACKED = APP_ASAR.replace('app.asar', 'app.asar.unpacked')
  const OPENCODE = `${UNPACKED}/node_modules/opencode-ai/bin/opencode.exe`
  const CODEX = `${UNPACKED}/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`

  it('returns the require-resolved binary when it exists on disk', () => {
    const r = makeResolver('darwin', 'arm64', { exists: (p) => p === OPENCODE || p === CODEX })
    expect(r.bundledBinary('opencode')).toBe(OPENCODE)
    expect(r.bundledBinary('codex')).toBe(CODEX)
  })

  it('returns undefined when the resolved path is absent', () => {
    const r = makeResolver('darwin', 'arm64', { exists: () => false })
    expect(r.bundledBinary('opencode')).toBeUndefined()
    expect(r.bundledBinary('codex')).toBeUndefined()
  })

  it('returns undefined when the package does not resolve', () => {
    const r = makeResolver('darwin', 'arm64', {
      exists: () => true,
      resolvePackage: (id: string) => {
        throw new Error(`not found: ${id}`)
      }
    })
    expect(r.bundledBinary('opencode')).toBeUndefined()
    expect(r.bundledBinary('codex')).toBeUndefined()
  })
})

describe('defaultRuntimesRoot', () => {
  const RP = '/Applications/Harness.app/Contents/Resources'

  it('returns undefined outside a packaged app', () => {
    expect(defaultRuntimesRoot(undefined, () => true)).toBeUndefined()
  })

  it('returns undefined when no runtime closure was staged', () => {
    expect(defaultRuntimesRoot(RP, (p) => p === `${RP}/runtimes`)).toBeUndefined()
  })

  it('returns <resourcesPath>/runtimes when its node_modules exists', () => {
    expect(defaultRuntimesRoot(RP, (p) => p === `${RP}/runtimes/node_modules`)).toBe(
      `${RP}/runtimes`
    )
  })
})

describe('stagedClaudeExecutablePath', () => {
  const claude = '/R/node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/claude'

  it('returns the staged claude binary when it exists', () => {
    expect(stagedClaudeExecutablePath('/R', 'darwin', 'x64', (p) => p === claude)).toBe(claude)
  })

  it('returns undefined when the staged binary is absent', () => {
    expect(stagedClaudeExecutablePath('/R', 'darwin', 'x64', () => false)).toBeUndefined()
  })

  it('returns undefined without a runtimes root', () => {
    expect(stagedClaudeExecutablePath(undefined, 'darwin', 'x64', () => true)).toBeUndefined()
  })
})

// Resolves the bundled native executables and JS entrypoints for the OpenCode
// and Codex ACP runtimes in both dev (pnpm node_modules) and packaged
// (app.asar.unpacked) layouts.
//
// Mirrors resolveClaudeAgentSdkExecutablePath (./claude-acp.ts): every resolved
// path is rewritten from app.asar → app.asar.unpacked so native executables
// land outside the asar archive with their executable bits intact. All paths
// returned are direct resolved executables — never a PATH/global CLI lookup.
//
// Bundled layout (pinned in package.json):
//   - opencode-ai            → bin/opencode.exe           (native launcher)
//   - @agentclientprotocol/codex-acp → dist/index.js      (ACP stdio JS entry)
//   - @openai/codex-<plat>-<arch>    → vendor/<triple>/bin/codex (native binary)
//
// The Codex ACP JS entrypoint is not itself a native binary; it is launched via
// process.execPath with ELECTRON_RUN_AS_NODE=1 and CODEX_PATH pointing at the
// bundled @openai/codex native binary so codex-acp's internal `codex app-server`
// spawn resolves to the packaged executable instead of a global install.

import { createRequire } from 'module'
import { dirname, join, sep } from 'path'
/** Full argv + env for an ACP stdio subprocess. */
export interface RuntimeLaunchConfig {
  /** Complete argv for the ACP stdio subprocess. */
  command: string[]
  /** Extra environment injected into the subprocess (merged over process.env). */
  env?: NodeJS.ProcessEnv
}

/** Minimal require subset used to resolve sibling packages. */
export interface PackageRequire {
  resolve(id: string): string
}

export interface BundledRuntimeResolverOptions {
  /** Current platform. Defaults to process.platform. */
  platform?: NodeJS.Platform
  /** Current CPU arch. Defaults to process.arch. */
  arch?: string
  /** process.execPath at runtime — the Electron binary, used as the Node
   *  interpreter for the Codex ACP JS entrypoint. Injectable for tests. */
  processExecPath?: string
  /** Resolve a package id from the app's node_modules. Defaults to
   *  createRequire(__filename). Injectable for tests. */
  resolvePackage?: (id: string) => string
  /** Root a fresh require at an arbitrary resolved package dir, used to reach
   *  the platform-scoped @openai/codex-<platform>-<arch> optional dep that
   *  lives in @openai/codex's own node_modules (not hoisted to the root).
   *  Defaults to createRequire. Injectable for tests. */
  requireFromDir?: (dir: string) => PackageRequire
}

/** Darwin/Linux → @openai/codex platform package id (its optional dep name). */
export function codexPlatformPackageId(
  platform: NodeJS.Platform,
  arch: string
): string {
  if (platform === 'darwin') return `@openai/codex-darwin-${arch}`
  if (platform === 'linux') return `@openai/codex-linux-${arch}`
  throw new Error(`Unsupported platform for Codex ACP: ${platform}`)
}

/** Darwin/Linux (x64/arm64) → vendor target triple inside the platform pkg. */
export function codexTargetTriple(
  platform: NodeJS.Platform,
  arch: string
): string {
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  }
  if (platform === 'linux') {
    return arch === 'arm64'
      ? 'aarch64-unknown-linux-musl'
      : 'x86_64-unknown-linux-musl'
  }
  throw new Error(`Unsupported platform for Codex ACP: ${platform}`)
}

export class BundledRuntimeResolver {
  private platform: NodeJS.Platform
  private arch: string
  private processExecPath: string
  private resolvePackage: (id: string) => string
  private requireFromDir: (dir: string) => PackageRequire

  constructor(opts: BundledRuntimeResolverOptions = {}) {
    const platform = opts.platform ?? process.platform
    const arch = opts.arch ?? process.arch
    // Only the platforms/arches we actually ship native binaries for.
    if (platform !== 'darwin' && platform !== 'linux') {
      throw new Error(
        `Bundled OpenCode/Codex runtimes are unsupported on ${platform}. ` +
          `Supported platforms: darwin, linux.`
      )
    }
    if (arch !== 'arm64' && arch !== 'x64') {
      throw new Error(
        `Bundled OpenCode/Codex runtimes are unsupported on ${platform}-${arch}. ` +
          `Supported architectures: arm64, x64.`
      )
    }
    this.platform = platform
    this.arch = arch
    this.processExecPath = opts.processExecPath ?? process.execPath
    this.resolvePackage =
      opts.resolvePackage ?? ((id) => createRequire(__filename).resolve(id))
    this.requireFromDir =
      opts.requireFromDir ?? ((dir) => createRequire(join(dir, 'noop.js')))
  }

  /** Rewrite an app.asar path to its unpacked counterpart so native binaries
   *  resolve to real filesystem paths with executable bits preserved. */
  private _unpack(p: string): string {
    return p.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
  }

  /** Native OpenCode launcher: opencode-ai/bin/opencode.exe. */
  resolveOpenCodeExecutable(): string {
    const pkgJson = this.resolvePackage('opencode-ai/package.json')
    return this._unpack(join(dirname(pkgJson), 'bin', 'opencode.exe'))
  }

  /** Codex ACP stdio JS entrypoint: @agentclientprotocol/codex-acp/dist/index.js. */
  resolveCodexAcpScript(): string {
    return this._unpack(
      this.resolvePackage('@agentclientprotocol/codex-acp/dist/index.js')
    )
  }

  /** Bundled @openai/codex native binary for the current platform/arch.
   *  @openai/codex is a dependency of @agentclientprotocol/codex-acp, and the
   *  platform-scoped package is a dep of @openai/codex — so both are resolved
   *  from within their declaring package dirs (works in both pnpm's nested
   *  dev layout and electron-builder's flattened packaged layout). */
  resolveCodexNativeBinary(): string {
    const acpScript = this.resolveCodexAcpScript()
    const codexBaseRequire = this.requireFromDir(dirname(acpScript))
    const basePkg = codexBaseRequire.resolve('@openai/codex/package.json')
    const baseDir = dirname(basePkg)
    const platformPkgId = codexPlatformPackageId(this.platform, this.arch)
    // The platform-scoped package is an optional dep of @openai/codex, so it
    // must be resolved from within @openai/codex's own node_modules.
    const platformPkg = this.requireFromDir(baseDir).resolve(
      `${platformPkgId}/package.json`
    )
    const triple = codexTargetTriple(this.platform, this.arch)
    const binName = this.platform === 'linux' || this.platform === 'darwin' ? 'codex' : 'codex.exe'
    return this._unpack(
      join(dirname(platformPkg), 'vendor', triple, 'bin', binName)
    )
  }

  /** Launch config for the OpenCode ACP stdio subprocess. */
  buildOpenCodeConfig(): RuntimeLaunchConfig {
    return { command: [this.resolveOpenCodeExecutable(), 'acp'] }
  }

  /** Launch config for the Codex ACP stdio subprocess: JS entrypoint run via
   *  process.execPath with ELECTRON_RUN_AS_NODE=1 and CODEX_PATH pointing at
   *  the bundled native binary. */
  buildCodexConfig(): RuntimeLaunchConfig {
    return {
      command: [this.processExecPath, this.resolveCodexAcpScript()],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        CODEX_PATH: this.resolveCodexNativeBinary()
      }
    }
  }
}

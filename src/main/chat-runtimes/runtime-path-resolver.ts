// Resolves the native executables and JS entrypoints for the OpenCode and
// Codex ACP runtimes in three layouts:
//   - packaged desktop: `<resourcesPath>/runtimes/node_modules` staged by
//     scripts/electron-after-pack.mjs holds the Codex ACP script; the native
//     binaries come from the first-use download in userData
//     (src/main/runtime-downloader) unless a build staged them too;
//   - headless tarball: `lib/node_modules` staged by scripts/pack-headless.mjs,
//     reached through ordinary require resolution from the main bundle;
//   - dev: pnpm node_modules, also through require resolution.
//
// Every require-resolved path is rewritten from app.asar → app.asar.unpacked so
// native executables land outside the asar archive with their executable bits
// intact. All paths returned are direct resolved executables — never a
// PATH/global CLI lookup.
//
// Package layout (pinned in package.json):
//   - opencode-<plat>-<arch> → bin/opencode                (native binary; desktop download)
//   - opencode-ai            → bin/opencode.exe            (hard link to it; dev + headless)
//   - @agentclientprotocol/codex-acp → dist/index.js       (ACP stdio JS entry)
//   - @openai/codex-<plat>-<arch>    → vendor/<triple>/bin/codex (native binary)
//
// The Codex ACP JS entrypoint is not itself a native binary; it is launched via
// process.execPath with ELECTRON_RUN_AS_NODE=1 and CODEX_PATH pointing at the
// bundled @openai/codex native binary so codex-acp's internal `codex app-server`
// spawn resolves to the packaged executable instead of a global install.

import { existsSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join, sep } from 'path'
import type { DownloadableRuntime } from '../../shared/state/runtimes'

/** `<resourcesPath>/runtimes` when the packaged desktop app staged a runtime
 *  closure there, otherwise undefined (dev, headless, tests). */
export function defaultRuntimesRoot(
  resourcesPath: string | undefined = process.resourcesPath,
  exists: (p: string) => boolean = existsSync
): string | undefined {
  if (!resourcesPath) return undefined
  const root = join(resourcesPath, 'runtimes')
  return exists(join(root, 'node_modules')) ? root : undefined
}

/** Darwin/Linux → opencode platform package id (optional dep of opencode-ai). */
export function opencodePlatformPackageId(platform: NodeJS.Platform, arch: string): string {
  return `opencode-${platform}-${arch}`
}

/** Darwin/Linux → Claude native package id (optional dep of the Claude SDK). */
export function claudePlatformPackageId(platform: NodeJS.Platform, arch: string): string {
  return `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`
}

/** The staged Claude native executable under a runtimes root, if present. */
export function stagedClaudeExecutablePath(
  runtimesRoot: string | undefined,
  platform: NodeJS.Platform,
  arch: string,
  exists: (p: string) => boolean = existsSync
): string | undefined {
  if (!runtimesRoot) return undefined
  const p = join(runtimesRoot, 'node_modules', claudePlatformPackageId(platform, arch), 'claude')
  return exists(p) ? p : undefined
}
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
  /** Staged runtime closure root (`<resourcesPath>/runtimes`). Defaults to
   *  defaultRuntimesRoot(); pass null to force require-based resolution. */
  runtimesRoot?: string | null
  /** A runtime downloaded into userData (see main/runtime-downloader). Used
   *  only in the staged layout, after the staged path, so a bundled binary
   *  always wins over a downloaded one. */
  downloadedBinary?: (kind: DownloadableRuntime) => string | undefined
  /** File existence probe. Injectable for tests. */
  exists?: (p: string) => boolean
}

export class RuntimeMissingError extends Error {
  constructor(public readonly agentKind: DownloadableRuntime) {
    super(`${agentKind} runtime is not installed`)
    this.name = 'RuntimeMissingError'
  }
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
  private runtimesRoot: string | undefined
  private downloadedBinary: (kind: DownloadableRuntime) => string | undefined
  private exists: (p: string) => boolean

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
    this.runtimesRoot =
      opts.runtimesRoot === null ? undefined : (opts.runtimesRoot ?? defaultRuntimesRoot())
    this.downloadedBinary = opts.downloadedBinary ?? (() => undefined)
    this.exists = opts.exists ?? existsSync
    this.requireFromDir =
      opts.requireFromDir ?? ((dir) => createRequire(join(dir, 'noop.js')))
    // A staged closure is a flat node_modules, so a require rooted at it
    // reaches every runtime package directly.
    this.resolvePackage =
      opts.resolvePackage ??
      (this.runtimesRoot
        ? (id) => this.requireFromDir(this.runtimesRoot!).resolve(id)
        : (id) => createRequire(__filename).resolve(id))
  }

  /** Rewrite an app.asar path to its unpacked counterpart so native binaries
   *  resolve to real filesystem paths with executable bits preserved. */
  private _unpack(p: string): string {
    return p.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
  }

  /** Where the staged desktop closure would hold a native binary. */
  private _stagedBinary(kind: DownloadableRuntime): string | undefined {
    if (!this.runtimesRoot) return undefined
    const nm = join(this.runtimesRoot, 'node_modules')
    if (kind === 'opencode') {
      return join(nm, opencodePlatformPackageId(this.platform, this.arch), 'bin', 'opencode')
    }
    const triple = codexTargetTriple(this.platform, this.arch)
    return join(nm, codexPlatformPackageId(this.platform, this.arch), 'vendor', triple, 'bin', 'codex')
  }

  /** The binary the app ships for a runtime, or undefined when the app
   *  relies on a download. In the staged layout only the staged path counts;
   *  in dev/headless it is whatever require resolution finds on disk. */
  bundledBinary(kind: DownloadableRuntime): string | undefined {
    if (this.runtimesRoot) {
      const staged = this._stagedBinary(kind)
      return staged && this.exists(staged) ? staged : undefined
    }
    try {
      const p = kind === 'opencode' ? this._requireOpenCode() : this._requireCodexNative()
      return this.exists(p) ? p : undefined
    } catch {
      return undefined
    }
  }

  /** Staged first, then downloaded; throws RuntimeMissingError when the
   *  staged layout has neither so the chat runtime can offer the download. */
  private _stagedOrDownloaded(kind: DownloadableRuntime): string {
    const staged = this._stagedBinary(kind)!
    if (this.exists(staged)) return staged
    const downloaded = this.downloadedBinary(kind)
    if (downloaded) return downloaded
    throw new RuntimeMissingError(kind)
  }

  private _requireOpenCode(): string {
    const pkgJson = this.resolvePackage('opencode-ai/package.json')
    return this._unpack(join(dirname(pkgJson), 'bin', 'opencode.exe'))
  }

  /** Native OpenCode binary: the platform package's bin/opencode in a staged
   *  desktop closure (or its download), otherwise the opencode-ai launcher
   *  bin/opencode.exe (a hard link to the same binary). */
  resolveOpenCodeExecutable(): string {
    if (this.runtimesRoot) return this._stagedOrDownloaded('opencode')
    return this._requireOpenCode()
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
    if (this.runtimesRoot) return this._stagedOrDownloaded('codex')
    return this._requireCodexNative()
  }

  private _requireCodexNative(): string {
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

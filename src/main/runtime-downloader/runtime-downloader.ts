// Downloads the OpenCode and Codex native packages on first chat use. The
// desktop app bundles only Claude; these two are fetched from the npm
// registry as the exact tarballs pinned in resources/runtime-manifest.json
// (generated from package.json + pnpm-lock.yaml at build time), verified
// against the lockfile's SRI hash, and unpacked into
// <userData>/runtimes/<package>/<version>/. A `.ok` marker is written last,
// so a crash mid-install never leaves a half-unpacked tree that looks ready.

import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { chmod, rename, rm } from 'fs/promises'
import { dirname, join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import * as tar from 'tar'
import type { Store } from '../store'
import type { DownloadableRuntime, RuntimeStatus } from '../../shared/state/runtimes'
import { RuntimeMissingError } from '../chat-runtimes'

export interface RuntimeManifestEntry {
  package: string
  version: string
  binary: string
  tarball: string
  integrity: string
  unpackedSize: number | null
}

export interface RuntimeManifest {
  schemaVersion: 1
  runtimes: Record<string, Partial<Record<DownloadableRuntime, RuntimeManifestEntry>>>
}

export const DOWNLOADABLE_RUNTIMES: readonly DownloadableRuntime[] = ['opencode', 'codex']

export interface RuntimeDownloaderOptions {
  store: Pick<Store, 'dispatch'>
  manifest: RuntimeManifest | null
  /** `<os>-<arch>` key into the manifest, e.g. darwin-arm64. */
  platform: string
  /** Where downloads are unpacked: `<userData>/runtimes`. */
  installRoot: string
  /** Returns the bundled binary for a runtime when the app ships it, so the
   *  status reports `bundled` and no download is offered. */
  bundledBinary: (kind: DownloadableRuntime) => string | undefined
  fetchFn?: typeof fetch
  /** Minimum ms between progress dispatches. */
  progressIntervalMs?: number
}

export function readRuntimeManifest(path: string): RuntimeManifest | null {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as RuntimeManifest
    return parsed?.schemaVersion === 1 && parsed.runtimes ? parsed : null
  } catch {
    return null
  }
}

/** Parse an SRI string (`sha512-<base64>`) into its algorithm + digest. */
export function parseIntegrity(sri: string): { algorithm: string; digest: string } {
  const idx = sri.indexOf('-')
  if (idx <= 0) throw new Error(`Malformed integrity string: ${sri}`)
  return { algorithm: sri.slice(0, idx), digest: sri.slice(idx + 1) }
}

/** Directory name for a package install: scoped names flatten to one segment. */
export function installDirName(entry: Pick<RuntimeManifestEntry, 'package' | 'version'>): string {
  return `${entry.package.replace('/', '+')}@${entry.version}`
}

export class RuntimeDownloader {
  private readonly store: Pick<Store, 'dispatch'>
  private readonly manifest: RuntimeManifest | null
  private readonly platform: string
  private readonly installRoot: string
  private readonly bundledBinary: (kind: DownloadableRuntime) => string | undefined
  private readonly fetchFn: typeof fetch
  private readonly progressIntervalMs: number
  private readonly inFlight = new Map<DownloadableRuntime, Promise<void>>()

  constructor(opts: RuntimeDownloaderOptions) {
    this.store = opts.store
    this.manifest = opts.manifest
    this.platform = opts.platform
    this.installRoot = opts.installRoot
    this.bundledBinary = opts.bundledBinary
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init))
    this.progressIntervalMs = opts.progressIntervalMs ?? 250
  }

  entry(kind: DownloadableRuntime): RuntimeManifestEntry | undefined {
    return this.manifest?.runtimes[this.platform]?.[kind]
  }

  private installDir(entry: RuntimeManifestEntry): string {
    return join(this.installRoot, installDirName(entry))
  }

  /** Absolute path of a downloaded, verified binary; undefined until the
   *  install finished (marker present) and the binary exists. */
  installedBinary(kind: DownloadableRuntime): string | undefined {
    const entry = this.entry(kind)
    if (!entry) return undefined
    const dir = this.installDir(entry)
    const bin = join(dir, entry.binary)
    return existsSync(join(dir, '.ok')) && existsSync(bin) ? bin : undefined
  }

  /** The binary to spawn: bundled first, then downloaded. Throws
   *  RuntimeMissingError when neither exists so the chat runtime can show
   *  the download card instead of a generic spawn failure. */
  resolveBinary(kind: DownloadableRuntime): string {
    const bundled = this.bundledBinary(kind)
    if (bundled) return bundled
    const installed = this.installedBinary(kind)
    if (installed) return installed
    throw new RuntimeMissingError(kind)
  }

  status(kind: DownloadableRuntime): RuntimeStatus {
    if (this.bundledBinary(kind)) return { state: 'bundled' }
    const entry = this.entry(kind)
    if (!entry) {
      return {
        state: 'error',
        version: 'unknown',
        error: `No ${kind} runtime is published for ${this.platform}`
      }
    }
    if (this.installedBinary(kind)) return { state: 'ready', version: entry.version }
    return { state: 'missing', version: entry.version, sizeBytes: entry.unpackedSize }
  }

  /** Dispatch the current status of every downloadable runtime. */
  publishStatuses(): void {
    for (const kind of DOWNLOADABLE_RUNTIMES) {
      this.dispatch(kind, this.status(kind))
    }
  }

  private dispatch(agentKind: DownloadableRuntime, status: RuntimeStatus): void {
    this.store.dispatch({ type: 'runtimes/statusChanged', payload: { agentKind, status } })
  }

  /** Download, verify and unpack one runtime. Concurrent calls for the same
   *  runtime share the in-flight promise. Resolves when the binary is ready;
   *  rejects (after dispatching an error status) on any failure. */
  download(kind: DownloadableRuntime): Promise<void> {
    const existing = this.inFlight.get(kind)
    if (existing) return existing
    const run = this._download(kind).finally(() => this.inFlight.delete(kind))
    this.inFlight.set(kind, run)
    return run
  }

  /** Drop installs of the same package at other versions so a version bump
   *  does not leave 100+ MB behind in userData. */
  private async removeOtherVersions(entry: RuntimeManifestEntry): Promise<void> {
    const prefix = `${entry.package.replace('/', '+')}@`
    const keep = installDirName(entry)
    let names: string[]
    try {
      names = readdirSync(this.installRoot)
    } catch {
      return
    }
    for (const name of names) {
      if (name.startsWith(prefix) && name !== keep && name !== `${keep}.partial`) {
        await rm(join(this.installRoot, name), { recursive: true, force: true }).catch(() => {})
      }
    }
  }

  private async _download(kind: DownloadableRuntime): Promise<void> {
    const current = this.status(kind)
    if (current.state === 'bundled' || current.state === 'ready') return
    const entry = this.entry(kind)
    if (!entry) {
      this.dispatch(kind, current)
      throw new Error(`No ${kind} runtime is published for ${this.platform}`)
    }
    const finalDir = this.installDir(entry)
    const tmpDir = `${finalDir}.partial`
    try {
      await rm(tmpDir, { recursive: true, force: true })
      mkdirSync(tmpDir, { recursive: true })
      this.dispatch(kind, {
        state: 'downloading',
        version: entry.version,
        receivedBytes: 0,
        totalBytes: null
      })

      const res = await this.fetchFn(entry.tarball)
      if (!res.ok || !res.body) {
        throw new Error(`Download failed: HTTP ${res.status} for ${entry.tarball}`)
      }
      const totalBytes = Number(res.headers.get('content-length')) || null
      const { algorithm, digest } = parseIntegrity(entry.integrity)
      const hash = createHash(algorithm)
      let received = 0
      let lastProgress = 0
      const onChunk = (chunk: Buffer): void => {
        hash.update(chunk)
        received += chunk.length
        const now = Date.now()
        if (now - lastProgress >= this.progressIntervalMs) {
          lastProgress = now
          this.dispatch(kind, {
            state: 'downloading',
            version: entry.version,
            receivedBytes: received,
            totalBytes
          })
        }
      }
      const source = Readable.fromWeb(res.body as never)
      const tap = async function* (chunks: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
        for await (const chunk of chunks) {
          onChunk(chunk)
          yield chunk
        }
      }
      // npm tarballs wrap everything in a top-level `package/` dir.
      await pipeline(source, tap, tar.x({ cwd: tmpDir, strip: 1 }))

      const actual = hash.digest('base64')
      if (actual !== digest) {
        throw new Error(
          `Integrity check failed for ${entry.package}@${entry.version}: ` +
            `expected ${algorithm}-${digest}, got ${algorithm}-${actual}`
        )
      }
      const bin = join(tmpDir, entry.binary)
      if (!existsSync(bin)) {
        throw new Error(`Tarball for ${entry.package}@${entry.version} has no ${entry.binary}`)
      }
      // Codex ships helper executables next to the main binary
      // (codex-code-mode-host); the bin dir is executables only.
      for (const f of readdirSync(dirname(bin))) {
        await chmod(join(dirname(bin), f), 0o755)
      }
      await rm(finalDir, { recursive: true, force: true })
      await rename(tmpDir, finalDir)
      writeFileSync(join(finalDir, '.ok'), `${entry.integrity}\n`)
      await this.removeOtherVersions(entry)
      this.dispatch(kind, { state: 'ready', version: entry.version })
    } catch (err) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      const error = err instanceof Error ? err.message : String(err)
      this.dispatch(kind, { state: 'error', version: entry.version, error })
      throw err
    }
  }
}

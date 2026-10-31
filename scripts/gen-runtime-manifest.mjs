#!/usr/bin/env node
// Writes resources/runtime-manifest.json: for every platform the desktop app
// ships, the exact npm tarball, version and lockfile integrity hash of the
// OpenCode and Codex native packages the main process downloads on first chat
// use (src/main/runtime-downloader). Versions come from package.json and the
// hashes from pnpm-lock.yaml, so the download can never drift from what the
// headless tarball bundles. Runs at the start of `pnpm run build`.
//
// `unpackedSize` is looked up from the npm registry so the download card can
// show a size before the user agrees to the download. The lookup is
// best-effort: offline builds keep the previous manifest's sizes or null.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLATFORM_PACKAGES } from './runtime-closure.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'resources', 'runtime-manifest.json')
const REGISTRY = 'https://registry.npmjs.org'

export function tarballUrl(name, version) {
  const base = name.includes('/') ? name.split('/')[1] : name
  return `${REGISTRY}/${name}/-/${base}-${version}.tgz`
}

/** pnpm-lock.yaml `packages:` entries are keyed `name@version:` (quoted when
 *  scoped) and carry `resolution: {integrity: sha512-...}` on the next lines. */
export function lockIntegrity(lockText, name, version) {
  const key = `${name}@${version}`
  const escaped = key.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const start = lockText.match(new RegExp(`^  '?${escaped}'?:\\n`, 'm'))
  if (!start) throw new Error(`pnpm-lock.yaml has no integrity for ${key} (no such entry)`)
  // The entry body is every following line indented deeper than the key;
  // the first line at key depth (or blank) starts the next entry.
  const body = lockText.slice(start.index + start[0].length).match(/^(?:    .*\n?)*/)[0]
  const m = body.match(/resolution: \{integrity: (sha\d+-[A-Za-z0-9+/=]+)/)
  if (!m) throw new Error(`pnpm-lock.yaml has no integrity for ${key}`)
  return m[1]
}

/** The downloadable runtime packages for one platform key. Codex's platform
 *  builds are published as npm aliases of `@openai/codex` itself, versioned
 *  `<version>-<os>-<arch>`, which is also how pnpm-lock.yaml records them. */
export function runtimePackagesForPlatform(platform, { opencodeVersion, codexVersion }) {
  const pkgs = PLATFORM_PACKAGES[platform]
  if (!pkgs) throw new Error(`Unsupported platform: ${platform}`)
  return {
    opencode: {
      package: pkgs.opencodePlatform,
      version: opencodeVersion,
      binary: 'bin/opencode'
    },
    codex: {
      package: '@openai/codex',
      version: `${codexVersion}-${platform}`,
      binary: `vendor/${pkgs.codexTriple}/bin/${pkgs.codexBin}`
    }
  }
}

export function buildManifest({ packageJson, lockText, previous = null, sizes = {} }) {
  const opencodeVersion = packageJson.dependencies['opencode-ai']
  const codexVersion = packageJson.pnpm?.overrides?.['@openai/codex']
  if (!opencodeVersion || !codexVersion) {
    throw new Error('package.json must pin opencode-ai and pnpm.overrides["@openai/codex"]')
  }
  const runtimes = {}
  for (const platform of Object.keys(PLATFORM_PACKAGES)) {
    const entries = runtimePackagesForPlatform(platform, { opencodeVersion, codexVersion })
    runtimes[platform] = {}
    for (const [kind, entry] of Object.entries(entries)) {
      const id = `${entry.package}@${entry.version}`
      const prev = previous?.runtimes?.[platform]?.[kind]
      runtimes[platform][kind] = {
        ...entry,
        tarball: tarballUrl(entry.package, entry.version),
        integrity: lockIntegrity(lockText, entry.package, entry.version),
        unpackedSize:
          sizes[id] ?? (prev && `${prev.package}@${prev.version}` === id ? prev.unpackedSize : null)
      }
    }
  }
  return { schemaVersion: 1, runtimes }
}

async function fetchUnpackedSize(name, version, fetchFn) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    const res = await fetchFn(`${REGISTRY}/${name}/${version}`, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return null
    const json = await res.json()
    return typeof json?.dist?.unpackedSize === 'number' ? json.dist.unpackedSize : null
  } catch {
    return null
  }
}

export async function generate({ fetchFn = globalThis.fetch, lookupSizes = true } = {}) {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const lockText = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
  const previous = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : null
  const draft = buildManifest({ packageJson, lockText, previous })
  const sizes = {}
  if (lookupSizes) {
    const wanted = new Map()
    for (const byKind of Object.values(draft.runtimes)) {
      for (const e of Object.values(byKind)) {
        if (e.unpackedSize == null) wanted.set(`${e.package}@${e.version}`, e)
      }
    }
    await Promise.all(
      [...wanted.entries()].map(async ([id, e]) => {
        const size = await fetchUnpackedSize(e.package, e.version, fetchFn)
        if (size != null) sizes[id] = size
      })
    )
  }
  const manifest = buildManifest({ packageJson, lockText, previous, sizes })
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  const missing = Object.values(manifest.runtimes)
    .flatMap((byKind) => Object.values(byKind))
    .filter((e) => e.unpackedSize == null).length
  console.log(
    `[runtime-manifest] wrote ${manifestPath}` + (missing ? ` (${missing} sizes unknown)` : '')
  )
  return manifest
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  generate({ lookupSizes: process.env.RUNTIME_MANIFEST_OFFLINE !== '1' }).catch((err) => {
    console.error(`[runtime-manifest] ${err.stack ?? err}`)
    process.exit(1)
  })
}

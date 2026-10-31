#!/usr/bin/env node
// First-use runtime download smoke. Exercises the exact path the packaged
// desktop app takes when a user opens their first OpenCode or Codex chat tab:
// read resources/runtime-manifest.json, download each native package for the
// host platform from the npm registry, verify the lockfile integrity hash,
// unpack, then boot the binary credential-free (`opencode acp` must stay
// alive; codex-acp over node with CODEX_PATH must stay alive).
//
// Runs in build-mac.yml / build-linux.yml / release.yml after the desktop
// smoke so a manifest that points at a bad tarball, a wrong hash, or a
// package layout change is caught before a release ships. Needs network.
//
// Usage: node scripts/smoke-runtime-download.mjs

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import * as tar from 'tar'
import { PLATFORM_PACKAGES } from './runtime-closure.mjs'
import { spawnBounded } from './smoke-bundled-runtimes.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'resources', 'runtime-manifest.json')

function hostPlatform() {
  const { platform, arch } = process
  if ((platform === 'darwin' || platform === 'linux') && (arch === 'arm64' || arch === 'x64')) {
    return `${platform}-${arch}`
  }
  return null
}

async function downloadAndVerify(entry, destDir) {
  mkdirSync(destDir, { recursive: true })
  const res = await fetch(entry.tarball)
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${entry.tarball}`)
  const [algorithm, expected] = entry.integrity.split(/-(.+)/)
  const hash = createHash(algorithm)
  const tap = async function* (chunks) {
    for await (const chunk of chunks) {
      hash.update(chunk)
      yield chunk
    }
  }
  await pipeline(Readable.fromWeb(res.body), tap, tar.x({ cwd: destDir, strip: 1 }))
  const actual = hash.digest('base64')
  if (actual !== expected) {
    throw new Error(`integrity mismatch for ${entry.package}@${entry.version}: ${actual}`)
  }
  const bin = join(destDir, entry.binary)
  if (!existsSync(bin)) throw new Error(`no ${entry.binary} in ${entry.package}@${entry.version}`)
  chmodSync(bin, 0o755)
  return bin
}

async function main() {
  const platform = hostPlatform()
  if (!platform) {
    console.log(`[smoke-download] unsupported host ${process.platform}-${process.arch}, skipping`)
    return
  }
  if (!existsSync(manifestPath)) {
    console.error(`[smoke-download] ${manifestPath} missing; run node scripts/gen-runtime-manifest.mjs`)
    process.exit(1)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const entries = manifest.runtimes?.[platform]
  if (!entries?.opencode || !entries?.codex) {
    console.error(`[smoke-download] manifest has no ${platform} entries`)
    process.exit(1)
  }
  const work = mkdtempSync(join(tmpdir(), 'harness-runtime-download-'))
  const results = []
  try {
    for (const kind of ['opencode', 'codex']) {
      const entry = entries[kind]
      const dest = join(work, kind)
      console.log(`[smoke-download] fetching ${entry.package}@${entry.version}`)
      const bin = await downloadAndVerify(entry, dest)
      console.log(`[smoke-download] ${kind}: verified ${entry.integrity.slice(0, 16)}…`)
      let result
      if (kind === 'opencode') {
        result = await spawnBounded([bin, 'acp'])
      } else {
        const acpRequire = (await import('node:module')).createRequire(join(root, 'package.json'))
        const script = acpRequire.resolve('@agentclientprotocol/codex-acp/dist/index.js')
        result = await spawnBounded([process.execPath, script], {
          CODEX_PATH: bin,
          ELECTRON_RUN_AS_NODE: '1'
        })
      }
      console.log(`[smoke-download] ${kind}: ${result.ok ? 'booted' : result.code}`)
      results.push({ kind, ...result })
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  if (results.some((r) => !r.ok)) process.exit(1)
  console.log(`[smoke-download] all downloaded runtimes booted OK (${Object.keys(PLATFORM_PACKAGES).length} platforms in manifest)`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`[smoke-download] ${err.stack ?? err}`)
    process.exit(1)
  })
}

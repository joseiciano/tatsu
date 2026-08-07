#!/usr/bin/env node
// Extracts the generated headless tarball and validates that the staged
// runtime dependency closure is complete and functional.
//
// Checks:
//   1. Every file the resolver expects is present (opencode binary,
//      codex-acp script, @openai/codex base, codex native binary,
//      node-pty, ws, claude-agent-sdk, claude binary).
//   2. Each native binary has the executable bit.
//   3. OpenCode ACP subprocess spawns and stays alive briefly (auth-free).
//   4. Codex ACP subprocess spawns and stays alive briefly (auth-free).
//
// This validates the *actual tarball* rather than repo node_modules, so
// it catches packaging regressions (missing packages, dangling symlinks,
// stripped permissions) that a repo-only smoke would miss.
//
// Run after `pnpm run pack:headless`:
//   node scripts/smoke-packed-runtimes.mjs

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as tar from 'tar'
import {
  PLATFORM_PACKAGES,
  validateStagedRuntimeClosure
} from './runtime-closure.mjs'
import { spawnBounded } from './smoke-bundled-runtimes.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const releaseDir = join(root, 'release', 'headless')

function detectPlatform() {
  const p = process.platform
  const a = process.arch
  if (p === 'darwin' && a === 'arm64') return 'darwin-arm64'
  if (p === 'linux' && a === 'x64') return 'linux-x64'
  if (p === 'linux' && a === 'arm64') return 'linux-arm64'
  return null
}

async function findTarball(platform) {
  const files = await readdir(releaseDir)
  const pattern = new RegExp(
    `harness-server-.*-${platform.replace(/-/g, '\\-')}\\.tar\\.gz$`
  )
  const match = files.find((f) => pattern.test(f))
  if (!match) {
    throw new Error(`No tarball found for ${platform} in ${releaseDir}`)
  }
  return join(releaseDir, match)
}

async function main() {
  const platform = detectPlatform()
  if (!platform) {
    console.log(
      `[validate-packed] unsupported host ${process.platform}-${process.arch}, skipping`
    )
    process.exit(0)
  }

  const tarball = await findTarball(platform)
  const tmpDir = await mkdtemp(join(tmpdir(), 'harness-packed-'))
  try {
    console.log(`[validate-packed] extracting ${basename(tarball)}`)
    await tar.x({ file: tarball, cwd: tmpDir })

    const entries = await readdir(tmpDir)
    const stageRoot = join(tmpDir, entries[0])
    const libDir = join(stageRoot, 'lib')

    console.log(`[validate-packed] validating staged closure`)
    const errors = validateStagedRuntimeClosure({ libDir, platform })
    if (errors.length > 0) {
      for (const e of errors) console.error(`[validate-packed] ${e}`)
      process.exit(1)
    }

    const nm = join(libDir, 'node_modules')
    const pkgs = PLATFORM_PACKAGES[platform]

    // Spawn opencode from staged layout
    const openCodePath = join(nm, 'opencode-ai', 'bin', pkgs.opencodeBin)
    console.log(`[validate-packed] spawning opencode from staged layout`)
    const openCodeResult = await spawnBounded([openCodePath, 'acp'])
    console.log(
      `[validate-packed] opencode: ${openCodeResult.ok ? 'booted' : openCodeResult.code}`
    )

    // Spawn codex from staged layout
    const codexScript = join(
      nm,
      '@agentclientprotocol',
      'codex-acp',
      'dist',
      'index.js'
    )
    const codexNative = join(
      nm,
      '@openai',
      pkgs.codexPlatform,
      'vendor',
      pkgs.codexTriple,
      'bin',
      pkgs.codexBin
    )
    const nodeBin = existsSync(join(libDir, 'node'))
      ? join(libDir, 'node')
      : process.execPath
    console.log(`[validate-packed] spawning codex from staged layout`)
    const codexResult = await spawnBounded(
      [nodeBin, codexScript],
      { CODEX_PATH: codexNative, ELECTRON_RUN_AS_NODE: '1' }
    )
    console.log(
      `[validate-packed] codex: ${codexResult.ok ? 'booted' : codexResult.code}`
    )

    if (!openCodeResult.ok || !codexResult.ok) {
      process.exit(1)
    }
    console.log(`[validate-packed] all staged runtimes booted OK`)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('[validate-packed] failed:', err.message)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})

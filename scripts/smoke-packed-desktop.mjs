#!/usr/bin/env node
// Packaged-desktop runtime smoke. Finds the unpacked Electron app that
// electron-builder wrote under release/ for the host platform, validates the
// runtime closure staged at <Resources>/runtimes by scripts/electron-after-pack.mjs,
// and boots each bundled runtime credential-free:
//   - claude:   `claude --version` must exit 0
//   - opencode: `opencode acp` must stay alive past the boot grace window
//   - codex:    codex-acp over node with CODEX_PATH must stay alive too
//
// Usage: node scripts/smoke-packed-desktop.mjs [<path to Resources dir>]
// Runs in build-mac.yml / build-linux.yml / release.yml right after packaging,
// before artifacts are uploaded, so a release can never ship without its
// bundled agents.

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeExecutables, validateStagedRuntimeClosure } from './runtime-closure.mjs'
import { spawnBounded } from './smoke-bundled-runtimes.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function hostPlatform() {
  const { platform, arch } = process
  if ((platform === 'darwin' || platform === 'linux') && (arch === 'arm64' || arch === 'x64')) {
    return `${platform}-${arch}`
  }
  return null
}

/** Locate the Resources dir of the unpacked app for the host platform. */
export function findResourcesDir(releaseDir, platform) {
  if (platform.startsWith('darwin')) {
    // electron-builder writes mac-arm64/ for arm64 and mac/ for x64.
    const dir = platform === 'darwin-arm64' ? 'mac-arm64' : 'mac'
    const appOut = join(releaseDir, dir)
    if (!existsSync(appOut)) return null
    const app = readdirSync(appOut).find((f) => f.endsWith('.app'))
    return app ? join(appOut, app, 'Contents', 'Resources') : null
  }
  const dir = platform === 'linux-arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked'
  const appOut = join(releaseDir, dir, 'resources')
  return existsSync(appOut) ? appOut : null
}

function runExpectExit0(command, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env }
    })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ ok: false, code: 'timeout' })
    }, 20000)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, code: `error: ${err.message}` })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code: code === 0 ? 'ok' : `exited ${code} ${stderr.slice(0, 300)}` })
    })
  })
}

async function main() {
  const platform = hostPlatform()
  if (!platform) {
    console.log(`[smoke-desktop] unsupported host ${process.platform}-${process.arch}, skipping`)
    return
  }
  const resourcesDir = process.argv[2] ?? findResourcesDir(join(root, 'release'), platform)
  if (!resourcesDir || !existsSync(resourcesDir)) {
    console.error(`[smoke-desktop] no packaged app found for ${platform} under release/`)
    process.exit(1)
  }
  const libDir = join(resourcesDir, 'runtimes')
  console.log(`[smoke-desktop] validating ${libDir}`)
  const errors = validateStagedRuntimeClosure({ libDir, platform, target: 'desktop' })
  if (errors.length > 0) {
    for (const e of errors) console.error(`[smoke-desktop] ${e}`)
    process.exit(1)
  }
  const exe = runtimeExecutables(libDir, platform, { target: 'desktop' })

  const results = []
  console.log('[smoke-desktop] running claude --version')
  const claude = await runExpectExit0([exe.claude, '--version'])
  results.push({ name: 'claude', ...claude })
  console.log(`[smoke-desktop] claude: ${claude.code}`)

  console.log('[smoke-desktop] spawning opencode acp')
  const opencode = await spawnBounded([exe.opencode, 'acp'])
  results.push({ name: 'opencode', ...opencode })
  console.log(`[smoke-desktop] opencode: ${opencode.ok ? 'booted' : opencode.code}`)

  console.log('[smoke-desktop] spawning codex-acp')
  const codex = await spawnBounded([process.execPath, exe.codexAcpScript], {
    CODEX_PATH: exe.codex,
    ELECTRON_RUN_AS_NODE: '1'
  })
  results.push({ name: 'codex', ...codex })
  console.log(`[smoke-desktop] codex: ${codex.ok ? 'booted' : codex.code}`)

  if (results.some((r) => !r.ok)) {
    process.exit(1)
  }
  console.log('[smoke-desktop] all bundled desktop runtimes OK')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`[smoke-desktop] ${err.stack ?? err}`)
    process.exit(1)
  })
}

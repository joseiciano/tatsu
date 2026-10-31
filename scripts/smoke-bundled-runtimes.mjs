#!/usr/bin/env node
// Credential-free smoke for the bundled OpenCode and Codex ACP runtimes.
//
// Asserts:
//   1. Each bundled runtime's executable/script resolves from node_modules
//      (the exact paths BundledRuntimeResolver returns at runtime).
//   2. Each ACP stdio subprocess actually spawns and stays alive briefly,
//      without requiring any auth handshake.
//
// It does NOT drive a full initialize/session round-trip — auth-free spawn is
// the goal, matching the packaged "runtime resolves + boots" smoke coverage in
// the plan. Processes are bounded to a short window and killed cleanly so CI
// never leaks zombies.
//
// Platform-aware: on darwin/linux x64/arm64 it checks the matching bundled
// binary; anywhere else (win32, ia32, ...) it skips with exit 0 since those
// targets aren't shipped.
//
// Run: node scripts/smoke-bundled-runtimes.mjs

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const require = createRequire(import.meta.url)

const BOOT_GRACE_MS = 3000

/** Map of @openai/codex optional-dep → vendor target triple, same as the
 *  BundledRuntimeResolver / codex.js unified entry. */
const TRIPLE_BY_TARGET = {
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64'
}

function targetTriple(platform, arch) {
  if (platform === 'darwin') return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  if (platform === 'linux') return arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl'
  return null
}

/** Resolve the three bundled runtime paths for the current host. Returns null
 *  (with a reason) when the platform/arch isn't supported or a bundle is
 *  missing. Never touches PATH/global CLIs. */
export function resolveBundledRuntimes({
  platform = process.platform,
  arch = process.arch,
  resolve = (id) => require.resolve(id),
  execRoot = root
} = {}) {
  const triple = targetTriple(platform, arch)
  if (!triple) return { supported: false, reason: `unsupported platform ${platform}-${arch}` }

  const openCode = join(execRoot, 'node_modules/opencode-ai/bin/opencode.exe')

  let codexScript
  let codexNative
  try {
    // @openai/codex is a dep of @agentclientprotocol/codex-acp, so anchor its
    // resolution at the codex-acp script (matches BundledRuntimeResolver).
    codexScript = resolve('@agentclientprotocol/codex-acp/dist/index.js')
    const acpRequire = createRequire(codexScript)
    const basePkg = acpRequire.resolve('@openai/codex/package.json')
    const baseDir = dirname(basePkg)
    const baseRequire = createRequire(join(baseDir, 'noop.js'))
    const platformPkg = baseRequire.resolve(
      `${TRIPLE_BY_TARGET[triple]}/package.json`
    )
    codexNative = join(dirname(platformPkg), 'vendor', triple, 'bin', 'codex')
  } catch (err) {
    return {
      supported: true,
      reason: `codex bundle resolution failed: ${err.message}`,
      openCode,
      codexScript: null,
      codexNative: null
    }
  }

  return {
    supported: true,
    openCode,
    codexScript,
    codexNative,
    codexEnv: () => ({
      ELECTRON_RUN_AS_NODE: '1',
      CODEX_PATH: codexNative
    })
  }
}

/** Spawn a process, wait BOOT_GRACE_MS to confirm it didn't die immediately
 *  (auth-free boot), then SIGKILL it. Resolves {ok, code} — ok=false when the
 *  process exited before the grace window (spawn/bootstrap failure). */
export function spawnBounded(command, env = {}, { bootGraceMs = BOOT_GRACE_MS, spawnFn = spawn } = {}) {
  return new Promise((resolvePromise) => {
    let settled = false
    let safetyTimer = null
    // Keep stdin piped and open so the ACP process blocks waiting for frames
    // (with stdio:'ignore' stdin closes → the agent exits 0 immediately).
    const child = spawnFn(command[0], command.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env }
    })
    const settle = (ok, code) => {
      if (settled) return
      settled = true
      if (safetyTimer) clearTimeout(safetyTimer)
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      resolvePromise({ ok, code })
    }
    child.on('error', (err) => settle(false, `error: ${err.message}`))
    child.on('exit', (code) => settle(false, `exited ${code}`))
    child.on('spawn', () => {
      // Alive past spawn. Wait the grace window to prove it booted without
      // exiting (auth failure would normally exit quickly with stderr).
      setTimeout(() => settle(true, 'booted'), bootGraceMs)
    })
    // Hard safety net so a hung spawn can never block CI forever.
    safetyTimer = setTimeout(() => settle(false, 'timeout'), bootGraceMs + 10000)
  })
}

/** Run the whole credential-free bundled-runtime smoke. Returns an array of
 *  { name, ok, detail } results. */
export async function runBundledRuntimeSmoke(opts = {}) {
  const resolved = resolveBundledRuntimes(opts)
  if (!resolved.supported) {
    return [{ name: 'platform', ok: true, detail: `skipped: ${resolved.reason}` }]
  }
  const results = []

  if (!resolved.openCode || !existsSync(resolved.openCode)) {
    results.push({ name: 'opencode', ok: false, detail: `missing opencode launcher: ${resolved.openCode}` })
  } else {
    const r = await spawnBounded([resolved.openCode, 'acp'], {}, opts)
    results.push({ name: 'opencode', ok: r.ok, detail: `${r.ok ? 'booted' : r.code}: ${resolved.openCode}` })
  }

  if (!resolved.codexScript || !resolved.codexNative) {
    results.push({ name: 'codex', ok: false, detail: resolved.reason || 'missing codex bundle' })
  } else {
    const r = await spawnBounded(
      [process.execPath, resolved.codexScript],
      resolved.codexEnv(process.env),
      opts
    )
    results.push({ name: 'codex', ok: r.ok, detail: `${r.ok ? 'booted' : r.code}: ${resolved.codexScript} (CODEX_PATH=${resolved.codexNative})` })
  }

  return results
}

// Run only when invoked directly (not when imported by the unit test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const results = await runBundledRuntimeSmoke()
  for (const r of results) {
    console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.name}: ${r.detail}`)
  }
  const failed = results.filter((r) => !r.ok)
  if (failed.length > 0) {
    process.exit(1)
  }
}

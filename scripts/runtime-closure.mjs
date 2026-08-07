import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { existsSync, statSync as _statSync } from 'node:fs'
import { cp, mkdir, chmod } from 'node:fs/promises'

/** Platform-scoped runtime packages that must be staged into the headless
 *  tarball so the bundled ACP runtimes resolve without touching the host
 *  package lock or global CLI. */
export const PLATFORM_PACKAGES = {
  'darwin-arm64': {
    claudePlatform: '@anthropic-ai/claude-agent-sdk-darwin-arm64',
    codexPlatform: '@openai/codex-darwin-arm64',
    codexTriple: 'aarch64-apple-darwin',
    codexBin: 'codex',
    opencodePlatform: 'opencode-darwin-arm64',
    opencodeBin: 'opencode.exe'
  },
  'linux-x64': {
    claudePlatform: '@anthropic-ai/claude-agent-sdk-linux-x64',
    codexPlatform: '@openai/codex-linux-x64',
    codexTriple: 'x86_64-unknown-linux-musl',
    codexBin: 'codex',
    opencodePlatform: 'opencode-linux-x64',
    opencodeBin: 'opencode.exe'
  },
  'linux-arm64': {
    claudePlatform: '@anthropic-ai/claude-agent-sdk-linux-arm64',
    codexPlatform: '@openai/codex-linux-arm64',
    codexTriple: 'aarch64-unknown-linux-musl',
    codexBin: 'codex',
    opencodePlatform: 'opencode-linux-arm64',
    opencodeBin: 'opencode.exe'
  }
}

/** Runtime deps of @agentclientprotocol/codex-acp that must ship alongside it
 *  so its stdio entry resolves `require('...')` from the staged flat
 *  node_modules at run time (not just the resolver's anchor packages). */
export const CODEX_ACP_DEPS = [
  '@agentclientprotocol/sdk',
  'diff',
  'open',
  'vscode-jsonrpc',
  'zod'
]

/** Return the full list of runtime packages that must be staged for a
 *  given target platform. */
export function runtimeClosureForPlatform(platform) {
  const pkgs = PLATFORM_PACKAGES[platform]
  if (!pkgs) throw new Error(`Unsupported platform: ${platform}`)
  return {
    ...pkgs,
    packages: [
      'node-pty',
      'ws',
      '@anthropic-ai/claude-agent-sdk',
      pkgs.claudePlatform,
      'opencode-ai',
      pkgs.opencodePlatform,
      '@agentclientprotocol/codex-acp',
      '@openai/codex',
      pkgs.codexPlatform,
      ...CODEX_ACP_DEPS
    ]
  }
}

/** Resolve the real on-disk directory for an npm package using
 *  `require.resolve` so pnpm symlinks are followed automatically.
 *  Falls back to walking up from the main entry when the package does
 *  not export `./package.json` (e.g. `@anthropic-ai/claude-agent-sdk`).
 *  The optional `resolve` injectable makes this testable. */
export function resolvePackageDir(
  pkgName,
  fromFile,
  resolve = (id) => createRequire(fromFile).resolve(id),
  _existsSync = existsSync
) {
  try {
    const pkgJson = resolve(`${pkgName}/package.json`)
    return dirname(pkgJson)
  } catch (err) {
    if (err.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      const mainFile = resolve(pkgName)
      let dir = dirname(mainFile)
      while (true) {
        const candidate = join(dir, 'package.json')
        if (_existsSync(candidate)) {
          return dir
        }
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
      throw new Error(`Could not find package.json for ${pkgName}`)
    }
    throw err
  }
}

/** Copy the full runtime dependency closure into `libDir/node_modules`.
 *  Uses `dereference: true` so pnpm symlinks are resolved to real files
 *  and the tarball is self-contained (no dangling symlinks into the
 *  host `.pnpm` store). */
export async function stageRuntimeClosure({ repoRoot, libDir, platform }) {
  const { packages } = runtimeClosureForPlatform(platform)
  const pkgs = PLATFORM_PACKAGES[platform]
  const destRoot = join(libDir, 'node_modules')
  await mkdir(destRoot, { recursive: true })

  for (const name of packages) {
    let src
    if (name === '@openai/codex') {
      // Resolve from codex-acp's dist dir so pnpm hoisting is followed
      const codexAcpDir = resolvePackageDir(
        '@agentclientprotocol/codex-acp',
        join(repoRoot, 'package.json')
      )
      src = resolvePackageDir('@openai/codex', join(codexAcpDir, 'dist', 'index.js'))
    } else if (name.startsWith('@anthropic-ai/claude-agent-sdk-')) {
      // The platform package is an optional dep of the base package;
      // resolve it from the base package's main entry so pnpm hoisting
      // is followed.
      const baseMain = resolvePackageDir(
        '@anthropic-ai/claude-agent-sdk',
        join(repoRoot, 'package.json')
      )
      src = resolvePackageDir(name, join(baseMain, 'sdk.mjs'))
    } else if (name.startsWith('@openai/codex-')) {
      // Resolve @openai/codex base from codex-acp's dist dir, then the
      // platform package from the base dir.
      const codexAcpDir = resolvePackageDir(
        '@agentclientprotocol/codex-acp',
        join(repoRoot, 'package.json')
      )
      const codexBaseDir = resolvePackageDir(
        '@openai/codex',
        join(codexAcpDir, 'dist', 'index.js')
      )
      src = resolvePackageDir(name, join(codexBaseDir, 'package.json'))
    } else if (name === pkgs.opencodePlatform) {
      // The opencode platform package (native binary provider) is an
      // optional dep of opencode-ai; resolve from its declaring dir.
      const opencodeDir = resolvePackageDir(
        'opencode-ai',
        join(repoRoot, 'package.json')
      )
      src = resolvePackageDir(name, join(opencodeDir, 'package.json'))
    } else if (CODEX_ACP_DEPS.includes(name)) {
      // codex-acp runtime deps are hoisted to the repo root under pnpm's
      // hoisted linker (CI); in an isolated install they live in codex-acp's
      // own scope, so fall back to resolving from its dist dir.
      const codexAcpDir = resolvePackageDir(
        '@agentclientprotocol/codex-acp',
        join(repoRoot, 'package.json')
      )
      try {
        src = resolvePackageDir(name, join(repoRoot, 'package.json'))
      } catch {
        src = resolvePackageDir(name, join(codexAcpDir, 'dist', 'index.js'))
      }
    } else {
      src = resolvePackageDir(name, join(repoRoot, 'package.json'))
    }

    if (!existsSync(src)) {
      throw new Error(
        `runtime package missing: ${name} (resolved to ${src})`
      )
    }

    const dest = join(destRoot, name)
    await cp(src, dest, {
      recursive: true,
      dereference: true,
      filter: (path) => {
        // Allow the root directory itself — cp calls the filter for it.
        if (path === src) return true
        if (!path.startsWith(src + '/')) return true
        const rel = path.slice(src.length + 1)
        if (rel.includes('node_modules')) return false
        if (rel.endsWith('.tsbuildinfo')) return false
        if (rel.includes('/build/Release/obj.target')) return false
        if (rel.includes('/build/Release/.deps')) return false
        return true
      }
    })
  }

  // Ensure native executables have the executable bit — cp preserves
  // mode in most cases, but explicit chmod is a safety net for
  // filesystems that strip bits during copy.
  const nm = join(destRoot)
  const executables = [
    join(nm, 'opencode-ai', 'bin', pkgs.opencodeBin),
    join(nm, pkgs.claudePlatform, 'claude'),
    join(
      nm,
      '@openai',
      pkgs.codexPlatform,
      'vendor',
      pkgs.codexTriple,
      'bin',
      pkgs.codexBin
    )
  ]
  for (const exe of executables) {
    if (existsSync(exe)) {
      await chmod(exe, 0o755)
    }
  }
}

/** Validate that every file the resolver expects is present in the staged
 *  `libDir/node_modules`. Returns an array of error strings (empty when
 *  everything is correct).  Injectable `existsSync` / `statSync` for tests. */
export function validateStagedRuntimeClosure({
  libDir,
  platform,
  existsSync: _existsSync = existsSync,
  statSync: __statSync = _statSync
}) {
  const pkgs = PLATFORM_PACKAGES[platform]
  if (!pkgs) throw new Error(`Unsupported platform: ${platform}`)

  const nm = join(libDir, 'node_modules')
  const checks = [
    {
      path: join(nm, 'opencode-ai', 'bin', pkgs.opencodeBin),
      exec: true,
      label: 'opencode binary'
    },
    {
      path: join(nm, pkgs.opencodePlatform, 'package.json'),
      exec: false,
      label: 'opencode platform package'
    },
    {
      path: join(nm, '@agentclientprotocol', 'codex-acp', 'dist', 'index.js'),
      exec: false,
      label: 'codex-acp script'
    },
    {
      path: join(nm, '@openai', 'codex', 'package.json'),
      exec: false,
      label: '@openai/codex base'
    },
    {
      path: join(
        nm,
        pkgs.codexPlatform,
        'vendor',
        pkgs.codexTriple,
        'bin',
        pkgs.codexBin
      ),
      exec: true,
      label: 'codex native binary'
    },
    {
      path: join(nm, 'node-pty', 'package.json'),
      exec: false,
      label: 'node-pty'
    },
    { path: join(nm, 'ws', 'package.json'), exec: false, label: 'ws' },
    {
      path: join(nm, '@anthropic-ai', 'claude-agent-sdk', 'package.json'),
      exec: false,
      label: 'claude-agent-sdk'
    },
    {
      path: join(nm, pkgs.claudePlatform, 'claude'),
      exec: true,
      label: 'claude binary'
    }
  ]

  // codex-acp resolves its runtime deps from the flat staged node_modules;
  // verify each is present so a missing transitive dep fails the pack before
  // it becomes a tarball that can't boot codex ACP.
  for (const dep of CODEX_ACP_DEPS) {
    checks.push({
      path: join(nm, ...dep.split('/'), 'package.json'),
      exec: false,
      label: `codex-acp dep ${dep}`
    })
  }

  const errors = []
  for (const c of checks) {
    if (!_existsSync(c.path)) {
      errors.push(`missing ${c.label}: ${c.path}`)
      continue
    }
    if (c.exec) {
      const stat = __statSync(c.path)
      if ((stat.mode & 0o111) === 0) {
        errors.push(`not executable ${c.label}: ${c.path}`)
      }
    }
  }
  return errors
}

// electron-builder `afterPack` hook. Stages the per-arch desktop runtime
// closure (Claude native binary, Codex ACP script + deps) into the packaged
// app's `Resources/runtimes` so the main process resolves bundled executables
// from `process.resourcesPath` instead of app.asar.unpacked. The OpenCode and
// Codex native binaries are not staged; the app downloads them on first chat
// use (src/main/runtime-downloader).
//
// electron-builder's pnpm dependency collector only finds a package's
// optional dependencies when they are hoisted to the root node_modules; the
// platform packages live in `.pnpm/`, so without this hook the app ships
// without the Claude native package. Staging here also keeps the other
// arch's binaries out of each DMG (the mac CI install carries both).
//
// Runs before signing, so on macOS the staged Mach-O executable is added to
// `mac.binaries` for codesign + notarization.

import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  runtimeExecutables,
  stageRuntimeClosure,
  validateStagedRuntimeClosure
} from './runtime-closure.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** electron-builder's `Arch` enum values, mirrored so this hook does not
 *  import builder-util. */
const ARCH_NAMES = { 1: 'x64', 3: 'arm64' }

export function closurePlatformForContext(context) {
  const os = context.electronPlatformName
  if (os !== 'darwin' && os !== 'linux') {
    return null
  }
  const arch = typeof context.arch === 'number' ? ARCH_NAMES[context.arch] : context.arch
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(
      `[after-pack] no bundled runtimes for ${os}/${context.arch}; ` +
        `only x64 and arm64 builds ship agent runtimes (universal builds are unsupported)`
    )
  }
  return `${os}-${arch}`
}

export async function stageDesktopRuntimes(
  context,
  { stage = stageRuntimeClosure, validate = validateStagedRuntimeClosure } = {}
) {
  const platform = closurePlatformForContext(context)
  if (!platform) {
    console.log(
      `[after-pack] no bundled runtimes for ${context.electronPlatformName}/${context.arch}; skipping`
    )
    return null
  }
  const libDir = join(context.packager.getResourcesDir(context.appOutDir), 'runtimes')
  console.log(`[after-pack] staging ${platform} runtimes into ${libDir}`)
  await stage({ repoRoot, libDir, platform, target: 'desktop' })
  const errors = validate({ libDir, platform, target: 'desktop' })
  if (errors.length > 0) {
    throw new Error(`[after-pack] staged runtime closure invalid:\n${errors.join('\n')}`)
  }
  if (context.electronPlatformName === 'darwin') {
    const exe = runtimeExecutables(libDir, platform, { target: 'desktop' })
    const binaries = [exe.claude]
    // One `electron-builder --mac` run packs every arch in turn and shares
    // this options object between them, so drop the previous arch's staged
    // paths before adding ours.
    const macOptions = context.packager.platformSpecificBuildOptions
    const kept = (macOptions.binaries ?? []).filter((p) => !isStagedRuntimePath(p))
    macOptions.binaries = [...kept, ...binaries]
  }
  return { platform, libDir }
}

export function isStagedRuntimePath(p) {
  return p.includes(`${sep}runtimes${sep}node_modules${sep}`)
}

export default stageDesktopRuntimes

import { describe, it, expect } from 'vitest'
import {
  buildManifest,
  lockIntegrity,
  runtimePackagesForPlatform,
  tarballUrl
} from './gen-runtime-manifest.mjs'

const OPENCODE = '1.18.14'
const CODEX = '0.146.1'
const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']

/** A distinct, SRI-shaped hash per package@version so a wrong lookup is visible. */
const hashOf = (id) => `sha512-${Buffer.from(id).toString('base64')}`

function lockEntry(name, version, quoted) {
  const key = `${name}@${version}`
  return [
    `  ${quoted ? `'${key}'` : key}:`,
    `    resolution: {integrity: ${hashOf(key)}}`,
    `    engines: {node: '>=16'}`,
    ''
  ].join('\n')
}

/** pnpm-lock shaped text: the base @openai/codex entry sits directly above its
 *  platform aliases, like the real lockfile. */
function fakeLock({ omit = [] } = {}) {
  const entries = [lockEntry('@openai/codex', CODEX, true)]
  for (const p of PLATFORMS) entries.push(lockEntry('@openai/codex', `${CODEX}-${p}`, true))
  entries.push(lockEntry('opencode-ai', OPENCODE, false))
  for (const p of PLATFORMS) entries.push(lockEntry(`opencode-${p}`, OPENCODE, false))
  const kept = entries.filter((e) => !omit.some((id) => e.includes(`${id}:`) || e.includes(`${id}':`)))
  return `lockfileVersion: '9.0'\n\npackages:\n\n${kept.join('\n')}`
}

const packageJson = {
  dependencies: { 'opencode-ai': OPENCODE },
  pnpm: { overrides: { '@openai/codex': CODEX } }
}

describe('tarballUrl', () => {
  it.each([
    {
      name: 'opencode-darwin-arm64',
      version: '1.18.14',
      expected: 'https://registry.npmjs.org/opencode-darwin-arm64/-/opencode-darwin-arm64-1.18.14.tgz'
    },
    {
      name: '@openai/codex',
      version: '0.146.1-linux-x64',
      expected: 'https://registry.npmjs.org/@openai/codex/-/codex-0.146.1-linux-x64.tgz'
    }
  ])('$name@$version', ({ name, version, expected }) => {
    expect(tarballUrl(name, version)).toBe(expected)
  })
})

describe('lockIntegrity', () => {
  const lock = fakeLock()

  it.each([
    { name: 'unscoped entry', pkg: 'opencode-linux-x64', version: OPENCODE },
    { name: 'scoped quoted entry', pkg: '@openai/codex', version: CODEX },
    { name: 'platform alias below the base entry', pkg: '@openai/codex', version: `${CODEX}-darwin-arm64` },
    { name: 'last platform alias', pkg: '@openai/codex', version: `${CODEX}-linux-arm64` }
  ])('$name', ({ pkg, version }) => {
    expect(lockIntegrity(lock, pkg, version)).toBe(hashOf(`${pkg}@${version}`))
  })

  it.each([
    { name: 'absent package', pkg: 'opencode-win32-x64', version: OPENCODE },
    { name: 'version that is a prefix of a locked one', pkg: 'opencode-linux-x64', version: '1.18.1' }
  ])('throws for $name', ({ pkg, version }) => {
    expect(() => lockIntegrity(lock, pkg, version)).toThrow(/no integrity/)
  })
})

describe('runtimePackagesForPlatform', () => {
  it('maps a platform to its opencode package and the codex platform alias', () => {
    expect(
      runtimePackagesForPlatform('linux-arm64', { opencodeVersion: '1.0.0', codexVersion: '0.2.0' })
    ).toEqual({
      opencode: { package: 'opencode-linux-arm64', version: '1.0.0', binary: 'bin/opencode' },
      codex: {
        package: '@openai/codex',
        version: '0.2.0-linux-arm64',
        binary: 'vendor/aarch64-unknown-linux-musl/bin/codex'
      }
    })
  })

  it('throws for an unsupported platform', () => {
    expect(() =>
      runtimePackagesForPlatform('win32-x64', { opencodeVersion: '1', codexVersion: '2' })
    ).toThrow(/Unsupported platform/)
  })
})

describe('buildManifest', () => {
  it('pins every platform to its own package, tarball and lockfile hash', () => {
    const manifest = buildManifest({ packageJson, lockText: fakeLock() })
    expect(manifest.schemaVersion).toBe(1)
    expect(Object.keys(manifest.runtimes).sort()).toEqual([...PLATFORMS].sort())
    for (const p of PLATFORMS) {
      const { opencode, codex } = manifest.runtimes[p]
      expect(opencode.integrity).toBe(hashOf(`opencode-${p}@${OPENCODE}`))
      expect(opencode.tarball).toBe(tarballUrl(`opencode-${p}`, OPENCODE))
      expect(codex.integrity).toBe(hashOf(`@openai/codex@${CODEX}-${p}`))
      expect(codex.tarball).toBe(tarballUrl('@openai/codex', `${CODEX}-${p}`))
    }
    expect(manifest.runtimes['darwin-x64'].codex).toEqual({
      package: '@openai/codex',
      version: `${CODEX}-darwin-x64`,
      binary: 'vendor/x86_64-apple-darwin/bin/codex',
      tarball: `https://registry.npmjs.org/@openai/codex/-/codex-${CODEX}-darwin-x64.tgz`,
      integrity: hashOf(`@openai/codex@${CODEX}-darwin-x64`),
      unpackedSize: null
    })
  })

  const previousWith = (version, unpackedSize) => ({
    schemaVersion: 1,
    runtimes: {
      'linux-x64': { opencode: { package: 'opencode-linux-x64', version, unpackedSize } }
    }
  })

  it.each([
    {
      name: 'keeps the previous size when package@version is unchanged',
      previous: previousWith(OPENCODE, 111),
      sizes: {},
      expected: 111
    },
    {
      name: 'drops the previous size after a version bump',
      previous: previousWith('1.0.0', 111),
      sizes: {},
      expected: null
    },
    {
      name: 'a looked-up size beats the previous one',
      previous: previousWith(OPENCODE, 111),
      sizes: { [`opencode-linux-x64@${OPENCODE}`]: 222 },
      expected: 222
    }
  ])('$name', ({ previous, sizes, expected }) => {
    const manifest = buildManifest({ packageJson, lockText: fakeLock(), previous, sizes })
    expect(manifest.runtimes['linux-x64'].opencode.unpackedSize).toBe(expected)
    expect(manifest.runtimes['linux-arm64'].opencode.unpackedSize).toBeNull()
  })

  it.each([
    { name: 'opencode-ai pin', pj: { ...packageJson, dependencies: {} } },
    { name: '@openai/codex override', pj: { ...packageJson, pnpm: { overrides: {} } } },
    { name: 'pnpm section', pj: { dependencies: packageJson.dependencies } }
  ])('throws when package.json lacks the $name', ({ pj }) => {
    expect(() => buildManifest({ packageJson: pj, lockText: fakeLock() })).toThrow(/must pin/)
  })

  it('throws when the lockfile lacks one platform package', () => {
    const lockText = fakeLock({ omit: [`@openai/codex@${CODEX}-linux-x64`] })
    expect(() => buildManifest({ packageJson, lockText })).toThrow(
      `no integrity for @openai/codex@${CODEX}-linux-x64`
    )
  })
})

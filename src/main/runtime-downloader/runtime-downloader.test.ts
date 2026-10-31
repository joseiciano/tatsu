import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as tar from 'tar'
import {
  RuntimeDownloader,
  installDirName,
  parseIntegrity,
  readRuntimeManifest,
  type RuntimeManifest,
  type RuntimeManifestEntry
} from '.'
import { RuntimeMissingError } from '../chat-runtimes'
import { Store } from '../store'
import type { RuntimeStatus } from '../../shared/state/runtimes'

const PLATFORM = 'linux-x64'
const TARBALL_URL = 'https://registry.test/opencode-linux-x64/-/opencode-linux-x64-1.0.0.tgz'

let work: string
let installRoot: string

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'runtime-downloader-'))
  installRoot = join(work, 'install')
})

afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

/** Packs `files` (paths relative to package/) into an npm-style tarball and
 *  returns its bytes. Files are written 0644 so the downloader's chmod is
 *  what makes the binary executable. */
async function buildTarball(name: string, files: Record<string, string>): Promise<Buffer> {
  const src = join(work, `src-${name}`)
  for (const [rel, content] of Object.entries(files)) {
    const p = join(src, 'package', rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content)
    chmodSync(p, 0o644)
  }
  const file = join(work, `${name}.tgz`)
  await tar.c({ gzip: true, cwd: src, portable: true, file }, ['package'])
  return readFileSync(file)
}

function sri(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

function entryFor(bytes: Buffer, overrides: Partial<RuntimeManifestEntry> = {}): RuntimeManifestEntry {
  return {
    package: 'opencode-linux-x64',
    version: '1.0.0',
    binary: 'bin/opencode',
    tarball: TARBALL_URL,
    integrity: sri(bytes),
    unpackedSize: 4096,
    ...overrides
  }
}

function manifestWith(entry: RuntimeManifestEntry): RuntimeManifest {
  return { schemaVersion: 1, runtimes: { [PLATFORM]: { opencode: entry } } }
}

/** Fake registry: serves `body` in three chunks, or an HTTP error. */
function fakeFetch(body: Buffer) {
  const state = { calls: 0, status: 200 }
  const fn = (async () => {
    state.calls++
    if (state.status !== 200) return new Response('nope', { status: state.status })
    const third = Math.ceil(body.length / 3)
    const chunks = [body.subarray(0, third), body.subarray(third, 2 * third), body.subarray(2 * third)]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new Uint8Array(c))
        controller.close()
      }
    })
    return new Response(stream, { headers: { 'content-length': String(body.length) } })
  }) as unknown as typeof fetch
  return { fn, state }
}

function setup(opts: {
  manifest: RuntimeManifest | null
  fetchFn?: typeof fetch
  bundled?: string
  platform?: string
}) {
  const store = new Store()
  const statuses: RuntimeStatus[] = []
  store.subscribe((e) => {
    if (e.type === 'runtimes/statusChanged' && e.payload.agentKind === 'opencode') {
      statuses.push(e.payload.status)
    }
  })
  const downloader = new RuntimeDownloader({
    store,
    manifest: opts.manifest,
    platform: opts.platform ?? PLATFORM,
    installRoot,
    bundledBinary: (kind) => (kind === 'opencode' ? opts.bundled : undefined),
    fetchFn: opts.fetchFn ?? (fakeFetch(Buffer.alloc(0)).fn),
    progressIntervalMs: 0
  })
  return { store, statuses, downloader }
}

const OPENCODE_SCRIPT = '#!/bin/sh\necho opencode\n'

describe('RuntimeDownloader.download', () => {
  it('downloads, verifies and installs the binary, reporting progress then ready', async () => {
    const bytes = await buildTarball('ok', { 'bin/opencode': OPENCODE_SCRIPT })
    const entry = entryFor(bytes)
    const { fn } = fakeFetch(bytes)
    const { statuses, downloader, store } = setup({ manifest: manifestWith(entry), fetchFn: fn })

    await downloader.download('opencode')

    const finalDir = join(installRoot, installDirName(entry))
    const bin = join(finalDir, 'bin', 'opencode')
    expect(readFileSync(bin, 'utf8')).toBe(OPENCODE_SCRIPT)
    expect(statSync(bin).mode & 0o111).not.toBe(0)
    expect(existsSync(join(finalDir, '.ok'))).toBe(true)
    expect(existsSync(`${finalDir}.partial`)).toBe(false)
    expect(downloader.installedBinary('opencode')).toBe(bin)
    expect(downloader.resolveBinary('opencode')).toBe(bin)

    expect(statuses[0]).toMatchObject({ state: 'downloading', version: '1.0.0', receivedBytes: 0 })
    const progress = statuses.filter((s) => s.state === 'downloading') as Array<
      Extract<RuntimeStatus, { state: 'downloading' }>
    >
    expect(progress.length).toBeGreaterThan(2)
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i].receivedBytes).toBeGreaterThanOrEqual(progress[i - 1].receivedBytes)
    }
    expect(progress[progress.length - 1].receivedBytes).toBe(bytes.length)
    expect(statuses[statuses.length - 1]).toEqual({ state: 'ready', version: '1.0.0' })
    expect(store.getSnapshot().state.runtimes.byAgent.opencode).toEqual({
      state: 'ready',
      version: '1.0.0'
    })
  })

  it.each<{
    name: string
    files: Record<string, string>
    integrity: (() => string) | undefined
    status: number
    error: RegExp
  }>([
    {
      name: 'integrity mismatch',
      files: { 'bin/opencode': OPENCODE_SCRIPT },
      integrity: () => sri(Buffer.from('some other tarball')),
      status: 200,
      error: /Integrity check failed/
    },
    {
      name: 'HTTP failure',
      files: { 'bin/opencode': OPENCODE_SCRIPT },
      integrity: undefined,
      status: 503,
      error: /HTTP 503/
    },
    {
      name: 'tarball without the binary',
      files: { 'README.md': 'no binary here' },
      integrity: undefined,
      status: 200,
      error: /has no bin\/opencode/
    }
  ])('$name: rejects, reports error, and leaves nothing installed', async (row) => {
    const bytes = await buildTarball('bad', row.files)
    const entry = entryFor(bytes, row.integrity ? { integrity: row.integrity() } : {})
    const { fn, state } = fakeFetch(bytes)
    state.status = row.status
    const { statuses, downloader } = setup({ manifest: manifestWith(entry), fetchFn: fn })

    await expect(downloader.download('opencode')).rejects.toThrow(row.error)

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('error')
    expect(last.state === 'error' && last.error).toMatch(row.error)
    const finalDir = join(installRoot, installDirName(entry))
    expect(existsSync(finalDir)).toBe(false)
    expect(existsSync(`${finalDir}.partial`)).toBe(false)
    expect(downloader.installedBinary('opencode')).toBeUndefined()
    expect(downloader.status('opencode').state).toBe('missing')
  })

  it('shares one fetch between concurrent downloads of the same runtime', async () => {
    const bytes = await buildTarball('ok', { 'bin/opencode': OPENCODE_SCRIPT })
    const { fn, state } = fakeFetch(bytes)
    const { downloader } = setup({ manifest: manifestWith(entryFor(bytes)), fetchFn: fn })

    await Promise.all([downloader.download('opencode'), downloader.download('opencode')])

    expect(state.calls).toBe(1)
    expect(downloader.status('opencode').state).toBe('ready')
  })

  it('can retry after a failed download', async () => {
    const bytes = await buildTarball('ok', { 'bin/opencode': OPENCODE_SCRIPT })
    const { fn, state } = fakeFetch(bytes)
    state.status = 500
    const { downloader } = setup({ manifest: manifestWith(entryFor(bytes)), fetchFn: fn })

    await expect(downloader.download('opencode')).rejects.toThrow(/HTTP 500/)
    state.status = 200
    await downloader.download('opencode')

    expect(state.calls).toBe(2)
    expect(downloader.status('opencode')).toEqual({ state: 'ready', version: '1.0.0' })
  })

  it('does not fetch when the runtime is already installed or bundled', async () => {
    const bytes = await buildTarball('ok', { 'bin/opencode': OPENCODE_SCRIPT })
    const { fn, state } = fakeFetch(bytes)
    const installed = setup({ manifest: manifestWith(entryFor(bytes)), fetchFn: fn })
    await installed.downloader.download('opencode')
    await installed.downloader.download('opencode')
    const bundled = setup({ manifest: manifestWith(entryFor(bytes)), fetchFn: fn, bundled: '/b' })
    await bundled.downloader.download('opencode')

    expect(state.calls).toBe(1)
  })

  it.each([
    { name: 'no entry for this platform', manifest: 'other-platform' as const },
    { name: 'no manifest at all', manifest: null }
  ])('$name: status is error and download rejects without fetching', async (row) => {
    const bytes = await buildTarball('ok', { 'bin/opencode': OPENCODE_SCRIPT })
    const { fn, state } = fakeFetch(bytes)
    const manifest: RuntimeManifest | null =
      row.manifest === null
        ? null
        : { schemaVersion: 1, runtimes: { 'darwin-arm64': { opencode: entryFor(bytes) } } }
    const { statuses, downloader } = setup({ manifest, fetchFn: fn })

    const status = downloader.status('opencode')
    expect(status.state).toBe('error')
    expect(status.state === 'error' && status.error).toContain(PLATFORM)
    await expect(downloader.download('opencode')).rejects.toThrow(PLATFORM)
    expect(state.calls).toBe(0)
    expect(statuses[statuses.length - 1].state).toBe('error')
  })
})

describe('RuntimeDownloader status + resolveBinary', () => {
  const entry: RuntimeManifestEntry = {
    package: 'opencode-linux-x64',
    version: '1.0.0',
    binary: 'bin/opencode',
    tarball: TARBALL_URL,
    integrity: 'sha512-AAAA',
    unpackedSize: 4096
  }

  function install({ marker }: { marker: boolean }): string {
    const dir = join(installRoot, installDirName(entry))
    mkdirSync(join(dir, 'bin'), { recursive: true })
    writeFileSync(join(dir, 'bin', 'opencode'), OPENCODE_SCRIPT)
    if (marker) writeFileSync(join(dir, '.ok'), 'x\n')
    return join(dir, 'bin', 'opencode')
  }

  it.each([
    {
      name: 'bundled beats an installed download',
      bundled: '/app/opencode',
      disk: 'installed' as const,
      status: { state: 'bundled' },
      resolved: '/app/opencode'
    },
    {
      name: 'installed download is ready',
      bundled: undefined,
      disk: 'installed' as const,
      status: { state: 'ready', version: '1.0.0' },
      resolved: 'installed'
    },
    {
      name: 'unpacked dir without the .ok marker is still missing',
      bundled: undefined,
      disk: 'no-marker' as const,
      status: { state: 'missing', version: '1.0.0', sizeBytes: 4096 },
      resolved: null
    },
    {
      name: 'nothing on disk is missing',
      bundled: undefined,
      disk: 'empty' as const,
      status: { state: 'missing', version: '1.0.0', sizeBytes: 4096 },
      resolved: null
    }
  ])('$name', (row) => {
    const bin = row.disk === 'empty' ? undefined : install({ marker: row.disk === 'installed' })
    const { downloader } = setup({ manifest: manifestWith(entry), bundled: row.bundled })

    expect(downloader.status('opencode')).toEqual(row.status)
    if (row.resolved === null) {
      expect(() => downloader.resolveBinary('opencode')).toThrow(RuntimeMissingError)
    } else {
      expect(downloader.resolveBinary('opencode')).toBe(
        row.resolved === 'installed' ? bin : row.resolved
      )
    }
  })

  it('throws a RuntimeMissingError naming the agent when nothing resolves', () => {
    const { downloader } = setup({ manifest: manifestWith(entry) })
    let caught: unknown
    try {
      downloader.resolveBinary('opencode')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(RuntimeMissingError)
    expect((caught as RuntimeMissingError).agentKind).toBe('opencode')
  })

  it('publishStatuses puts every downloadable runtime into the store', () => {
    const { downloader, store } = setup({ manifest: manifestWith(entry) })
    downloader.publishStatuses()
    const byAgent = store.getSnapshot().state.runtimes.byAgent
    expect(byAgent.opencode).toEqual({ state: 'missing', version: '1.0.0', sizeBytes: 4096 })
    expect(byAgent.codex?.state).toBe('error')
  })
})

describe('readRuntimeManifest', () => {
  it.each([
    { name: 'missing file', content: undefined, expected: null },
    { name: 'unknown schema version', content: { schemaVersion: 2, runtimes: {} }, expected: null },
    { name: 'no runtimes key', content: { schemaVersion: 1 }, expected: null },
    {
      name: 'valid manifest',
      content: { schemaVersion: 1, runtimes: { [PLATFORM]: {} } },
      expected: { schemaVersion: 1, runtimes: { [PLATFORM]: {} } }
    }
  ])('$name', ({ content, expected }) => {
    const path = join(work, 'runtime-manifest.json')
    if (content !== undefined) writeFileSync(path, JSON.stringify(content))
    expect(readRuntimeManifest(path)).toEqual(expected)
  })
})

describe('parseIntegrity', () => {
  it('splits an SRI string at the first dash', () => {
    expect(parseIntegrity('sha512-ab+/c==')).toEqual({ algorithm: 'sha512', digest: 'ab+/c==' })
  })

  it.each(['nodash', '-leadingdash'])('rejects malformed %s', (sri) => {
    expect(() => parseIntegrity(sri)).toThrow(/Malformed integrity/)
  })
})

describe('installDirName', () => {
  it.each([
    { pkg: 'opencode-darwin-arm64', version: '1.18.14', expected: 'opencode-darwin-arm64@1.18.14' },
    {
      pkg: '@openai/codex',
      version: '0.146.1-darwin-arm64',
      expected: '@openai+codex@0.146.1-darwin-arm64'
    }
  ])('$pkg flattens to a single path segment', ({ pkg, version, expected }) => {
    expect(installDirName({ package: pkg, version })).toBe(expected)
  })
})

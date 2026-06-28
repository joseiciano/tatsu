import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, mkdtempSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadRepoConfig, saveRepoConfig, invalidateRepoConfigCache } from './repo-config'
import type { RepoConfig } from '../../shared/state/repo-configs'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true }) } catch { /* ignore */ }
  }
  tempDirs.length = 0
})

describe('loadRepoConfig container parsing', () => {
  it('parses valid image config via save', () => {
    const dir = makeTempDir('rc-test-image-')
    const saved = saveRepoConfig(dir, { container: { image: 'node:20-alpine' } })
    expect(saved.container).toEqual({ image: 'node:20-alpine' })
    invalidateRepoConfigCache(dir)
  })


  it('rejects container images that look like Docker flags', () => {
    const dir = makeTempDir('rc-test-image-flag-')
    const saved = saveRepoConfig(dir, { container: { image: '--privileged' } })
    expect(saved.container).toBeUndefined()
    invalidateRepoConfigCache(dir)
  })

  it('allows container config without image or dockerfile for default image', () => {
    const dir = makeTempDir('rc-test-default-image-')
    const saved = saveRepoConfig(dir, { container: { env: { NODE_ENV: 'development' } } })
    expect(saved.container).toEqual({ env: { NODE_ENV: 'development' } })
    invalidateRepoConfigCache(dir)
  })

  it('rejects both image and dockerfile', () => {
    const dir = makeTempDir('rc-test-both-')
    const saved = saveRepoConfig(dir, { container: { image: 'n', dockerfile: './D' } })
    expect(saved.container).toBeUndefined()
    invalidateRepoConfigCache(dir)
  })

  it('rejects invalid workdir', () => {
    const dir = makeTempDir('rc-test-wd-')
    const saved = saveRepoConfig(dir, { container: { image: 'n', workdir: 'relative' } })
    expect(saved.container).toBeUndefined()
    invalidateRepoConfigCache(dir)
  })

  it('rejects invalid env key', () => {
    const dir = makeTempDir('rc-test-env-')
    const saved = saveRepoConfig(dir, { container: { image: 'n', env: { 'BAD KEY': 'v' } } })
    expect(saved.container).toBeUndefined()
    invalidateRepoConfigCache(dir)
  })

  it('rejects unsafe volume target /', () => {
    const dir = makeTempDir('rc-test-vol-')
    const saved = saveRepoConfig(dir, { container: { image: 'n', volumes: [{ source: '/h', target: '/' }] } })
    expect(saved.container).toBeUndefined()
    invalidateRepoConfigCache(dir)
  })

  it('rejects harness status volume target', () => {
    const dir = makeTempDir('rc-test-status-vol-')
    const saved = saveRepoConfig(dir, { container: { image: 'n', volumes: [{ source: '/h', target: '/tmp/harness-status' }] } })
    expect(saved.container).toBeUndefined()
    invalidateRepoConfigCache(dir)
  })

  it('rejects volume sources containing commas', () => {
    const dir = makeTempDir('rc-test-vol-source-comma-')
    const saved = saveRepoConfig(dir, { container: { image: 'n', volumes: [{ source: '/h,malformed', target: '/data' }] } })
    expect(saved.container).toBeUndefined()
    invalidateRepoConfigCache(dir)
  })

  it('rejects volume targets containing commas', () => {
    const dir = makeTempDir('rc-test-vol-target-comma-')
    const saved = saveRepoConfig(dir, { container: { image: 'n', volumes: [{ source: '/h', target: '/data,malformed' }] } })
    expect(saved.container).toBeUndefined()
    invalidateRepoConfigCache(dir)
  })

  it('rejects volume sources containing equals signs', () => {
    const dir = makeTempDir('rc-test-vol-source-equals-')
    const saved = saveRepoConfig(dir, { container: { image: 'n', volumes: [{ source: '/h=malformed', target: '/data' }] } })
    expect(saved.container).toBeUndefined()
    invalidateRepoConfigCache(dir)
  })

  it('rejects volume targets containing equals signs', () => {
    const dir = makeTempDir('rc-test-vol-target-equals-')
    const saved = saveRepoConfig(dir, { container: { image: 'n', volumes: [{ source: '/h', target: '/data=malformed' }] } })
    expect(saved.container).toBeUndefined()
    invalidateRepoConfigCache(dir)
  })

  it('allows disabled without image or dockerfile', () => {
    const dir = makeTempDir('rc-test-dis-')
    const saved = saveRepoConfig(dir, { container: { disabled: true } })
    expect(saved.container).toEqual({ disabled: true })
    invalidateRepoConfigCache(dir)
  })

  it('normalizes relative dockerfile on load', () => {
    const dir = makeTempDir('rc-test-df-')
    writeFileSync(join(dir, '.harness.json'), JSON.stringify({ container: { dockerfile: './Dockerfile' } }))
    invalidateRepoConfigCache(dir)
    const loaded = loadRepoConfig(dir)
    expect(loaded.container?.dockerfile).toBe(join(dir, 'Dockerfile'))
  })

  it('normalizes relative container build context on load', () => {
    const dir = makeTempDir('rc-test-build-context-')
    writeFileSync(join(dir, '.harness.json'), JSON.stringify({ container: { dockerfile: './docker/Dockerfile', buildContext: './docker' } }))
    invalidateRepoConfigCache(dir)
    const loaded = loadRepoConfig(dir)
    expect(loaded.container?.buildContext).toBe(join(dir, 'docker'))
  })


  it('rejects dockerfile symlinks that resolve outside the repo', () => {
    const dir = makeTempDir('rc-test-df-symlink-')
    symlinkSync('/etc/passwd', join(dir, 'Dockerfile'))
    writeFileSync(join(dir, '.harness.json'), JSON.stringify({ container: { dockerfile: './Dockerfile' } }))
    invalidateRepoConfigCache(dir)
    const loaded = loadRepoConfig(dir)
    expect(loaded.container).toBeUndefined()
  })

  it('rejects build context symlinks that resolve outside the repo', () => {
    const dir = makeTempDir('rc-test-build-context-symlink-')
    const outside = makeTempDir('rc-test-build-context-outside-')
    symlinkSync(outside, join(dir, 'docker'))
    writeFileSync(join(dir, '.harness.json'), JSON.stringify({ container: { dockerfile: './Dockerfile', buildContext: './docker' } }))
    invalidateRepoConfigCache(dir)
    const loaded = loadRepoConfig(dir)
    expect(loaded.container).toBeUndefined()
  })

  it('normalizes relative volume source on load', () => {
    const dir = makeTempDir('rc-test-vol2-')
    writeFileSync(join(dir, '.harness.json'), JSON.stringify({ container: { image: 'n', volumes: [{ source: './data', target: '/data' }] } }))
    invalidateRepoConfigCache(dir)
    const loaded = loadRepoConfig(dir)
    expect(loaded.container?.volumes).toEqual([{ source: join(dir, 'data'), target: '/data' }])
  })


  it('rejects absolute volume source symlinks that resolve to unsafe paths', () => {
    const dir = makeTempDir('rc-test-absolute-vol-symlink-')
    const link = join(dir, 'safe-looking')
    symlinkSync('/etc/passwd', link)
    const saved = saveRepoConfig(dir, { container: { image: 'node:20-alpine', volumes: [{ source: link, target: '/data' }] } })
    expect(saved.container).toBeUndefined()
    invalidateRepoConfigCache(dir)
  })

  it('rejects ports greater than 65535', () => {
    const dir = makeTempDir('rc-test-port-max-')
    const saved = saveRepoConfig(dir, { container: { image: 'n', ports: [99999] } })
    expect(saved.container).toBeUndefined()
    invalidateRepoConfigCache(dir)
  })

  it('rejects non-integer ports', () => {
    const dir = makeTempDir('rc-test-port-float-')
    const saved = saveRepoConfig(dir, { container: { image: 'n', ports: [1.5] } })
    expect(saved.container).toBeUndefined()
    invalidateRepoConfigCache(dir)
  })

  it('accepts valid port range', () => {
    const dir = makeTempDir('rc-test-port-valid-')
    const saved = saveRepoConfig(dir, { container: { image: 'n', ports: [80, 443, 65535] } })
    expect(saved.container?.ports).toEqual([80, 443, 65535])
    invalidateRepoConfigCache(dir)
  })

  it('strips invalid container on load', () => {
    const dir = makeTempDir('rc-test-bad-')
    writeFileSync(join(dir, '.harness.json'), JSON.stringify({ container: { image: 'n', dockerfile: './D' } }))
    invalidateRepoConfigCache(dir)
    const loaded = loadRepoConfig(dir)
    expect(loaded.container).toBeUndefined()
  })
})

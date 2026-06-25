import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'fs'
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

  it('normalizes relative volume source on load', () => {
    const dir = makeTempDir('rc-test-vol2-')
    writeFileSync(join(dir, '.harness.json'), JSON.stringify({ container: { image: 'n', volumes: [{ source: './data', target: '/data' }] } }))
    invalidateRepoConfigCache(dir)
    const loaded = loadRepoConfig(dir)
    expect(loaded.container?.volumes).toEqual([{ source: join(dir, 'data'), target: '/data' }])
  })

  it('strips invalid container on load', () => {
    const dir = makeTempDir('rc-test-bad-')
    writeFileSync(join(dir, '.harness.json'), JSON.stringify({ container: { image: 'n', dockerfile: './D' } }))
    invalidateRepoConfigCache(dir)
    const loaded = loadRepoConfig(dir)
    expect(loaded.container).toBeUndefined()
  })
})
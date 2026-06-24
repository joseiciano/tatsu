import { describe, it, expect } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { loadRepoConfig, saveRepoConfig, invalidateRepoConfigCache } from './repo-config'
import type { RepoConfig } from '../../shared/state/repo-configs'

function ensureDir(path: string) { mkdirSync(path, { recursive: true }) }
function cleanup(path: string) { try { rmSync(path, { recursive: true }) } catch { /* ignore */ } }

describe('loadRepoConfig container parsing', () => {
  it('parses valid image config via save', () => {
    ensureDir('/tmp/rc-test-image')
    const saved = saveRepoConfig('/tmp/rc-test-image', { container: { image: 'node:20-alpine' } })
    expect(saved.container).toEqual({ image: 'node:20-alpine' })
    invalidateRepoConfigCache('/tmp/rc-test-image')
    cleanup('/tmp/rc-test-image')
  })

  it('rejects both image and dockerfile', () => {
    ensureDir('/tmp/rc-test-both')
    const saved = saveRepoConfig('/tmp/rc-test-both', { container: { image: 'n', dockerfile: './D' } })
    expect(saved.container).toBeUndefined()
    invalidateRepoConfigCache('/tmp/rc-test-both')
    cleanup('/tmp/rc-test-both')
  })

  it('rejects invalid workdir', () => {
    ensureDir('/tmp/rc-test-wd')
    const saved = saveRepoConfig('/tmp/rc-test-wd', { container: { image: 'n', workdir: 'relative' } })
    expect(saved.container).toBeUndefined()
    invalidateRepoConfigCache('/tmp/rc-test-wd')
    cleanup('/tmp/rc-test-wd')
  })

  it('rejects invalid env key', () => {
    ensureDir('/tmp/rc-test-env')
    const saved = saveRepoConfig('/tmp/rc-test-env', { container: { image: 'n', env: { 'BAD KEY': 'v' } } })
    expect(saved.container).toBeUndefined()
    invalidateRepoConfigCache('/tmp/rc-test-env')
    cleanup('/tmp/rc-test-env')
  })

  it('rejects unsafe volume target /', () => {
    ensureDir('/tmp/rc-test-vol')
    const saved = saveRepoConfig('/tmp/rc-test-vol', { container: { image: 'n', volumes: [{ source: '/h', target: '/' }] } })
    expect(saved.container).toBeUndefined()
    invalidateRepoConfigCache('/tmp/rc-test-vol')
    cleanup('/tmp/rc-test-vol')
  })

  it('allows disabled without image or dockerfile', () => {
    ensureDir('/tmp/rc-test-dis')
    const saved = saveRepoConfig('/tmp/rc-test-dis', { container: { disabled: true } })
    expect(saved.container).toEqual({ disabled: true })
    invalidateRepoConfigCache('/tmp/rc-test-dis')
    cleanup('/tmp/rc-test-dis')
  })

  it('normalizes relative dockerfile on load', () => {
    ensureDir('/tmp/rc-test-df')
    writeFileSync('/tmp/rc-test-df/.harness.json', JSON.stringify({ container: { dockerfile: './Dockerfile' } }))
    invalidateRepoConfigCache('/tmp/rc-test-df')
    const loaded = loadRepoConfig('/tmp/rc-test-df')
    expect(loaded.container?.dockerfile).toBe('/tmp/rc-test-df/Dockerfile')
    cleanup('/tmp/rc-test-df')
  })

  it('normalizes relative volume source on load', () => {
    ensureDir('/tmp/rc-test-vol2')
    writeFileSync('/tmp/rc-test-vol2/.harness.json', JSON.stringify({ container: { image: 'n', volumes: [{ source: './data', target: '/data' }] } }))
    invalidateRepoConfigCache('/tmp/rc-test-vol2')
    const loaded = loadRepoConfig('/tmp/rc-test-vol2')
    expect(loaded.container?.volumes).toEqual([{ source: '/tmp/rc-test-vol2/data', target: '/data' }])
    cleanup('/tmp/rc-test-vol2')
  })

  it('strips invalid container on load', () => {
    ensureDir('/tmp/rc-test-bad')
    writeFileSync('/tmp/rc-test-bad/.harness.json', JSON.stringify({ container: { image: 'n', dockerfile: './D' } }))
    invalidateRepoConfigCache('/tmp/rc-test-bad')
    const loaded = loadRepoConfig('/tmp/rc-test-bad')
    expect(loaded.container).toBeUndefined()
    cleanup('/tmp/rc-test-bad')
  })
})
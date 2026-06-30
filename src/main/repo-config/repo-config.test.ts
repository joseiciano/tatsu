import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, mkdtempSync, symlinkSync, readFileSync, existsSync, readdirSync } from 'fs'
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

  it('rejects volume target /workspace', () => {
    const dir = makeTempDir('rc-test-vol-workspace-')
    const saved = saveRepoConfig(dir, { container: { image: 'n', volumes: [{ source: '/h', target: '/workspace' }] } })
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

  it('rejects disabled container with both image and dockerfile', () => {
    const dir = makeTempDir('rc-test-dis-both-')
    const saved = saveRepoConfig(dir, { container: { disabled: true, image: 'node:20', dockerfile: './Dockerfile' } })
    // When disabled:true but both image+dockerfile, the config should be dropped
    expect(saved.container).toBeUndefined()
    invalidateRepoConfigCache(dir)
  })

  it('rejects disabled container with both image and dockerfile on load', () => {
    const dir = makeTempDir('rc-test-dis-both-load-')
    writeFileSync(join(dir, '.harness.json'), JSON.stringify({ container: { disabled: true, image: 'node:20', dockerfile: './Dockerfile' } }))
    invalidateRepoConfigCache(dir)
    const loaded = loadRepoConfig(dir)
    expect(loaded.container).toBeUndefined()
  })

  it('allows disabled container with only image', () => {
    const dir = makeTempDir('rc-test-dis-img-')
    const saved = saveRepoConfig(dir, { container: { disabled: true, image: 'node:20' } })
    expect(saved.container).toEqual({ disabled: true, image: 'node:20' })
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

describe('loadRepoConfig non-container field validation', () => {
  it('drops non-string setupCommand on load', () => {
    const dir = makeTempDir('rc-test-setup-cmd-')
    writeFileSync(join(dir, '.harness.json'), JSON.stringify({ setupCommand: 123 }))
    invalidateRepoConfigCache(dir)
    const loaded = loadRepoConfig(dir)
    expect(loaded.setupCommand).toBeUndefined()
  })

  it('drops non-string teardownCommand on load', () => {
    const dir = makeTempDir('rc-test-teardown-cmd-')
    writeFileSync(join(dir, '.harness.json'), JSON.stringify({ teardownCommand: true }))
    invalidateRepoConfigCache(dir)
    const loaded = loadRepoConfig(dir)
    expect(loaded.teardownCommand).toBeUndefined()
  })

  it('drops invalid mergeStrategy on load', () => {
    const dir = makeTempDir('rc-test-merge-strategy-')
    writeFileSync(join(dir, '.harness.json'), JSON.stringify({ mergeStrategy: 'invalid-strategy' }))
    invalidateRepoConfigCache(dir)
    const loaded = loadRepoConfig(dir)
    expect(loaded.mergeStrategy).toBeUndefined()
  })

  it('accepts valid mergeStrategy values', () => {
    const dir = makeTempDir('rc-test-merge-strategy-valid-')
    writeFileSync(join(dir, '.harness.json'), JSON.stringify({ mergeStrategy: 'squash' }))
    invalidateRepoConfigCache(dir)
    let loaded = loadRepoConfig(dir)
    expect(loaded.mergeStrategy).toBe('squash')

    writeFileSync(join(dir, '.harness.json'), JSON.stringify({ mergeStrategy: 'merge-commit' }))
    invalidateRepoConfigCache(dir)
    loaded = loadRepoConfig(dir)
    expect(loaded.mergeStrategy).toBe('merge-commit')

    writeFileSync(join(dir, '.harness.json'), JSON.stringify({ mergeStrategy: 'fast-forward' }))
    invalidateRepoConfigCache(dir)
    loaded = loadRepoConfig(dir)
    expect(loaded.mergeStrategy).toBe('fast-forward')
  })

  it('accepts valid string setupCommand and teardownCommand', () => {
    const dir = makeTempDir('rc-test-valid-cmds-')
    writeFileSync(join(dir, '.harness.json'), JSON.stringify({ setupCommand: 'pnpm install', teardownCommand: 'pnpm clean' }))
    invalidateRepoConfigCache(dir)
    const loaded = loadRepoConfig(dir)
    expect(loaded.setupCommand).toBe('pnpm install')
    expect(loaded.teardownCommand).toBe('pnpm clean')
  })
})

describe('saveRepoConfig non-container field validation', () => {
  it('drops non-string setupCommand on save', () => {
    const dir = makeTempDir('rc-test-save-setup-cmd-')
    const saved = saveRepoConfig(dir, { setupCommand: 123 } as unknown as RepoConfig)
    expect(saved.setupCommand).toBeUndefined()
    invalidateRepoConfigCache(dir)
  })

  it('drops non-string teardownCommand on save', () => {
    const dir = makeTempDir('rc-test-save-teardown-cmd-')
    const saved = saveRepoConfig(dir, { teardownCommand: true } as unknown as RepoConfig)
    expect(saved.teardownCommand).toBeUndefined()
    invalidateRepoConfigCache(dir)
  })

  it('drops invalid mergeStrategy on save', () => {
    const dir = makeTempDir('rc-test-save-merge-strategy-')
    const saved = saveRepoConfig(dir, { mergeStrategy: 'invalid-strategy' } as unknown as RepoConfig)
    expect(saved.mergeStrategy).toBeUndefined()
    invalidateRepoConfigCache(dir)
  })
})

describe('validateContainerConfig workdir unsafe targets', () => {
  it('rejects unsafe workdir /', () => {
    const dir = makeTempDir('rc-test-wd-unsafe-')
    const saved = saveRepoConfig(dir, { container: { image: 'n', workdir: '/' } })
    expect(saved.container).toBeUndefined()
    invalidateRepoConfigCache(dir)
  })

  it('accepts explicit /workspace workdir (default container workdir)', () => {
    const dir = makeTempDir('rc-test-wd-explicit-ws-')
    const saved = saveRepoConfig(dir, { container: { image: 'n', workdir: '/workspace' } })
    expect(saved.container?.workdir).toBe('/workspace')
    invalidateRepoConfigCache(dir)
  })

  it('rejects unsafe workdir /proc', () => {
    const dir = makeTempDir('rc-test-wd-unsafe-proc-')
    const saved = saveRepoConfig(dir, { container: { image: 'n', workdir: '/proc' } })
    expect(saved.container).toBeUndefined()
    invalidateRepoConfigCache(dir)
  })

  it('rejects unsafe workdir /etc', () => {
    const dir = makeTempDir('rc-test-wd-unsafe-etc-')
    const saved = saveRepoConfig(dir, { container: { image: 'n', workdir: '/etc' } })
    expect(saved.container).toBeUndefined()
    invalidateRepoConfigCache(dir)
  })

  it('rejects unsafe workdir /sys', () => {
    const dir = makeTempDir('rc-test-wd-unsafe-sys-')
    const saved = saveRepoConfig(dir, { container: { image: 'n', workdir: '/sys' } })
    expect(saved.container).toBeUndefined()
    invalidateRepoConfigCache(dir)
  })

  it('rejects unsafe workdir /dev', () => {
    const dir = makeTempDir('rc-test-wd-unsafe-dev-')
    const saved = saveRepoConfig(dir, { container: { image: 'n', workdir: '/dev' } })
    expect(saved.container).toBeUndefined()
    invalidateRepoConfigCache(dir)
  })

  it('rejects unsafe workdir /tmp/harness-status', () => {
    const dir = makeTempDir('rc-test-wd-unsafe-status-')
    const saved = saveRepoConfig(dir, { container: { image: 'n', workdir: '/tmp/harness-status' } })
    expect(saved.container).toBeUndefined()
    invalidateRepoConfigCache(dir)
  })

  it('accepts safe workdir', () => {
    const dir = makeTempDir('rc-test-wd-safe-')
    const saved = saveRepoConfig(dir, { container: { image: 'n', workdir: '/home/user/project' } })
    expect(saved.container?.workdir).toBe('/home/user/project')
    invalidateRepoConfigCache(dir)
  })
})

describe('saveRepoConfig atomic write', () => {
  it('writes .harness.json via temp file then rename, no temp leftovers', () => {
    const dir = makeTempDir('rc-test-atomic-')
    const saved = saveRepoConfig(dir, { container: { image: 'node:20-alpine' } })
    expect(saved.container).toEqual({ image: 'node:20-alpine' })

    // Target file should exist with correct content
    const content = readFileSync(join(dir, '.harness.json'), 'utf8')
    const parsed = JSON.parse(content)
    expect(parsed.container).toEqual({ image: 'node:20-alpine' })

    // No temp files should remain after successful write
    const leftovers = readdirSync(dir).filter(f => f.includes('.tmp.'))
    expect(leftovers).toEqual([])

    invalidateRepoConfigCache(dir)
  })

  it('does not corrupt target when writing an empty config (unlink path)', () => {
    const dir = makeTempDir('rc-test-atomic-empty-')
    // Write a config first
    saveRepoConfig(dir, { container: { image: 'node:20-alpine' } })
    expect(existsSync(join(dir, '.harness.json'))).toBe(true)

    // Overwrite with empty config — should unlink the file
    saveRepoConfig(dir, {})
    expect(existsSync(join(dir, '.harness.json'))).toBe(false)

    // No temp files should remain
    const leftovers = readdirSync(dir).filter(f => f.includes('.tmp.'))
    expect(leftovers).toEqual([])

    invalidateRepoConfigCache(dir)
  })
})

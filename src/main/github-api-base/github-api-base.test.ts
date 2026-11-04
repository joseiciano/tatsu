import { describe, it, expect, vi, afterEach } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

vi.mock('../debug', () => ({ log: vi.fn() }))

import { resolveGithubApiBase, githubApiUrl, DEFAULT_GITHUB_API_BASE } from '.'

describe('resolveGithubApiBase', () => {
  it.each([
    ['http://127.0.0.1:4567', 'http://127.0.0.1:4567'],
    ['http://localhost:4567', 'http://localhost:4567'],
    ['http://[::1]:4567', 'http://[::1]:4567'],
    ['https://127.0.0.1:8443/some/path?q=1#frag', 'https://127.0.0.1:8443']
  ])('honors loopback override %s', (raw, expected) => {
    const log = vi.fn()
    expect(resolveGithubApiBase(raw, log)).toBe(expected)
    expect(log).not.toHaveBeenCalled()
  })

  it.each([undefined, ''])('uses the default for %j without logging', (raw) => {
    const log = vi.fn()
    expect(resolveGithubApiBase(raw, log)).toBe(DEFAULT_GITHUB_API_BASE)
    expect(log).not.toHaveBeenCalled()
  })

  it.each([
    'https://evil.example',
    'file:///x',
    'http://127.0.0.1@evil.example',
    'http://user:pw@127.0.0.1:1',
    'http://localhost.evil.example',
    'http://127.0.0.1.evil.example',
    'not a url at all'
  ])('ignores %s and logs once without the raw value', (raw) => {
    const log = vi.fn()
    expect(resolveGithubApiBase(`${raw}?secret=leak`, log)).toBe(DEFAULT_GITHUB_API_BASE)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toBe('github')
    const message = String(log.mock.calls[0][1])
    expect(message).not.toContain('secret=leak')
    expect(message).not.toContain('pw')
  })
})

describe('githubApiUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('defaults to api.github.com when the env var is unset', () => {
    expect(githubApiUrl('/user')).toBe('https://api.github.com/user')
  })

  it('reads the env override once at module load', async () => {
    vi.stubEnv('HARNESS_GITHUB_API_URL', 'http://127.0.0.1:9/ignored')
    vi.resetModules()
    const fresh = await import('.')
    expect(fresh.githubApiUrl('/repos/o/r/pulls')).toBe('http://127.0.0.1:9/repos/o/r/pulls')
  })

  it('keeps api.github.com when the env override is off-host', async () => {
    vi.stubEnv('HARNESS_GITHUB_API_URL', 'https://evil.example')
    vi.resetModules()
    const fresh = await import('.')
    expect(fresh.githubApiUrl('/user')).toBe('https://api.github.com/user')
  })
})

describe('GitHub API host literal', () => {
  const HOST_PATTERN = /api\\?\.github\\?\.com/
  const dirs = ['github', 'github-auth'].map((d) => join(__dirname, '..', d))

  it.each(dirs)('appears in no non-test source under %s', (dir) => {
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    expect(sources.length).toBeGreaterThan(0)
    for (const file of sources) {
      expect(readFileSync(join(dir, file), 'utf-8'), file).not.toMatch(HOST_PATTERN)
    }
  })
})

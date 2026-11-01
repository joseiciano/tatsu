import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { applyConnectionDefaults, loadConfig, LOCAL_BACKEND_ID, type Config } from '.'
import { resetPathsForTests } from '../paths'
import { SCHEMA_VERSION } from '../persistence-migrations'

function bareConfig(): Config {
  return {
    schemaVersion: 5,
    windowBounds: null,
    repoRoots: []
  }
}

describe('applyConnectionDefaults', () => {
  it('seeds a single Local backend when connections is missing', () => {
    const out = applyConnectionDefaults(bareConfig(), 1700000000000)
    expect(out.connections).toEqual([
      {
        id: LOCAL_BACKEND_ID,
        label: 'Local',
        url: '',
        kind: 'local',
        addedAt: 1700000000000
      }
    ])
  })

  it('seeds Local when connections is an empty array', () => {
    const out = applyConnectionDefaults({ ...bareConfig(), connections: [] })
    expect(out.connections).toHaveLength(1)
    expect(out.connections?.[0].kind).toBe('local')
  })

  it('defaults activeBackendId to LOCAL_BACKEND_ID', () => {
    const out = applyConnectionDefaults(bareConfig())
    expect(out.activeBackendId).toBe(LOCAL_BACKEND_ID)
  })

  it('preserves existing connections', () => {
    const existing: Config = {
      ...bareConfig(),
      connections: [
        { id: 'local', label: 'Local', url: '', kind: 'local', addedAt: 1 },
        { id: 'abc', label: 'Build box', url: 'build-box.local:37291/', kind: 'remote', addedAt: 2 }
      ]
    }
    const out = applyConnectionDefaults(existing)
    expect(out.connections).toBe(existing.connections)
  })

  it('preserves an existing activeBackendId', () => {
    const out = applyConnectionDefaults({
      ...bareConfig(),
      connections: [
        { id: 'local', label: 'Local', url: '', kind: 'local', addedAt: 1 },
        { id: 'abc', label: 'Build box', url: 'build-box.local:37291/', kind: 'remote', addedAt: 2 }
      ],
      activeBackendId: 'abc'
    })
    expect(out.activeBackendId).toBe('abc')
  })

  it('does not mutate the input config', () => {
    const input = bareConfig()
    const before = JSON.stringify(input)
    applyConnectionDefaults(input)
    expect(JSON.stringify(input)).toBe(before)
  })
})

describe('loadConfig — harnessConfig key', () => {
  const originalDataDir = process.env.HARNESS_DATA_DIR
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-load-config-test-'))
    process.env.HARNESS_DATA_DIR = dir
    resetPathsForTests()
  })

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.HARNESS_DATA_DIR
    else process.env.HARNESS_DATA_DIR = originalDataDir
    resetPathsForTests()
    rmSync(dir, { recursive: true, force: true })
  })

  function writeConfig(value: Record<string, unknown>): void {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ schemaVersion: SCHEMA_VERSION, repoRoots: [], ...value }))
  }

  it('keeps an existing harnessConfig key exactly as stored so an older build still finds it', () => {
    const saved = {
      version: 1,
      resources: [{ id: 'res-1', agentKind: 'claude', resourceType: 'agents', relativePath: 'a.md', content: '# A' }]
    }
    writeConfig({ harnessConfig: saved })
    expect(loadConfig().harnessConfig).toEqual(saved)
  })

  it('does not add a harnessConfig key when the file has none', () => {
    writeConfig({ claudeCommand: 'claude --verbose' })
    const config = loadConfig()
    expect(config.claudeCommand).toBe('claude --verbose')
    expect('harnessConfig' in config).toBe(false)
  })
})

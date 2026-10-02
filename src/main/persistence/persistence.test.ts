import { createHash } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import {
  applyConnectionDefaults,
  getPersistedHarnessConfigResources,
  LOCAL_BACKEND_ID,
  replacePersistedHarnessConfigScope,
  type Config,
  type PersistedHarnessConfigResource
} from '.'
import { resetPathsForTests } from '../paths'
import type { HarnessConfigScope } from '../../shared/state/harness-config'

function bareConfig(): Config {
  return {
    schemaVersion: 5,
    windowBounds: null,
    repoRoots: []
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')
}

function resource(overrides: Partial<PersistedHarnessConfigResource> = {}): PersistedHarnessConfigResource {
  const content = overrides.content ?? '# Resource\n\nBody.'
  return {
    id: 'res-id',
    agentKind: 'claude',
    resourceType: 'agents',
    aliasResourceTypes: [],
    relativePath: 'my-agent.md',
    label: 'My Agent',
    content,
    hash: sha256(content),
    updatedAt: 1700000000000,
    ...overrides
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

describe('getPersistedHarnessConfigResources', () => {
  it('reads an empty version-1 Tatsu config when the field is missing', () => {
    expect(getPersistedHarnessConfigResources(bareConfig())).toEqual([])
  })

  it('returns exact content, hash, and alias metadata for a valid resource', () => {
    const r = resource({ aliasResourceTypes: ['commands'], resourceType: 'skills', relativePath: 'my-skill/SKILL.md' })
    const config: Config = { ...bareConfig(), harnessConfig: { version: 1, resources: [r] } }
    const out = getPersistedHarnessConfigResources(config)
    expect(out).toEqual([r])
  })

  it('accepts a resource with aliasResourceTypes omitted (optional on the reused contract) as having no aliases', () => {
    const r = resource()
    delete (r as { aliasResourceTypes?: unknown }).aliasResourceTypes
    const config: Config = { ...bareConfig(), harnessConfig: { version: 1, resources: [r] } }
    const out = getPersistedHarnessConfigResources(config)
    expect(out).toEqual([{ ...r, aliasResourceTypes: [] }])
  })

  it('preserves a canonicalResourceType that agrees with resourceType, and rejects one that disagrees', () => {
    const agreeing = resource({ canonicalResourceType: 'agents' })
    const config: Config = { ...bareConfig(), harnessConfig: { version: 1, resources: [agreeing] } }
    expect(getPersistedHarnessConfigResources(config)[0].canonicalResourceType).toBe('agents')

    const disagreeing = resource({ canonicalResourceType: 'skills' })
    const badConfig: Config = { ...bareConfig(), harnessConfig: { version: 1, resources: [disagreeing] } }
    expect(() => getPersistedHarnessConfigResources(badConfig)).toThrow(/Invalid Tatsu config/)
  })

  it('does not share array/object references with the source Config', () => {
    const r = resource()
    const config: Config = { ...bareConfig(), harnessConfig: { version: 1, resources: [r] } }
    const out = getPersistedHarnessConfigResources(config)
    expect(out).not.toBe(config.harnessConfig!.resources)
    expect(out[0]).not.toBe(r)
    out[0].aliasResourceTypes?.push('commands')
    expect(r.aliasResourceTypes).toEqual([])
  })

  it('throws a content-free error for malformed harnessConfig without reading further', () => {
    const config: Config = { ...bareConfig(), harnessConfig: { not: 'valid' } as unknown as Config['harnessConfig'] }
    expect(() => getPersistedHarnessConfigResources(config)).toThrow(/Invalid Tatsu config/)
  })

  it('throws for an unsupported nested version rather than coercing it', () => {
    const config: Config = {
      ...bareConfig(),
      harnessConfig: { version: 2, resources: [] } as unknown as Config['harnessConfig']
    }
    expect(() => getPersistedHarnessConfigResources(config)).toThrow(/Invalid Tatsu config/)
  })

  it('throws when content and hash disagree, without leaking content in the error', () => {
    const r = resource({ content: 'real content', hash: sha256('a different payload') })
    const config: Config = { ...bareConfig(), harnessConfig: { version: 1, resources: [r] } }
    try {
      getPersistedHarnessConfigResources(config)
      throw new Error('expected validation to throw')
    } catch (e) {
      const message = (e as Error).message
      expect(message).not.toContain('real content')
      expect(message).not.toContain('a different payload')
    }
  })

  it('orders resources by harness (claude, codex, opencode), then resourceType (agents, skills, commands), then relativePath, then id', () => {
    const resources = [
      resource({ id: 'z', agentKind: 'opencode', resourceType: 'commands', relativePath: 'c.md' }),
      resource({ id: 'y', agentKind: 'codex', resourceType: 'agents', relativePath: 'a.md' }),
      resource({ id: 'b', agentKind: 'claude', resourceType: 'skills', relativePath: 'z-skill/SKILL.md' }),
      resource({ id: 'a', agentKind: 'claude', resourceType: 'skills', relativePath: 'a-skill/SKILL.md' }),
      resource({ id: 'x', agentKind: 'claude', resourceType: 'agents', relativePath: 'a.md' })
    ]
    const config: Config = { ...bareConfig(), harnessConfig: { version: 1, resources } }
    const out = getPersistedHarnessConfigResources(config)
    expect(out.map((r) => r.id)).toEqual(['x', 'a', 'b', 'y', 'z'])
  })
})

describe('replacePersistedHarnessConfigScope — isolated config path', () => {
  const originalDataDir = process.env.HARNESS_DATA_DIR
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-config-test-'))
    process.env.HARNESS_DATA_DIR = dir
    resetPathsForTests()
  })

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.HARNESS_DATA_DIR
    else process.env.HARNESS_DATA_DIR = originalDataDir
    resetPathsForTests()
    rmSync(dir, { recursive: true, force: true })
  })

  const skillsScope: HarnessConfigScope = { agentKind: 'claude', resourceType: 'skills' }

  it('replaces only the requested logical view and preserves everything else by value', () => {
    const agentRes = resource({ id: 'agent-1', agentKind: 'claude', resourceType: 'agents', relativePath: 'a.md' })
    const commandRes = resource({ id: 'command-1', agentKind: 'claude', resourceType: 'commands', relativePath: 'c.md' })
    const codexRes = resource({ id: 'codex-1', agentKind: 'codex', resourceType: 'agents', relativePath: 'codex-a.md' })
    const opencodeRes = resource({ id: 'opencode-1', agentKind: 'opencode', resourceType: 'skills', relativePath: 'oc-skill/SKILL.md' })
    const oldSkill = resource({ id: 'skill-old', agentKind: 'claude', resourceType: 'skills', relativePath: 'old-skill/SKILL.md' })
    const config: Config = {
      ...bareConfig(),
      harnessConfig: { version: 1, resources: [agentRes, commandRes, codexRes, opencodeRes, oldSkill] }
    }

    const newSkill = resource({ id: 'skill-new', agentKind: 'claude', resourceType: 'skills', relativePath: 'new-skill/SKILL.md' })
    replacePersistedHarnessConfigScope(config, skillsScope, [newSkill])

    const ids = config.harnessConfig!.resources.map((r) => r.id).sort()
    expect(ids).toEqual(['agent-1', 'codex-1', 'command-1', 'opencode-1', 'skill-new'])
    expect(config.harnessConfig!.resources.find((r) => r.id === 'agent-1')).toEqual(agentRes)
    expect(config.harnessConfig!.resources.find((r) => r.id === 'command-1')).toEqual(commandRes)
    expect(config.harnessConfig!.resources.find((r) => r.id === 'codex-1')).toEqual(codexRes)
    expect(config.harnessConfig!.resources.find((r) => r.id === 'opencode-1')).toEqual(opencodeRes)
  })

  it('adopting Commands with a canonical Skill aliasing Commands persists the skill once and preserves non-aliasing Skills', () => {
    const commandsScope: HarnessConfigScope = { agentKind: 'claude', resourceType: 'commands' }
    const nativeCommand = resource({ id: 'native-command', agentKind: 'claude', resourceType: 'commands', relativePath: 'native.md' })
    const nonAliasingSkill = resource({ id: 'plain-skill', agentKind: 'claude', resourceType: 'skills', relativePath: 'plain-skill/SKILL.md' })
    const config: Config = {
      ...bareConfig(),
      harnessConfig: { version: 1, resources: [nativeCommand, nonAliasingSkill] }
    }

    const aliasingSkill = resource({
      id: 'aliasing-skill',
      agentKind: 'claude',
      resourceType: 'skills',
      aliasResourceTypes: ['commands'],
      relativePath: 'aliasing-skill/SKILL.md'
    })
    replacePersistedHarnessConfigScope(config, commandsScope, [aliasingSkill])

    const ids = config.harnessConfig!.resources.map((r) => r.id).sort()
    expect(ids).toEqual(['aliasing-skill', 'plain-skill'])
    expect(config.harnessConfig!.resources.find((r) => r.id === 'aliasing-skill')).toEqual(aliasingSkill)
  })

  it('rejects incoming resources outside the requested logical view without mutating the config', () => {
    const config: Config = { ...bareConfig(), harnessConfig: { version: 1, resources: [] } }
    const before = JSON.stringify(config)
    const wrongType = resource({ id: 'wrong', agentKind: 'claude', resourceType: 'agents' })
    expect(() => replacePersistedHarnessConfigScope(config, skillsScope, [wrongType])).toThrow(/Invalid Tatsu config/)
    expect(JSON.stringify(config)).toBe(before)
  })

  it('rejects Pi resources', () => {
    const config: Config = { ...bareConfig(), harnessConfig: { version: 1, resources: [] } }
    const piResource = resource({ agentKind: 'pi' as unknown as PersistedHarnessConfigResource['agentKind'] })
    expect(() => replacePersistedHarnessConfigScope(config, skillsScope, [piResource])).toThrow(/Invalid Tatsu config/)
  })

  it('rejects duplicate physical IDs in the incoming batch', () => {
    const config: Config = { ...bareConfig(), harnessConfig: { version: 1, resources: [] } }
    const a = resource({ id: 'dup', agentKind: 'claude', resourceType: 'skills', relativePath: 'a/SKILL.md' })
    const b = resource({ id: 'dup', agentKind: 'claude', resourceType: 'skills', relativePath: 'b/SKILL.md' })
    expect(() => replacePersistedHarnessConfigScope(config, skillsScope, [a, b])).toThrow(/Invalid Tatsu config/)
  })

  it('rejects unsafe relative paths', () => {
    const config: Config = { ...bareConfig(), harnessConfig: { version: 1, resources: [] } }
    const bad = resource({ agentKind: 'claude', resourceType: 'skills', relativePath: '../escape/SKILL.md' })
    expect(() => replacePersistedHarnessConfigScope(config, skillsScope, [bad])).toThrow(/Invalid Tatsu config/)
  })

  it('rejects a self-alias', () => {
    const config: Config = { ...bareConfig(), harnessConfig: { version: 1, resources: [] } }
    const bad = resource({ agentKind: 'claude', resourceType: 'skills', aliasResourceTypes: ['skills'] })
    expect(() => replacePersistedHarnessConfigScope(config, skillsScope, [bad])).toThrow(/Invalid Tatsu config/)
  })

  it('rejects duplicate alias types', () => {
    const config: Config = { ...bareConfig(), harnessConfig: { version: 1, resources: [] } }
    const bad = resource({
      agentKind: 'claude',
      resourceType: 'skills',
      aliasResourceTypes: ['commands', 'commands'] as unknown as PersistedHarnessConfigResource['aliasResourceTypes']
    })
    expect(() => replacePersistedHarnessConfigScope(config, skillsScope, [bad])).toThrow(/Invalid Tatsu config/)
  })

  it('rejects invalid (negative) timestamps', () => {
    const config: Config = { ...bareConfig(), harnessConfig: { version: 1, resources: [] } }
    const bad = resource({ agentKind: 'claude', resourceType: 'skills', updatedAt: -1 })
    expect(() => replacePersistedHarnessConfigScope(config, skillsScope, [bad])).toThrow(/Invalid Tatsu config/)
  })

  it('rejects malformed hashes', () => {
    const config: Config = { ...bareConfig(), harnessConfig: { version: 1, resources: [] } }
    const bad = resource({ agentKind: 'claude', resourceType: 'skills', hash: 'not-a-hash' })
    expect(() => replacePersistedHarnessConfigScope(config, skillsScope, [bad])).toThrow(/Invalid Tatsu config/)
  })

  it('rejects content/hash mismatches', () => {
    const config: Config = { ...bareConfig(), harnessConfig: { version: 1, resources: [] } }
    const bad = resource({ agentKind: 'claude', resourceType: 'skills', content: 'a', hash: sha256('b') })
    expect(() => replacePersistedHarnessConfigScope(config, skillsScope, [bad])).toThrow(/Invalid Tatsu config/)
  })

  it('produces deterministic output order: harness, then resourceType, then relativePath, then id', () => {
    const config: Config = { ...bareConfig(), harnessConfig: { version: 1, resources: [] } }
    const agentsScope: HarnessConfigScope = { agentKind: 'claude', resourceType: 'agents' }
    const resources = [
      resource({ id: 'b', agentKind: 'claude', resourceType: 'agents', relativePath: 'z.md' }),
      resource({ id: 'a', agentKind: 'claude', resourceType: 'agents', relativePath: 'a.md' })
    ]
    replacePersistedHarnessConfigScope(config, agentsScope, resources)
    expect(config.harnessConfig!.resources.map((r) => r.id)).toEqual(['a', 'b'])
  })
})

describe('replacePersistedHarnessConfigScope — durable write', () => {
  const originalDataDir = process.env.HARNESS_DATA_DIR
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-config-write-test-'))
    process.env.HARNESS_DATA_DIR = dir
    resetPathsForTests()
  })

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.HARNESS_DATA_DIR
    else process.env.HARNESS_DATA_DIR = originalDataDir
    resetPathsForTests()
    rmSync(dir, { recursive: true, force: true })
  })

  const skillsScope: HarnessConfigScope = { agentKind: 'claude', resourceType: 'skills' }

  it('writes the complete JSON config containing unrelated settings plus the next Tatsu config, then updates the in-memory reference', () => {
    const config: Config = { ...bareConfig(), claudeCommand: 'claude --verbose', harnessConfig: { version: 1, resources: [] } }
    const newSkill = resource({ id: 'skill-new', agentKind: 'claude', resourceType: 'skills' })

    replacePersistedHarnessConfigScope(config, skillsScope, [newSkill])

    expect(config.harnessConfig!.resources).toEqual([newSkill])

    const onDisk = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8')) as Config
    expect(onDisk.claudeCommand).toBe('claude --verbose')
    expect(onDisk.harnessConfig).toEqual({ version: 1, resources: [newSkill] })
  })

  it('propagates a write failure and leaves the in-memory Tatsu config unchanged, without logging content', () => {
    // Point the config path at a regular file instead of a directory so the
    // write underneath it fails with a realistic filesystem error (ENOTDIR),
    // without mocking fs.
    rmSync(dir, { recursive: true, force: true })
    writeFileSync(dir, '') // `dir` is now a file, not a directory
    resetPathsForTests()

    const original = { version: 1 as const, resources: [] }
    const config: Config = { ...bareConfig(), harnessConfig: original }
    const secretContent = 'top secret skill instructions, never log me'
    const bad = resource({ agentKind: 'claude', resourceType: 'skills', content: secretContent, hash: sha256(secretContent) })

    const errors: unknown[][] = []
    const originalConsoleError = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args)
    }
    try {
      expect(() => replacePersistedHarnessConfigScope(config, skillsScope, [bad])).toThrow()
    } finally {
      console.error = originalConsoleError
    }

    expect(config.harnessConfig).toBe(original)
    for (const call of errors) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(secretContent)
      }
    }
  })
})

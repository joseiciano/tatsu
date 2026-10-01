import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { basename, dirname, join, resolve } from 'path'

import { createHarnessConfigService } from '.'
import {
  createCommandFromSkill,
  createSkillFromCommand,
  extractFrontMatterDescription,
  slugifyLogicalName
} from './conversion'


type AnyRecord = Record<string, unknown>
type Scope = { agentKind: string; resourceType: string }

type FileRef = {
  id: string
  agentKind: string
  resourceType: string
  canonicalResourceType: string
  aliasResourceTypes: string[]
  label: string
  relativePath: string
  absolutePath: string
  hash: string
  existsOnDisk: boolean
  managed: boolean
  updatedAt: number
}
type RefSeed = Pick<FileRef, 'id' | 'agentKind' | 'relativePath'> & Partial<Omit<FileRef, 'id' | 'agentKind' | 'relativePath'>>

type DesiredResource = {
  id: string
  agentKind: string
  resourceType: string
  canonicalResourceType?: string
  aliasResourceTypes?: string[]
  relativePath: string
  label?: string
  content: string
  hash: string
  updatedAt: number
}

type Resolver = AnyRecord
type Comparison = {
  scope: Scope
  status: string
  diskOnly: FileRef[]
  configOnly: FileRef[]
  changed: AnyRecord[]
}
type Plan = Comparison & {
  planId: string
  direction: string
  generatedAt: number
  fingerprint: string
}
type MutationPlan = { planId: string; [key: string]: unknown }
type ApplyResult = { applied: AnyRecord[]; requiresRescan: boolean; [key: string]: unknown }
type Conversion = { status: string; ref: FileRef; [key: string]: unknown }

type TestService = {
  scan(scope: Scope): FileRef[]
  readFile(id: string): Promise<AnyRecord> | AnyRecord
  planSync(scope: Scope): Comparison
  planSyncToDisk(scope: Scope): Plan
  planAdoptFromDisk(scope: Scope): Plan
  prepareCreate(scope: Scope, name: string, content: string): MutationPlan
  prepareUpdate(scope: Scope, id: string, content: string): MutationPlan
  prepareDelete(scope: Scope, id: string): MutationPlan
  prepareCommandFromSkill(scope: Scope, id: string): Conversion
  prepareSkillFromCommand(scope: Scope, id: string): Conversion
  applyPlan(request: AnyRecord): Promise<ApplyResult>
}

type DesiredStore = {
  resources: DesiredResource[]
  loadDesiredResources: ReturnType<typeof vi.fn>
  replaceDesiredScope: ReturnType<typeof vi.fn>
}

type FsAdapter = AnyRecord
type FixtureOptions = {
  root?: string
  roots?: Record<string, string>
  resolvers?: Record<string, AnyRecord>
  desired?: DesiredResource[]
  fs?: AnyRecord
  clock?: () => number
  uuid?: () => string
  log?: (...args: unknown[]) => void
  deps?: AnyRecord
}

type Fixture = {
  root: string
  roots: Record<string, string>
  resolvers: Record<string, AnyRecord>
  desired: DesiredStore
  fs: FsAdapter
  service: TestService
}

const NOW = 1_759_000_000_000
let root: string
let nextId = 0

const unsupportedScopes: Scope[] = [
  { agentKind: 'pi', resourceType: 'agents' },
  { agentKind: 'pi', resourceType: 'skills' },
  { agentKind: 'pi', resourceType: 'commands' },
  { agentKind: 'codex', resourceType: 'commands' }
]
const managedScopes: Scope[] = [
  { agentKind: 'claude', resourceType: 'agents' },
  { agentKind: 'claude', resourceType: 'skills' },
  { agentKind: 'claude', resourceType: 'commands' },
  { agentKind: 'codex', resourceType: 'agents' },
  { agentKind: 'codex', resourceType: 'skills' },
  { agentKind: 'opencode', resourceType: 'agents' },
  { agentKind: 'opencode', resourceType: 'skills' },
  { agentKind: 'opencode', resourceType: 'commands' }
]



function hashBytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
function physicalId(agentKind: string, rootKey: string, relativePath: string): string {
  return hashBytes(Buffer.from(`${agentKind}\u0000${rootKey}\u0000${relativePath}`, 'utf8'))
}


function pathFor(rootPath: string, path: string): string {
  return join(rootPath, ...path.split('/'))
}

function put(rootPath: string, path: string, content: string | Buffer): string {
  const target = pathFor(rootPath, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  return target
}

function resolver(
  agentKind: string,
  resourceType: string,
  rootKey: string,
  pattern: RegExp,
  options: AnyRecord = {}
): Resolver {
  return {
    supported: true,
    reason: options.reason ?? 'fixture unsupported',
    rootKey,
    identity: options.identity ?? `${agentKind}-${resourceType}-fixture-v1`,
    verificationSource: options.verificationSource ?? 'test fixture',
    canonicalResourceType: options.canonicalResourceType ?? resourceType,
    aliasResourceTypes: options.aliasResourceTypes ?? [],
    aliasSourceResourceTypes: options.aliasSourceResourceTypes ?? [],
    maxDepth: options.maxDepth ?? Number.POSITIVE_INFINITY,
    matches: options.matches ?? ((relativePath: string) => pattern.test(relativePath)),
    nameToRelativePath:
      options.nameToRelativePath ?? ((name: string) => `${name}.md`),
    pattern
  }
}

function makeDesired(initial: DesiredResource[] = []): DesiredStore {
  const desired: DesiredStore = {
    resources: structuredClone(initial),
    loadDesiredResources: vi.fn(() => structuredClone(desired.resources)),
    replaceDesiredScope: vi.fn((scope: Scope, resources: DesiredResource[]) => {
      desired.resources = desired.resources.filter(
        (resource) =>
          resource.agentKind !== scope.agentKind ||
          (resource.resourceType !== scope.resourceType &&
            !(resource.aliasResourceTypes ?? []).includes(scope.resourceType))
      )
      desired.resources.push(...structuredClone(resources))
    })
  }
  return desired
}

function makeFsAdapter(overrides: AnyRecord = {}): FsAdapter {
  return {
    readdirSync,
    lstatSync,
    readFileSync,
    writeFileSync,
    appendFileSync,
    renameSync,
    unlinkSync,
    mkdirSync,
    existsSync,
    realpathSync: (value: string) => resolve(value),
    ...overrides
  }
}

function makeFixture(options: FixtureOptions = {}): Fixture {
  root = options.root ?? mkdtempSync(join(tmpdir(), 'harness-config-test-'))
  const roots: Record<string, string> = options.roots ?? {}
  const resolvers: Record<string, AnyRecord> = options.resolvers ?? {}
  const desired = makeDesired(options.desired ?? [])
  const fs = makeFsAdapter(options.fs)
  const clock = options.clock ?? (() => NOW)
  const uuid = options.uuid ?? (() => `plan-${++nextId}`)
  const resolverMap: Record<string, AnyRecord> = { ...resolvers }
  const deps: AnyRecord = {
    knownRoots: roots,
    resolvers: resolverMap,
    clock,
    uuid,
    loadDesiredResources: desired.loadDesiredResources,
    replaceDesiredScope: desired.replaceDesiredScope,
    filesystem: fs,
    fs,
    log: options.log ?? vi.fn(),
    formatErr: (error: unknown) => String(error),
    ...options.deps
  }
  const service = createHarnessConfigService(deps as unknown as Parameters<typeof createHarnessConfigService>[0]) as unknown as TestService
  return { root, roots, resolvers: resolverMap, desired, fs, service }
}

function addResolver(
  fixture: Fixture,
  scope: Scope,
  key: string,
  pattern = /\.md$/,
  options: AnyRecord = {}
): Resolver {
  const resolverDescriptor = resolver(
    scope.agentKind,
    scope.resourceType,
    key,
    pattern,
    options
  )
  fixture.roots[key] = join(fixture.root, key.replace(/[^a-z0-9-]/gi, '-'))
  mkdirSync(fixture.roots[key], { recursive: true })
  const harness = fixture.resolvers[scope.agentKind] ?? {
    agentKind: scope.agentKind,
    identity: options.harnessIdentity ?? `${scope.agentKind}-fixture-v1`,
    resources: {}
  }
  const resources = (harness.resources ?? {}) as Record<string, Resolver>
  resources[scope.resourceType] = resolverDescriptor
  harness.resources = resources
  fixture.resolvers[scope.agentKind] = harness
  return resolverDescriptor
}
function resourceDescriptor(fixture: Fixture, scope: Scope): AnyRecord {
  const harness = fixture.resolvers[scope.agentKind]
  const resources = harness.resources
  if (!resources || typeof resources !== 'object') throw new Error('missing resolver resources')
  const descriptor = (resources as Record<string, unknown>)[scope.resourceType]
  if (!descriptor || typeof descriptor !== 'object') throw new Error('missing resolver descriptor')
  return descriptor as AnyRecord
}

function refToDesired(ref: RefSeed, content: string): DesiredResource {
  return {
    id: ref.id,
    agentKind: ref.agentKind,
    resourceType: ref.canonicalResourceType ?? ref.resourceType ?? 'agents',
    canonicalResourceType: ref.canonicalResourceType ?? ref.resourceType ?? 'agents',
    aliasResourceTypes: ref.aliasResourceTypes ?? [],
    relativePath: ref.relativePath,
    label: ref.label ?? ref.relativePath,
    content,
    hash: hashBytes(Buffer.from(content, 'utf8')),
    updatedAt: ref.updatedAt ?? NOW
  }
}

function expectStructuredCode(error: unknown, code: string): void {
  expect(error).toMatchObject({ code })
}

async function rejectsCode(action: () => unknown | Promise<unknown>, code: string): Promise<void> {
  try {
    await action()
    throw new Error(`expected ${code} rejection`)
  } catch (error) {
    expectStructuredCode(error, code)
  }
}

function backupFiles(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.includes('.x-backup-'))
}

function tempFiles(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.includes('.tmp-') || name.includes('.harness-config-'))
}

function snapshotTree(directory: string): Record<string, string> {
  const snapshot: Record<string, string> = {}
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const entryPath = join(dir, name)
      const relative = prefix ? `${prefix}/${name}` : name
      const info = lstatSync(entryPath)
      if (info.isSymbolicLink()) {
        snapshot[relative] = '<symlink>'
      } else if (info.isDirectory()) {
        walk(entryPath, relative)
      } else {
        snapshot[relative] = readFileSync(entryPath).toString('base64')
      }
    }
  }
  walk(directory, '')
  return snapshot
}

beforeEach(() => {
  nextId = 0
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

  it('uses built-in production resolvers for all supported pairs and rejects Codex commands', () => {
    const fixture = makeFixture()
    const fixtureRoot = fixture.root
    const home = join(fixtureRoot, 'home')
    const claudeHome = join(home, '.claude')
    const codexHome = join(home, '.codex')
    const agentsHome = join(home, '.agents')
    const opencodeHome = join(home, '.config', 'opencode')
    const roots: Record<string, string> = {
      claudeAgents: join(claudeHome, 'agents'),
      claudeSkills: join(claudeHome, 'skills'),
      claudeCommands: join(claudeHome, 'commands'),
      codexHome,
      codexSkills: join(agentsHome, 'skills'),
      opencodeAgents: join(opencodeHome, 'agents'),
      opencodeSkills: join(opencodeHome, 'skills'),
      opencodeCommands: join(opencodeHome, 'commands')
    }
    const production = makeFixture({
      roots,
      deps: {
        homeDir: home,
        env: { HOME: home, CODEX_HOME: codexHome }
      }
    })
    rmSync(fixtureRoot, { recursive: true, force: true })
    put(roots.claudeAgents, 'built-in.md', 'claude agent')
    put(roots.claudeSkills, 'built-in/SKILL.md', 'claude skill')
    put(roots.claudeCommands, 'built-in.md', 'claude command')
    put(roots.codexHome, 'AGENTS.md', 'codex agent')
    put(roots.codexSkills, 'built-in/SKILL.md', 'codex skill')
    put(roots.opencodeAgents, 'built-in.md', 'opencode agent')
    put(roots.opencodeSkills, 'built-in/SKILL.md', 'opencode skill')
    put(roots.opencodeCommands, 'built-in.md', 'opencode command')

    for (const scope of managedScopes) {
      expect(production.service.scan(scope)).not.toEqual([])
    }
    expect(() => production.service.scan({ agentKind: 'codex', resourceType: 'commands' })).toThrow()
  })
  it('honors Claude config override while rejecting ambiguous OpenCode overrides', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'harness-config-env-test-'))
    const home = join(fixtureRoot, 'home')
    const claudeOverride = join(fixtureRoot, 'claude-config')
    const opencodeOverride = join(fixtureRoot, 'opencode-config')
    const standardOpenCodeSkills = join(home, '.config', 'opencode', 'skills')
    const fixture = makeFixture({
      root: fixtureRoot,
      deps: {
        homeDir: home,
        env: {
          HOME: home,
          CLAUDE_CONFIG_DIR: claudeOverride,
          OPENCODE_CONFIG_DIR: opencodeOverride
        }
      }
    })
    put(claudeOverride, 'agents/override.md', 'agent')
    put(claudeOverride, 'skills/override/SKILL.md', 'skill')
    put(claudeOverride, 'commands/override.md', 'command')

    for (const scope of [
      { agentKind: 'claude', resourceType: 'agents' },
      { agentKind: 'claude', resourceType: 'skills' },
      { agentKind: 'claude', resourceType: 'commands' }
    ]) {
      const refs = fixture.service.scan(scope)
      expect(refs).not.toEqual([])
      expect(refs.every((ref: FileRef) => ref.absolutePath.startsWith(claudeOverride))).toBe(true)
    }
    expect(() => fixture.service.scan({ agentKind: 'opencode', resourceType: 'agents' })).toThrow()
    expect(() => fixture.service.scan({ agentKind: 'opencode', resourceType: 'skills' })).toThrow()
    expect(() => fixture.service.scan({ agentKind: 'opencode', resourceType: 'commands' })).toThrow()
  })

  it('uses standard OpenCode skills root without override', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'harness-config-opencode-std-'))
    const home = join(fixtureRoot, 'home')
    const standardOpenCodeSkills = join(home, '.config', 'opencode', 'skills')
    const fixture = makeFixture({
      root: fixtureRoot,
      deps: { homeDir: home, env: { HOME: home } }
    })
    put(standardOpenCodeSkills, 'standard/SKILL.md', 'standard skill')
    const refs = fixture.service.scan({ agentKind: 'opencode', resourceType: 'skills' })
    expect(refs).toHaveLength(1)
    expect(refs.every((ref: FileRef) => ref.absolutePath.startsWith(standardOpenCodeSkills))).toBe(true)
  })

describe('harness-config inventory and resolver boundaries', () => {
  it.each([
    ['claude', 'agents', 'claude-agents', /(?:^|\/)[^/]+\.md$/],
    ['claude', 'skills', 'claude-skills', /(?:^|\/)SKILL\.md$/],
    ['claude', 'commands', 'claude-commands', /(?:^|\/)[^/]+\.md$/],
    ['codex', 'agents', 'codex-agents', /AGENTS(?:\.override)?\.md$/],
    ['codex', 'skills', 'codex-skills', /(?:^|\/)SKILL\.md$/],
    ['opencode', 'agents', 'opencode-agents', /(?:^|\/)[^/]+\.md$/],
    ['opencode', 'skills', 'opencode-skills', /(?:^|\/)SKILL\.md$/],
    ['opencode', 'commands', 'opencode-commands', /(?:^|\/)[^/]+\.md$/]
  ])(
    'scans supported %s/%s only from its injected known root and declared entrypoint',
    (agentKind, resourceType, rootKey, pattern) => {
      const fixture = makeFixture()
      const scope = { agentKind, resourceType }
      addResolver(fixture, scope, rootKey, pattern)
      put(fixture.roots[rootKey], 'nested/keep.md', 'managed')
      put(fixture.roots[rootKey], 'nested/SKILL.md', 'skill')
      put(fixture.roots[rootKey], 'adjacent.txt', 'ignore')
      put(fixture.roots[rootKey], 'nested/SKILL.md.x-backup-20260926T000000000Z', 'backup')

      const refs = fixture.service.scan(scope)
      expect(refs.map((ref: FileRef) => ref.relativePath)).toEqual(
        refs.map((ref: FileRef) => ref.relativePath).sort()
      )
      expect(refs.every((ref: FileRef) => ref.absolutePath.startsWith(fixture.roots[rootKey]))).toBe(true)
      expect(refs.some((ref: FileRef) => ref.relativePath.includes('backup'))).toBe(false)
      expect(refs.some((ref: FileRef) => ref.relativePath === 'adjacent.txt')).toBe(false)
    }
  )

  it.each(unsupportedScopes)(
    'rejects unsupported %s/%s without synthesizing a path',
    (scope) => {
      const fixture = makeFixture()
      expect(() => fixture.service.scan(scope)).toThrow()
      expect(() => fixture.service.planSync(scope)).toThrow()
      expect(fixture.desired.loadDesiredResources).not.toHaveBeenCalled()
    }
  )

  it('rejects an unavailable, empty, or ambiguous root instead of falling back', () => {
    const fixture = makeFixture({ roots: { one: join(fixtureRootPlaceholder(), 'missing') } })
    const scope = { agentKind: 'claude', resourceType: 'agents' }
    fixture.resolvers.claude = {
      agentKind: 'claude',
      identity: 'claude-fixture-v1',
      resources: { agents: resolver('claude', 'agents', 'one', /\.md$/) }
    }
    fixture.roots.one = join(fixture.root, 'missing')

    expect(() => fixture.service.scan(scope)).toThrow()
    expect(() => fixture.service.scan({ agentKind: 'pi', resourceType: 'agents' })).toThrow()
  })

  it('excludes symlink files and symlink directories, including escaping targets', () => {
    const fixture = makeFixture()
    const scope = { agentKind: 'claude', resourceType: 'skills' }
    addResolver(fixture, scope, 'skills', /(?:^|\/)SKILL\.md$/)
    put(fixture.roots.skills, 'real/SKILL.md', 'real')
    const outside = join(fixture.root, 'outside')
    mkdirSync(outside)
    put(outside, 'SKILL.md', 'secret')
    symlinkSync(join(outside, 'SKILL.md'), join(fixture.roots.skills, 'escape.md'))
    symlinkSync(outside, join(fixture.roots.skills, 'linked-dir'))

    const refs = fixture.service.scan(scope)
    expect(refs.map((ref: FileRef) => ref.relativePath)).toEqual(['real/SKILL.md'])
  })

  it('sorts by POSIX relative path and reports disk metadata without mutating desired state', () => {
    const fixture = makeFixture()
    const scope = { agentKind: 'opencode', resourceType: 'commands' }
    addResolver(fixture, scope, 'commands', /\.md$/)
    put(fixture.roots.commands, 'z.md', 'z')
    put(fixture.roots.commands, 'a.md', 'a')
    put(fixture.roots.commands, 'nested/m.md', 'm')

    const refs = fixture.service.scan(scope)
    expect(refs.map((ref: FileRef) => ref.relativePath)).toEqual(['a.md', 'nested/m.md', 'z.md'])
    expect(refs.every((ref: FileRef) => ref.existsOnDisk === true && ref.managed === false)).toBe(true)
    expect(fixture.desired.loadDesiredResources).toHaveBeenCalledTimes(1)
    expect(fixture.desired.replaceDesiredScope).not.toHaveBeenCalled()
  })
})

describe('harness-config hashes, identities, aliases, and reads', () => {
  it('hashes exact bytes, preserving Unicode and newline distinctions', async () => {
    const fixture = makeFixture()
    const scope = { agentKind: 'claude', resourceType: 'commands' }
    addResolver(fixture, scope, 'commands', /\.md$/)
    const content = Buffer.from('é\r\nline\n', 'utf8')
    put(fixture.roots.commands, 'unicode.md', content)

    const [ref] = fixture.service.scan(scope)
    expect(ref.hash).toBe(hashBytes(content))
    expect(await fixture.service.readFile(ref.id)).toMatchObject({
      content: content.toString('utf8'),
      hash: hashBytes(content)
    })
  })

  it('keeps physical identity stable across fresh scans and independent of logical view', () => {
    const fixture = makeFixture()
    const skills = { agentKind: 'claude', resourceType: 'skills' }
    const commands = { agentKind: 'claude', resourceType: 'commands' }
    addResolver(fixture, skills, 'claude-skills', /SKILL\.md$/, {
      canonicalResourceType: 'skills',
      aliasResourceTypes: ['commands']
    })
    addResolver(fixture, commands, 'claude-skills', /SKILL\.md$/, {
      canonicalResourceType: 'skills',
      aliasResourceTypes: ['commands'],
      aliases: [{ resourceType: 'commands', canonicalResourceType: 'skills' }]
    })
    put(fixture.roots['claude-skills'], 'format/SKILL.md', '# skill')
    const skillRef = fixture.service.scan(skills)[0]
    const commandRef = fixture.service.scan(commands)[0]
    expect(commandRef.id).toBe(skillRef.id)
    expect(commandRef.absolutePath).toBe(skillRef.absolutePath)
    expect(commandRef.canonicalResourceType).toBe('skills')
    expect(commandRef.aliasResourceTypes).toEqual(['commands'])
    expect(fixture.service.scan(skills)[0].id).toBe(skillRef.id)
  })

  it('uses fresh recognized inventory for reads and never trusts a renderer path', async () => {
    const fixture = makeFixture()
    const scope = { agentKind: 'claude', resourceType: 'agents' }
    addResolver(fixture, scope, 'agents', /\.md$/)
    const target = put(fixture.roots.agents, 'agent.md', 'safe')
    const [ref] = fixture.service.scan(scope)
    appendFileSync(target, '-changed')

    expect(await fixture.service.readFile(ref.id)).toMatchObject({
      content: 'safe-changed',
      hash: hashBytes(Buffer.from('safe-changed'))
    })
  })
})

describe('scoped comparison and non-mutating actionable plans', () => {
  function setupComparison(desired: DesiredResource[] = []): Fixture {
    const fixture = makeFixture({ desired })
    const scope = { agentKind: 'claude', resourceType: 'agents' }
    addResolver(fixture, scope, 'agents', /\.md$/)
    return fixture
  }

  it('classifies synced, disk-only, config-only, and changed scopes with exact precedence', () => {
    const fixture = setupComparison()
    const scope = { agentKind: 'claude', resourceType: 'agents' }
    const target = put(fixture.roots.agents, 'same.md', 'disk')
    const sameRef = fixture.service.scan(scope)[0]
    fixture.desired.resources = [refToDesired(sameRef, 'disk')]
    expect(fixture.service.planSync(scope).status).toBe('synced')

    // TEST-003: a disk file with no corresponding desired resource appears in
    // `diskOnly` with real hash/path metadata and `existsOnDisk: true`.
    fixture.desired.resources = []
    const diskOnlyComparison = fixture.service.planSync(scope)
    expect(diskOnlyComparison.status).toBe('disk-only')
    expect(diskOnlyComparison.configOnly).toHaveLength(0)
    expect(diskOnlyComparison.changed).toHaveLength(0)
    expect(diskOnlyComparison.diskOnly).toHaveLength(1)
    expect(diskOnlyComparison.diskOnly[0]).toMatchObject({
      relativePath: 'same.md',
      existsOnDisk: true,
      hash: hashBytes(Buffer.from('disk'))
    })
    expect(diskOnlyComparison.diskOnly[0].absolutePath).toBe(target)

    // TEST-004: a desired resource with no corresponding disk file appears in
    // `configOnly` with `existsOnDisk: false` and a resolver-derived path.
    unlinkSync(target)
    fixture.desired.resources = [refToDesired(sameRef, 'disk')]
    const configOnlyComparison = fixture.service.planSync(scope)
    expect(configOnlyComparison.status).toBe('config-only')
    expect(configOnlyComparison.diskOnly).toHaveLength(0)
    expect(configOnlyComparison.changed).toHaveLength(0)
    expect(configOnlyComparison.configOnly).toHaveLength(1)
    expect(configOnlyComparison.configOnly[0]).toMatchObject({
      relativePath: 'same.md',
      existsOnDisk: false
    })
    expect(configOnlyComparison.configOnly[0].absolutePath).toBe(target)

    // TEST-005: differing bytes on disk versus desired state classify as an
    // explicit `{ disk, config }` changed pair and force status `conflict`,
    // even though diskOnly/configOnly are both empty.
    put(fixture.roots.agents, 'same.md', 'new-disk')
    const conflictComparison = fixture.service.planSync(scope)
    expect(conflictComparison.status).toBe('conflict')
    expect(conflictComparison.diskOnly).toHaveLength(0)
    expect(conflictComparison.configOnly).toHaveLength(0)
    expect(conflictComparison.changed).toHaveLength(1)
    expect(conflictComparison.changed[0].disk).toMatchObject({
      relativePath: 'same.md',
      hash: hashBytes(Buffer.from('new-disk')),
      existsOnDisk: true
    })
    expect(conflictComparison.changed[0].config).toMatchObject({
      relativePath: 'same.md',
      hash: hashBytes(Buffer.from('disk'))
    })
  })
  it('rejects a persisted resource whose id does not match physical identity before comparison', () => {
    const fixture = setupComparison([{
      id: 'not-the-physical-id',
      agentKind: 'claude',
      resourceType: 'agents',
      relativePath: 'config.md',
      content: 'config',
      hash: hashBytes('config'),
      updatedAt: NOW
    }])
    expect(() => fixture.service.planSync({ agentKind: 'claude', resourceType: 'agents' })).toThrow()
  })

  it('isolates comparisons and plans to exact harness/resource scope', () => {
    const fixture = makeFixture()
    const claude = { agentKind: 'claude', resourceType: 'agents' }
    const codex = { agentKind: 'codex', resourceType: 'agents' }
    addResolver(fixture, claude, 'claude-agents', /\.md$/)
    addResolver(fixture, codex, 'codex-agents', /\.md$/)
    put(fixture.roots['claude-agents'], 'one.md', 'one')
    put(fixture.roots['codex-agents'], 'other.md', 'other')

    const comparison = fixture.service.planSync(claude)
    expect(comparison.scope).toEqual(claude)
    expect(comparison.diskOnly.every((ref: FileRef) => ref.agentKind === 'claude')).toBe(true)
    expect(comparison.diskOnly.every((ref: FileRef) => ref.resourceType === 'agents')).toBe(true)
    expect(fixture.service.planSync(codex).diskOnly[0].agentKind).toBe('codex')

    // TEST-012: sync-to-disk plans generated for two different harnesses are
    // distinct objects that never share a mutable `diskOnly` array — mutating
    // one plan's array must never be observable through the other.
    const claudePlan = fixture.service.planSyncToDisk(claude)
    const codexPlan = fixture.service.planSyncToDisk(codex)
    expect(claudePlan).not.toBe(codexPlan)
    expect(claudePlan.diskOnly).not.toBe(codexPlan.diskOnly)
    expect(claudePlan.diskOnly.every((ref) => ref.agentKind === 'claude')).toBe(true)
    expect(codexPlan.diskOnly.every((ref) => ref.agentKind === 'codex')).toBe(true)
    const claudeDiskOnlyLengthBefore = claudePlan.diskOnly.length
    codexPlan.diskOnly.push({ ...codexPlan.diskOnly[0] })
    expect(claudePlan.diskOnly).toHaveLength(claudeDiskOnlyLengthBefore)
  })

  it('generates sync and adopt plans without writes and keeps executable content private', () => {
    const fixture = setupComparison()
    put(fixture.roots.agents, 'disk.md', 'disk')
    fixture.desired.resources = [{
      ...refToDesired({
        id: physicalId('claude', 'agents', 'config.md'),
        agentKind: 'claude',
        resourceType: 'agents',
        canonicalResourceType: 'agents',
        relativePath: 'config.md',
        label: 'config'
      }, 'config')
    }]
    const scope = { agentKind: 'claude', resourceType: 'agents' }
    const sync = fixture.service.planSyncToDisk(scope)
    const adopt = fixture.service.planAdoptFromDisk(scope)

    expect(sync.direction).toBe('sync-to-disk')
    expect(adopt.direction).toBe('adopt-from-disk')
    expect(sync).not.toHaveProperty('operations')
    expect(sync).not.toHaveProperty('content')
    expect(adopt).not.toHaveProperty('operations')
    expect(adopt).not.toHaveProperty('content')
    expect(fixture.desired.replaceDesiredScope).not.toHaveBeenCalled()
    expect(readFileSync(join(fixture.roots.agents, 'disk.md'), 'utf8')).toBe('disk')
  })

  it('deduplicates Claude alias records and retains canonical physical identity in plans', () => {
    const fixture = makeFixture()
    const skills = { agentKind: 'claude', resourceType: 'skills' }
    const commands = { agentKind: 'claude', resourceType: 'commands' }
    addResolver(fixture, skills, 'skills', /SKILL\.md$/, {
      canonicalResourceType: 'skills', aliasResourceTypes: ['commands']
    })
    addResolver(fixture, commands, 'skills', /SKILL\.md$/, {
      canonicalResourceType: 'skills', aliasResourceTypes: ['commands'],
      aliases: [{ resourceType: 'commands', canonicalResourceType: 'skills' }]
    })
    put(fixture.roots.skills, 'one/SKILL.md', 'same')

    const skillRef = fixture.service.scan(skills)[0]
    fixture.desired.resources = [refToDesired(skillRef, 'same')]
    const comparison = fixture.service.planSync(commands)
    expect(comparison.status).toBe('synced')
    expect(comparison.diskOnly).toHaveLength(0)
    expect(comparison.configOnly).toHaveLength(0)
  })

  it('refuses direct destination collisions before storing a mutation plan', async () => {
    const fixture = setupComparison()
    put(fixture.roots.agents, 'taken.md', 'existing')
    await rejectsCode(
      () => fixture.service.prepareCreate({ agentKind: 'claude', resourceType: 'agents' }, 'taken', 'new'),
      'collision'
    )
    expect(fixture.desired.replaceDesiredScope).not.toHaveBeenCalled()
  })

  // TEST-001: a logical name that does not match the resolver's filename
  // pattern for the selected harness/resource cannot be written, even when
  // the name is otherwise path-safe (no traversal/NUL/absolute characters).
  it('rejects a create whose logical name does not match the resolver pattern', async () => {
    const fixture = makeFixture()
    const scope = { agentKind: 'codex', resourceType: 'agents' }
    addResolver(fixture, scope, 'codex-agents', /^AGENTS(?:\.override)?\.md$/)
    const beforeTree = snapshotTree(fixture.root)

    await rejectsCode(() => fixture.service.prepareCreate(scope, 'notes', 'content'), 'unsafe-path')
    expect(snapshotTree(fixture.root)).toEqual(beforeTree)
    expect(fixture.desired.replaceDesiredScope).not.toHaveBeenCalled()
  })

  // TEST-001: an update/delete of an ID absent from a fresh recognized
  // inventory is rejected with zero writes and zero desired-state changes.
  it('rejects update and delete of an unrecognized resource id with zero writes', async () => {
    const fixture = setupComparison()
    const scope = { agentKind: 'claude', resourceType: 'agents' }
    put(fixture.roots.agents, 'existing.md', 'keep')
    const beforeTree = snapshotTree(fixture.root)

    await rejectsCode(() => fixture.service.prepareUpdate(scope, 'nonexistent-id', 'new'), 'unknown-resource')
    await rejectsCode(() => fixture.service.prepareDelete(scope, 'nonexistent-id'), 'unknown-resource')

    expect(snapshotTree(fixture.root)).toEqual(beforeTree)
    expect(fixture.desired.replaceDesiredScope).not.toHaveBeenCalled()
  })
})

describe('confirmation, staleness, and path security', () => {
  function createFixture(): { fixture: Fixture; scope: Scope; target: string } {
    const fixture = makeFixture()
    const scope = { agentKind: 'claude', resourceType: 'agents' }
    addResolver(fixture, scope, 'agents', /\.md$/)
    const target = put(fixture.roots.agents, 'target.md', 'old')
    return { fixture, scope, target }
  }

  it('treats cancellation and confirmed !== true as no-ops without consuming a plan', async () => {
    const { fixture, scope, target } = createFixture()
    fixture.desired.resources = []
    const plan = fixture.service.prepareUpdate(scope, fixture.service.scan(scope)[0].id, 'new')

    await rejectsCode(
      () => fixture.service.applyPlan({ scope, planId: plan.planId, confirmed: false }),
      'unconfirmed-plan'
    )
    expect(readFileSync(target, 'utf8')).toBe('old')
    expect(fixture.desired.replaceDesiredScope).not.toHaveBeenCalled()

    // TEST-015: a request with `confirmed` entirely absent is rejected the
    // same as an explicit `false`, proving the gate checks for `=== true`
    // rather than treating a missing key as implicitly confirmed.
    await rejectsCode(
      () => fixture.service.applyPlan({ scope, planId: plan.planId }),
      'unconfirmed-plan'
    )
    expect(readFileSync(target, 'utf8')).toBe('old')
    expect(fixture.desired.replaceDesiredScope).not.toHaveBeenCalled()

    expect((await fixture.service.applyPlan({ scope, planId: plan.planId, confirmed: true })).applied).toHaveLength(1)
  })

  it.each([
    ['unknown plan', (fixture: Fixture, scope: Scope, _plan: MutationPlan) => ({ scope, planId: 'missing', confirmed: true }), 'unknown-plan'],
    ['wrong scope', (fixture: Fixture, scope: Scope, plan: MutationPlan) => ({ scope: { ...scope, resourceType: 'skills' }, planId: plan.planId, confirmed: true }), 'scope-mismatch']
  ])('%s cannot mutate disk or desired state', async (_name, request, code) => {
    const { fixture, scope } = createFixture()
    const plan = fixture.service.prepareCreate(scope, 'fresh', 'new')
    await rejectsCode(() => fixture.service.applyPlan(request(fixture, scope, plan)), code)
    expect(existsSync(join(fixture.roots.agents, 'fresh.md'))).toBe(false)
    expect(fixture.desired.replaceDesiredScope).not.toHaveBeenCalled()
  })

  it('rejects a reused plan after one successful confirmed application', async () => {
    const { fixture, scope } = createFixture()
    const id = fixture.service.scan(scope)[0].id
    const plan = fixture.service.prepareUpdate(scope, id, 'new')
    await expect(fixture.service.applyPlan({ scope, planId: plan.planId, confirmed: true })).resolves.toBeDefined()
    await rejectsCode(
      () => fixture.service.applyPlan({ scope, planId: plan.planId, confirmed: true }),
      'stale-plan'
    )
  })
  it.each([
    ['disk', (fixture: Fixture, scope: Scope) => put(fixture.roots.agents, 'new.md', 'drift')],
    ['desired config', (fixture: Fixture) => { fixture.desired.resources.push({ id: physicalId('claude', 'agents', 'x.md'), agentKind: 'claude', resourceType: 'agents', relativePath: 'x.md', content: 'x', hash: hashBytes('x'), updatedAt: NOW }) }],
    ['resolver', (fixture: Fixture, scope: Scope) => { resourceDescriptor(fixture, scope).identity = 'changed-v2' }]
  ])('consumes stale %s plans without writing', async (_name, drift) => {
    const { fixture, scope } = createFixture()
    const plan = fixture.service.planSyncToDisk(scope)
    drift(fixture, scope)
    await rejectsCode(() => fixture.service.applyPlan({ scope, planId: plan.planId, confirmed: true }), 'stale-plan')
    expect(fixture.desired.replaceDesiredScope).not.toHaveBeenCalled()
  })

  it.each(['', '/absolute.md', '../escape', 'a/../escape', 'a\\b', 'a\u0000b', '.', '..'])('rejects unsafe logical names: %s', async (name) => {
    const { fixture, scope } = createFixture()
    await rejectsCode(() => fixture.service.prepareCreate(scope, name, 'unsafe'), 'unsafe-path')
    expect(readdirSync(fixture.roots.agents)).toEqual(['target.md'])
  })

  it('rejects persisted traversal and prefix-sibling paths rather than trusting config refs', async () => {
    const fixture = makeFixture({
      desired: [{ id: physicalId('claude', 'agents', '../outside.md'), agentKind: 'claude', resourceType: 'agents', relativePath: '../outside.md', content: 'x', hash: hashBytes('x'), updatedAt: NOW }]
    })
    const scope = { agentKind: 'claude', resourceType: 'agents' }
    addResolver(fixture, scope, 'agents', /\.md$/)
    await rejectsCode(() => fixture.service.planSync(scope), 'unsafe-path')

    fixture.desired.resources = [{ id: physicalId('claude', 'agents', 'agents-sibling/evil.md'), agentKind: 'claude', resourceType: 'agents', relativePath: 'agents-sibling/evil.md', content: 'x', hash: hashBytes('x'), updatedAt: NOW }]
    await rejectsCode(() => fixture.service.planSync(scope), 'unsafe-path')
  })

  it('rejects target and ancestor symlink escapes for direct mutations', async () => {
    const { fixture, scope } = createFixture()
    const outside = join(fixture.root, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(fixture.roots.agents, 'escape'))
    await rejectsCode(() => fixture.service.prepareCreate(scope, 'escape/new', 'secret'), 'unsafe-path')

    symlinkSync(join(outside, 'target.md'), join(fixture.roots.agents, 'link.md'))
    const targetRef = fixture.service.scan(scope).find((ref: FileRef) => ref.relativePath === 'link.md')
    expect(targetRef).toBeUndefined()
  })
  it('rejects creates beneath dangling symlink directories', async () => {
    const { fixture, scope } = createFixture()
    const missingTarget = join(fixture.root, 'missing-target')
    symlinkSync(missingTarget, join(fixture.roots.agents, 'dangling'))
    await rejectsCode(() => fixture.service.prepareCreate(scope, 'dangling/new', 'secret'), 'unsafe-path')
  })

  it('creates parent directories only after confirmed create validation', async () => {
    const { fixture, scope } = createFixture()
    const plan = fixture.service.prepareCreate(scope, 'nested/new', 'created')
    expect(existsSync(join(fixture.roots.agents, 'nested'))).toBe(false)
    await rejectsCode(() => fixture.service.applyPlan({ scope, planId: plan.planId, confirmed: false }), 'unconfirmed-plan')
    expect(existsSync(join(fixture.roots.agents, 'nested'))).toBe(false)
    await fixture.service.applyPlan({ scope, planId: plan.planId, confirmed: true })
    expect(readFileSync(join(fixture.roots.agents, 'nested/new.md'), 'utf8')).toBe('created')
  })
})

describe('backups, atomic writes, rollback, and partial application', () => {
  it('backs up exact pre-change bytes before overwrite and uses collision suffixes', async () => {
    const events: string[] = []
    const fixture = makeFixture({
      fs: makeFsAdapter({
        readFileSync: (path: string) => { events.push(`read:${path}`); return readFileSync(path) },
        writeFileSync: (path: string, data: string | Buffer) => { events.push(`write:${path}`); return writeFileSync(path, data) },
        renameSync: (from: string, to: string) => { events.push(`rename:${from}->${to}`); return renameSync(from, to) }
      })
    })
    const scope = { agentKind: 'claude', resourceType: 'agents' }
    addResolver(fixture, scope, 'agents', /\.md$/)
    put(fixture.roots.agents, 'one.md', Buffer.from([0, 1, 2, 255]))
    put(fixture.roots.agents, 'one.md.x-backup-20250927T190640000Z', 'old-backup')
    const id = fixture.service.scan(scope)[0].id
    const plan = fixture.service.prepareUpdate(scope, id, 'replacement')
    await fixture.service.applyPlan({ scope, planId: plan.planId, confirmed: true })

    const backups = backupFiles(fixture.roots.agents)
    expect(backups).toContain('one.md.x-backup-20250927T190640000Z-2')
    expect(readFileSync(join(fixture.roots.agents, backups.find((name) => name.endsWith('-2'))!))).toEqual(Buffer.from([0, 1, 2, 255]))
    expect(events.findIndex((event) => event.includes('.x-backup-'))).toBeLessThan(events.findIndex((event) => event.includes('rename:')))
  })

  it('backs up deletes, leaves backups visible on disk, and excludes them from rescans', async () => {
    const fixture = makeFixture()
    const scope = { agentKind: 'claude', resourceType: 'agents' }
    addResolver(fixture, scope, 'agents', /\.md$/)
    const target = put(fixture.roots.agents, 'delete.md', 'preserve me')
    const id = fixture.service.scan(scope)[0].id
    const plan = fixture.service.prepareDelete(scope, id)
    await fixture.service.applyPlan({ scope, planId: plan.planId, confirmed: true })

    expect(existsSync(target)).toBe(false)
    const backups = backupFiles(fixture.roots.agents)
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(fixture.roots.agents, backups[0]), 'utf8')).toBe('preserve me')
    expect(fixture.service.scan(scope)).toEqual([])
  })

  it('does not create a backup for a genuinely new target', async () => {
    const fixture = makeFixture()
    const scope = { agentKind: 'claude', resourceType: 'agents' }
    addResolver(fixture, scope, 'agents', /\.md$/)
    const plan = fixture.service.prepareCreate(scope, 'new', 'new bytes')
    await fixture.service.applyPlan({ scope, planId: plan.planId, confirmed: true })
    expect(backupFiles(fixture.roots.agents)).toEqual([])
  })

  it.each(['read', 'create', 'write'])('fails closed when backup %s fails', async (failure) => {
    const fixture = makeFixture()
    const scope = { agentKind: 'claude', resourceType: 'agents' }
    addResolver(fixture, scope, 'agents', /\.md$/)
    const target = put(fixture.roots.agents, 'protected.md', 'original')
    const original = readFileSync(target)
    const throwing = new Error(`backup ${failure}`)
    const fsOverrides: AnyRecord = {}
    let applyStarted = false
    let readsDuringApply = 0
    if (failure === 'read') {
      fsOverrides.readFileSync = vi.fn((path: string) => {
        if (applyStarted && readsDuringApply++ > 0) throw throwing
        return readFileSync(path)
      })
    }
    if (failure === 'create') fsOverrides.writeFileSync = vi.fn(() => { throw throwing })
    if (failure === 'write') fsOverrides.renameSync = vi.fn(() => { throw throwing })
    const failingService = makeFixture({ root: fixture.root, fs: makeFsAdapter(fsOverrides), roots: fixture.roots, resolvers: fixture.resolvers, desired: fixture.desired.resources }).service
    const id = failingService.scan(scope)[0].id
    const plan = failingService.prepareUpdate(scope, id, 'replacement')
    applyStarted = true
    await expect(failingService.applyPlan({ scope, planId: plan.planId, confirmed: true })).rejects.toThrow()
    expect(readFileSync(target)).toEqual(original)
  })

  it('removes temporary files after atomic replacement failure', async () => {
    const fixture = makeFixture({
      fs: makeFsAdapter({ renameSync: vi.fn(() => { throw new Error('rename failed') }) })
    })
    const scope = { agentKind: 'claude', resourceType: 'agents' }
    addResolver(fixture, scope, 'agents', /\.md$/)
    const target = put(fixture.roots.agents, 'atomic.md', 'old')
    const id = fixture.service.scan(scope)[0].id
    const plan = fixture.service.prepareUpdate(scope, id, 'new')
    await expect(fixture.service.applyPlan({ scope, planId: plan.planId, confirmed: true })).rejects.toThrow()
    expect(readFileSync(target, 'utf8')).toBe('old')
    expect(tempFiles(fixture.roots.agents)).toEqual([])
  })

  it('rolls back disk after desired-state persistence failure and retains backup bytes', async () => {
    const desired = makeDesired()
    desired.replaceDesiredScope.mockImplementation(() => { throw new Error('config unavailable') })
    const fixture = makeFixture({
      deps: {
        loadDesiredResources: desired.loadDesiredResources,
        replaceDesiredScope: desired.replaceDesiredScope
      }
    })
    const scope = { agentKind: 'claude', resourceType: 'agents' }
    addResolver(fixture, scope, 'agents', /\.md$/)
    const target = put(fixture.roots.agents, 'rollback.md', 'before')
    const id = fixture.service.scan(scope)[0].id
    const plan = fixture.service.prepareUpdate(scope, id, 'after')
    await rejectsCode(() => fixture.service.applyPlan({ scope, planId: plan.planId, confirmed: true }), 'desired-state-failed')
    expect(readFileSync(target, 'utf8')).toBe('before')
    expect(backupFiles(fixture.roots.agents)).toHaveLength(1)
  })

  // TEST-008 (service half): a confirmed delete whose disk removal succeeds
  // but whose desired-state persistence fails must restore the deleted file
  // from its backup bytes and leave no partial desired-state change. The
  // contrasting control run (below) proves desired state is only touched
  // after the disk delete has already succeeded.
  it('restores a deleted file from backup when desired-state persistence fails after a successful disk delete', async () => {
    const scope = { agentKind: 'claude', resourceType: 'agents' }
    const seeded = {
      id: physicalId('claude', 'agents', 'delete-me.md'),
      agentKind: 'claude',
      resourceType: 'agents',
      relativePath: 'delete-me.md',
      content: 'before delete',
      hash: hashBytes('before delete'),
      updatedAt: NOW
    }
    const desired = makeDesired([seeded])
    const targetExistedAtPersist: boolean[] = []
    desired.replaceDesiredScope.mockImplementation(() => {
      targetExistedAtPersist.push(existsSync(target))
      throw new Error('config unavailable')
    })
    const fixture = makeFixture({
      deps: {
        loadDesiredResources: desired.loadDesiredResources,
        replaceDesiredScope: desired.replaceDesiredScope
      }
    })
    addResolver(fixture, scope, 'agents', /\.md$/)
    const target = put(fixture.roots.agents, 'delete-me.md', 'before delete')
    const id = fixture.service.scan(scope)[0].id
    const plan = fixture.service.prepareDelete(scope, id)

    await rejectsCode(() => fixture.service.applyPlan({ scope, planId: plan.planId, confirmed: true }), 'desired-state-failed')

    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('before delete')
    expect(backupFiles(fixture.roots.agents)).toHaveLength(1)
    expect(desired.replaceDesiredScope).toHaveBeenCalledTimes(1)
    expect(targetExistedAtPersist).toEqual([false])
    expect(fixture.service.planSync(scope).status).toBe('synced')

    // Control run: with a working desired-state store, the same delete plan
    // flow removes the file from disk and updates desired state only after
    // the disk delete itself has succeeded. Reuses the same temporary root
    // and resolver, targeting a second file so it cannot be confused with
    // the restored file above.
    const controlSeeded = {
      ...seeded,
      id: physicalId('claude', 'agents', 'delete-me-control.md'),
      relativePath: 'delete-me-control.md'
    }
    const controlDesired = makeDesired([controlSeeded])
    const persistControl = controlDesired.replaceDesiredScope.getMockImplementation() as (
      scope: Scope,
      resources: DesiredResource[]
    ) => void
    const controlTargetExistedAtPersist: boolean[] = []
    controlDesired.replaceDesiredScope.mockImplementation((controlScope: Scope, resources: DesiredResource[]) => {
      controlTargetExistedAtPersist.push(existsSync(controlTarget))
      persistControl(controlScope, resources)
    })
    const controlService = makeFixture({
      root: fixture.root,
      roots: fixture.roots,
      resolvers: fixture.resolvers,
      deps: {
        loadDesiredResources: controlDesired.loadDesiredResources,
        replaceDesiredScope: controlDesired.replaceDesiredScope
      }
    }).service
    const controlTarget = put(fixture.roots.agents, 'delete-me-control.md', 'before delete')
    const controlId = controlService.scan(scope)[0].id
    const controlPlan = controlService.prepareDelete(scope, controlId)
    await controlService.applyPlan({ scope, planId: controlPlan.planId, confirmed: true })
    expect(existsSync(controlTarget)).toBe(false)
    expect(controlDesired.replaceDesiredScope).toHaveBeenCalledTimes(1)
    expect(controlTargetExistedAtPersist).toEqual([false])
    expect(controlDesired.resources.some((r) => r.relativePath === 'delete-me-control.md')).toBe(false)
  })

  it('reports one completed overwrite and requires rescan when second atomic rename fails', async () => {
    let renames = 0
    const fixture = makeFixture({
      fs: makeFsAdapter({
        renameSync: (from: string, to: string) => {
          renames += 1
          if (renames === 2) throw new Error('second overwrite failed')
          return renameSync(from, to)
        }
      })
    })
    const scope = { agentKind: 'claude', resourceType: 'agents' }
    addResolver(fixture, scope, 'agents', /\.md$/)
    put(fixture.roots.agents, 'a.md', 'old-a')
    put(fixture.roots.agents, 'b.md', 'old-b')
    const refs = fixture.service.scan(scope)
    fixture.desired.resources = refs.map((ref: FileRef) =>
      refToDesired(ref, ref.relativePath === 'a.md' ? 'new-a' : 'new-b')
    )
    const plan = fixture.service.planSyncToDisk(scope)
    const failure = await fixture.service.applyPlan({ scope, planId: plan.planId, confirmed: true }).catch((error: unknown) => error as ApplyResult)
    expect(failure.applied).toHaveLength(1)
    expect(failure.requiresRescan).toBe(true)
    expect(readFileSync(join(fixture.roots.agents, 'a.md'), 'utf8')).toBe('new-a')
    expect(readFileSync(join(fixture.roots.agents, 'b.md'), 'utf8')).toBe('old-b')
  })
})

describe('sync/adopt direction and conversion preparation', () => {
  it('syncs only selected scope to disk and never replaces desired state', async () => {
    const fixture = makeFixture()
    const scope = { agentKind: 'claude', resourceType: 'agents' }
    const other = { agentKind: 'codex', resourceType: 'agents' }
    addResolver(fixture, scope, 'claude-agents', /\.md$/)
    addResolver(fixture, other, 'codex-agents', /\.md$/)
    fixture.desired.resources = [{
      id: physicalId('claude', 'claude-agents', 'new.md'), agentKind: 'claude', resourceType: 'agents', relativePath: 'new.md', label: 'new', content: 'desired', hash: hashBytes('desired'), updatedAt: NOW
    }]
    const plan = fixture.service.planSyncToDisk(scope)
    await fixture.service.applyPlan({ scope, planId: plan.planId, confirmed: true })
    expect(readFileSync(join(fixture.roots['claude-agents'], 'new.md'), 'utf8')).toBe('desired')
    expect(existsSync(join(fixture.roots['codex-agents'], 'new.md'))).toBe(false)
    expect(fixture.desired.replaceDesiredScope).not.toHaveBeenCalled()
  })

  // TEST-007: a confirmed sync-to-disk plan combining create, overwrite, and
  // delete writes only inside the selected harness root — exact file set,
  // nothing in the parent temp directory or a sibling root, no leftover
  // atomic-write temp files.
  it('applies a combined create/overwrite/delete sync-to-disk plan only inside the selected root', async () => {
    const fixture = makeFixture()
    const scope = { agentKind: 'claude', resourceType: 'agents' }
    const sibling = { agentKind: 'codex', resourceType: 'agents' }
    addResolver(fixture, scope, 'claude-agents', /\.md$/)
    addResolver(fixture, sibling, 'codex-agents', /\.md$/)
    put(fixture.roots['claude-agents'], 'overwrite.md', 'old bytes')
    put(fixture.roots['claude-agents'], 'remove.md', 'obsolete bytes')
    put(fixture.roots['codex-agents'], 'sibling.md', 'sibling bytes')
    const refs = fixture.service.scan(scope)
    const overwriteRef = refs.find((ref: FileRef) => ref.relativePath === 'overwrite.md')!
    fixture.desired.resources = [
      refToDesired(overwriteRef, 'new bytes'),
      {
        id: physicalId('claude', 'claude-agents', 'created.md'),
        agentKind: 'claude',
        resourceType: 'agents',
        relativePath: 'created.md',
        label: 'created',
        content: 'created bytes',
        hash: hashBytes('created bytes'),
        updatedAt: NOW
      }
    ]
    const plan = fixture.service.planSyncToDisk(scope)
    await fixture.service.applyPlan({ scope, planId: plan.planId, confirmed: true })

    const resultingNonBackupFiles = readdirSync(fixture.roots['claude-agents']).filter(
      (name) => !name.includes('.x-backup-')
    )
    expect(resultingNonBackupFiles.sort()).toEqual(['created.md', 'overwrite.md'])
    expect(readFileSync(join(fixture.roots['claude-agents'], 'created.md'), 'utf8')).toBe('created bytes')
    expect(readFileSync(join(fixture.roots['claude-agents'], 'overwrite.md'), 'utf8')).toBe('new bytes')
    expect(existsSync(join(fixture.roots['claude-agents'], 'remove.md'))).toBe(false)
    expect(tempFiles(fixture.roots['claude-agents'])).toEqual([])

    // Nothing was created in the parent temp directory or the sibling root.
    expect(existsSync(join(fixture.root, 'created.md'))).toBe(false)
    expect(readdirSync(fixture.roots['codex-agents'])).toEqual(['sibling.md'])
    expect(readFileSync(join(fixture.roots['codex-agents'], 'sibling.md'), 'utf8')).toBe('sibling bytes')
  })

  it('adopts exactly one scope, performs no harness writes, and canonicalizes Claude aliases', async () => {
    const otherDesired = {
      id: physicalId('codex', 'codex-agents', 'preserved.md'),
      agentKind: 'codex',
      resourceType: 'agents',
      relativePath: 'preserved.md',
      content: 'untouched desired state',
      hash: hashBytes('untouched desired state'),
      updatedAt: NOW
    }
    const fixture = makeFixture({ desired: [otherDesired] })
    const scope = { agentKind: 'claude', resourceType: 'commands' }
    const other = { agentKind: 'codex', resourceType: 'agents' }
    addResolver(fixture, scope, 'claude-skills', /SKILL\.md$/, {
      canonicalResourceType: 'skills', aliasResourceTypes: ['commands']
    })
    addResolver(fixture, other, 'codex-agents', /\.md$/)
    put(fixture.roots['claude-skills'], 'one/SKILL.md', 'one')
    const beforeTree = snapshotTree(fixture.root)
    const plan = fixture.service.planAdoptFromDisk(scope)
    await fixture.service.applyPlan({ scope, planId: plan.planId, confirmed: true })

    expect(fixture.desired.replaceDesiredScope).toHaveBeenCalledTimes(1)
    expect(fixture.desired.replaceDesiredScope.mock.calls[0][0]).toEqual(scope)
    const adopted = fixture.desired.replaceDesiredScope.mock.calls[0][1]
    expect(adopted).toHaveLength(1)
    expect(adopted[0].resourceType).toBe('skills')
    expect(adopted[0].aliasResourceTypes).toEqual(['commands'])
    // TEST-006: no harness-directory file changed — a byte-exact snapshot of
    // the entire temporary root (not just a filename listing) is unchanged.
    expect(snapshotTree(fixture.root)).toEqual(beforeTree)
    // TEST-006: the service hands persistence only the selected scope's
    // resources; preserving other scopes on write is defended by the
    // replacePersistedHarnessConfigScope tests in persistence.test.ts.
    expect(adopted.every((r: DesiredResource) => r.agentKind === 'claude')).toBe(true)
  })
  it('preserves canonical Claude skill aliases when creating native command', async () => {
    const existing = {
      id: physicalId('claude', 'claude-skills', 'existing/SKILL.md'),
      agentKind: 'claude',
      resourceType: 'skills',
      canonicalResourceType: 'skills',
      aliasResourceTypes: ['commands'],
      relativePath: 'existing/SKILL.md',
      label: 'existing',
      content: 'skill',
      hash: hashBytes('skill'),
      updatedAt: NOW
    }
    const fixture = makeFixture({ desired: [existing] })
    const scope = { agentKind: 'claude', resourceType: 'commands' }
    addResolver(fixture, scope, 'claude-commands', /\.md$/, {
      canonicalResourceType: 'commands',
      aliasResourceTypes: [],
      aliasSourceResourceTypes: ['skills']
    })
    const plan = fixture.service.prepareCreate(scope, 'native', 'command')
    await fixture.service.applyPlan({ scope, planId: plan.planId, confirmed: true })

    expect(fixture.desired.replaceDesiredScope).toHaveBeenCalledTimes(1)
    expect(fixture.desired.replaceDesiredScope.mock.calls[0][0]).toEqual(scope)
    const persisted = fixture.desired.replaceDesiredScope.mock.calls[0][1] as DesiredResource[]
    expect(persisted.filter((resource) => resource.id === existing.id)).toHaveLength(1)
    expect(persisted.filter((resource) => resource.resourceType === 'commands' && resource.relativePath === 'native.md')).toHaveLength(1)
  })

  it.each(['update', 'delete'] as const)('preserves canonical skill aliases when native command %s applies', async (action) => {
    const existing = {
      id: physicalId('claude', 'claude-skills', 'existing/SKILL.md'),
      agentKind: 'claude',
      resourceType: 'skills',
      canonicalResourceType: 'skills',
      aliasResourceTypes: ['commands'],
      relativePath: 'existing/SKILL.md',
      label: 'existing',
      content: 'skill',
      hash: hashBytes('skill'),
      updatedAt: NOW
    }
    const fixture = makeFixture({ desired: [existing] })
    const scope = { agentKind: 'claude', resourceType: 'commands' }
    addResolver(fixture, scope, 'claude-commands', /\.md$/, {
      canonicalResourceType: 'commands',
      aliasResourceTypes: [],
      aliasSourceResourceTypes: ['skills']
    })
    put(fixture.roots['claude-commands'], 'native.md', action === 'update' ? 'old' : 'obsolete')
    const ref = fixture.service.scan(scope)[0]
    const plan = action === 'update'
      ? fixture.service.prepareUpdate(scope, ref.id, 'revised')
      : fixture.service.prepareDelete(scope, ref.id)
    await fixture.service.applyPlan({ scope, planId: plan.planId, confirmed: true })

    const persisted = fixture.desired.replaceDesiredScope.mock.calls.at(-1)?.[1] as DesiredResource[]
    expect(persisted.filter((resource) => resource.id === existing.id)).toHaveLength(1)
    if (action === 'update') {
      expect(persisted.filter((resource) => resource.relativePath === 'native.md' && resource.content === 'revised')).toHaveLength(1)
    } else {
      expect(persisted.filter((resource) => resource.relativePath === 'native.md')).toHaveLength(0)
    }
  })

  it('prepares Claude alias conversion as identity-preserving no-op', () => {
    const fixture = makeFixture()
    const scope = { agentKind: 'claude', resourceType: 'skills' }
    addResolver(fixture, scope, 'skills', /SKILL\.md$/, {
      canonicalResourceType: 'skills', aliasResourceTypes: ['commands']
    })
    put(fixture.roots.skills, 'alias/SKILL.md', 'alias')
    const ref = fixture.service.scan(scope)[0]
    const conversion = fixture.service.prepareCommandFromSkill(scope, ref.id)
    expect(conversion).toEqual({ status: 'alias', ref })
    expect(fixture.desired.replaceDesiredScope).not.toHaveBeenCalled()
  })

  it('returns existing for independent destination collision and draft otherwise without a write or plan', () => {
    const fixture = makeFixture()
    const scope = { agentKind: 'opencode', resourceType: 'skills' }
    const destination = { agentKind: 'opencode', resourceType: 'commands' }
    addResolver(fixture, scope, 'skills', /SKILL\.md$/, {
      canonicalResourceType: 'skills', aliasResourceTypes: []
    })
    addResolver(fixture, destination, 'skills', /\.md$/, {
      canonicalResourceType: 'commands', aliasResourceTypes: []
    })
    put(fixture.roots.skills, 'source/SKILL.md', 'source')
    put(fixture.roots.skills, 'source.md', 'existing destination')
    const source = fixture.service.scan(scope)[0]
    const existing = fixture.service.prepareCommandFromSkill(scope, source.id)
    expect(existing.status).toBe('existing')
    expect(existing.ref.relativePath).toBe('source.md')

    unlinkSync(join(fixture.roots.skills, 'source.md'))
    const draft = fixture.service.prepareCommandFromSkill(scope, source.id)
    expect(draft.status).toBe('draft')
    expect(draft).not.toHaveProperty('planId')
    expect(fixture.desired.replaceDesiredScope).not.toHaveBeenCalled()
    expect(readdirSync(fixture.roots.skills)).toEqual(['source'])
  })

  it('reports an existing destination that differs only by case on a case-insensitive filesystem', () => {
    const caseInsensitiveLstat = (path: string) => {
      try {
        return lstatSync(path)
      } catch (error) {
        const dir = dirname(path)
        const match = readdirSync(dir).find((entry) => entry.toLowerCase() === basename(path).toLowerCase())
        if (!match) throw error
        return lstatSync(join(dir, match))
      }
    }
    const fixture = makeFixture({ fs: { lstatSync: caseInsensitiveLstat } })
    const scope = { agentKind: 'opencode', resourceType: 'skills' }
    const destination = { agentKind: 'opencode', resourceType: 'commands' }
    addResolver(fixture, scope, 'skills', /SKILL\.md$/, { canonicalResourceType: 'skills' })
    addResolver(fixture, destination, 'skills', /\.md$/, { canonicalResourceType: 'commands' })
    put(fixture.roots.skills, 'MySkill/SKILL.md', 'source')
    put(fixture.roots.skills, 'MySkill.md', 'existing destination')
    const source = fixture.service.scan(scope)[0]
    const conversion = fixture.service.prepareCommandFromSkill(scope, source.id)
    expect(conversion.status).toBe('existing')
    expect(conversion.ref.relativePath).toBe('MySkill.md')
  })

  it('rejects conversion across harnesses and ignores plugin payload/settings files', async () => {
    const fixture = makeFixture()
    const claude = { agentKind: 'claude', resourceType: 'skills' }
    const codex = { agentKind: 'codex', resourceType: 'skills' }
    addResolver(fixture, claude, 'claude-skills', /SKILL\.md$/)
    addResolver(fixture, codex, 'codex-skills', /SKILL\.md$/)
    put(fixture.roots['claude-skills'], 'plugin/SKILL.md', 'plugin payload')
    put(fixture.roots['claude-skills'], 'settings.json', 'settings')
    const ref = fixture.service.scan(claude)[0]
    await rejectsCode(() => fixture.service.prepareCommandFromSkill(codex, ref.id), 'unknown-resource')
    expect(fixture.service.scan(claude).map((r: FileRef) => r.relativePath)).toEqual(['plugin/SKILL.md'])
    expect(readFileSync(join(fixture.roots['claude-skills'], 'settings.json'), 'utf8')).toBe('settings')
  })

  // TEST-013: driving a full sync-to-disk and adopt-from-disk cycle with
  // drift present in every managed harness never copies, writes, or persists
  // a resource into another `agentKind`, and plugin/settings files seeded
  // beside the roots are left untouched throughout.
  it('runs a full sync-to-disk and adopt-from-disk cycle without cross-harness writes', async () => {
    const fixture = makeFixture()
    const claude = { agentKind: 'claude', resourceType: 'agents' }
    const codex = { agentKind: 'codex', resourceType: 'agents' }
    const opencode = { agentKind: 'opencode', resourceType: 'agents' }
    addResolver(fixture, claude, 'claude-agents', /\.md$/)
    addResolver(fixture, codex, 'codex-agents', /\.md$/)
    addResolver(fixture, opencode, 'opencode-agents', /\.md$/)

    put(fixture.roots['claude-agents'], 'claude.md', 'claude old')
    put(fixture.roots['claude-agents'], 'plugin.json', 'claude plugin')
    put(fixture.roots['codex-agents'], 'codex.md', 'codex old')
    put(fixture.roots['codex-agents'], 'settings.json', 'codex settings')
    put(fixture.roots['opencode-agents'], 'opencode.md', 'opencode old')
    put(fixture.roots['opencode-agents'], 'plugin.json', 'opencode plugin')

    const claudeRef = fixture.service.scan(claude)[0]
    const codexRef = fixture.service.scan(codex)[0]
    fixture.desired.resources = [
      refToDesired(claudeRef, 'claude new'),
      refToDesired(codexRef, 'codex new')
    ]

    const claudeSyncPlan = fixture.service.planSyncToDisk(claude)
    await fixture.service.applyPlan({ scope: claude, planId: claudeSyncPlan.planId, confirmed: true })
    const codexSyncPlan = fixture.service.planSyncToDisk(codex)
    await fixture.service.applyPlan({ scope: codex, planId: codexSyncPlan.planId, confirmed: true })
    const opencodeAdoptPlan = fixture.service.planAdoptFromDisk(opencode)
    await fixture.service.applyPlan({ scope: opencode, planId: opencodeAdoptPlan.planId, confirmed: true })

    expect(readFileSync(join(fixture.roots['claude-agents'], 'claude.md'), 'utf8')).toBe('claude new')
    expect(readFileSync(join(fixture.roots['codex-agents'], 'codex.md'), 'utf8')).toBe('codex new')
    expect(readFileSync(join(fixture.roots['opencode-agents'], 'opencode.md'), 'utf8')).toBe('opencode old')

    expect(readFileSync(join(fixture.roots['claude-agents'], 'plugin.json'), 'utf8')).toBe('claude plugin')
    expect(readFileSync(join(fixture.roots['codex-agents'], 'settings.json'), 'utf8')).toBe('codex settings')
    expect(readFileSync(join(fixture.roots['opencode-agents'], 'plugin.json'), 'utf8')).toBe('opencode plugin')

    expect(fixture.desired.replaceDesiredScope).toHaveBeenCalledTimes(1)
    const [adoptScope, adoptedResources] = fixture.desired.replaceDesiredScope.mock.calls[0]
    expect(adoptScope).toEqual(opencode)
    expect(adoptedResources.every((resource: DesiredResource) => resource.agentKind === 'opencode')).toBe(true)
    expect(fixture.desired.resources.filter((r) => r.agentKind === 'claude')).toHaveLength(1)
    expect(fixture.desired.resources.filter((r) => r.agentKind === 'codex')).toHaveLength(1)
    expect(fixture.desired.resources.every((r) => r.relativePath !== 'opencode.md' || r.agentKind === 'opencode')).toBe(true)
  })

  it('resolves the reverse Claude alias direction as an identity-preserving no-op', () => {
    const fixture = makeFixture()
    const scope = { agentKind: 'claude', resourceType: 'commands' }
    addResolver(fixture, scope, 'claude-skills', /SKILL\.md$/, {
      canonicalResourceType: 'skills', aliasResourceTypes: ['commands'], aliasSourceResourceTypes: ['skills']
    })
    put(fixture.roots['claude-skills'], 'alias/SKILL.md', 'alias')
    const ref = fixture.service.scan(scope)[0]
    const conversion = fixture.service.prepareSkillFromCommand(scope, ref.id)
    expect(conversion).toEqual({ status: 'alias', ref })
    expect(fixture.desired.replaceDesiredScope).not.toHaveBeenCalled()
  })

  it('generates a byte-exact command draft from a skill via the pure generator', () => {
    const fixture = makeFixture()
    const scope = { agentKind: 'opencode', resourceType: 'skills' }
    const destination = { agentKind: 'opencode', resourceType: 'commands' }
    addResolver(fixture, scope, 'skills', /SKILL\.md$/, { canonicalResourceType: 'skills' })
    addResolver(fixture, destination, 'skills', /\.md$/, { canonicalResourceType: 'commands' })
    put(fixture.roots.skills, 'My Skill/SKILL.md', '---\ndescription: Does a thing\n---\n\nBody text.\n')
    const source = fixture.service.scan(scope)[0]
    const draft = fixture.service.prepareCommandFromSkill(scope, source.id) as AnyRecord
    expect(draft.status).toBe('draft')
    expect(draft.name).toBe('my-skill')
    expect(draft.relativePath).toBe('my-skill.md')
    expect(draft.content).toBe(
      '---\ndescription: Does a thing\n---\n\nUse the my-skill skill.\n\n<!-- Converted by Tatsu from opencode skills My Skill/SKILL.md -->\n'
    )
  })

  it('generates a byte-exact skill draft from a command with a fallback description', () => {
    const fixture = makeFixture()
    const scope = { agentKind: 'opencode', resourceType: 'commands' }
    const destination = { agentKind: 'opencode', resourceType: 'skills' }
    addResolver(fixture, scope, 'commands', /\.md$/, { canonicalResourceType: 'commands' })
    addResolver(fixture, destination, 'commands', /SKILL\.md$/, {
      canonicalResourceType: 'skills',
      nameToRelativePath: (name: string) => `${name}/SKILL.md`
    })
    put(fixture.roots.commands, 'Deploy Now.md', 'no front matter here')
    const source = fixture.service.scan(scope)[0]
    const draft = fixture.service.prepareSkillFromCommand(scope, source.id) as AnyRecord
    expect(draft.status).toBe('draft')
    expect(draft.name).toBe('deploy-now')
    expect(draft.relativePath).toBe('deploy-now/SKILL.md')
    expect(draft.content).toBe(
      '# deploy-now\n\nUse this skill when the user requests the `deploy-now` command behavior.\n\n<!-- Converted by Tatsu from opencode commands Deploy Now.md -->\n'
    )
  })

  it('repeated conversion is idempotent once the drafted destination exists', () => {
    const fixture = makeFixture()
    const scope = { agentKind: 'codex', resourceType: 'skills' }
    const destination = { agentKind: 'codex', resourceType: 'commands' }
    addResolver(fixture, scope, 'skills', /SKILL\.md$/, { canonicalResourceType: 'skills' })
    addResolver(fixture, destination, 'skills', /\.md$/, { canonicalResourceType: 'commands' })
    put(fixture.roots.skills, 'repeat/SKILL.md', 'body')
    const source = fixture.service.scan(scope)[0]
    const first = fixture.service.prepareCommandFromSkill(scope, source.id) as AnyRecord
    expect(first.status).toBe('draft')
    put(fixture.roots.skills, 'repeat.md', first.content as string)
    const second = fixture.service.prepareCommandFromSkill(scope, source.id) as Conversion
    expect(second.status).toBe('existing')
    expect(second.ref.relativePath).toBe('repeat.md')
  })
})

describe('conversion content generators (TEST-001/TEST-002)', () => {
  it('slugifies labels deterministically', () => {
    expect(slugifyLogicalName('My Cool Skill!')).toBe('my-cool-skill')
    expect(slugifyLogicalName('  __Weird///Name__  ')).toBe('weird-name')
    expect(slugifyLogicalName('already-slug')).toBe('already-slug')
    const long = 'a'.repeat(90)
    expect(slugifyLogicalName(long)).toBe('a'.repeat(80))
    expect(slugifyLogicalName(`${'a'.repeat(79)}-!!!`)).toBe('a'.repeat(79))
  })

  it('throws invalid-name when a label has no derivable slug', () => {
    expect(() => slugifyLogicalName('!!!')).toThrow(/invalid-name|Unable to derive/)
    try {
      slugifyLogicalName('***')
      expect.unreachable()
    } catch (error) {
      expect((error as { code?: string }).code).toBe('invalid-name')
    }
  })

  it('extracts a leading front-matter description', () => {
    expect(extractFrontMatterDescription('---\ndescription: Hello world\n---\nbody')).toBe('Hello world')
    expect(extractFrontMatterDescription('---\ntags: [a]\ndescription:   padded value  \n---\n')).toBe('padded value')
  })

  it('returns null when there is no block, no closing delimiter, or no description line', () => {
    expect(extractFrontMatterDescription('no front matter at all')).toBeNull()
    expect(extractFrontMatterDescription('---\ndescription: unterminated')).toBeNull()
    expect(extractFrontMatterDescription('---\ntags: [a]\n---\nbody')).toBeNull()
    const tooLong = ['---', ...Array.from({ length: 60 }, (_, i) => `line${i}: x`), 'description: late', '---'].join('\n')
    expect(extractFrontMatterDescription(tooLong)).toBeNull()
  })

  it('extracts descriptions from CRLF files and ignores block scalar indicators', () => {
    expect(extractFrontMatterDescription('---\r\ndescription: Windows line\r\n---\r\nbody')).toBe('Windows line')
    expect(extractFrontMatterDescription('---\ndescription: >-\n  folded\n---\n')).toBeNull()
    expect(extractFrontMatterDescription('---\ndescription: |\n  literal\n---\n')).toBeNull()
  })

  it('createCommandFromSkill rejects a non-skills source', () => {
    expect(() =>
      createCommandFromSkill({
        agentKind: 'claude',
        resourceType: 'commands' as unknown as 'skills',
        name: 'x',
        label: 'x',
        relativePath: 'x.md',
        content: ''
      })
    ).toThrow()
  })

  it('createSkillFromCommand rejects a non-commands source', () => {
    expect(() =>
      createSkillFromCommand({
        agentKind: 'claude',
        resourceType: 'skills' as unknown as 'commands',
        name: 'x',
        label: 'x',
        relativePath: 'x/SKILL.md',
        content: ''
      })
    ).toThrow()
  })

  it('falls back to the source logical name when the label has no derivable slug', () => {
    const draft = createCommandFromSkill({
      agentKind: 'codex',
      resourceType: 'skills',
      name: 'fallback-name',
      label: '!!!',
      relativePath: 'fallback-name/SKILL.md',
      content: 'body'
    })
    expect(draft.destinationName).toBe('fallback-name')
  })
})

function fixtureRootPlaceholder(): string {
  return join(tmpdir(), `harness-config-missing-${Date.now()}-${Math.random()}`)
}

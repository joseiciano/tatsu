import { createHash, randomUUID } from 'crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync as nodeReadFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import type { Stats } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path'

import type { HarnessConfigResourceType } from '../../shared/agent-registry'
import {
  harnessConfigScopeKey,
  type HarnessConfigComparison,
  type HarnessConfigFileRef,
  type HarnessConfigScope,
  type HarnessConfigSyncDirection,
  type HarnessConfigSyncPlan,
  type HarnessConfigSyncStatus,
  type ManagedHarnessKind
} from '../../shared/state/harness-config'
import { formatErr as defaultFormatErr, log as defaultLog } from '../debug'
import { conversionDestinationName, createCommandFromSkill, createSkillFromCommand } from './conversion'
import type {
  HarnessConfigAppliedOperation,
  HarnessConfigApplyRequest,
  HarnessConfigApplyResult,
  HarnessConfigConversionResult,
  HarnessConfigConversionSource,
  HarnessConfigDesiredResource,
  HarnessConfigFilesystem,
  HarnessConfigErrorCode,
  HarnessConfigMutationDirection,
  HarnessConfigMutationPlan,
  HarnessConfigReadResult,
  HarnessConfigResourceResolver,
  HarnessConfigService,
  HarnessConfigServiceDeps,
  HarnessResolver
} from './types'
import { HarnessConfigError } from './types'

const RESOURCE_TYPES: readonly HarnessConfigResourceType[] = ['agents', 'skills', 'commands']
const MANAGED_HARNESSES: readonly ManagedHarnessKind[] = ['claude', 'codex', 'opencode']
const BACKUP_SUFFIX = /\.x-backup-\d{8}T\d{9}Z(?:-\d+)?$/
const MAX_LIVE_PLANS = 64
const MAX_ATTEMPTED_PLAN_IDS = 512

const unsupported = (identity: string, reason: string): HarnessConfigResourceResolver => ({
  supported: false,
  identity,
  reason
})

const markdownResolver = (
  rootKey: string,
  identity: string,
  verificationSource: string,
  canonicalResourceType: HarnessConfigResourceType,
  pattern: RegExp,
  nameToRelativePath: (name: string) => string,
  options: Pick<HarnessConfigResourceResolver, 'aliasResourceTypes' | 'aliasSourceResourceTypes' | 'maxDepth'> = {}
): HarnessConfigResourceResolver => ({
  supported: true,
  rootKey,
  identity,
  verificationSource,
  canonicalResourceType,
  aliasResourceTypes: options.aliasResourceTypes ?? [],
  aliasSourceResourceTypes: options.aliasSourceResourceTypes ?? [],
  maxDepth: options.maxDepth ?? Number.POSITIVE_INFINITY,
  pattern,
  matches: (relativePath) => {
    pattern.lastIndex = 0
    return pattern.test(relativePath)
  },
  nameToRelativePath
})

const BUILTIN_RESOLVERS: Record<ManagedHarnessKind, HarnessResolver> = {
  claude: {
    agentKind: 'claude',
    identity: 'claude-config-v1',
    resources: {
      agents: markdownResolver(
        'claudeAgents',
        'claude-agents-v1',
        'https://code.claude.com/docs/en/sub-agents.md',
        'agents',
        /(?:^|\/)[^/]+\.md$/,
        (name) => `${name}.md`
      ),
      skills: markdownResolver(
        'claudeSkills',
        'claude-skills-v1',
        'https://code.claude.com/docs/en/skills',
        'skills',
        /(?:^|\/)SKILL\.md$/,
        (name) => `${name}/SKILL.md`,
        { aliasResourceTypes: ['commands'], maxDepth: 1 }
      ),
      commands: markdownResolver(
        'claudeCommands',
        'claude-commands-v1',
        'https://code.claude.com/docs/en/skills',
        'commands',
        /(?:^|\/)[^/]+\.md$/,
        (name) => `${name}.md`,
        { aliasSourceResourceTypes: ['skills'] }
      )
    }
  },
  codex: {
    agentKind: 'codex',
    identity: 'codex-config-v1',
    resources: {
      agents: markdownResolver(
        'codexHome',
        'codex-agents-v1',
        'https://learn.chatgpt.com/docs/agent-configuration/agents-md.md',
        'agents',
        /^AGENTS(?:\.override)?\.md$/,
        (name) => `${name}.md`,
        { maxDepth: 0 }
      ),
      skills: markdownResolver(
        'codexSkills',
        'codex-skills-v1',
        'https://learn.chatgpt.com/docs/build-skills.md',
        'skills',
        /(?:^|\/)SKILL\.md$/,
        (name) => `${name}/SKILL.md`,
        { maxDepth: 1 }
      ),
      commands: unsupported('codex-commands-unsupported-v1', 'Codex commands have no verified managed entrypoint')
    }
  },
  opencode: {
    agentKind: 'opencode',
    identity: 'opencode-config-v1',
    resources: {
      agents: markdownResolver(
        'opencodeAgents',
        'opencode-agents-v1',
        'https://opencode.ai/docs/agents',
        'agents',
        /(?:^|\/)[^/]+\.md$/,
        (name) => `${name}.md`,
        { maxDepth: 0 }
      ),
      skills: markdownResolver(
        'opencodeSkills',
        'opencode-skills-v1',
        'https://opencode.ai/docs/skills',
        'skills',
        /(?:^|\/)SKILL\.md$/,
        (name) => `${name}/SKILL.md`,
        { maxDepth: 1 }
      ),
      commands: markdownResolver(
        'opencodeCommands',
        'opencode-commands-v1',
        'https://opencode.ai/docs/commands',
        'commands',
        /(?:^|\/)[^/]+\.md$/,
        (name) => `${name}.md`,
        { maxDepth: 0 }
      )
    }
  }
}

type DiskEntry = {
  ref: HarnessConfigFileRef
  descriptor: HarnessConfigResourceResolver
  root: string
}

type ConfigEntry = {
  resource: HarnessConfigDesiredResource
  ref: HarnessConfigFileRef
  descriptor: HarnessConfigResourceResolver
  root: string
}

type DiskOperation = {
  type: 'create' | 'overwrite' | 'delete'
  id: string
  relativePath: string
  content?: string
  descriptorResourceType: HarnessConfigResourceType
}

type PrivatePlan = {
  publicPlan: HarnessConfigSyncPlan | HarnessConfigMutationPlan
  scopeKey: string
  direction: HarnessConfigSyncDirection | HarnessConfigMutationDirection
  diskFingerprint: string
  configFingerprint: string
  resolverIdentity: string
  operations: DiskOperation[]
  adoptedResources?: HarnessConfigDesiredResource[]
  attempted: boolean
}

type MutationOutcome = {
  operation: DiskOperation
  applied: HarnessConfigAppliedOperation
  existed: boolean
  before?: Buffer
}
type SnapshotState = {
  scope: HarnessConfigScope
  disk: DiskEntry[]
  desired: HarnessConfigDesiredResource[]
  diskFingerprint: string
  configFingerprint: string
  resolverIdentity: string
}

type ComparisonState = SnapshotState & {
  comparison: HarnessConfigComparison
  diskOnly: DiskEntry[]
  configOnly: ConfigEntry[]
  changed: Array<{ disk: DiskEntry; config: ConfigEntry }>
  config: ConfigEntry[]
}

const nodeFilesystem: HarnessConfigFilesystem = {
  readdirSync: (path, options) => readdirSync(path, options),
  lstatSync,
  readFileSync: (path) => nodeReadFileSync(path),
  writeFileSync: (path, data, options) => writeFileSync(path, data, options),
  renameSync,
  unlinkSync,
  mkdirSync,
  existsSync,
  realpathSync: (path) => realpathSync.native(path)
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function physicalId(agentKind: ManagedHarnessKind, rootKey: string, relativePath: string): string {
  return sha256(`${agentKind}\0${rootKey}\0${relativePath}`)
}

function posixPath(value: string): string {
  return value.split(sep).join('/')
}

function compactTimestamp(value: number): string {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace('.', '')
}

function lexicalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function compareRefs(a: HarnessConfigFileRef, b: HarnessConfigFileRef): number {
  return lexicalCompare(a.agentKind, b.agentKind) ||
    lexicalCompare(a.resourceType, b.resourceType) ||
    lexicalCompare(a.relativePath, b.relativePath) ||
    lexicalCompare(a.id, b.id)
}

function comparisonStatus(
  diskOnly: readonly unknown[],
  configOnly: readonly unknown[],
  changed: readonly unknown[]
): HarnessConfigSyncStatus {
  const categories = Number(diskOnly.length > 0) + Number(configOnly.length > 0) + Number(changed.length > 0)
  if (categories === 0) return 'synced'
  if (categories > 1 || changed.length > 0) return 'conflict'
  return diskOnly.length > 0 ? 'disk-only' : 'config-only'
}

function cloneScope(scope: HarnessConfigScope): HarnessConfigScope {
  return { agentKind: scope.agentKind, resourceType: scope.resourceType }
}

function cloneRef(ref: HarnessConfigFileRef): HarnessConfigFileRef {
  return { ...ref, aliasResourceTypes: [...ref.aliasResourceTypes] }
}

export class HarnessConfigServiceImpl implements HarnessConfigService {
  private readonly deps: HarnessConfigServiceDeps
  private readonly fs: HarnessConfigFilesystem
  private readonly clock: () => number
  private readonly uuid: () => string
  private readonly plans = new Map<string, PrivatePlan>()
  private readonly attemptedPlanIds = new Set<string>()
  private tempSequence = 0

  constructor(deps: HarnessConfigServiceDeps = {}) {
    this.deps = deps
    this.fs = deps.filesystem ?? nodeFilesystem
    this.clock = deps.clock ?? Date.now
    this.uuid = deps.uuid ?? randomUUID
  }

  private rememberPlan(planId: string, plan: PrivatePlan): void {
    while (this.plans.size >= MAX_LIVE_PLANS) {
      const oldest = this.plans.keys().next().value
      if (oldest === undefined) break
      this.plans.delete(oldest)
    }
    this.plans.set(planId, plan)
  }

  private rememberAttempted(planId: string): void {
    while (this.attemptedPlanIds.size >= MAX_ATTEMPTED_PLAN_IDS) {
      const oldest = this.attemptedPlanIds.values().next().value
      if (oldest === undefined) break
      this.attemptedPlanIds.delete(oldest)
    }
    this.attemptedPlanIds.add(planId)
  }

  scan(scope: HarnessConfigScope): HarnessConfigFileRef[] {
    return this.guard('scan', () => this.snapshot(scope).disk.map(({ ref }) => cloneRef(ref)))
  }

  readFile(id: string): HarnessConfigReadResult {
    return this.guard('readFile', () => {
      if (typeof id !== 'string' || id.length === 0) {
        throw new HarnessConfigError('unknown-resource', 'The requested harness resource is unknown')
      }
      for (const scope of this.availableScopes()) {
        try {
          const desired = this.loadDesired()
          const entry = this.scanDisk(scope, desired).find((candidate) => candidate.ref.id === id)
          if (!entry) continue
          const target = this.resolveCandidate(entry.descriptor, entry.ref.relativePath, true)
          let bytes: Buffer
          try {
            bytes = this.fs.readFileSync(target.absolutePath)
          } catch (error) {
            throw new HarnessConfigError('read-failed', 'Unable to read the harness resource', { cause: error })
          }
          const hash = sha256(bytes)
          return {
            ref: { ...entry.ref, absolutePath: target.absolutePath, hash },
            content: bytes.toString('utf8'),
            hash
          }
        } catch (error) {
          if (error instanceof HarnessConfigError && error.code === 'unsupported-scope') continue
          throw error
        }
      }
      throw new HarnessConfigError('unknown-resource', 'The requested harness resource is unknown')
    })
  }

  planSync(scope: HarnessConfigScope): HarnessConfigComparison {
    return this.guard('planSync', () => this.buildComparison(scope).comparison)
  }

  planSyncToDisk(scope: HarnessConfigScope): HarnessConfigSyncPlan {
    return this.guard('planSyncToDisk', () => {
      const state = this.buildComparison(scope)
      const operations: DiskOperation[] = []
      for (const entry of state.configOnly) {
        operations.push({
          type: 'create',
          id: entry.ref.id,
          relativePath: entry.ref.relativePath,
          content: entry.resource.content,
          descriptorResourceType: this.descriptorResourceType(scope, entry.descriptor)
        })
      }
      for (const pair of state.changed) {
        operations.push({
          type: 'overwrite',
          id: pair.config.ref.id,
          relativePath: pair.config.ref.relativePath,
          content: pair.config.resource.content,
          descriptorResourceType: this.descriptorResourceType(scope, pair.config.descriptor)
        })
      }
      for (const entry of state.diskOnly) {
        operations.push({
          type: 'delete',
          id: entry.ref.id,
          relativePath: entry.ref.relativePath,
          descriptorResourceType: this.descriptorResourceType(scope, entry.descriptor)
        })
      }
      operations.sort((a, b) => lexicalCompare(a.relativePath, b.relativePath) || lexicalCompare(a.type, b.type))
      const generatedAt = this.clock()
      const fingerprint = this.planFingerprint(state.diskFingerprint, state.configFingerprint, state.resolverIdentity)
      const publicPlan: HarnessConfigSyncPlan = {
        planId: this.uuid(),
        scope: cloneScope(scope),
        direction: 'sync-to-disk',
        status: state.comparison.status,
        diskOnly: state.comparison.diskOnly.map(cloneRef),
        configOnly: state.comparison.configOnly.map(cloneRef),
        changed: state.comparison.changed.map((entry) => ({ disk: cloneRef(entry.disk), config: cloneRef(entry.config) })),
        generatedAt,
        fingerprint
      }
      this.storePlan(publicPlan, state, operations)
      return publicPlan
    })
  }

  planAdoptFromDisk(scope: HarnessConfigScope): HarnessConfigSyncPlan {
    return this.guard('planAdoptFromDisk', () => {
      const state = this.buildComparison(scope)
      const adoptedResources = state.disk.map(({ ref }) => {
        const bytes = this.readInventoryBytes(ref.absolutePath)
        return this.desiredFromRef(ref, bytes.toString('utf8'))
      })
      const uniqueResources = [...new Map(adoptedResources.map((resource) => [resource.id, resource])).values()]
      const generatedAt = this.clock()
      const fingerprint = this.planFingerprint(state.diskFingerprint, state.configFingerprint, state.resolverIdentity)
      const publicPlan: HarnessConfigSyncPlan = {
        planId: this.uuid(),
        scope: cloneScope(scope),
        direction: 'adopt-from-disk',
        status: state.comparison.status,
        diskOnly: state.comparison.diskOnly.map(cloneRef),
        configOnly: state.comparison.configOnly.map(cloneRef),
        changed: state.comparison.changed.map((entry) => ({ disk: cloneRef(entry.disk), config: cloneRef(entry.config) })),
        generatedAt,
        fingerprint
      }
      this.rememberPlan(publicPlan.planId, {
        publicPlan,
        scopeKey: harnessConfigScopeKey(scope),
        direction: 'adopt-from-disk',
        diskFingerprint: state.diskFingerprint,
        configFingerprint: state.configFingerprint,
        resolverIdentity: state.resolverIdentity,
        operations: [],
        adoptedResources: uniqueResources,
        attempted: false
      })
      return publicPlan
    })
  }

  prepareCreate(scope: HarnessConfigScope, name: string, content: string): HarnessConfigMutationPlan {
    return this.guard('prepareCreate', () => {
      if (typeof content !== 'string') {
        throw new HarnessConfigError('write-failed', 'Harness resource content must be text')
      }
      const descriptor = this.getDescriptor(scope)
      this.validateLogicalName(name)
      if (!descriptor.nameToRelativePath) {
        throw new HarnessConfigError('invalid-name', 'This harness resource does not support creation')
      }
      const relativePath = descriptor.nameToRelativePath(name)
      this.assertDiscoverableDepth(descriptor, relativePath)
      const target = this.resolveCandidate(descriptor, relativePath, false)
      const state = this.snapshot(scope)
      if (this.fs.existsSync(target.absolutePath) || state.disk.some(({ ref }) => ref.relativePath === target.relativePath)) {
        throw new HarnessConfigError('collision', 'A harness resource already exists at that destination')
      }
      const canonicalResourceType = descriptor.canonicalResourceType ?? scope.resourceType
      const ref: HarnessConfigFileRef = {
        id: physicalId(scope.agentKind, descriptor.rootKey!, target.relativePath),
        agentKind: scope.agentKind,
        resourceType: scope.resourceType,
        canonicalResourceType,
        aliasResourceTypes: [...(descriptor.aliasResourceTypes ?? [])],
        label: this.labelFor(target.relativePath, canonicalResourceType),
        relativePath: target.relativePath,
        absolutePath: target.absolutePath,
        hash: sha256(Buffer.from(content, 'utf8')),
        existsOnDisk: false,
        managed: true,
        updatedAt: this.clock()
      }
      return this.storeMutationPlan(scope, 'create', ref, content, state)
    }, 'write-failed')
  }

  prepareUpdate(scope: HarnessConfigScope, id: string, content: string): HarnessConfigMutationPlan {
    return this.guard('prepareUpdate', () => {
      if (typeof content !== 'string') {
        throw new HarnessConfigError('write-failed', 'Harness resource content must be text')
      }
      const state = this.snapshot(scope)
      const entry = state.disk.find(({ ref }) => ref.id === id)
      if (!entry) throw new HarnessConfigError('unknown-resource', 'The requested harness resource is unknown')
      const ref = {
        ...cloneRef(entry.ref),
        hash: sha256(Buffer.from(content, 'utf8')),
        managed: true,
        updatedAt: this.clock()
      }
      return this.storeMutationPlan(scope, 'update', ref, content, state, entry.descriptor)
    }, 'write-failed')
  }

  prepareDelete(scope: HarnessConfigScope, id: string): HarnessConfigMutationPlan {
    return this.guard('prepareDelete', () => {
      const state = this.snapshot(scope)
      const entry = state.disk.find(({ ref }) => ref.id === id)
      if (!entry) throw new HarnessConfigError('unknown-resource', 'The requested harness resource is unknown')
      return this.storeMutationPlan(scope, 'delete', cloneRef(entry.ref), undefined, state, entry.descriptor)
    }, 'write-failed')
  }

  prepareCommandFromSkill(scope: HarnessConfigScope, id: string): HarnessConfigConversionResult {
    return this.guard('prepareCommandFromSkill', () => this.prepareConversion(scope, id, 'skills', 'commands'), 'write-failed')
  }

  prepareSkillFromCommand(scope: HarnessConfigScope, id: string): HarnessConfigConversionResult {
    return this.guard('prepareSkillFromCommand', () => this.prepareConversion(scope, id, 'commands', 'skills'), 'write-failed')
  }

  async applyPlan(request: HarnessConfigApplyRequest): Promise<HarnessConfigApplyResult> {
    return this.guardAsync('applyPlan', async () => {
      const scope = this.validateScopeShape(request.scope)
      if (request.confirmed !== true) {
        throw new HarnessConfigError('unconfirmed-plan', 'The plan was not explicitly confirmed')
      }
      const plan = this.plans.get(request.planId)
      if (!plan) {
        if (this.attemptedPlanIds.has(request.planId)) {
          throw new HarnessConfigError('stale-plan', 'The plan has already been attempted')
        }
        throw new HarnessConfigError('unknown-plan', 'The plan is unavailable')
      }
      if (plan.attempted) {
        this.consumePlan(request.planId)
        throw new HarnessConfigError('stale-plan', 'The plan has already been attempted')
      }
      if (plan.scopeKey !== harnessConfigScopeKey(scope)) {
        this.consumePlan(request.planId)
        throw new HarnessConfigError('scope-mismatch', 'The plan does not belong to the requested scope')
      }

      let current: SnapshotState
      try {
        current = this.snapshot(scope)
      } catch (error) {
        this.consumePlan(request.planId)
        throw new HarnessConfigError('stale-plan', 'The plan resolver is no longer current', { cause: error })
      }
      if (
        current.diskFingerprint !== plan.diskFingerprint ||
        current.configFingerprint !== plan.configFingerprint ||
        current.resolverIdentity !== plan.resolverIdentity
      ) {
        this.consumePlan(request.planId)
        throw new HarnessConfigError('stale-plan', 'The plan no longer matches current harness configuration')
      }

      plan.attempted = true
      this.consumePlan(request.planId)
      this.preflight(scope, plan.operations)
      const applied: HarnessConfigAppliedOperation[] = []

      if (plan.direction === 'adopt-from-disk') {
        try {
          await this.replaceDesired(scope, plan.adoptedResources ?? [])
          applied.push({ type: 'adopt' })
        } catch (error) {
          throw new HarnessConfigError('desired-state-failed', 'Unable to persist adopted harness resources', {
            cause: error,
            applied,
            requiresRescan: true
          })
        }
      } else if (plan.direction === 'sync-to-disk') {
        for (const operation of plan.operations) {
          try {
            this.applyDiskOperation(scope, operation)
            applied.push(this.appliedSummary(operation))
          } catch (error) {
            throw this.withPartialResult(error, applied)
          }
        }
      } else {
        const operation = plan.operations[0]
        let outcome: MutationOutcome
        try {
          outcome = this.applyDiskOperation(scope, operation)
          applied.push(outcome.applied)
        } catch (error) {
          throw this.withPartialResult(error, applied)
        }
        try {
          await this.persistDirectMutation(scope, plan.direction, outcome)
        } catch (error) {
          try {
            this.rollback(scope, outcome)
          } catch (rollbackError) {
            this.logFailure('rollback', rollbackError)
          }
          throw new HarnessConfigError('desired-state-failed', 'Unable to persist the harness resource', {
            cause: error,
            applied,
            requiresRescan: true
          })
        }
      }

      return {
        scope: cloneScope(scope),
        planId: request.planId,
        applied,
        resultingRefs: this.snapshot(scope).disk.map(({ ref }) => cloneRef(ref)),
        requiresRescan: true
      }
    })
  }

  private guard<T>(
    operation: string,
    action: () => T,
    fallbackCode: HarnessConfigErrorCode = 'read-failed'
  ): T {
    try {
      return action()
    } catch (error) {
      this.logFailure(operation, error)
      if (error instanceof HarnessConfigError) throw error
      throw new HarnessConfigError(fallbackCode, `Harness configuration ${operation} failed`, { cause: error })
    }
  }

  private async guardAsync<T>(
    operation: string,
    action: () => Promise<T>,
    fallbackCode: HarnessConfigErrorCode = 'write-failed'
  ): Promise<T> {
    try {
      return await action()
    } catch (error) {
      this.logFailure(operation, error)
      if (error instanceof HarnessConfigError) throw error
      throw new HarnessConfigError(fallbackCode, `Harness configuration ${operation} failed`, { cause: error })
    }
  }

  private logFailure(operation: string, error: unknown): void {
    const logger = this.deps.log ?? defaultLog
    const formatter = this.deps.formatErr ?? defaultFormatErr
    logger('harness-config', `${operation} failed`, formatter(error))
  }

  private validateScopeShape(scope: HarnessConfigScope): HarnessConfigScope {
    if (
      !scope ||
      !MANAGED_HARNESSES.includes(scope.agentKind) ||
      !RESOURCE_TYPES.includes(scope.resourceType)
    ) {
      throw new HarnessConfigError('unsupported-scope', 'The requested harness configuration scope is unsupported')
    }
    return scope
  }

  private getHarness(agentKind: ManagedHarnessKind): HarnessResolver {
    return this.deps.resolvers?.[agentKind] ?? BUILTIN_RESOLVERS[agentKind]
  }

  private getDescriptor(scope: HarnessConfigScope): HarnessConfigResourceResolver {
    this.validateScopeShape(scope)
    const descriptor = this.getHarness(scope.agentKind).resources[scope.resourceType]
    if (!descriptor?.supported || !descriptor.rootKey) {
      throw new HarnessConfigError('unsupported-scope', descriptor?.reason ?? 'The requested harness configuration scope is unsupported')
    }
    return descriptor
  }

  private availableScopes(): HarnessConfigScope[] {
    const scopes: HarnessConfigScope[] = []
    for (const agentKind of MANAGED_HARNESSES) {
      const harness = this.getHarness(agentKind)
      for (const resourceType of RESOURCE_TYPES) {
        if (harness.resources[resourceType]?.supported) scopes.push({ agentKind, resourceType })
      }
    }
    return scopes
  }

  private defaultRoots(): Record<string, string> {
    const home = this.deps.homeDir ?? this.deps.env?.HOME ?? homedir()
    const codexHome = this.deps.env?.CODEX_HOME || join(home, '.codex')
    const claudeHome = this.deps.env?.CLAUDE_CONFIG_DIR || join(home, '.claude')
    const opencodeHome = join(home, '.config', 'opencode')
    return {
      claudeAgents: join(claudeHome, 'agents'),
      claudeSkills: join(claudeHome, 'skills'),
      claudeCommands: join(claudeHome, 'commands'),
      codexHome,
      codexSkills: join(home, '.agents', 'skills'),
      opencodeAgents: join(opencodeHome, 'agents'),
      opencodeSkills: join(opencodeHome, 'skills'),
      opencodeCommands: join(opencodeHome, 'commands')
    }
  }

  private get openCodeCustom(): string | undefined {
    return this.deps.env?.OPENCODE_CONFIG_DIR
  }

  private resolveRoot(descriptor: HarnessConfigResourceResolver): string {
    const rootKey = descriptor.rootKey
    if (!rootKey) throw new HarnessConfigError('unsupported-scope', 'The resolver has no verified known root')
    const configured = this.deps.knownRoots?.[rootKey]
    // OPENCODE_CONFIG_DIR has no verified contract with the managed entrypoints this
    // service knows (agents/skills/commands subdirectories). Honoring it would point
    // scans at a root whose layout we cannot verify; silently ignoring it would scan
    // the wrong root. Fail closed instead: no explicit knownRoots entry, no opencode scope.
    if (
      this.openCodeCustom?.trim() &&
      configured === undefined &&
      (rootKey === 'opencodeAgents' ||
      rootKey === 'opencodeSkills' ||
      rootKey === 'opencodeCommands')
    ) {
      throw new HarnessConfigError('unsupported-scope', 'The resolver has multiple active configuration roots')
    }
    const value = configured === undefined ? this.defaultRoots()[rootKey] : configured
    if (!value || value.trim() === '' || !isAbsolute(value)) {
      throw new HarnessConfigError('unsupported-scope', 'The resolver known root is unavailable')
    }
    const root = resolve(value)
    try {
      const info = this.fs.lstatSync(root)
      if (!info.isDirectory()) throw new Error('not a directory')
    } catch (error) {
      throw new HarnessConfigError('unsupported-scope', 'The resolver known root is unavailable', { cause: error })
    }
    return root
  }

  private descriptorMatches(descriptor: HarnessConfigResourceResolver, relativePath: string): boolean {
    if (descriptor.matches) return descriptor.matches(relativePath)
    if (!descriptor.pattern) return false
    descriptor.pattern.lastIndex = 0
    return descriptor.pattern.test(relativePath)
  }

  private validateRelativePath(value: string, descriptor: HarnessConfigResourceResolver, root?: string): string {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.includes('\0') ||
      value.includes('\\') ||
      value.startsWith('/') ||
      isAbsolute(value)
    ) {
      throw new HarnessConfigError('unsafe-path', 'The harness resource path is unsafe')
    }
    const normalized = value.replace(/\/+/g, '/')
    const segments = normalized.split('/')
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new HarnessConfigError('unsafe-path', 'The harness resource path is unsafe')
    }
    // Reject sibling-prefix confusion: a first segment named "<root-basename>-…"
    // (e.g. "agents-backup/", "agents-helper/" beside an "agents" root) is the shape
    // of a sibling directory masquerading as managed content. TEST-006 requires
    // rejecting prefix-sibling paths rather than trusting config-supplied refs.
    if (root && segments[0].startsWith(`${basename(root)}-`)) {
      throw new HarnessConfigError('unsafe-path', 'The harness resource path is unsafe')
    }
    if (!this.descriptorMatches(descriptor, normalized)) {
      throw new HarnessConfigError('unsafe-path', 'The harness resource path is outside the managed entrypoint')
    }
    return normalized
  }

  private resolveCandidate(
    descriptor: HarnessConfigResourceResolver,
    suppliedRelativePath: string,
    mustExist: boolean
  ): { root: string; relativePath: string; absolutePath: string } {
    const root = this.resolveRoot(descriptor)
    const relativePath = this.validateRelativePath(suppliedRelativePath, descriptor, root)
    const absolutePath = resolve(root, ...relativePath.split('/'))
    if (absolutePath !== root && !absolutePath.startsWith(root + sep)) {
      throw new HarnessConfigError('unsafe-path', 'The harness resource path escapes its known root')
    }
    this.assertRealContainment(root, absolutePath, mustExist)
    return { root, relativePath, absolutePath }
  }

  private assertRealContainment(root: string, candidate: string, mustExist: boolean): void {
    let existing = candidate
    while (true) {
      try {
        const info = this.fs.lstatSync(existing)
        if (info.isSymbolicLink()) {
          throw new HarnessConfigError('unsafe-path', 'A symbolic link makes the harness resource path unsafe')
        }
        break
      } catch (error) {
        if (error instanceof HarnessConfigError) throw error
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOTDIR') {
          throw new HarnessConfigError('unsafe-path', 'The harness resource path crosses a non-directory', { cause: error })
        }
        if (code !== 'ENOENT') {
          throw new HarnessConfigError('unsafe-path', 'Unable to verify the harness resource path', { cause: error })
        }
        const parent = dirname(existing)
        if (parent === existing) {
          throw new HarnessConfigError('unsafe-path', 'Unable to locate a safe harness resource ancestor')
        }
        existing = parent
      }
    }
    if (mustExist && existing !== candidate) {
      throw new HarnessConfigError('unknown-resource', 'The requested harness resource is no longer present')
    }
    let cursor = existing
    while (cursor !== root) {
      if (!cursor.startsWith(root + sep)) {
        throw new HarnessConfigError('unsafe-path', 'The harness resource path escapes its known root')
      }
      try {
        if (this.fs.lstatSync(cursor).isSymbolicLink()) {
          throw new HarnessConfigError('unsafe-path', 'A symbolic link makes the harness resource path unsafe')
        }
      } catch (error) {
        if (error instanceof HarnessConfigError) throw error
        throw new HarnessConfigError('unsafe-path', 'Unable to verify the harness resource path', { cause: error })
      }
      cursor = dirname(cursor)
    }
    let realRoot: string
    let realExisting: string
    try {
      realRoot = resolve(this.fs.realpathSync(root))
      realExisting = resolve(this.fs.realpathSync(existing))
    } catch (error) {
      throw new HarnessConfigError('unsafe-path', 'Unable to verify the harness resource path', { cause: error })
    }
    if (realExisting !== realRoot && !realExisting.startsWith(realRoot + sep)) {
      throw new HarnessConfigError('unsafe-path', 'The harness resource path escapes its known root')
    }
  }

  private validateLogicalName(name: string): void {
    if (
      typeof name !== 'string' ||
      name.length === 0 ||
      name.includes('\0') ||
      name.includes('\\') ||
      name.startsWith('/') ||
      isAbsolute(name) ||
      name.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      throw new HarnessConfigError('unsafe-path', 'The harness resource name is unsafe')
    }
  }

  private assertDiscoverableDepth(descriptor: HarnessConfigResourceResolver, relativePath: string): void {
    const depth = relativePath.split('/').length - 1
    if (depth > (descriptor.maxDepth ?? Number.POSITIVE_INFINITY)) {
      throw new HarnessConfigError('invalid-name', 'The derived resource path is outside the managed discovery boundary')
    }
  }

  private snapshot(scope: HarnessConfigScope): SnapshotState {
    this.getDescriptor(scope)
    const desired = this.loadDesired()
    const disk = this.scanDisk(scope, desired)
    const scopedDesired = this.desiredForScope(scope, desired)
    return {
      scope: cloneScope(scope),
      disk,
      desired: scopedDesired,
      diskFingerprint: this.diskFingerprint(disk),
      configFingerprint: this.configFingerprint(scopedDesired),
      resolverIdentity: this.resolverIdentity(scope)
    }
  }

  private scanDisk(scope: HarnessConfigScope, desired: HarnessConfigDesiredResource[]): DiskEntry[] {
    const primary = this.getDescriptor(scope)
    const descriptors: HarnessConfigResourceResolver[] = [primary]
    for (const sourceType of primary.aliasSourceResourceTypes ?? []) {
      const source = this.getHarness(scope.agentKind).resources[sourceType]
      if (source?.supported && source.rootKey) descriptors.push(source)
    }
    const desiredIds = new Set(
      desired
        .filter((resource) => resource.agentKind === scope.agentKind)
        .map((resource) => resource.id)
    )
    const byId = new Map<string, DiskEntry>()
    for (const descriptor of descriptors) {
      const root = this.resolveRoot(descriptor)
      const paths: string[] = []
      this.walk(root, '', 0, descriptor, paths)
      for (const relativePath of paths) {
        const target = this.resolveCandidate(descriptor, relativePath, true)
        let info: Stats
        try {
          info = this.fs.lstatSync(target.absolutePath)
        } catch {
          continue
        }
        if (!info.isFile() || info.isSymbolicLink()) continue
        const bytes = this.readInventoryBytes(target.absolutePath)
        const canonicalResourceType = descriptor.canonicalResourceType ?? scope.resourceType
        const aliasResourceTypes = [...new Set(descriptor.aliasResourceTypes ?? [])].sort()
        const id = physicalId(scope.agentKind, descriptor.rootKey!, target.relativePath)
        const ref: HarnessConfigFileRef = {
          id,
          agentKind: scope.agentKind,
          resourceType: scope.resourceType,
          canonicalResourceType,
          aliasResourceTypes,
          label: this.labelFor(target.relativePath, canonicalResourceType),
          relativePath: target.relativePath,
          absolutePath: target.absolutePath,
          hash: sha256(bytes),
          existsOnDisk: true,
          managed: desiredIds.has(id),
          updatedAt: info.mtimeMs
        }
        byId.set(id, { ref, descriptor, root })
      }
    }
    return [...byId.values()].sort((a, b) => compareRefs(a.ref, b.ref))
  }

  private walk(
    root: string,
    currentRelative: string,
    depth: number,
    descriptor: HarnessConfigResourceResolver,
    output: string[]
  ): void {
    const current = currentRelative ? join(root, ...currentRelative.split('/')) : root
    let entries
    try {
      entries = this.fs.readdirSync(current, { withFileTypes: true })
    } catch (error) {
      throw new HarnessConfigError('read-failed', 'Unable to enumerate the harness configuration root', { cause: error })
    }
    entries.sort((a, b) => lexicalCompare(a.name, b.name))
    for (const entry of entries) {
      const nextRelative = currentRelative ? `${currentRelative}/${entry.name}` : entry.name
      if (BACKUP_SUFFIX.test(nextRelative)) continue
      const absolutePath = join(root, ...nextRelative.split('/'))
      let info
      try {
        info = this.fs.lstatSync(absolutePath)
      } catch {
        continue
      }
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) {
        if (depth < (descriptor.maxDepth ?? Number.POSITIVE_INFINITY)) {
          this.walk(root, nextRelative, depth + 1, descriptor, output)
        }
      } else if (info.isFile() && this.descriptorMatches(descriptor, nextRelative)) {
        output.push(nextRelative)
      }
    }
  }

  private readInventoryBytes(path: string): Buffer {
    try {
      return this.fs.readFileSync(path)
    } catch (error) {
      throw new HarnessConfigError('read-failed', 'Unable to read a harness resource', { cause: error })
    }
  }

  private loadDesired(): HarnessConfigDesiredResource[] {
    const resources = this.deps.loadDesiredResources?.() ?? []
    if (!Array.isArray(resources)) {
      throw new HarnessConfigError('read-failed', 'Desired harness resources are unavailable')
    }
    return resources.map((resource) => ({
      ...resource,
      canonicalResourceType: resource.canonicalResourceType ?? resource.resourceType,
      aliasResourceTypes: [...(resource.aliasResourceTypes ?? [])]
    }))
  }

  private desiredForScope(
    scope: HarnessConfigScope,
    resources: HarnessConfigDesiredResource[]
  ): HarnessConfigDesiredResource[] {
    return resources
      .filter((resource) =>
        resource.agentKind === scope.agentKind &&
        (resource.resourceType === scope.resourceType ||
          resource.canonicalResourceType === scope.resourceType ||
          resource.aliasResourceTypes?.includes(scope.resourceType))
      )
      .sort((a, b) => lexicalCompare(a.id, b.id) || lexicalCompare(a.relativePath, b.relativePath))
  }

  private configEntries(scope: HarnessConfigScope, resources: HarnessConfigDesiredResource[]): ConfigEntry[] {
    const selected = this.getDescriptor(scope)
    const entries = new Map<string, ConfigEntry>()
    for (const resource of resources) {
      const descriptor = this.descriptorForDesired(scope, selected, resource)
      const target = this.resolveCandidate(descriptor, resource.relativePath, false)
      const expectedId = physicalId(scope.agentKind, descriptor.rootKey!, target.relativePath)
      if (resource.id !== expectedId) {
        throw new HarnessConfigError('unsafe-path', 'The desired harness resource identity is invalid')
      }
      const canonicalResourceType = resource.canonicalResourceType ?? resource.resourceType
      const aliasResourceTypes = [...new Set(resource.aliasResourceTypes ?? descriptor.aliasResourceTypes ?? [])].sort()
      const contentHash = sha256(Buffer.from(resource.content, 'utf8'))
      const ref: HarnessConfigFileRef = {
        id: expectedId,
        agentKind: scope.agentKind,
        resourceType: scope.resourceType,
        canonicalResourceType,
        aliasResourceTypes,
        label: resource.label || this.labelFor(target.relativePath, canonicalResourceType),
        relativePath: target.relativePath,
        absolutePath: target.absolutePath,
        hash: contentHash,
        existsOnDisk: false,
        managed: true,
        updatedAt: resource.updatedAt
      }
      entries.set(expectedId, {
        resource: { ...resource, id: expectedId, hash: contentHash },
        ref,
        descriptor,
        root: target.root
      })
    }
    return [...entries.values()].sort((a, b) => compareRefs(a.ref, b.ref))
  }

  private descriptorForDesired(
    scope: HarnessConfigScope,
    selected: HarnessConfigResourceResolver,
    resource: HarnessConfigDesiredResource
  ): HarnessConfigResourceResolver {
    const canonical = resource.canonicalResourceType ?? resource.resourceType
    if ((selected.canonicalResourceType ?? scope.resourceType) === canonical) return selected
    const candidate = this.getHarness(scope.agentKind).resources[canonical]
    if (!candidate?.supported || !candidate.rootKey) {
      throw new HarnessConfigError('unsafe-path', 'The desired harness resource has no verified resolver')
    }
    return candidate
  }

  private buildComparison(scope: HarnessConfigScope): ComparisonState {
    const state = this.snapshot(scope)
    const config = this.configEntries(scope, state.desired)
    const diskById = new Map(state.disk.map((entry) => [entry.ref.id, entry]))
    const configById = new Map(config.map((entry) => [entry.ref.id, entry]))
    const diskOnly = state.disk.filter((entry) => !configById.has(entry.ref.id))
    const configOnly = config.filter((entry) => !diskById.has(entry.ref.id))
    const changed = state.disk.flatMap((disk) => {
      const desired = configById.get(disk.ref.id)
      return desired && desired.ref.hash !== disk.ref.hash ? [{ disk, config: desired }] : []
    })
    const comparison: HarnessConfigComparison = {
      scope: cloneScope(scope),
      status: comparisonStatus(diskOnly, configOnly, changed),
      diskOnly: diskOnly.map(({ ref }) => cloneRef(ref)),
      configOnly: configOnly.map(({ ref }) => cloneRef(ref)),
      changed: changed.map(({ disk, config }) => ({ disk: cloneRef(disk.ref), config: cloneRef(config.ref) })),
      comparedAt: this.clock()
    }
    return { ...state, comparison, diskOnly, configOnly, changed, config }
  }

  private diskFingerprint(entries: DiskEntry[]): string {
    return sha256(JSON.stringify(entries.map(({ ref }) => [ref.id, ref.relativePath, ref.hash])))
  }

  private configFingerprint(resources: HarnessConfigDesiredResource[]): string {
    return sha256(JSON.stringify(resources.map((resource) => [
      resource.id,
      resource.agentKind,
      resource.resourceType,
      resource.canonicalResourceType,
      [...(resource.aliasResourceTypes ?? [])].sort(),
      resource.relativePath,
      resource.label,
      resource.content,
      resource.hash,
      resource.updatedAt
    ])))
  }

  private resolverIdentity(scope: HarnessConfigScope): string {
    const harness = this.getHarness(scope.agentKind)
    const primary = this.getDescriptor(scope)
    const descriptors = [primary, ...(primary.aliasSourceResourceTypes ?? []).map((type) => harness.resources[type]).filter((value): value is HarnessConfigResourceResolver => Boolean(value))]
    return sha256(JSON.stringify([
      harness.identity,
      ...descriptors.map((descriptor) => [
        descriptor.identity,
        descriptor.rootKey,
        descriptor.canonicalResourceType,
        descriptor.aliasResourceTypes,
        descriptor.aliasSourceResourceTypes,
        descriptor.maxDepth,
        descriptor.rootKey ? this.resolveRoot(descriptor) : null
      ])
    ]))
  }

  private planFingerprint(diskFingerprint: string, configFingerprint: string, resolverIdentity: string): string {
    return sha256(`${diskFingerprint}\0${configFingerprint}\0${resolverIdentity}`)
  }

  private storePlan(
    publicPlan: HarnessConfigSyncPlan,
    state: SnapshotState,
    operations: DiskOperation[]
  ): void {
    this.rememberPlan(publicPlan.planId, {
      publicPlan,
      scopeKey: harnessConfigScopeKey(publicPlan.scope),
      direction: publicPlan.direction,
      diskFingerprint: state.diskFingerprint,
      configFingerprint: state.configFingerprint,
      resolverIdentity: state.resolverIdentity,
      operations,
      attempted: false
    })
  }

  private storeMutationPlan(
    scope: HarnessConfigScope,
    direction: 'create' | 'update' | 'delete',
    ref: HarnessConfigFileRef,
    content: string | undefined,
    state: SnapshotState,
    descriptor = this.getDescriptor(scope)
  ): HarnessConfigMutationPlan {
    const operation: DiskOperation = {
      type: direction === 'update' ? 'overwrite' : direction,
      id: ref.id,
      relativePath: ref.relativePath,
      content,
      descriptorResourceType: this.descriptorResourceType(scope, descriptor)
    }
    const fingerprint = this.planFingerprint(state.diskFingerprint, state.configFingerprint, state.resolverIdentity)
    const publicPlan: HarnessConfigMutationPlan = {
      planId: this.uuid(),
      scope: cloneScope(scope),
      direction,
      resource: cloneRef(ref),
      generatedAt: this.clock(),
      fingerprint
    }
    this.rememberPlan(publicPlan.planId, {
      publicPlan,
      scopeKey: harnessConfigScopeKey(scope),
      direction,
      diskFingerprint: state.diskFingerprint,
      configFingerprint: state.configFingerprint,
      resolverIdentity: state.resolverIdentity,
      operations: [operation],
      attempted: false
    })
    return publicPlan
  }

  private descriptorResourceType(
    scope: HarnessConfigScope,
    descriptor: HarnessConfigResourceResolver
  ): HarnessConfigResourceType {
    const harness = this.getHarness(scope.agentKind)
    for (const resourceType of RESOURCE_TYPES) {
      if (harness.resources[resourceType] === descriptor) return resourceType
    }
    return scope.resourceType
  }

  private prepareConversion(
    scope: HarnessConfigScope,
    id: string,
    sourceType: HarnessConfigResourceType,
    destinationType: HarnessConfigResourceType
  ): HarnessConfigConversionResult {
    this.validateScopeShape(scope)
    if (scope.resourceType !== sourceType) {
      throw new HarnessConfigError('unknown-resource', 'The requested resource is not in the conversion source scope')
    }
    const source = this.scanDisk(scope, this.loadDesired()).find(({ ref }) => ref.id === id)
    if (!source) throw new HarnessConfigError('unknown-resource', 'The requested harness resource is unknown')
    if (
      scope.agentKind === 'claude' &&
      (source.ref.aliasResourceTypes.includes(destinationType) || source.ref.canonicalResourceType === destinationType)
    ) {
      return { status: 'alias', ref: cloneRef(source.ref) }
    }
    const destinationScope: HarnessConfigScope = { agentKind: scope.agentKind, resourceType: destinationType }
    const descriptor = this.getDescriptor(destinationScope)
    if (!descriptor.nameToRelativePath) {
      throw new HarnessConfigError('invalid-name', 'The destination resolver cannot derive a resource path')
    }
    const destinationName = conversionDestinationName({
      name: this.conversionName(source.ref),
      label: source.ref.label
    })
    const target = this.resolveCandidate(descriptor, descriptor.nameToRelativePath(destinationName), false)
    let existingTarget
    try {
      existingTarget = this.fs.lstatSync(target.absolutePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new HarnessConfigError('unsafe-path', 'Unable to verify the conversion destination', { cause: error })
      }
    }
    if (existingTarget?.isSymbolicLink()) {
      throw new HarnessConfigError('unsafe-path', 'A symbolic link makes the conversion destination unsafe')
    }
    const destinationEntries = existingTarget ? this.scanDisk(destinationScope, this.loadDesired()) : []
    const foldedTarget = target.relativePath.toLowerCase()
    const existing =
      destinationEntries.find(({ ref }) => ref.relativePath === target.relativePath) ??
      destinationEntries.find(({ ref }) => ref.relativePath.toLowerCase() === foldedTarget)
    if (existing) return { status: 'existing', ref: cloneRef(existing.ref) }
    // Fresh content is read only now that alias/existing resolution has
    // determined generation is actually required (REQ-008).
    const content = this.readInventoryBytes(source.ref.absolutePath).toString('utf8')
    const generatorSource: HarnessConfigConversionSource = {
      agentKind: scope.agentKind,
      resourceType: sourceType as HarnessConfigConversionSource['resourceType'],
      name: this.conversionName(source.ref),
      label: source.ref.label,
      relativePath: source.ref.relativePath,
      content
    }
    const draft =
      sourceType === 'skills'
        ? createCommandFromSkill(generatorSource)
        : createSkillFromCommand(generatorSource)
    return {
      status: 'draft',
      agentKind: scope.agentKind,
      resourceType: destinationType,
      name: draft.destinationName,
      relativePath: target.relativePath,
      label: this.labelFor(target.relativePath, descriptor.canonicalResourceType ?? destinationType),
      content: draft.content
    }
  }

  private conversionName(ref: HarnessConfigFileRef): string {
    if (ref.canonicalResourceType === 'skills' || ref.relativePath.endsWith('/SKILL.md')) {
      const parent = posixPath(dirname(ref.relativePath))
      return parent === '.' ? ref.label : parent
    }
    return ref.relativePath.replace(/\.md$/, '')
  }

  private labelFor(relativePath: string, resourceType: HarnessConfigResourceType): string {
    if (resourceType === 'skills' || relativePath.endsWith('/SKILL.md')) {
      const parent = posixPath(dirname(relativePath))
      return parent === '.' ? 'SKILL' : basename(parent)
    }
    return basename(relativePath, '.md')
  }

  private desiredFromRef(ref: HarnessConfigFileRef, content: string): HarnessConfigDesiredResource {
    return {
      id: ref.id,
      agentKind: ref.agentKind,
      resourceType: ref.canonicalResourceType,
      canonicalResourceType: ref.canonicalResourceType,
      aliasResourceTypes: [...ref.aliasResourceTypes],
      relativePath: ref.relativePath,
      label: ref.label,
      content,
      hash: sha256(Buffer.from(content, 'utf8')),
      updatedAt: ref.updatedAt
    }
  }

  private preflight(scope: HarnessConfigScope, operations: DiskOperation[]): void {
    const seen = new Set<string>()
    for (const operation of operations) {
      const descriptor = this.operationDescriptor(scope, operation)
      const target = this.resolveCandidate(descriptor, operation.relativePath, operation.type !== 'create')
      if (seen.has(target.absolutePath)) {
        throw new HarnessConfigError('collision', 'The plan contains more than one operation for a target')
      }
      seen.add(target.absolutePath)
      const exists = this.fs.existsSync(target.absolutePath)
      if (operation.type === 'create' && exists) {
        throw new HarnessConfigError('collision', 'A harness resource already exists at that destination')
      }
      if (operation.type !== 'create' && !exists) {
        throw new HarnessConfigError('stale-plan', 'A planned harness resource is no longer present')
      }
      if (exists) {
        const info = this.fs.lstatSync(target.absolutePath)
        if (!info.isFile() || info.isSymbolicLink()) {
          throw new HarnessConfigError('unsafe-path', 'The planned target is not a safe regular file')
        }
      }
    }
  }

  private operationDescriptor(scope: HarnessConfigScope, operation: DiskOperation): HarnessConfigResourceResolver {
    const descriptor = this.getHarness(scope.agentKind).resources[operation.descriptorResourceType]
    if (!descriptor?.supported || !descriptor.rootKey) {
      throw new HarnessConfigError('stale-plan', 'The plan resolver is no longer available')
    }
    return descriptor
  }

  private applyDiskOperation(scope: HarnessConfigScope, operation: DiskOperation): MutationOutcome {
    const descriptor = this.operationDescriptor(scope, operation)
    const target = this.resolveCandidate(descriptor, operation.relativePath, operation.type !== 'create')
    const existed = this.fs.existsSync(target.absolutePath)
    let before: Buffer | undefined
    if (existed) before = this.createBackup(target.absolutePath)

    if (operation.type === 'delete') {
      try {
        this.fs.unlinkSync(target.absolutePath)
      } catch (error) {
        throw new HarnessConfigError('delete-failed', 'Unable to delete the harness resource', { cause: error })
      }
    } else {
      if (operation.type === 'create' && existed) {
        throw new HarnessConfigError('collision', 'A harness resource already exists at that destination')
      }
      this.atomicWrite(target.absolutePath, Buffer.from(operation.content ?? '', 'utf8'))
    }
    return { operation, applied: this.appliedSummary(operation), existed, before }
  }

  private createBackup(target: string): Buffer {
    let bytes: Buffer
    try {
      bytes = this.fs.readFileSync(target)
    } catch (error) {
      throw new HarnessConfigError('backup-failed', 'Unable to read the resource for backup', { cause: error })
    }
    const base = `${target}.x-backup-${compactTimestamp(this.clock())}`
    for (let collision = 1; ; collision += 1) {
      const backup = collision === 1 ? base : `${base}-${collision}`
      if (this.fs.existsSync(backup)) continue
      try {
        this.fs.writeFileSync(backup, bytes, { flag: 'wx' })
        return bytes
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        try {
          if (this.fs.existsSync(backup)) this.fs.unlinkSync(backup)
        } catch (cleanupError) {
          this.logFailure('backup cleanup', cleanupError)
        }
        throw new HarnessConfigError('backup-failed', 'Unable to create the resource backup', { cause: error })
      }
    }
  }

  private atomicWrite(target: string, bytes: Buffer): void {
    const parent = dirname(target)
    const temporary = `${target}.harness-config-${this.clock()}-${++this.tempSequence}.tmp-${process.pid}`
    try {
      this.fs.mkdirSync(parent, { recursive: true })
      this.fs.writeFileSync(temporary, bytes, { flag: 'wx' })
      this.fs.renameSync(temporary, target)
    } catch (error) {
      try {
        if (this.fs.existsSync(temporary)) this.fs.unlinkSync(temporary)
      } catch (cleanupError) {
        this.logFailure('temporary-file cleanup', cleanupError)
      }
      throw new HarnessConfigError('write-failed', 'Unable to atomically write the harness resource', { cause: error })
    }
  }

  private appliedSummary(operation: DiskOperation): HarnessConfigAppliedOperation {
    return { type: operation.type, id: operation.id, relativePath: operation.relativePath }
  }

  private async persistDirectMutation(
    requestedScope: HarnessConfigScope,
    direction: 'create' | 'update' | 'delete',
    outcome: MutationOutcome
  ): Promise<void> {
    const descriptor = this.operationDescriptor(requestedScope, outcome.operation)
    const canonicalResourceType = descriptor.canonicalResourceType ?? requestedScope.resourceType
    const canonicalScope: HarnessConfigScope = {
      agentKind: requestedScope.agentKind,
      resourceType: canonicalResourceType
    }
    const current = this.desiredForScope(canonicalScope, this.loadDesired())
    const resources = current.filter((resource) => resource.id !== outcome.operation.id)
    if (direction !== 'delete') {
      const target = this.resolveCandidate(descriptor, outcome.operation.relativePath, true)
      const bytes = this.readInventoryBytes(target.absolutePath)
      const info = this.fs.lstatSync(target.absolutePath)
      const ref: HarnessConfigFileRef = {
        id: outcome.operation.id,
        agentKind: requestedScope.agentKind,
        resourceType: requestedScope.resourceType,
        canonicalResourceType,
        aliasResourceTypes: [...(descriptor.aliasResourceTypes ?? [])],
        label: this.labelFor(target.relativePath, canonicalResourceType),
        relativePath: target.relativePath,
        absolutePath: target.absolutePath,
        hash: sha256(bytes),
        existsOnDisk: true,
        managed: true,
        updatedAt: info.mtimeMs
      }
      resources.push(this.desiredFromRef(ref, bytes.toString('utf8')))
    }
    resources.sort((a, b) => lexicalCompare(a.id, b.id))
    await this.replaceDesired(canonicalScope, resources)
  }

  private async replaceDesired(scope: HarnessConfigScope, resources: HarnessConfigDesiredResource[]): Promise<void> {
    if (!this.deps.replaceDesiredScope) {
      throw new HarnessConfigError('desired-state-failed', 'Desired harness configuration persistence is unavailable')
    }
    await this.deps.replaceDesiredScope(cloneScope(scope), resources.map((resource) => ({
      ...resource,
      aliasResourceTypes: [...(resource.aliasResourceTypes ?? [])]
    })))
  }

  private rollback(scope: HarnessConfigScope, outcome: MutationOutcome): void {
    const descriptor = this.operationDescriptor(scope, outcome.operation)
    const target = this.resolveCandidate(descriptor, outcome.operation.relativePath, false)
    if (!outcome.existed) {
      if (this.fs.existsSync(target.absolutePath)) this.fs.unlinkSync(target.absolutePath)
      return
    }
    if (!outcome.before) throw new Error('Backup bytes are unavailable for rollback')
    this.atomicWrite(target.absolutePath, outcome.before)
  }

  private withPartialResult(error: unknown, applied: HarnessConfigAppliedOperation[]): HarnessConfigError {
    if (error instanceof HarnessConfigError) {
      return new HarnessConfigError(error.code, error.message, {
        cause: error,
        applied: [...applied],
        requiresRescan: true
      })
    }
    return new HarnessConfigError('write-failed', 'Unable to apply the harness configuration plan', {
      cause: error,
      applied: [...applied],
      requiresRescan: true
    })
  }

  private consumePlan(planId: string): void {
    this.plans.delete(planId)
    this.rememberAttempted(planId)
  }
}

export function createHarnessConfigService(deps: HarnessConfigServiceDeps = {}): HarnessConfigService {
  return new HarnessConfigServiceImpl(deps)
}

export { BUILTIN_RESOLVERS }

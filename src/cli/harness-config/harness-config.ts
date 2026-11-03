import { AGENT_REGISTRY, getAgentInfo, type HarnessConfigResourceType } from '../../shared/agent-registry'
import type {
  HarnessConfigAppliedOperation,
  HarnessConfigRequestErrorCode,
  HarnessConfigRequestResult,
  HarnessConfigScope,
  ManagedHarnessKind
} from '../../shared/state/harness-config'
import type { AgentKind } from '../../shared/state/terminals'
import type { TatsuClient } from '../client'
import { CliError, type CliErrorCode } from '../errors'
import type { CommandContext, CommandOption } from '../commands'

const MANAGED_KINDS: readonly ManagedHarnessKind[] = ['claude', 'codex', 'opencode']
const RESOURCE_TYPES: readonly HarnessConfigResourceType[] = ['agents', 'skills', 'commands']

const REPLAN_HINT = "re-run 'tatsu sync plan' (plans live in backend memory and go stale when the files change)"

const CODE_MAP = {
  'invalid-request': 'usage',
  'unsupported-scope': 'usage',
  'invalid-name': 'usage',
  'unknown-plan': 'command-failed',
  'stale-plan': 'command-failed',
  'unconfirmed-plan': 'command-failed',
  'unknown-resource': 'command-failed',
  'unsafe-path': 'command-failed',
  'scope-mismatch': 'command-failed',
  collision: 'command-failed',
  'backup-failed': 'command-failed',
  'read-failed': 'command-failed',
  'write-failed': 'command-failed',
  'delete-failed': 'command-failed',
  'desired-state-failed': 'command-failed',
  'linked-resource': 'command-failed',
  'invalid-template': 'command-failed',
  'invalid-target': 'command-failed',
  'template-shadows': 'command-failed',
  'invalid-fragment': 'command-failed',
  'internal-error': 'command-failed'
} satisfies Record<HarnessConfigRequestErrorCode, CliErrorCode>

const PLAN_CODES: ReadonlySet<string> = new Set<HarnessConfigRequestErrorCode>(['unknown-plan', 'stale-plan', 'unconfirmed-plan'])

export interface HcRequestOptions {
  detach?: boolean
}

export interface HcErrorDetails {
  code: string
  applied?: HarnessConfigAppliedOperation[]
}

export function codeFor(code: string, { detach = false }: HcRequestOptions = {}): CliErrorCode {
  if (code === 'unknown-resource' && detach) return 'usage'
  return Object.hasOwn(CODE_MAP, code) ? CODE_MAP[code as HarnessConfigRequestErrorCode] : 'command-failed'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isRequestResult(value: unknown): value is HarnessConfigRequestResult<unknown> {
  if (!isRecord(value)) return false
  if (value.ok === true) return 'value' in value
  if (value.ok !== false || !isRecord(value.error)) return false
  return typeof value.error.code === 'string' && typeof value.error.message === 'string'
}

export async function hcRequest<T>(client: TatsuClient, channel: string, payload: unknown, options: HcRequestOptions = {}): Promise<T> {
  const res = await client.request(channel, payload)
  if (!isRequestResult(res)) throw new CliError('request-failed', `backend sent a malformed reply to '${channel}'`)
  if (res.ok) return res.value as T
  const { code, message, applied } = res.error
  const details: HcErrorDetails = { code, ...(applied !== undefined ? { applied } : {}) }
  const text = PLAN_CODES.has(code) ? `${message}; ${REPLAN_HINT}` : message
  throw new CliError(codeFor(code, options), text, details)
}

export interface ScopeFilters {
  agent?: string
  type?: string
}

const AGENT_VALUES: readonly AgentKind[] = AGENT_REGISTRY.map((info) => info.kind)

function isAgentValue(value: string): value is AgentKind {
  return (AGENT_VALUES as readonly string[]).includes(value)
}

function isResourceType(value: string): value is HarnessConfigResourceType {
  return (RESOURCE_TYPES as readonly string[]).includes(value)
}

function isManagedKind(kind: AgentKind): kind is ManagedHarnessKind {
  return (MANAGED_KINDS as readonly string[]).includes(kind)
}

function supportedScopes(): HarnessConfigScope[] {
  return AGENT_REGISTRY.flatMap(({ kind, configCapabilities }) => {
    if (!isManagedKind(kind)) return []
    return configCapabilities
      .filter((capability) => capability.status === 'supported')
      .map((capability) => ({ agentKind: kind, resourceType: capability.resourceType }))
  })
}

export function enumerateScopes(filters: ScopeFilters): HarnessConfigScope[] {
  const { agent, type } = filters
  if (agent !== undefined && !isAgentValue(agent)) {
    throw new CliError('usage', `--agent must be one of ${AGENT_VALUES.join(', ')} (got '${agent}')`)
  }
  if (type !== undefined && !isResourceType(type)) {
    throw new CliError('usage', `--type must be one of ${RESOURCE_TYPES.join(', ')} (got '${type}')`)
  }
  const scopes = supportedScopes().filter(
    (scope) => (agent === undefined || scope.agentKind === agent) && (type === undefined || scope.resourceType === type)
  )
  if (scopes.length > 0) return scopes
  if (agent !== undefined && type !== undefined) {
    throw new CliError('usage', `${getAgentInfo(agent).displayName} does not support ${type}`)
  }
  if (agent !== undefined) throw new CliError('usage', `${getAgentInfo(agent).displayName} has no supported config scopes`)
  throw new CliError('usage', `no harness supports ${type ?? 'any resource type'}`)
}

export function scopeFiltersFrom(values: CommandContext['values']): ScopeFilters {
  const { agent, type } = values
  return {
    ...(typeof agent === 'string' ? { agent } : {}),
    ...(typeof type === 'string' ? { type } : {})
  }
}

export function scopeLabel(scope: HarnessConfigScope): string {
  return `${getAgentInfo(scope.agentKind).displayName} · ${scope.resourceType}`
}

export const scopeOptions = {
  agent: { type: 'string', valueName: 'kind', description: `Only this harness: ${MANAGED_KINDS.join('|')}` },
  type: { type: 'string', valueName: 'type', description: `Only this resource type: ${RESOURCE_TYPES.join('|')}` }
} satisfies Record<string, CommandOption>

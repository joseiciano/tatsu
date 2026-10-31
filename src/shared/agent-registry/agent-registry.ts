import type { AgentKind } from '../state/terminals'

export type HarnessConfigResourceType = 'agents' | 'skills' | 'commands'
export type HarnessConfigCapabilityStatus = 'supported' | 'unsupported' | 'unknown'

/** How a template renders for a harness. `frontmatterName` is false where
 *  the harness derives the name from the file path and would misread an
 *  extra `name` key. */
export interface HarnessTemplateOutput {
  frontmatterName: boolean
}

export type AgentConfigCapability =
  | {
      resourceType: HarnessConfigResourceType
      label: string
      status: 'supported'
      notes?: string
      aliasResourceTypes?: readonly HarnessConfigResourceType[]
      /** `single-file` means the harness keeps this resource type in one
       *  shared file, so a template cannot own a file per resource. */
      layout?: 'per-resource' | 'single-file'
      templateOutput?: HarnessTemplateOutput
    }
  | {
      resourceType: HarnessConfigResourceType
      label: string
      status: 'unsupported' | 'unknown'
      notes: string
      aliasResourceTypes?: never
      layout?: never
      templateOutput?: never
    }

export function isHarnessConfigCapabilityEnabled(capability: AgentConfigCapability): boolean {
  return capability.status === 'supported'
}

type ResourcePathKind = 'claude' | 'codex' | 'opencode'

const RESOURCE_PATHS: Record<ResourcePathKind, Partial<Record<HarnessConfigResourceType, (name: string) => string>>> = {
  claude: {
    agents: (name) => `${name}.md`,
    skills: (name) => `${name}/SKILL.md`,
    commands: (name) => `${name}.md`
  },
  codex: {
    agents: (name) => `${name}.md`,
    skills: (name) => `${name}/SKILL.md`
  },
  opencode: {
    agents: (name) => `${name}.md`,
    skills: (name) => `${name}/SKILL.md`,
    commands: (name) => `${name}.md`
  }
}

/** Root-relative path of a named resource, shared by the main-process
 *  resolvers and the template renderer so both agree on layouts. */
export function resourcePathForName(
  agentKind: AgentKind,
  resourceType: HarnessConfigResourceType,
  name: string
): string | null {
  if (agentKind !== 'claude' && agentKind !== 'codex' && agentKind !== 'opencode') return null
  const pathFor = RESOURCE_PATHS[agentKind][resourceType]
  return pathFor ? pathFor(name) : null
}

export function templateOutputFor(
  agentKind: AgentKind,
  resourceType: HarnessConfigResourceType
): HarnessTemplateOutput | null {
  const capability = getAgentInfo(agentKind).configCapabilities.find((entry) => entry.resourceType === resourceType)
  return capability?.status === 'supported' ? (capability.templateOutput ?? null) : null
}

export interface AgentInfo {
  kind: AgentKind
  displayName: string
  vendor: string
  /** If true, Harness generates a session ID and passes it to the CLI on
   * first spawn. If false, the agent assigns its own ID and Harness
   * discovers it from the first hook event. */
  assignsSessionId: boolean
  configCapabilities: readonly AgentConfigCapability[]
}

export const AGENT_REGISTRY: AgentInfo[] = [
  {
    kind: 'claude',
    displayName: 'Claude Code',
    vendor: 'Anthropic',
    assignsSessionId: true,
    configCapabilities: [
      {
        resourceType: 'agents',
        label: 'Agents',
        status: 'supported',
        templateOutput: { frontmatterName: true }
      },
      {
        resourceType: 'skills',
        label: 'Skills',
        status: 'supported',
        notes: 'Claude skills also appear in the Commands view as the same physical resource.',
        aliasResourceTypes: ['commands'],
        templateOutput: { frontmatterName: true }
      },
      {
        resourceType: 'commands',
        label: 'Commands',
        status: 'supported',
        notes: 'Includes native Claude commands and aliases of Claude skills.',
        templateOutput: { frontmatterName: true }
      }
    ]
  },
  {
    kind: 'codex',
    displayName: 'Codex',
    vendor: 'OpenAI',
    assignsSessionId: false,
    configCapabilities: [
      {
        resourceType: 'agents',
        label: 'Agents',
        status: 'supported',
        notes: 'Codex agents are one top-level AGENTS.md file, not a folder of agents.',
        layout: 'single-file'
      },
      {
        resourceType: 'skills',
        label: 'Skills',
        status: 'supported',
        templateOutput: { frontmatterName: true }
      },
      {
        resourceType: 'commands',
        label: 'Commands',
        status: 'unsupported',
        notes: 'Tatsu has no verified first-version custom-command filesystem contract.'
      }
    ]
  },
  {
    kind: 'opencode',
    displayName: 'Opencode',
    vendor: 'Opencode',
    assignsSessionId: false,
    configCapabilities: [
      {
        resourceType: 'agents',
        label: 'Agents',
        status: 'supported',
        templateOutput: { frontmatterName: false }
      },
      {
        resourceType: 'skills',
        label: 'Skills',
        status: 'supported',
        templateOutput: { frontmatterName: true }
      },
      {
        resourceType: 'commands',
        label: 'Commands',
        status: 'supported',
        templateOutput: { frontmatterName: false }
      }
    ]
  },
  {
    kind: 'pi',
    displayName: 'Pi',
    vendor: 'Earendil',
    assignsSessionId: false,
    configCapabilities: [
      {
        resourceType: 'agents',
        label: 'Agents',
        status: 'unknown',
        notes: 'Pi config management is deferred; its resource capabilities and layouts are not yet specified.'
      },
      {
        resourceType: 'skills',
        label: 'Skills',
        status: 'unknown',
        notes: 'Pi config management is deferred; its resource capabilities and layouts are not yet specified.'
      },
      {
        resourceType: 'commands',
        label: 'Commands',
        status: 'unknown',
        notes: 'Pi config management is deferred; its resource capabilities and layouts are not yet specified.'
      }
    ]
  }
]

export interface ModelOption {
  id: string
  displayName: string
  tier: 'current' | 'legacy'
}

export const CLAUDE_MODELS: ModelOption[] = [
  { id: 'claude-opus-4-7', displayName: 'Claude Opus 4.7', tier: 'current' },
  { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', tier: 'current' },
  { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', tier: 'current' },
  { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', tier: 'legacy' },
  { id: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5', tier: 'legacy' },
  { id: 'claude-opus-4-5', displayName: 'Claude Opus 4.5', tier: 'legacy' },
  { id: 'claude-opus-4-1', displayName: 'Claude Opus 4.1', tier: 'legacy' },
  { id: 'claude-sonnet-4-0', displayName: 'Claude Sonnet 4.0', tier: 'legacy' },
  { id: 'claude-opus-4-0', displayName: 'Claude Opus 4.0', tier: 'legacy' },
  { id: 'claude-3-5-sonnet-latest', displayName: 'Claude 3.5 Sonnet', tier: 'legacy' },
  { id: 'claude-3-5-haiku-latest', displayName: 'Claude 3.5 Haiku', tier: 'legacy' },
  { id: 'claude-3-opus-latest', displayName: 'Claude 3 Opus', tier: 'legacy' }
]

export const CODEX_MODELS: ModelOption[] = [
  { id: 'gpt-5-codex', displayName: 'GPT-5 Codex', tier: 'current' },
  { id: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', tier: 'current' },
  { id: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', tier: 'current' },
  { id: 'gpt-5.1-codex', displayName: 'GPT-5.1 Codex', tier: 'current' },
  { id: 'gpt-5.1-codex-max', displayName: 'GPT-5.1 Codex Max', tier: 'current' },
  { id: 'gpt-5.1-codex-mini', displayName: 'GPT-5.1 Codex Mini', tier: 'current' },
  { id: 'gpt-5.4', displayName: 'GPT-5.4', tier: 'current' },
  { id: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini', tier: 'current' },
  { id: 'gpt-5.4-nano', displayName: 'GPT-5.4 Nano', tier: 'current' },
  { id: 'o3', displayName: 'o3', tier: 'legacy' },
  { id: 'o4-mini', displayName: 'o4-mini', tier: 'legacy' },
  { id: 'gpt-4.1', displayName: 'GPT-4.1', tier: 'legacy' },
  { id: 'gpt-4.1-mini', displayName: 'GPT-4.1 Mini', tier: 'legacy' },
]

export function getAgentInfo(kind: AgentKind): AgentInfo {
  return AGENT_REGISTRY.find((a) => a.kind === kind) ?? AGENT_REGISTRY[0]
}

export function agentDisplayName(kind: AgentKind | undefined): string {
  if (!kind) return AGENT_REGISTRY[0].displayName
  return getAgentInfo(kind).displayName
}

export function getNextAgentKind(defaultAgent: AgentKind): AgentKind {
  const idx = AGENT_REGISTRY.findIndex((a) => a.kind === defaultAgent)
  const nextIdx = (idx + 1) % AGENT_REGISTRY.length
  return AGENT_REGISTRY[nextIdx].kind
}

export function cycleAltAgent(defaultAgent: AgentKind, clickCount: number): AgentKind {
  const altAgents = AGENT_REGISTRY.filter((a) => a.kind !== defaultAgent)
  if (altAgents.length === 0) return defaultAgent
  return altAgents[clickCount % altAgents.length].kind
}

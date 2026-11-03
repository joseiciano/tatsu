import { fileURLToPath } from 'node:url'
import {
  AGENT_REGISTRY,
  CLAUDE_MODELS,
  CODEX_MODELS,
  agentDisplayName,
  cycleAltAgent,
  getAgentInfo,
  getNextAgentKind,
  isHarnessConfigCapabilityEnabled,
  resourcePathForName,
  templateOutputFor,
  type HarnessConfigResourceType
} from '../../../src/shared/agent-registry'
import type { AgentKind } from '../../../src/shared/state/terminals'
import type { Recorder } from './types'

export interface AgentRegistryCase {
  name: string
  fn:
    | 'registry'
    | 'getAgentInfo'
    | 'agentDisplayName'
    | 'isHarnessConfigCapabilityEnabled'
    | 'resourcePathForName'
    | 'templateOutputFor'
    | 'getNextAgentKind'
    | 'cycleAltAgent'
  kind?: AgentKind
  resourceType?: HarnessConfigResourceType
  resourceName?: string
  clickCount?: number
  expected?: unknown
}

function capabilityOf(kind: AgentKind, resourceType: HarnessConfigResourceType) {
  const capability = getAgentInfo(kind).configCapabilities.find((entry) => entry.resourceType === resourceType)
  if (!capability) throw new Error(`no ${resourceType} capability for ${kind}`)
  return capability
}

function required<T>(value: T | undefined, field: string, name: string): T {
  if (value === undefined) throw new Error(`${name}: missing ${field}`)
  return value
}

function recordAgentRegistry({ name, fn, kind, resourceType, resourceName, clickCount }: AgentRegistryCase): unknown {
  switch (fn) {
    case 'registry':
      return { agentRegistry: AGENT_REGISTRY, claudeModels: CLAUDE_MODELS, codexModels: CODEX_MODELS }
    case 'getAgentInfo':
      return getAgentInfo(required(kind, 'kind', name))
    case 'agentDisplayName':
      return agentDisplayName(kind)
    case 'isHarnessConfigCapabilityEnabled':
      return isHarnessConfigCapabilityEnabled(
        capabilityOf(required(kind, 'kind', name), required(resourceType, 'resourceType', name))
      )
    case 'resourcePathForName':
      return resourcePathForName(
        required(kind, 'kind', name),
        required(resourceType, 'resourceType', name),
        required(resourceName, 'resourceName', name)
      )
    case 'templateOutputFor':
      return templateOutputFor(required(kind, 'kind', name), required(resourceType, 'resourceType', name))
    case 'getNextAgentKind':
      return getNextAgentKind(required(kind, 'kind', name))
    case 'cycleAltAgent':
      return cycleAltAgent(required(kind, 'kind', name), required(clickCount, 'clickCount', name))
  }
}

export const agentRegistryRecorder: Recorder<AgentRegistryCase, unknown> = {
  path: fileURLToPath(new URL('../../../fixtures/core/helpers/agent-registry.json', import.meta.url)),
  record: (fixture) => JSON.parse(JSON.stringify(recordAgentRegistry(fixture))) as unknown,
  recordedOf: ({ expected }) => expected,
  withRecorded: ({ expected: _old, ...fixture }, expected) => ({ ...fixture, expected })
}

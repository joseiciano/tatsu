import { describe, it, expect } from 'vitest'
import {
  AGENT_REGISTRY,
  cycleAltAgent,
  getAgentInfo,
  getNextAgentKind,
  isHarnessConfigCapabilityEnabled,
  type AgentConfigCapability,
  type HarnessConfigCapabilityStatus,
  type HarnessConfigResourceType
} from '.'

type RegistryAgentKind = 'claude' | 'codex' | 'opencode' | 'pi'

type ExpectedCapability = {
  resourceType: HarnessConfigResourceType
  status: HarnessConfigCapabilityStatus
  label: string
  notes?: string
  aliasResourceTypes?: readonly HarnessConfigResourceType[]
}
const unsupportedCapabilityWithAlias = {
  resourceType: 'commands',
  status: 'unsupported',
  label: 'Commands',
  notes: 'unsupported',
  aliasResourceTypes: ['skills']
} as const
// @ts-expect-error Unsupported capabilities cannot carry aliases.
const unsupportedCapability: AgentConfigCapability = unsupportedCapabilityWithAlias

const unknownCapabilityWithAlias = {
  resourceType: 'agents',
  status: 'unknown',
  label: 'Agents',
  notes: 'unknown',
  aliasResourceTypes: ['skills']
} as const
// @ts-expect-error Unknown capabilities cannot carry aliases.
const unknownCapability: AgentConfigCapability = unknownCapabilityWithAlias

const expectedAgentCapabilities: readonly {
  kind: RegistryAgentKind
  capabilities: readonly ExpectedCapability[]
}[] = [
  {
    kind: 'claude',
    capabilities: [
      { resourceType: 'agents', status: 'supported', label: 'Agents' },
      {
        resourceType: 'skills',
        status: 'supported',
        label: 'Skills',
        notes: 'Claude skills also appear in the Commands view as the same physical resource.',
        aliasResourceTypes: ['commands']
      },
      {
        resourceType: 'commands',
        status: 'supported',
        label: 'Commands',
        notes: 'Includes native Claude commands and aliases of Claude skills.'
      }
    ]
  },
  {
    kind: 'codex',
    capabilities: [
      { resourceType: 'agents', status: 'supported', label: 'Agents' },
      { resourceType: 'skills', status: 'supported', label: 'Skills' },
      {
        resourceType: 'commands',
        status: 'unsupported',
        label: 'Commands',
        notes: 'Tatsu has no verified first-version custom-command filesystem contract.'
      }
    ]
  },
  {
    kind: 'opencode',
    capabilities: [
      { resourceType: 'agents', status: 'supported', label: 'Agents' },
      { resourceType: 'skills', status: 'supported', label: 'Skills' },
      { resourceType: 'commands', status: 'supported', label: 'Commands' }
    ]
  },
  {
    kind: 'pi',
    capabilities: [
      {
        resourceType: 'agents',
        status: 'unknown',
        label: 'Agents',
        notes: 'Pi config management is deferred; its resource capabilities and layouts are not yet specified.'
      },
      {
        resourceType: 'skills',
        status: 'unknown',
        label: 'Skills',
        notes: 'Pi config management is deferred; its resource capabilities and layouts are not yet specified.'
      },
      {
        resourceType: 'commands',
        status: 'unknown',
        label: 'Commands',
        notes: 'Pi config management is deferred; its resource capabilities and layouts are not yet specified.'
      }
    ]
  }
]

const piDeferredNote =
  'Pi config management is deferred; its resource capabilities and layouts are not yet specified.'

describe('harness config capability metadata', () => {
  it('publishes the complete ordered capability matrix for every agent', () => {
    expect(AGENT_REGISTRY).toHaveLength(4)
    expect(AGENT_REGISTRY.map(({ kind }) => kind)).toEqual(['claude', 'codex', 'opencode', 'pi'])

    for (const { kind, capabilities } of expectedAgentCapabilities) {
      const info = getAgentInfo(kind)

      expect(info.configCapabilities).toHaveLength(3)
      expect(info.configCapabilities.map(({ resourceType }) => resourceType)).toEqual([
        'agents',
        'skills',
        'commands'
      ])
      expect(info.configCapabilities).toEqual(capabilities)
    }
  })

  it('preserves Claude skill alias metadata and independently supported commands', () => {
    const claude = getAgentInfo('claude')
    const skills = claude.configCapabilities.find(({ resourceType }) => resourceType === 'skills')
    const commands = claude.configCapabilities.find(({ resourceType }) => resourceType === 'commands')

    expect(skills).toEqual({
      resourceType: 'skills',
      status: 'supported',
      label: 'Skills',
      notes: 'Claude skills also appear in the Commands view as the same physical resource.',
      aliasResourceTypes: ['commands']
    })
    expect(commands).toEqual({
      resourceType: 'commands',
      status: 'supported',
      label: 'Commands',
      notes: 'Includes native Claude commands and aliases of Claude skills.'
    })
    expect(commands).not.toHaveProperty('aliasResourceTypes')
  })

  it('rejects self-aliases and keeps aliases absent for other agents', () => {
    for (const agent of AGENT_REGISTRY) {
      for (const capability of agent.configCapabilities) {
        expect(('aliasResourceTypes' in capability ? capability.aliasResourceTypes : []) ?? []).not.toContain(
          capability.resourceType
        )
      }
    }

    for (const kind of ['codex', 'opencode', 'pi'] as const) {
      for (const capability of getAgentInfo(kind).configCapabilities) {
        expect(capability).not.toHaveProperty('aliasResourceTypes')
      }
    }
  })

  it('enables supported rows and keeps Codex Commands unsupported and disabled', () => {
    const supported = getAgentInfo('claude').configCapabilities[0]
    const codexCommands = getAgentInfo('codex').configCapabilities[2]

    expect(isHarnessConfigCapabilityEnabled(supported)).toBe(true)
    expect(codexCommands).toEqual({
      resourceType: 'commands',
      status: 'unsupported',
      label: 'Commands',
      notes: 'Tatsu has no verified first-version custom-command filesystem contract.'
    })
    expect(isHarnessConfigCapabilityEnabled(codexCommands)).toBe(false)
  })

  it('keeps every Pi capability visible, unknown, disabled, and explicitly deferred', () => {
    const piCapabilities = getAgentInfo('pi').configCapabilities

    expect(piCapabilities).toHaveLength(3)
    expect(piCapabilities.map(({ resourceType }) => resourceType)).toEqual([
      'agents',
      'skills',
      'commands'
    ])
    for (const capability of piCapabilities) {
      expect(capability).toMatchObject({ status: 'unknown', notes: piDeferredNote })
      expect(capability).not.toHaveProperty('aliasResourceTypes')
      expect(isHarnessConfigCapabilityEnabled(capability)).toBe(false)
    }
  })

  const predicateCases: readonly {
    name: string
    capability: AgentConfigCapability
    expected: boolean
  }[] = [
    {
      name: 'status controls supported rows despite label, note, and alias metadata',
      capability: {
        resourceType: 'skills',
        status: 'supported',
        label: 'Disabled',
        notes: 'unsupported',
        aliasResourceTypes: ['commands']
      },
      expected: true
    },
    {
      name: 'status controls unsupported rows despite enabled-looking presentation metadata',
      capability: {
        resourceType: 'commands',
        status: 'unsupported',
        label: 'Enabled',
        notes: 'available'
      },
      expected: false
    },
    {
      name: 'status controls unknown rows despite enabled-looking presentation metadata',
      capability: {
        resourceType: 'agents',
        status: 'unknown',
        label: 'Enabled',
        notes: 'available'
      },
      expected: false
    }
  ]

  it.each(predicateCases)('$name', ({ capability, expected }) => {
    expect(isHarnessConfigCapabilityEnabled(capability)).toBe(expected)
  })
})

describe('getNextAgentKind', () => {
  it('cycles claude -> codex', () => {
    expect(getNextAgentKind('claude')).toBe('codex')
  })

  it('cycles codex -> opencode', () => {
    expect(getNextAgentKind('codex')).toBe('opencode')
  })

  it('cycles opencode -> pi', () => {
    expect(getNextAgentKind('opencode')).toBe('pi')
  })

  it('cycles pi -> claude', () => {
    expect(getNextAgentKind('pi')).toBe('claude')
  })
})

describe('cycleAltAgent', () => {
  it('cycles through non-default agents for claude default', () => {
    expect(cycleAltAgent('claude', 0)).toBe('codex')
    expect(cycleAltAgent('claude', 1)).toBe('opencode')
    expect(cycleAltAgent('claude', 2)).toBe('pi')
    expect(cycleAltAgent('claude', 3)).toBe('codex')
  })

  it('cycles through non-default agents for codex default', () => {
    expect(cycleAltAgent('codex', 0)).toBe('claude')
    expect(cycleAltAgent('codex', 1)).toBe('opencode')
    expect(cycleAltAgent('codex', 2)).toBe('pi')
    expect(cycleAltAgent('codex', 3)).toBe('claude')
  })

  it('cycles through non-default agents for opencode default', () => {
    expect(cycleAltAgent('opencode', 0)).toBe('claude')
    expect(cycleAltAgent('opencode', 1)).toBe('codex')
    expect(cycleAltAgent('opencode', 2)).toBe('pi')
    expect(cycleAltAgent('opencode', 3)).toBe('claude')
  })

  it('cycles through non-default agents for pi default', () => {
    expect(cycleAltAgent('pi', 0)).toBe('claude')
    expect(cycleAltAgent('pi', 1)).toBe('codex')
    expect(cycleAltAgent('pi', 2)).toBe('opencode')
    expect(cycleAltAgent('pi', 3)).toBe('claude')
  })
})

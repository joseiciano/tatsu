import { describe, expect, it } from 'vitest'
import { buildConfigResourceGroups } from './ConfigResourceList'
import type { AgentConfigCapability, AgentInfo } from '../../../shared/agent-registry'
import type {
  HarnessConfigChangedRef,
  HarnessConfigComparison,
  HarnessConfigFileRef,
  HarnessConfigResourceType,
  HarnessConfigState
} from '../../../shared/state/harness-config'
import type { BuildConfigResourceGroupsInput } from './types'

function capability(overrides: Partial<AgentConfigCapability> = {}): AgentConfigCapability {
  return {
    resourceType: 'skills',
    label: 'Skills',
    status: 'supported',
    ...overrides
  } as AgentConfigCapability
}

// Local fixture registry — deliberately independent of the real
// `AGENT_REGISTRY` so this test doesn't silently drift when Step 3's
// capability metadata changes. Mirrors the shape the real registry has
// today: Claude's skills alias into commands, Codex commands are
// unsupported, Opencode supports everything.
const REGISTRY: AgentInfo[] = [
  {
    kind: 'claude',
    displayName: 'Claude Code',
    vendor: 'Anthropic',
    assignsSessionId: true,
    configCapabilities: [
      capability({ resourceType: 'agents' }),
      capability({
        resourceType: 'skills',
        notes: 'Claude skills also appear in Commands.',
        aliasResourceTypes: ['commands']
      }),
      capability({ resourceType: 'commands', notes: 'Includes native commands and skill aliases.' })
    ]
  },
  {
    kind: 'codex',
    displayName: 'Codex',
    vendor: 'OpenAI',
    assignsSessionId: false,
    configCapabilities: [
      capability({ resourceType: 'agents' }),
      capability({ resourceType: 'skills' }),
      capability({
        resourceType: 'commands',
        status: 'unsupported',
        notes: 'Codex has no verified command-file contract yet.'
      })
    ]
  },
  {
    kind: 'opencode',
    displayName: 'Opencode',
    vendor: 'Opencode',
    assignsSessionId: false,
    configCapabilities: [
      capability({ resourceType: 'agents' }),
      capability({ resourceType: 'skills' }),
      capability({ resourceType: 'commands' })
    ]
  }
]

function ref(overrides: Partial<HarnessConfigFileRef> = {}): HarnessConfigFileRef {
  return {
    id: 'ref:claude:skills:one',
    agentKind: 'claude',
    resourceType: 'skills',
    canonicalResourceType: 'skills',
    aliasResourceTypes: [],
    label: 'One',
    relativePath: 'skills/one.md',
    absolutePath: '/workspace/.claude/skills/one.md',
    hash: 'sha256:one',
    existsOnDisk: true,
    managed: true,
    updatedAt: 100,
    ...overrides
  }
}

function changed(
  overrides: { disk?: Partial<HarnessConfigFileRef>; config?: Partial<HarnessConfigFileRef> } = {}
): HarnessConfigChangedRef {
  const disk = ref({ id: 'ref:changed', hash: 'sha256:disk', ...overrides.disk })
  const config = ref({ id: 'ref:changed', hash: 'sha256:config', ...overrides.config })
  return { disk, config }
}

function comparison(overrides: Partial<HarnessConfigComparison> = {}): HarnessConfigComparison {
  return {
    scope: { agentKind: 'claude', resourceType: 'skills' },
    status: 'conflict',
    diskOnly: [],
    configOnly: [],
    changed: [],
    comparedAt: 1,
    ...overrides
  }
}

function baseInput(
  overrides: Partial<BuildConfigResourceGroupsInput> = {}
): BuildConfigResourceGroupsInput {
  return {
    resourceType: 'skills' as HarnessConfigResourceType,
    agentFilter: 'all',
    query: '',
    resources: [],
    comparisons: {} as HarnessConfigState['comparisons'],
    selected: null,
    registry: REGISTRY,
    ...overrides
  }
}

describe('buildConfigResourceGroups', () => {
  it('returns one group per managed harness in registry order', () => {
    const groups = buildConfigResourceGroups(baseInput())
    expect(groups.map((g) => g.agentKind)).toEqual(['claude', 'codex', 'opencode'])
  })

  it('filters groups to the exact selected agent', () => {
    const groups = buildConfigResourceGroups(baseInput({ agentFilter: 'codex' }))
    expect(groups.map((g) => g.agentKind)).toEqual(['codex'])
  })

  it('marks an unsupported capability visible, disabled, with its note', () => {
    const groups = buildConfigResourceGroups(
      baseInput({ resourceType: 'commands', agentFilter: 'codex' })
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].supported).toBe(false)
    expect(groups[0].note).toBe('Codex has no verified command-file contract yet.')
  })

  it('sorts rows by relativePath then id', () => {
    const resources = [
      ref({ id: 'b', relativePath: 'skills/b.md', label: 'B' }),
      ref({ id: 'a2', relativePath: 'skills/a.md', label: 'A2' }),
      ref({ id: 'a1', relativePath: 'skills/a.md', label: 'A1' })
    ]
    const groups = buildConfigResourceGroups(baseInput({ agentFilter: 'claude', resources }))
    const claude = groups.find((g) => g.agentKind === 'claude')!
    expect(claude.rows.map((r) => r.ref.id)).toEqual(['a1', 'a2', 'b'])
  })

  it('matches search case-insensitively against label, relativePath, and absolutePath', () => {
    const resources = [
      ref({ id: 'one', label: 'Deploy Helper', relativePath: 'skills/one.md', absolutePath: '/x/one.md' }),
      ref({ id: 'two', label: 'Other', relativePath: 'skills/DEPLOY-TWO.md', absolutePath: '/x/two.md' }),
      ref({ id: 'three', label: 'Third', relativePath: 'skills/three.md', absolutePath: '/x/DEPLOY-three.md' }),
      ref({ id: 'four', label: 'No match', relativePath: 'skills/four.md', absolutePath: '/x/four.md' })
    ]
    const groups = buildConfigResourceGroups(
      baseInput({ agentFilter: 'claude', resources, query: '  deploy  ' })
    )
    const claude = groups.find((g) => g.agentKind === 'claude')!
    expect(claude.rows.map((r) => r.ref.id).sort()).toEqual(['one', 'three', 'two'])
    // Search narrows rows but not the raw pre-search count.
    expect(claude.totalResourceCount).toBe(4)
  })

  it('shows every group even with zero resources, and search does not change which groups are visible', () => {
    const groups = buildConfigResourceGroups(baseInput({ query: 'nothing matches' }))
    expect(groups.map((g) => g.agentKind)).toEqual(['claude', 'codex', 'opencode'])
    expect(groups.every((g) => g.rows.length === 0)).toBe(true)
  })

  it('merges refs from diskOnly, configOnly, and both sides of changed even when absent from the scan inventory', () => {
    const diskOnlyRef = ref({ id: 'disk-only', relativePath: 'skills/disk-only.md' })
    const configOnlyRef = ref({ id: 'config-only', relativePath: 'skills/config-only.md' })
    const changedPair = changed({
      disk: { relativePath: 'skills/changed.md' },
      config: { relativePath: 'skills/changed.md' }
    })
    const comparisons: HarnessConfigState['comparisons'] = {
      'claude:skills': comparison({
        diskOnly: [diskOnlyRef],
        configOnly: [configOnlyRef],
        changed: [changedPair]
      })
    }
    const groups = buildConfigResourceGroups(
      baseInput({ agentFilter: 'claude', resources: [], comparisons })
    )
    const claude = groups.find((g) => g.agentKind === 'claude')!
    const ids = claude.rows.map((r) => r.ref.id).sort()
    expect(ids).toEqual(['config-only', 'disk-only', 'ref:changed'])
    expect(claude.totalResourceCount).toBe(3)
  })

  it('prefers the disk-backed ref on a same-ID collision with a comparison entry', () => {
    const scannedRef = ref({ id: 'dup', hash: 'sha256:fresh-from-disk', label: 'Fresh' })
    const staleComparisonRef = ref({ id: 'dup', hash: 'sha256:stale', label: 'Stale' })
    const comparisons: HarnessConfigState['comparisons'] = {
      'claude:skills': comparison({ diskOnly: [staleComparisonRef] })
    }
    const groups = buildConfigResourceGroups(
      baseInput({ agentFilter: 'claude', resources: [scannedRef], comparisons })
    )
    const claude = groups.find((g) => g.agentKind === 'claude')!
    expect(claude.rows).toHaveLength(1)
    expect(claude.rows[0].ref.hash).toBe('sha256:fresh-from-disk')
    // Membership in diskOnly still drives the badge even though the
    // disk-backed ref object won the identity collision.
    expect(claude.rows[0].badge).toBe('disk-only')
  })

  it('derives Conflict only for rows in `changed`, leaving unrelated rows Synced under an overall conflict status', () => {
    const untouchedRef = ref({ id: 'untouched', relativePath: 'skills/untouched.md' })
    const changedPair = changed({
      disk: { relativePath: 'skills/changed.md' },
      config: { relativePath: 'skills/changed.md' }
    })
    const comparisons: HarnessConfigState['comparisons'] = {
      'claude:skills': comparison({ status: 'conflict', changed: [changedPair] })
    }
    const groups = buildConfigResourceGroups(
      baseInput({ agentFilter: 'claude', resources: [untouchedRef], comparisons })
    )
    const claude = groups.find((g) => g.agentKind === 'claude')!
    expect(claude.comparisonStatus).toBe('conflict')
    const untouchedRow = claude.rows.find((r) => r.ref.id === 'untouched')!
    const changedRow = claude.rows.find((r) => r.ref.id === 'ref:changed')!
    expect(untouchedRow.badge).toBe('synced')
    expect(changedRow.badge).toBe('conflict')
  })

  it('derives diskOnly/configOnly badges from exact comparison membership', () => {
    const diskOnlyRef = ref({ id: 'd1', relativePath: 'skills/d1.md' })
    const configOnlyRef = ref({ id: 'c1', relativePath: 'skills/c1.md' })
    const comparisons: HarnessConfigState['comparisons'] = {
      'claude:skills': comparison({ diskOnly: [diskOnlyRef], configOnly: [configOnlyRef] })
    }
    const groups = buildConfigResourceGroups(
      baseInput({ agentFilter: 'claude', resources: [], comparisons })
    )
    const claude = groups.find((g) => g.agentKind === 'claude')!
    expect(claude.rows.find((r) => r.ref.id === 'd1')!.badge).toBe('disk-only')
    expect(claude.rows.find((r) => r.ref.id === 'c1')!.badge).toBe('config-only')
  })

  it('retains one stable row for a Claude skill alias appearing in the Commands view', () => {
    const aliasRef = ref({
      id: 'alias:deploy',
      resourceType: 'commands',
      canonicalResourceType: 'skills',
      aliasResourceTypes: [],
      relativePath: 'skills/deploy/SKILL.md',
      label: 'deploy'
    })
    const groups = buildConfigResourceGroups(
      baseInput({ resourceType: 'commands', agentFilter: 'claude', resources: [aliasRef] })
    )
    const claude = groups.find((g) => g.agentKind === 'claude')!
    expect(claude.rows).toHaveLength(1)
    expect(claude.rows[0].ref.id).toBe('alias:deploy')
  })

  it('excludes refs belonging to a different logical resourceType', () => {
    const skillsRef = ref({ id: 'in-scope', resourceType: 'skills' })
    const commandsRef = ref({ id: 'out-of-scope', resourceType: 'commands' })
    const groups = buildConfigResourceGroups(
      baseInput({ resourceType: 'skills', agentFilter: 'claude', resources: [skillsRef, commandsRef] })
    )
    const claude = groups.find((g) => g.agentKind === 'claude')!
    expect(claude.rows.map((r) => r.ref.id)).toEqual(['in-scope'])
  })

  it('marks the selected row when its exact scope and id match', () => {
    const resources = [ref({ id: 'pick-me' }), ref({ id: 'not-me', relativePath: 'skills/not-me.md' })]
    const groups = buildConfigResourceGroups(
      baseInput({
        agentFilter: 'claude',
        resources,
        selected: { scope: { agentKind: 'claude', resourceType: 'skills' }, id: 'pick-me' }
      })
    )
    const claude = groups.find((g) => g.agentKind === 'claude')!
    expect(claude.rows.find((r) => r.ref.id === 'pick-me')!.selected).toBe(true)
    expect(claude.rows.find((r) => r.ref.id === 'not-me')!.selected).toBe(false)
  })

  it('disables every row in an unsupported group', () => {
    const resources = [ref({ id: 'x', agentKind: 'codex', resourceType: 'commands' })]
    const groups = buildConfigResourceGroups(
      baseInput({ resourceType: 'commands', agentFilter: 'codex', resources })
    )
    const codex = groups.find((g) => g.agentKind === 'codex')!
    expect(codex.rows.every((r) => r.disabled)).toBe(true)
  })

  describe('conversion action derivation (TEST-008)', () => {
    it('offers Create command on a Skills-tab row when the destination capability is supported', () => {
      const resources = [ref({ id: 'one', agentKind: 'claude', resourceType: 'skills' })]
      const groups = buildConfigResourceGroups(
        baseInput({ resourceType: 'skills', agentFilter: 'claude', resources })
      )
      const row = groups.find((g) => g.agentKind === 'claude')!.rows[0]
      expect(row.conversionAction).toEqual({
        targetResourceType: 'commands',
        label: 'Create command',
        disabled: false,
        disabledReason: null
      })
    })

    it('offers Create skill on a Commands-tab row', () => {
      const resources = [ref({ id: 'one', agentKind: 'opencode', resourceType: 'commands' })]
      const groups = buildConfigResourceGroups(
        baseInput({ resourceType: 'commands', agentFilter: 'opencode', resources })
      )
      const row = groups.find((g) => g.agentKind === 'opencode')!.rows[0]
      expect(row.conversionAction?.targetResourceType).toBe('skills')
      expect(row.conversionAction?.label).toBe('Create skill')
      expect(row.conversionAction?.disabled).toBe(false)
    })

    it('disables the conversion action with an accessible reason when the destination capability is unsupported', () => {
      const resources = [ref({ id: 'one', agentKind: 'codex', resourceType: 'skills' })]
      const groups = buildConfigResourceGroups(
        baseInput({ resourceType: 'skills', agentFilter: 'codex', resources })
      )
      const row = groups.find((g) => g.agentKind === 'codex')!.rows[0]
      expect(row.conversionAction).toEqual({
        targetResourceType: 'commands',
        label: 'Create command',
        disabled: true,
        disabledReason: 'Codex has no verified command-file contract yet.'
      })
    })

    it('disables the conversion action with an accessible reason for a config-only row', () => {
      const resources = [ref({ id: 'one', agentKind: 'claude', resourceType: 'skills', existsOnDisk: false })]
      const groups = buildConfigResourceGroups(
        baseInput({ resourceType: 'skills', agentFilter: 'claude', resources })
      )
      const row = groups.find((g) => g.agentKind === 'claude')!.rows[0]
      expect(row.conversionAction?.disabled).toBe(true)
      expect(row.conversionAction?.disabledReason).toBe(
        'This resource exists only in Tatsu config, not on disk.'
      )
    })

    it('offers no conversion action on the Agents tab', () => {
      const resources = [ref({ id: 'one', agentKind: 'claude', resourceType: 'agents' })]
      const groups = buildConfigResourceGroups(
        baseInput({ resourceType: 'agents', agentFilter: 'claude', resources })
      )
      const row = groups.find((g) => g.agentKind === 'claude')!.rows[0]
      expect(row.conversionAction).toBeNull()
    })
  })
})

import { Plus, RefreshCw } from 'lucide-react'
import { AgentIcon } from '../AgentIcon'
import {
  harnessConfigScopeKey,
  type HarnessConfigFileRef,
  type HarnessConfigScope
} from '../../../shared/state/harness-config'
import { isHarnessConfigCapabilityEnabled } from '../../../shared/agent-registry'
import type {
  BuildConfigResourceGroupsInput,
  ConfigDriftBadge,
  ConfigResourceGroup,
  ConfigResourceListProps,
  ConfigResourceRow
} from './types'

function compareRows(a: ConfigResourceRow, b: ConfigResourceRow): number {
  if (a.ref.relativePath < b.ref.relativePath) return -1
  if (a.ref.relativePath > b.ref.relativePath) return 1
  if (a.ref.id < b.ref.id) return -1
  if (a.ref.id > b.ref.id) return 1
  return 0
}

function matchesQuery(ref: HarnessConfigFileRef, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true
  const haystack = `${ref.label}\u0000${ref.relativePath}\u0000${ref.absolutePath}`.toLowerCase()
  return haystack.includes(normalizedQuery)
}

/** Deterministic, pure derivation of the resource rail's groups and
 *  rows. No backend calls, no store reads — everything it needs is
 *  passed in, which is what makes it unit-testable without React or
 *  Vitest DOM mocking (TEST-001/TEST-002). */
export function buildConfigResourceGroups(
  input: BuildConfigResourceGroupsInput
): ConfigResourceGroup[] {
  const { resourceType, agentFilter, query, resources, comparisons, selected, registry } = input
  const normalizedQuery = query.trim().toLowerCase()
  const groups: ConfigResourceGroup[] = []

  for (const agent of registry) {
    const agentKind = agent.kind as ConfigResourceGroup['agentKind']
    if (agentFilter !== 'all' && agentFilter !== agentKind) continue

    const capability = agent.configCapabilities.find((c) => c.resourceType === resourceType)
    if (!capability) continue

    const scope: HarnessConfigScope = { agentKind, resourceType }
    const scopeKey = harnessConfigScopeKey(scope)
    const comparison = comparisons[scopeKey] ?? null

    // Union disk-backed refs with every public ref from the latest
    // comparison's three difference collections (REQ-013). Disk-backed
    // refs are inserted first so they win the same-ID dedup below.
    const byId = new Map<string, HarnessConfigFileRef>()
    const changedIds = new Set<string>()
    const diskOnlyIds = new Set<string>()
    const configOnlyIds = new Set<string>()

    for (const ref of resources) {
      if (ref.agentKind !== agentKind || ref.resourceType !== resourceType) continue
      byId.set(ref.id, ref)
    }

    if (comparison) {
      for (const ref of comparison.diskOnly) {
        if (ref.agentKind !== agentKind || ref.resourceType !== resourceType) continue
        diskOnlyIds.add(ref.id)
        if (!byId.has(ref.id)) byId.set(ref.id, ref)
      }
      for (const ref of comparison.configOnly) {
        if (ref.agentKind !== agentKind || ref.resourceType !== resourceType) continue
        configOnlyIds.add(ref.id)
        if (!byId.has(ref.id)) byId.set(ref.id, ref)
      }
      for (const entry of comparison.changed) {
        const diskRef = entry.disk
        if (diskRef.agentKind !== agentKind || diskRef.resourceType !== resourceType) continue
        changedIds.add(diskRef.id)
        if (!byId.has(diskRef.id)) byId.set(diskRef.id, diskRef)
      }
    }

    const supported = isHarnessConfigCapabilityEnabled(capability)
    const totalResourceCount = byId.size

    const rows: ConfigResourceRow[] = []
    for (const ref of byId.values()) {
      if (!matchesQuery(ref, normalizedQuery)) continue
      let badge: ConfigDriftBadge = 'synced'
      if (changedIds.has(ref.id)) badge = 'conflict'
      else if (diskOnlyIds.has(ref.id)) badge = 'disk-only'
      else if (configOnlyIds.has(ref.id)) badge = 'config-only'

      rows.push({
        key: `${ref.agentKind}:${ref.id}`,
        ref,
        badge,
        selected:
          !!selected &&
          selected.scope.agentKind === agentKind &&
          selected.scope.resourceType === resourceType &&
          selected.id === ref.id,
        disabled: !supported
      })
    }
    rows.sort(compareRows)

    groups.push({
      agentKind,
      displayName: agent.displayName,
      scope,
      scopeKey,
      capability,
      supported,
      note: capability.status === 'supported' ? capability.notes ?? null : capability.notes,
      comparisonStatus: comparison?.status ?? null,
      rows,
      totalResourceCount,
      busy: false,
      requestError: null,
      notice: null
    })
  }

  return groups
}

const BADGE_LABEL: Record<ConfigDriftBadge, string> = {
  synced: 'Synced',
  'disk-only': 'Disk only',
  'config-only': 'Config only',
  conflict: 'Conflict'
}

const BADGE_CLASS: Record<ConfigDriftBadge, string> = {
  synced: 'text-success',
  'disk-only': 'text-warning',
  'config-only': 'text-info',
  conflict: 'text-danger'
}

function DriftBadge({ badge }: { badge: ConfigDriftBadge }): JSX.Element {
  return <span className={`text-xs shrink-0 ${BADGE_CLASS[badge]}`}>{BADGE_LABEL[badge]}</span>
}

function ResourceRow({
  row,
  onSelect
}: {
  row: ConfigResourceRow
  onSelect: (scope: HarnessConfigScope, id: string) => void
}): JSX.Element {
  const scope: HarnessConfigScope = { agentKind: row.ref.agentKind, resourceType: row.ref.resourceType }
  return (
    <button
      type="button"
      disabled={row.disabled}
      aria-current={row.selected ? 'true' : undefined}
      onClick={() => onSelect(scope, row.ref.id)}
      className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-left cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        row.selected ? 'bg-surface text-fg-bright' : 'hover:bg-surface-hover text-fg'
      }`}
    >
      <span className="flex-1 min-w-0">
        <span className="block text-xs truncate">{row.ref.label}</span>
        <span className="block text-xs text-faint truncate">{row.ref.relativePath}</span>
      </span>
      <DriftBadge badge={row.badge} />
    </button>
  )
}

function GroupHeader({
  group,
  onCreate,
  onSync
}: {
  group: ConfigResourceGroup
  onCreate: (scope: HarnessConfigScope) => void
  onSync: (scope: HarnessConfigScope) => void
}): JSX.Element {
  const disabled = !group.supported || group.busy
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1.5">
      <AgentIcon kind={group.agentKind} className="icon-sm" />
      <span className="text-xs font-medium text-fg-bright flex-1 min-w-0 truncate">
        {group.displayName}
      </span>
      {group.comparisonStatus === 'conflict' && (
        <span className="text-xs text-danger shrink-0">Conflict</span>
      )}
      <button
        type="button"
        disabled={disabled}
        title="Scope sync preview"
        aria-label={`Sync ${group.displayName}`}
        onClick={() => onSync(group.scope)}
        className="p-1 rounded text-dim hover:text-fg-bright hover:bg-surface-hover cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <RefreshCw className="icon-xs" />
      </button>
      <button
        type="button"
        disabled={disabled}
        title="Create"
        aria-label={`Create in ${group.displayName}`}
        onClick={() => onCreate(group.scope)}
        className="p-1 rounded text-dim hover:text-fg-bright hover:bg-surface-hover cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <Plus className="icon-xs" />
      </button>
    </div>
  )
}

export function ConfigResourceList({
  groups,
  searchActive,
  sharedError,
  onSelectResource,
  onCreate,
  onSync
}: ConfigResourceListProps): JSX.Element {
  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {sharedError && (
        <div className="px-2.5 py-2 text-xs text-danger border-b border-border">{sharedError}</div>
      )}
      {groups.map((group) => (
        <div key={group.agentKind} className="border-b border-border/60">
          <GroupHeader group={group} onCreate={onCreate} onSync={onSync} />
          {group.notice && (
            <div className="px-2.5 pb-1.5 text-xs text-success">{group.notice}</div>
          )}
          {group.requestError && (
            <div className="px-2.5 pb-1.5 text-xs text-danger">{group.requestError}</div>
          )}
          {!group.supported && group.note && (
            <div className="px-2.5 pb-1.5 text-xs text-faint">{group.note}</div>
          )}
          <div className="flex flex-col gap-0.5 px-1 pb-1.5">
            {group.rows.map((row) => (
              <ResourceRow key={row.key} row={row} onSelect={onSelectResource} />
            ))}
            {group.supported && group.totalResourceCount === 0 && !searchActive && (
              <div className="px-1.5 py-2 flex flex-col gap-1.5">
                <span className="text-xs text-faint">No resources yet</span>
                <button
                  type="button"
                  onClick={() => onCreate(group.scope)}
                  className="self-start text-xs text-accent hover:text-fg-bright cursor-pointer"
                >
                  Create
                </button>
              </div>
            )}
            {group.totalResourceCount > 0 && group.rows.length === 0 && searchActive && (
              <div className="px-1.5 py-2 text-xs text-faint">No matching resources</div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

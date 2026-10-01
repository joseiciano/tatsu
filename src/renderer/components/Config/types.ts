import type {
  HarnessConfigComparison,
  HarnessConfigFileRef,
  HarnessConfigResourceType,
  HarnessConfigScope,
  HarnessConfigScopeKey,
  HarnessConfigState,
  ManagedHarnessKind
} from '../../../shared/state/harness-config'
import type { AgentConfigCapability, AgentInfo } from '../../../shared/agent-registry'

/** Public contract for the Config page shell. Step 8 mounts this
 *  component as a per-client overlay and owns navigation/visibility. */
export interface ConfigProps {
  onClose: () => void
}

/** Agent-filter scope. `all` shows every managed harness group;
 *  anything else narrows the rail to one harness. Never `pi` — Pi has
 *  no `ManagedHarnessKind` scope in the first implementation. */
export type ConfigAgentFilter = 'all' | ManagedHarnessKind

export type ConfigEditorMode = 'empty' | 'create' | 'edit'

export type ConfigDriftBadge = 'synced' | 'disk-only' | 'config-only' | 'conflict'

/** Exact identity of the resource the page is reading/editing. Both
 *  fields travel together everywhere a request is made so a stale
 *  read/mutation can never be applied to the wrong scope. */
export interface ConfigSelection {
  scope: HarnessConfigScope
  id: string
}

/** One render-ready row in the resource rail. Wraps the shared ref
 *  rather than restating its fields so the presentational list never
 *  drifts from the domain contract. */
export interface ConfigResourceRow {
  /** Stable React key — `${agentKind}:${id}`. */
  key: string
  ref: HarnessConfigFileRef
  badge: ConfigDriftBadge
  selected: boolean
  disabled: boolean
}

/** One harness's section of the resource rail for the active tab. */
export interface ConfigResourceGroup {
  agentKind: ManagedHarnessKind
  displayName: string
  scope: HarnessConfigScope
  scopeKey: HarnessConfigScopeKey
  capability: AgentConfigCapability
  supported: boolean
  /** Non-empty explanatory note for an unsupported/unknown capability;
   *  the optional note Step 3 attaches to a supported one otherwise. */
  note: string | null
  comparisonStatus: HarnessConfigComparison['status'] | null
  rows: ConfigResourceRow[]
  /** Count of deduplicated resources before search filtering — used to
   *  tell "no resources yet" apart from "search matched nothing". */
  totalResourceCount: number
  /** Attached by `Config.tsx` after derivation — `buildConfigResourceGroups`
   *  itself has no notion of in-flight requests. */
  busy: boolean
  requestError: string | null
  /** Transient "Synced" success notice after an explicit Sync click
   *  resolves with no drift (REQ-027). */
  notice: string | null
}

export interface ConfigTabDefinition {
  id: HarnessConfigResourceType
  label: string
}

export interface ConfigAgentFilterOption {
  id: ConfigAgentFilter
  label: string
}

export interface ConfigTabsProps {
  onClose: () => void
  tabs: readonly ConfigTabDefinition[]
  activeTab: HarnessConfigResourceType
  onTabChange: (tab: HarnessConfigResourceType) => void
  agentFilterOptions: readonly ConfigAgentFilterOption[]
  agentFilter: ConfigAgentFilter
  onAgentFilterChange: (filter: ConfigAgentFilter) => void
  searchQuery: string
  onSearchChange: (value: string) => void
}

export interface ConfigResourceListProps {
  groups: readonly ConfigResourceGroup[]
  searchActive: boolean
  sharedError: string | null
  onSelectResource: (scope: HarnessConfigScope, id: string) => void
  onCreate: (scope: HarnessConfigScope) => void
  onSync: (scope: HarnessConfigScope) => void
}

/** Discriminated editor view. Each variant carries exactly the data
 *  that view needs — `ConfigEditor` never has to re-derive capability
 *  or selection state from loose booleans. */
export type ConfigEditorView =
  | { kind: 'empty' }
  | { kind: 'loading' }
  | { kind: 'unsupported'; scope: HarnessConfigScope; agentDisplayName: string; note: string }
  | {
      kind: 'config-only'
      scope: HarnessConfigScope
      agentDisplayName: string
      ref: HarnessConfigFileRef
      badge: ConfigDriftBadge
    }
  | { kind: 'create'; scope: HarnessConfigScope; agentDisplayName: string }
  | {
      kind: 'edit'
      scope: HarnessConfigScope
      agentDisplayName: string
      ref: HarnessConfigFileRef
      badge: ConfigDriftBadge
    }

export interface ConfigEditorProps {
  view: ConfigEditorView
  draft: string
  onDraftChange: (value: string) => void
  nameDraft: string
  onNameDraftChange: (value: string) => void
  dirty: boolean
  busy: boolean
  canSave: boolean
  canCreate: boolean
  canDelete: boolean
  error: string | null
  fontFamily?: string
  fontSize?: number
  onSave: () => void
  onCreate: () => void
  onDelete: () => void
  onCancel: () => void
  onReset: () => void
}

export interface ConfigSyncDialogProps {
  open: boolean
  comparison: HarnessConfigComparison | null
  agentDisplayName: string
  resourceLabel: string
  onClose: () => void
}

/** Input to the pure list-derivation helper. Everything here is either
 *  a primitive, a shared domain object, or the managed-harness slice
 *  of the registry — no renderer/backend handles. */
export interface BuildConfigResourceGroupsInput {
  resourceType: HarnessConfigResourceType
  agentFilter: ConfigAgentFilter
  query: string
  resources: readonly HarnessConfigFileRef[]
  comparisons: HarnessConfigState['comparisons']
  selected: ConfigSelection | null
  registry: readonly AgentInfo[]
}

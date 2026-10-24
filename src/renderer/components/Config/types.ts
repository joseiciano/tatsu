import type {
  HarnessConfigComparison,
  HarnessConfigFileRef,
  HarnessConfigFragmentResolution,
  HarnessConfigResourceType,
  HarnessConfigScope,
  HarnessConfigScopeKey,
  HarnessConfigState,
  HarnessConfigSyncStatus,
  HarnessFragment,
  HarnessTemplate,
  HarnessTemplateKind,
  HarnessTemplateParseError,
  HarnessTemplateReference,
  ManagedHarnessKind
} from '../../../shared/state/harness-config'
import type { RenderedResource } from '../../../shared/harness-template-render'
import type { AgentConfigCapability, AgentInfo } from '../../../shared/agent-registry'
import type { AgentKind } from '../../../shared/state/terminals'

/** Public contract for the Config page shell. Step 8 mounts this
 *  component as a per-client overlay and owns navigation/visibility. */
export interface ConfigProps {
  onClose: () => void
  onOpenConfigFolders?: () => void
}

/** Agent-filter scope. `all` shows every managed harness group;
 *  anything else narrows the rail to one harness. Never `pi` — Pi has
 *  no `ManagedHarnessKind` scope in the first implementation. */
export type ConfigAgentFilter = 'all' | ManagedHarnessKind

export type ConfigEditorMode = 'empty' | 'create' | 'edit'

/** REQ-015: the generation source line shown above a conversion draft
 *  ("Generated from <agent> <resourceType> <relativePath>"). Renderer-
 *  local only — never entered into `AppState` (REQ-018). */
export interface ConfigConversionSourceInfo {
  agentKind: ManagedHarnessKind
  sourceResourceType: HarnessConfigResourceType
  relativePath: string
}

/** Pure, render-ready projection of a `HarnessConfigConversionResult`
 *  (TASK-011). `already-available` carries the exact notice text and
 *  relative path (REQ-014); `draft` carries everything conversion
 *  create mode needs to pre-fill (REQ-015). */
export type ConfigConversionOutcome =
  | { kind: 'already-available'; message: string; relativePath: string }
  | {
      kind: 'draft'
      scope: HarnessConfigScope
      name: string
      content: string
      source: ConfigConversionSourceInfo
    }

export type ConfigDriftBadge = 'synced' | 'disk-only' | 'config-only' | 'conflict'

/** Exact identity of the resource the page is reading/editing. Both
 *  fields travel together everywhere a request is made so a stale
 *  read/mutation can never be applied to the wrong scope. */
export interface ConfigSelection {
  scope: HarnessConfigScope
  id: string
}

/** REQ-013: one row's conversion action — `Create command` on a
 *  Skills-tab row, `Create skill` on a Commands-tab row. `disabled`
 *  covers an unsupported destination capability, a config-only row
 *  (`existsOnDisk: false`), and (overlaid by `Config.tsx`) a
 *  conversion request already in flight for this row; `disabledReason`
 *  is always non-null alongside `disabled` so the control stays
 *  accessible. */
export interface ConfigRowConversionAction {
  targetResourceType: Extract<HarnessConfigResourceType, 'skills' | 'commands'>
  label: 'Create command' | 'Create skill'
  disabled: boolean
  disabledReason: string | null
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
  /** `null` on the Agents tab — conversion exists only between Skills
   *  and Commands (REQ-013). */
  conversionAction: ConfigRowConversionAction | null
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

/** A Config page view: one of the three resource tabs, or the
 *  Templates view (Step 21), which has no single resource type. */
export type ConfigViewId = HarnessConfigResourceType | 'templates'

export interface ConfigViewTabDefinition {
  id: ConfigViewId
  label: string
}

export interface ConfigTabsProps {
  onClose: () => void
  tabs: readonly ConfigViewTabDefinition[]
  activeTab: ConfigViewId
  onTabChange: (tab: ConfigViewId) => void
  /** False in the Templates view, which is not split by harness. */
  showAgentFilter?: boolean
  agentFilterOptions: readonly ConfigAgentFilterOption[]
  agentFilter: ConfigAgentFilter
  onAgentFilterChange: (filter: ConfigAgentFilter) => void
  searchQuery: string
  onSearchChange: (value: string) => void
}

/** A harness whose config management is explicitly deferred (Step 1
 *  REQ-005). Display-only: it has no scope, no rows, and no actions, so
 *  nothing derived from it can reach scan, compare, or any mutation. */
export interface ConfigDeferredHarness {
  agentKind: AgentKind
  displayName: string
  note: string
}

export interface ConfigResourceListProps {
  groups: readonly ConfigResourceGroup[]
  deferredHarnesses: readonly ConfigDeferredHarness[]
  searchActive: boolean
  sharedError: string | null
  onSelectResource: (scope: HarnessConfigScope, id: string) => void
  onCreate: (scope: HarnessConfigScope) => void
  onSync: (scope: HarnessConfigScope) => void
  /** REQ-014: the only caller of `prepareHarnessConfigCommandFromSkill` —
   *  invoked exclusively by a row's own `Create command` click. */
  onCreateCommand: (scope: HarnessConfigScope, id: string) => void
  /** REQ-014: the only caller of `prepareHarnessConfigSkillFromCommand` —
   *  invoked exclusively by a row's own `Create skill` click. */
  onCreateSkill: (scope: HarnessConfigScope, id: string) => void
  /** Step 21: opens the template a row was rendered from. */
  onEditTemplate?: (templateRef: string) => void
  onOpenConfigFolders?: () => void
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
  | {
      kind: 'create'
      scope: HarnessConfigScope
      agentDisplayName: string
      /** REQ-015: overrides the generic "Create" submit label when this
       *  create mode was entered from a conversion draft. */
      submitLabel?: string
      /** REQ-015: the destination-scope label plus generation source
       *  line shown above the editor for a conversion draft. */
      conversionSource?: ConfigConversionSourceInfo
    }
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
  canEdit: boolean
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

// --- Step 9: scoped sync conflict review/apply contracts ---

export type ConfigSyncStage = 'idle' | 'planning' | 'applying'

export type ConfigSyncFreshPlanDecision = 'already-synced' | 'review-refreshed-plan' | 'apply-fresh-plan'

/** One render-ready file row inside a conflict section. Wraps the
 *  shared `HarnessConfigFileRef` rather than restating its fields
 *  (REQ-006/REQ-007). */
export interface ConfigSyncFileRow {
  /** Stable React key. */
  key: string
  ref: HarnessConfigFileRef
  sourceLabel: 'Disk' | 'Tatsu config' | 'Template'
  updatedAtLabel: string
  /** `sha256:<first 12 chars>` — the default visual label (REQ-007). */
  hashShortLabel: string
  /** Complete `sha256:<hash>` — used only in `title`/accessible-label. */
  hashFullLabel: string
}

/** One content-changed pair: the disk side and the Tatsu config side of
 *  the same logical resource, rendered as two explicitly labeled sides
 *  of one row (REQ-008). */
export interface ConfigSyncChangedRow {
  key: string
  disk: ConfigSyncFileRow
  config: ConfigSyncFileRow
}

export interface ConfigSyncReviewSections {
  diskOnly: ConfigSyncFileRow[]
  configOnly: ConfigSyncFileRow[]
  changed: ConfigSyncChangedRow[]
  /** Stored entries hidden by template output at the same path (Step 20). */
  shadowed: ConfigSyncFileRow[]
  renderErrors: ConfigSyncRenderErrorRow[]
  fragmentErrors: ConfigSyncFragmentErrorRow[]
  fragmentEdits: ConfigSyncFragmentEditRow[]
}

/** A stored file whose fragment placeholders cannot expand. Its disk
 *  copy, when there is one, is held instead of synced or deleted. */
export interface ConfigSyncFragmentErrorRow {
  key: string
  label: string
  relativePath: string
  message: string
  held: ConfigSyncFileRow | null
}

/** A stored file with hand-edited fragment sections to resolve. */
export interface ConfigSyncFragmentEditRow {
  key: string
  id: string
  label: string
  relativePath: string
  fragments: string[]
}

/** A template that failed to render, with its earlier disk output that
 *  sync leaves in place (Step 20 REQ-007). */
export interface ConfigSyncRenderErrorRow {
  key: string
  templateRef: string
  message: string
  held: ConfigSyncFileRow[]
}

/** Renderer-local, non-authorizing projection of either a returned
 *  `HarnessConfigComparison` or the discarded public comparison data of
 *  a `HarnessConfigSyncPlan`. Carries no `planId`, `direction`, or
 *  `fingerprint` — see REQ-011/REQ-013/SEC-001. `reviewKey` is the
 *  `configSyncReviewKey` of the underlying comparison/plan and is what
 *  a fresh plan is checked against before it may be applied. */
export interface ConfigSyncReview {
  scope: HarnessConfigScope
  scopeKey: HarnessConfigScopeKey
  status: HarnessConfigSyncStatus
  sections: ConfigSyncReviewSections
  reviewKey: string
  timestampLabel: string
}

export interface ConfigSyncDialogProps {
  open: boolean
  review: ConfigSyncReview | null
  agentDisplayName: string
  resourceLabel: string
  stage: ConfigSyncStage
  /** False once a consumed plan's recovery comparison has itself failed
   *  (REQ-017) — the displayed review can no longer be trusted to drive
   *  another apply until the user cancels and starts Sync again. */
  reviewUsable: boolean
  actionError: string | null
  actionNotice: string | null
  /** Template-built ids the user chose to detach on adopt (REQ-006). */
  detachIds: ReadonlySet<string>
  onDetachChange: (id: string, detach: boolean) => void
  onResolveFragmentEdit: (id: string, fragment: string, resolution: HarnessConfigFragmentResolution) => void
  onSyncToDisk: () => void
  onAdoptFromDisk: () => void
  onCancel: () => void
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

// --- Step 21: template and fragment editing ---

export interface ConfigTemplateHarnessDraft {
  enabled: boolean
  /** The block was written as `false`; a disabled harness keeps that on save. */
  excluded: boolean
  /** YAML for this harness's native frontmatter. `name` and `fragments`
   *  here override the template's for this harness only. */
  frontmatterText: string
}

/** Renderer-local editing copy of a template (REQ-008). */
export interface ConfigTemplateDraft {
  kind: HarnessTemplateKind
  name: string
  description: string
  fragments: string[]
  body: string
  harnesses: Record<ManagedHarnessKind, ConfigTemplateHarnessDraft>
  references: HarnessTemplateReference[]
}

export interface ConfigTemplateHarnessAvailability {
  displayName: string
  valid: boolean
  /** Capability-metadata reason when `valid` is false. */
  reason: string | null
}

export interface ConfigTemplatePreview {
  resource: RenderedResource | null
  errors: string[]
}

export type ConfigTemplateSelection =
  | { type: 'template'; kind: HarnessTemplateKind; name: string }
  | { type: 'fragment'; name: string }

/** The open file changed or vanished in the source folder since it was
 *  opened (Step 18 RISK-001). */
export type ConfigTemplateOutsideChange = 'changed' | 'removed' | null

export interface ConfigTemplatesProps {
  /** `<kind>/<name>` to open on mount, from a row's "Edit template". */
  initialTemplateRef: string | null
  searchQuery: string
  onDirtyChange: (dirty: boolean) => void
  onImport: () => void
  fontFamily?: string
  fontSize?: number
}

export interface ConfigImportWizardProps {
  onClose: () => void
  onReviewScope: (scope: HarnessConfigScope) => void
  onDirtyChange: (dirty: boolean) => void
  fontFamily?: string
  fontSize?: number
}

export interface ConfigTemplateListProps {
  templates: readonly HarnessTemplate[]
  fragments: readonly HarnessFragment[]
  parseErrors: readonly HarnessTemplateParseError[]
  searchActive: boolean
  selection: ConfigTemplateSelection | null
  onSelectTemplate: (kind: HarnessTemplateKind, name: string) => void
  onSelectFragment: (name: string) => void
  onCreateTemplate: (kind: HarnessTemplateKind) => void
  onCreateFragment: () => void
  onImport: () => void
}

export interface ConfigTemplateEditorProps {
  mode: 'create' | 'edit'
  draft: ConfigTemplateDraft
  onDraftChange: (draft: ConfigTemplateDraft) => void
  availability: Record<ManagedHarnessKind, ConfigTemplateHarnessAvailability>
  blockErrors: Partial<Record<ManagedHarnessKind, string>>
  problems: readonly string[]
  fragmentNames: readonly string[]
  previewHarness: ManagedHarnessKind | null
  onPreviewHarnessChange: (harness: ManagedHarnessKind) => void
  preview: ConfigTemplatePreview
  dirty: boolean
  busy: boolean
  error: string | null
  notice: string | null
  outsideChange: ConfigTemplateOutsideChange
  fontFamily?: string
  fontSize?: number
  onSave: () => void
  onDelete: () => void
  onReset: () => void
  onCancel: () => void
}

export interface ConfigFragmentEditorProps {
  mode: 'create' | 'edit'
  name: string
  onNameChange: (name: string) => void
  content: string
  onContentChange: (content: string) => void
  /** `<kind>/<name>` of every template that uses this fragment. */
  usedBy: readonly string[]
  /** `<harness> <path>` of every stored file that uses this fragment. */
  usedByFiles: readonly string[]
  dirty: boolean
  busy: boolean
  error: string | null
  notice: string | null
  outsideChange: ConfigTemplateOutsideChange
  fontFamily?: string
  fontSize?: number
  onSave: () => void
  onDelete: () => void
  onReset: () => void
  onCancel: () => void
}

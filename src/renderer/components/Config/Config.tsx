import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useBackend } from '../../backend'
import { useActiveBackend, useHarnessConfig, useSettings } from '../../store'
import { getAgentInfo, isHarnessConfigCapabilityEnabled, type AgentInfo } from '../../../shared/agent-registry'
import {
  harnessConfigScopeKey,
  type HarnessConfigFileRef,
  type HarnessConfigResourceType,
  type HarnessConfigScope,
  type HarnessConfigScopeKey,
  type HarnessConfigSyncDirection,
  type ManagedHarnessKind
} from '../../../shared/state/harness-config'
import { ConfigTabs } from './ConfigTabs'
import { ConfigResourceList, buildConfigResourceGroups } from './ConfigResourceList'
import { ConfigEditor } from './ConfigEditor'
import { ConfigSyncDialog } from './ConfigSyncDialog'
import { decideFreshPlanOutcome, toConfigSyncReview } from './config-sync-review'
import { deriveConfigConversionOutcome } from './config-conversion'
import type {
  ConfigAgentFilter,
  ConfigAgentFilterOption,
  ConfigConversionSourceInfo,
  ConfigDriftBadge,
  ConfigEditorView,
  ConfigProps,
  ConfigResourceGroup,
  ConfigSelection,
  ConfigSyncReview,
  ConfigSyncStage,
  ConfigTabDefinition
} from './types'

const TABS: readonly ConfigTabDefinition[] = [
  { id: 'agents', label: 'Agents' },
  { id: 'skills', label: 'Skills' },
  { id: 'commands', label: 'Commands' }
]

const AGENT_FILTER_OPTIONS: readonly ConfigAgentFilterOption[] = [
  { id: 'all', label: 'All' },
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'Opencode' }
]

const MANAGED_KINDS: readonly ManagedHarnessKind[] = ['claude', 'codex', 'opencode']
const MANAGED_REGISTRY: readonly AgentInfo[] = MANAGED_KINDS.map((kind) => getAgentInfo(kind))

interface ScopeStatus {
  busy: boolean
  error: string | null
  notice: string | null
}

function isScopeSupported(scope: HarnessConfigScope): boolean {
  const capability = getAgentInfo(scope.agentKind).configCapabilities.find(
    (c) => c.resourceType === scope.resourceType
  )
  return !!capability && isHarnessConfigCapabilityEnabled(capability)
}

/** Every logical scope a mutation on `ref` can affect — its canonical
 *  view plus every alias view Step 3 declares for it (REQ-024). Falls
 *  back to the requested scope's own resource type when no ref is
 *  available yet (e.g. a delete whose pre-mutation ref vanished). */
function affectedResourceTypes(
  scope: HarnessConfigScope,
  ref: HarnessConfigFileRef | null
): HarnessConfigResourceType[] {
  if (!ref) return [scope.resourceType]
  return [...new Set([ref.canonicalResourceType, ...ref.aliasResourceTypes, scope.resourceType])]
}

function findBadge(
  groups: readonly ConfigResourceGroup[],
  agentKind: ManagedHarnessKind,
  id: string
): ConfigDriftBadge {
  for (const group of groups) {
    if (group.agentKind !== agentKind) continue
    const row = group.rows.find((r) => r.ref.id === id)
    if (row) return row.badge
  }
  return 'synced'
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  if (target.closest('.monaco-editor')) return true
  return false
}

export function Config({ onClose }: ConfigProps): JSX.Element {
  const backend = useBackend()
  const harnessConfig = useHarnessConfig()
  const settings = useSettings()
  const activeBackend = useActiveBackend()

  const [activeTab, setActiveTab] = useState<HarnessConfigResourceType>('agents')
  const [agentFilter, setAgentFilter] = useState<ConfigAgentFilter>('all')
  const [searchQuery, setSearchQuery] = useState('')

  const [selected, setSelected] = useState<ConfigSelection | null>(null)
  const [selectedRef, setSelectedRef] = useState<HarnessConfigFileRef | null>(null)
  const [editorMode, setEditorMode] = useState<'empty' | 'create' | 'edit'>('empty')
  const [createScope, setCreateScope] = useState<HarnessConfigScope | null>(null)
  const [createName, setCreateName] = useState('')

  const [draft, setDraft] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [readBusy, setReadBusy] = useState(false)
  const [mutationBusy, setMutationBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  // Step 10: conversion create mode is the Step 7 create flow pre-filled
  // from a `draft` conversion result — these two fields are renderer-
  // local only (REQ-018) and reset alongside every other create-mode
  // field. `conversionPending` is the per-row in-flight guard overlaid
  // onto rows in `displayGroups` below (REQ-013/REQ-014).
  const [conversionSubmitLabel, setConversionSubmitLabel] = useState<string | null>(null)
  const [conversionSource, setConversionSource] = useState<ConfigConversionSourceInfo | null>(null)
  const [conversionPending, setConversionPending] = useState<ReadonlySet<string>>(new Set())
  const conversionPendingRef = useRef<Set<string>>(new Set())

  const [scopeStatus, setScopeStatusState] = useState<
    Partial<Record<HarnessConfigScopeKey, ScopeStatus>>
  >({})

  const [dialogOpen, setDialogOpen] = useState(false)
  // Step 9: the displayed review is a non-authorizing projection of
  // either a `HarnessConfigComparison` or a discarded plan's public
  // comparison data (REQ-011/REQ-013) — never the plan itself, which is
  // kept only in the request-scoped closure that generated it (TASK-007).
  const [dialogReview, setDialogReview] = useState<ConfigSyncReview | null>(null)
  const [dialogStage, setDialogStage] = useState<ConfigSyncStage>('idle')
  const [dialogActionError, setDialogActionError] = useState<string | null>(null)
  const [dialogActionNotice, setDialogActionNotice] = useState<string | null>(null)
  const [dialogReviewUsable, setDialogReviewUsable] = useState(true)

  // Session bookkeeping — plain refs so they never themselves trigger a
  // render; every async chain captures these at call time and re-checks
  // them after every await (REQ-009, RISK-004).
  const backendGenerationRef = useRef(0)
  const activeBackendIdRef = useRef(activeBackend.id)
  const readTokenRef = useRef(0)
  const scannedRef = useRef<Map<string, Set<HarnessConfigScopeKey>>>(new Map())
  const pendingScanRef = useRef<Map<string, Set<HarnessConfigScopeKey>>>(new Map())
  const syncNoticeTimeoutsRef = useRef<Map<HarnessConfigScopeKey, number>>(new Map())
  // Bumped on every dialog open/replace/dismiss/backend-switch so an
  // in-flight planner/apply continuation can tell it's been superseded
  // (REQ-021, TASK-012).
  const dialogTokenRef = useRef(0)
  // Mirrors the scope key of whatever dialog is currently open (or null
  // when none is), updated synchronously alongside dialogOpen/dialogReview.
  // A `useCallback` closure only ever sees the `dialogReview` value from
  // the render that created it, so a slower comparison response can't rely
  // on that state to detect a *different* dialog opened by a faster
  // request in the meantime; this ref always reflects the live value
  // (REQ-021, TASK-007 "current dialog identity").
  const openDialogScopeKeyRef = useRef<HarnessConfigScopeKey | null>(null)

  const clearSyncNoticeTimeouts = useCallback(() => {
    for (const timeoutId of syncNoticeTimeoutsRef.current.values()) {
      window.clearTimeout(timeoutId)
    }
    syncNoticeTimeoutsRef.current.clear()
  }, [])

  useEffect(() => clearSyncNoticeTimeouts, [clearSyncNoticeTimeouts])

  const [dialogAgentName, setDialogAgentName] = useState('')
  const [dialogResourceLabel, setDialogResourceLabel] = useState('')

  const setScopeStatus = useCallback((key: HarnessConfigScopeKey, patch: Partial<ScopeStatus>) => {
    setScopeStatusState((prev) => ({
      ...prev,
      [key]: {
        busy: prev[key]?.busy ?? false,
        error: prev[key]?.error ?? null,
        notice: prev[key]?.notice ?? null,
        ...patch
      }
    }))
  }, [])

  const resetPageLocalState = useCallback(() => {
    setSelected(null)
    setSelectedRef(null)
    setEditorMode('empty')
    setCreateScope(null)
    setCreateName('')
    setDraft('')
    setSavedContent('')
    setReadBusy(false)
    setMutationBusy(false)
    setActionError(null)
    setConversionSubmitLabel(null)
    setConversionSource(null)
    conversionPendingRef.current = new Set()
    setConversionPending(new Set())
    setScopeStatusState({})
    dialogTokenRef.current += 1
    openDialogScopeKeyRef.current = null
    setDialogOpen(false)
    setDialogReview(null)
    setDialogStage('idle')
    setDialogActionError(null)
    setDialogActionNotice(null)
    setDialogReviewUsable(true)
  }, [])

  // REQ-009: an active-backend switch invalidates every page-local
  // chain immediately — bump the generation first so anything still in
  // flight under the old generation is ignored when it resolves, then
  // clear local state (including the per-session scanned-scope
  // bookkeeping, so a backend revisited later in the same page session
  // is scanned again rather than treated as already-scanned) and let
  // the scan effect below load the new backend's scopes from scratch.
  useEffect(() => {
    if (activeBackendIdRef.current === activeBackend.id) return
    activeBackendIdRef.current = activeBackend.id
    backendGenerationRef.current += 1
    scannedRef.current = new Map()
    pendingScanRef.current = new Map()
    clearSyncNoticeTimeouts()
    resetPageLocalState()
  }, [activeBackend.id, resetPageLocalState, clearSyncNoticeTimeouts])

  const isDirty =
    editorMode === 'edit'
      ? draft !== savedContent
      : editorMode === 'create'
        ? createName.trim().length > 0 || draft.length > 0
        : false

  const confirmDiscard = useCallback((): boolean => {
    if (!isDirty) return true
    return window.confirm('Discard unsaved changes in the Config editor?')
  }, [isDirty])

  // ---- Scanning (REQ-010) ----

  const runScopeScan = useCallback(
    async (scope: HarnessConfigScope, backendId: string, generation: number) => {
      const key = harnessConfigScopeKey(scope)
      setScopeStatus(key, { busy: true, error: null })
      try {
        const scanResult = await backend.scanHarnessConfig({ scope })
        if (activeBackendIdRef.current !== backendId || backendGenerationRef.current !== generation) return
        if (!scanResult.ok) {
          setScopeStatus(key, { busy: false, error: scanResult.error.message })
          return
        }
        const cmpResult = await backend.compareHarnessConfig({ scope })
        if (activeBackendIdRef.current !== backendId || backendGenerationRef.current !== generation) return
        if (!cmpResult.ok) {
          setScopeStatus(key, { busy: false, error: cmpResult.error.message })
          return
        }
        setScopeStatus(key, { busy: false, error: null })
      } finally {
        const scannedSet = scannedRef.current.get(backendId) ?? new Set<HarnessConfigScopeKey>()
        scannedSet.add(key)
        scannedRef.current.set(backendId, scannedSet)
        pendingScanRef.current.get(backendId)?.delete(key)
      }
    },
    [backend, setScopeStatus]
  )

  useEffect(() => {
    const backendId = activeBackend.id
    const generation = backendGenerationRef.current
    const agentsToVisit = agentFilter === 'all' ? MANAGED_KINDS : [agentFilter]
    for (const agentKind of agentsToVisit) {
      const scope: HarnessConfigScope = { agentKind, resourceType: activeTab }
      if (!isScopeSupported(scope)) continue
      const key = harnessConfigScopeKey(scope)
      const scannedSet = scannedRef.current.get(backendId) ?? new Set<HarnessConfigScopeKey>()
      const pendingSet = pendingScanRef.current.get(backendId) ?? new Set<HarnessConfigScopeKey>()
      if (scannedSet.has(key) || pendingSet.has(key)) continue
      pendingSet.add(key)
      pendingScanRef.current.set(backendId, pendingSet)
      void runScopeScan(scope, backendId, generation)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, agentFilter, activeBackend.id, runScopeScan])

  const refreshComparisons = useCallback(
    async (
      agentKind: ManagedHarnessKind,
      resourceTypes: readonly HarnessConfigResourceType[],
      backendId: string,
      generation: number
    ) => {
      for (const resourceType of resourceTypes) {
        const scope: HarnessConfigScope = { agentKind, resourceType }
        const key = harnessConfigScopeKey(scope)
        const result = await backend.compareHarnessConfig({ scope })
        if (activeBackendIdRef.current !== backendId || backendGenerationRef.current !== generation) return
        setScopeStatus(key, { error: result.ok ? null : result.error.message })
      }
    },
    [backend, setScopeStatus]
  )

  // ---- Derived resource groups ----

  const searchActive = searchQuery.trim().length > 0

  const groupsNoSearch = useMemo(
    () =>
      buildConfigResourceGroups({
        resourceType: activeTab,
        agentFilter,
        query: '',
        resources: harnessConfig.resources[activeTab],
        comparisons: harnessConfig.comparisons,
        selected,
        registry: MANAGED_REGISTRY
      }),
    [activeTab, agentFilter, harnessConfig.resources, harnessConfig.comparisons, selected]
  )

  const baseGroups = useMemo(
    () =>
      searchActive
        ? buildConfigResourceGroups({
            resourceType: activeTab,
            agentFilter,
            query: searchQuery,
            resources: harnessConfig.resources[activeTab],
            comparisons: harnessConfig.comparisons,
            selected,
            registry: MANAGED_REGISTRY
          })
        : groupsNoSearch,
    [searchActive, searchQuery, activeTab, agentFilter, harnessConfig.resources, harnessConfig.comparisons, selected, groupsNoSearch]
  )

  const displayGroups: ConfigResourceGroup[] = useMemo(
    () =>
      baseGroups.map((group) => {
        const status = scopeStatus[group.scopeKey]
        return {
          ...group,
          busy: !!status?.busy,
          requestError: status?.error ?? null,
          notice: status?.notice ?? null,
          // Step 10: overlay the in-flight guard onto each row's pure
          // conversion action — the pure derivation in
          // `buildConfigResourceGroups` has no notion of a request
          // already in progress.
          rows: group.rows.map((row) => {
            if (!row.conversionAction) return row
            const pendingKey = `${row.ref.agentKind}:${row.ref.resourceType}:${row.ref.id}`
            if (!conversionPending.has(pendingKey)) return row
            return {
              ...row,
              conversionAction: {
                ...row.conversionAction,
                disabled: true,
                disabledReason: 'A conversion request is already in progress.'
              }
            }
          })
        }
      }),
    [baseGroups, scopeStatus, conversionPending]
  )

  // REQ-010/TASK-010: when the mirrored inventory no longer contains the
  // selected disk ref (and it isn't surfaced by the latest comparison
  // either), clear the selection rather than attempt to read/mutate a
  // ref that's gone.
  useEffect(() => {
    if (!selected) return
    const diskList = harnessConfig.resources[selected.scope.resourceType]
    const existsOnDisk = diskList.some(
      (r) => r.agentKind === selected.scope.agentKind && r.id === selected.id
    )
    if (existsOnDisk) return
    const comparison = harnessConfig.comparisons[harnessConfigScopeKey(selected.scope)]
    const existsInComparison =
      !!comparison &&
      (comparison.configOnly.some((r) => r.id === selected.id) ||
        comparison.diskOnly.some((r) => r.id === selected.id) ||
        comparison.changed.some((c) => c.disk.id === selected.id))
    if (existsInComparison) return
    setSelected(null)
    setSelectedRef(null)
    setEditorMode('empty')
    setDraft('')
    setSavedContent('')
    setReadBusy(false)
  }, [harnessConfig.resources, harnessConfig.comparisons, selected])

  // ---- Tab / filter / search transitions (REQ-025) ----

  const clearSelectionAndEditor = useCallback(() => {
    setSelected(null)
    setSelectedRef(null)
    setEditorMode('empty')
    setCreateScope(null)
    setCreateName('')
    setDraft('')
    setSavedContent('')
    setActionError(null)
    setConversionSubmitLabel(null)
    setConversionSource(null)
  }, [])

  const handleTabChange = useCallback(
    (tab: HarnessConfigResourceType) => {
      if (tab === activeTab) return
      if (!confirmDiscard()) return
      setActiveTab(tab)
      clearSelectionAndEditor()
    },
    [activeTab, confirmDiscard, clearSelectionAndEditor]
  )

  const handleAgentFilterChange = useCallback(
    (filter: ConfigAgentFilter) => {
      if (filter === agentFilter) return
      const staysVisible = filter === 'all' || !selected || selected.scope.agentKind === filter
      if (!staysVisible && !confirmDiscard()) return
      setAgentFilter(filter)
      if (!staysVisible) clearSelectionAndEditor()
    },
    [agentFilter, selected, confirmDiscard, clearSelectionAndEditor]
  )

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value)
  }, [])

  // ---- Selection / read (REQ-016, REQ-017) ----

  const handleSelectResource = useCallback(
    (scope: HarnessConfigScope, id: string) => {
      if (
        selected &&
        selected.scope.agentKind === scope.agentKind &&
        selected.scope.resourceType === scope.resourceType &&
        selected.id === id
      ) {
        return
      }
      if (!confirmDiscard()) return

      const group = groupsNoSearch.find((g) => g.agentKind === scope.agentKind)
      const row = group?.rows.find((r) => r.ref.id === id)
      if (!row) return
      const ref = row.ref

      setActionError(null)
      setCreateScope(null)
      setCreateName('')
      setSelected({ scope, id })
      setSelectedRef(ref)
      setEditorMode('edit')

      if (!ref.existsOnDisk) {
        setDraft('')
        setSavedContent('')
        setReadBusy(false)
        return
      }

      setReadBusy(true)
      setDraft('')
      setSavedContent('')

      const token = ++readTokenRef.current
      const backendId = activeBackend.id
      const generation = backendGenerationRef.current

      void (async () => {
        const result = await backend.readHarnessConfigFile({ scope, id })
        if (
          activeBackendIdRef.current !== backendId ||
          backendGenerationRef.current !== generation ||
          readTokenRef.current !== token
        ) {
          return
        }
        if (!result.ok) {
          setReadBusy(false)
          setActionError(result.error.message)
          return
        }
        setSelectedRef(result.value.ref)
        setDraft(result.value.content)
        setSavedContent(result.value.content)
        setReadBusy(false)
      })()
    },
    [selected, confirmDiscard, groupsNoSearch, backend, activeBackend.id]
  )

  // ---- Create ----

  const handleEnterCreate = useCallback(
    (scope: HarnessConfigScope) => {
      if (!confirmDiscard()) return
      setSelected(null)
      setSelectedRef(null)
      setCreateScope(scope)
      setCreateName('')
      setDraft('')
      setSavedContent('')
      setEditorMode('create')
      setActionError(null)
      setConversionSubmitLabel(null)
      setConversionSource(null)
    },
    [confirmDiscard]
  )

  const handleCancelCreate = useCallback(() => {
    setCreateScope(null)
    setCreateName('')
    setDraft('')
    setEditorMode('empty')
    setActionError(null)
    setConversionSubmitLabel(null)
    setConversionSource(null)
  }, [])

  const handleSubmitCreate = useCallback(async () => {
    if (!createScope || mutationBusy) return
    const name = createName.trim()
    if (!name) {
      setActionError('Enter a name before creating.')
      return
    }

    setMutationBusy(true)
    setActionError(null)
    const backendId = activeBackend.id
    const generation = backendGenerationRef.current
    const scope = createScope
    const content = draft
    const scopeKey = harnessConfigScopeKey(scope)
    setScopeStatus(scopeKey, { busy: true })

    try {
      const prepareResult = await backend.prepareHarnessConfigCreate({ scope, name, content })
      if (activeBackendIdRef.current !== backendId || backendGenerationRef.current !== generation) return
      if (!prepareResult.ok) {
        setActionError(prepareResult.error.message)
        return
      }
      const applyResult = await backend.createHarnessConfigFile({
        scope,
        planId: prepareResult.value.planId,
        confirmed: true
      })
      if (activeBackendIdRef.current !== backendId || backendGenerationRef.current !== generation) return
      if (!applyResult.ok) {
        setActionError(applyResult.error.message)
        return
      }

      const createdId = applyResult.value.applied.find((op) => op.type === 'create')?.id
      const resultingRef = createdId
        ? (applyResult.value.resultingRefs.find((ref) => ref.id === createdId) ?? null)
        : null

      setCreateScope(null)
      setCreateName('')
      setConversionSubmitLabel(null)
      setConversionSource(null)

      if (resultingRef) {
        setSelected({ scope, id: resultingRef.id })
        setSelectedRef(resultingRef)
        setEditorMode('edit')
        setDraft(content)
        setSavedContent(content)
      } else {
        setDraft('')
        setSavedContent('')
        setEditorMode('empty')
      }

      await refreshComparisons(scope.agentKind, affectedResourceTypes(scope, resultingRef), backendId, generation)
    } finally {
      if (activeBackendIdRef.current === backendId && backendGenerationRef.current === generation) {
        setMutationBusy(false)
        setScopeStatus(scopeKey, { busy: false })
      }
    }
  }, [createScope, createName, draft, mutationBusy, activeBackend.id, backend, refreshComparisons, setScopeStatus])

  // ---- Conversion (Step 10) ----

  // REQ-014: the *only* two callers of the conversion prepare channels.
  // Nothing else — mount, tab/filter change, scan, Tatsu-config refresh,
  // sync/adopt, conflict completion, plugin metadata — may invoke this.
  // An `alias`/`existing` result is a pure notice with zero mutation
  // (REQ-017); a `draft` result enters the existing create flow without
  // ever applying itself (REQ-015/REQ-016).
  const handleConvert = useCallback(
    (target: 'commands' | 'skills', scope: HarnessConfigScope, id: string) => {
      const pendingKey = `${scope.agentKind}:${scope.resourceType}:${id}`
      if (conversionPendingRef.current.has(pendingKey)) return
      conversionPendingRef.current.add(pendingKey)
      setConversionPending(new Set(conversionPendingRef.current))

      const backendId = activeBackend.id
      const generation = backendGenerationRef.current
      const scopeKey = harnessConfigScopeKey(scope)
      const destinationNoun = target === 'commands' ? 'command' : 'skill'

      void (async () => {
        const result =
          target === 'commands'
            ? await backend.prepareHarnessConfigCommandFromSkill({ scope, id })
            : await backend.prepareHarnessConfigSkillFromCommand({ scope, id })

        conversionPendingRef.current.delete(pendingKey)
        const stillCurrent = activeBackendIdRef.current === backendId && backendGenerationRef.current === generation
        setConversionPending(new Set(conversionPendingRef.current))
        if (!stillCurrent) return

        if (!result.ok) {
          setScopeStatus(scopeKey, { error: result.error.message })
          return
        }

        const outcome = deriveConfigConversionOutcome(result.value, destinationNoun)
        if (outcome.kind === 'already-available') {
          setScopeStatus(scopeKey, { notice: outcome.message, error: null })
          return
        }

        if (!confirmDiscard()) return
        setSelected(null)
        setSelectedRef(null)
        setCreateScope(outcome.scope)
        setCreateName(outcome.name)
        setDraft(outcome.content)
        setSavedContent('')
        setEditorMode('create')
        setActionError(null)
        setConversionSubmitLabel(target === 'commands' ? 'Create command' : 'Create skill')
        setConversionSource(outcome.source)
      })()
    },
    [activeBackend.id, backend, confirmDiscard, setScopeStatus]
  )

  const handleCreateCommand = useCallback(
    (scope: HarnessConfigScope, id: string) => handleConvert('commands', scope, id),
    [handleConvert]
  )
  const handleCreateSkill = useCallback(
    (scope: HarnessConfigScope, id: string) => handleConvert('skills', scope, id),
    [handleConvert]
  )

  // ---- Update (save) ----

  const handleSave = useCallback(async () => {
    if (!selected || !selectedRef || mutationBusy) return
    if (draft === savedContent) return
    const confirmed = window.confirm(
      `Save changes to "${selectedRef.relativePath}"?\n\nTatsu creates a backup of the existing file before overwriting it.`
    )
    if (!confirmed) return

    setMutationBusy(true)
    setActionError(null)
    const backendId = activeBackend.id
    const generation = backendGenerationRef.current
    const scope = selected.scope
    const id = selected.id
    const content = draft
    const preMutationRef = selectedRef
    const scopeKey = harnessConfigScopeKey(scope)
    setScopeStatus(scopeKey, { busy: true })

    try {
      const prepareResult = await backend.prepareHarnessConfigUpdate({ scope, id, content })
      if (activeBackendIdRef.current !== backendId || backendGenerationRef.current !== generation) return
      if (!prepareResult.ok) {
        setActionError(prepareResult.error.message)
        return
      }
      const applyResult = await backend.updateHarnessConfigFile({
        scope,
        planId: prepareResult.value.planId,
        confirmed: true
      })
      if (activeBackendIdRef.current !== backendId || backendGenerationRef.current !== generation) return
      if (!applyResult.ok) {
        setActionError(applyResult.error.message)
        return
      }

      const readResult = await backend.readHarnessConfigFile({ scope, id })
      if (activeBackendIdRef.current !== backendId || backendGenerationRef.current !== generation) return
      if (readResult.ok) {
        setSelectedRef(readResult.value.ref)
        setDraft(readResult.value.content)
        setSavedContent(readResult.value.content)
      } else {
        // The write already succeeded — fall back to treating the content we
        // just wrote as the new saved baseline so the editor doesn't stay
        // stuck "dirty", and surface the re-read failure so it isn't silent.
        setSavedContent(content)
        setActionError(`Saved, but failed to refresh the file: ${readResult.error.message}`)
      }

      await refreshComparisons(
        scope.agentKind,
        affectedResourceTypes(scope, preMutationRef),
        backendId,
        generation
      )
    } finally {
      if (activeBackendIdRef.current === backendId && backendGenerationRef.current === generation) {
        setMutationBusy(false)
        setScopeStatus(scopeKey, { busy: false })
      }
    }
  }, [selected, selectedRef, draft, savedContent, mutationBusy, activeBackend.id, backend, refreshComparisons, setScopeStatus])

  // ---- Delete ----

  const handleDelete = useCallback(async () => {
    if (!selected || !selectedRef || mutationBusy) return
    const confirmed = window.confirm(
      `Delete "${selectedRef.relativePath}"?\n\nTatsu creates a backup before removing it.`
    )
    if (!confirmed) return

    setMutationBusy(true)
    setActionError(null)
    const backendId = activeBackend.id
    const generation = backendGenerationRef.current
    const scope = selected.scope
    const id = selected.id
    const preMutationRef = selectedRef
    const scopeKey = harnessConfigScopeKey(scope)
    setScopeStatus(scopeKey, { busy: true })

    try {
      const prepareResult = await backend.prepareHarnessConfigDelete({ scope, id })
      if (activeBackendIdRef.current !== backendId || backendGenerationRef.current !== generation) return
      if (!prepareResult.ok) {
        setActionError(prepareResult.error.message)
        return
      }
      const applyResult = await backend.deleteHarnessConfigFile({
        scope,
        planId: prepareResult.value.planId,
        confirmed: true
      })
      if (activeBackendIdRef.current !== backendId || backendGenerationRef.current !== generation) return
      if (!applyResult.ok) {
        setActionError(applyResult.error.message)
        return
      }

      setSelected(null)
      setSelectedRef(null)
      setEditorMode('empty')
      setDraft('')
      setSavedContent('')

      await refreshComparisons(
        scope.agentKind,
        affectedResourceTypes(scope, preMutationRef),
        backendId,
        generation
      )
    } finally {
      if (activeBackendIdRef.current === backendId && backendGenerationRef.current === generation) {
        setMutationBusy(false)
        setScopeStatus(scopeKey, { busy: false })
      }
    }
  }, [selected, selectedRef, mutationBusy, activeBackend.id, backend, refreshComparisons, setScopeStatus])

  const handleResetDraft = useCallback(() => setDraft(savedContent), [savedContent])

  // ---- Sync preview + scoped conflict review/apply (Step 9) ----

  // Shared by the already-synced path and a successful apply — both
  // report a transient scope-level notice rather than mutating any
  // group/row data optimistically (REQ-019, ALT-007).
  const showScopeNotice = useCallback(
    (key: HarnessConfigScopeKey, notice: string, backendId: string, generation: number) => {
      setScopeStatus(key, { notice, error: null })
      const existingTimeout = syncNoticeTimeoutsRef.current.get(key)
      if (existingTimeout !== undefined) window.clearTimeout(existingTimeout)
      const timeoutId = window.setTimeout(() => {
        syncNoticeTimeoutsRef.current.delete(key)
        if (activeBackendIdRef.current !== backendId || backendGenerationRef.current !== generation) return
        setScopeStatus(key, { notice: null })
      }, 2500)
      syncNoticeTimeoutsRef.current.set(key, timeoutId)
    },
    [setScopeStatus]
  )

  // REQ-020/TASK-012: the single no-op dismissal path for Cancel, the
  // close icon, Escape, and backdrop. Bumps the dialog token *before*
  // clearing state so a planning continuation still in flight sees a
  // stale token when it resumes and aborts without applying. Applying
  // can't be dismissed — the renderer can't cancel an in-progress
  // main-process mutation (REQ-020) — so this is a no-op while
  // `dialogStage === 'applying'`.
  const closeDialog = useCallback(() => {
    dialogTokenRef.current += 1
    openDialogScopeKeyRef.current = null
    setDialogOpen(false)
    setDialogReview(null)
    setDialogStage('idle')
    setDialogActionError(null)
    setDialogActionNotice(null)
    setDialogReviewUsable(true)
  }, [])

  const handleDialogCancel = useCallback(() => {
    if (dialogStage === 'applying') return
    closeDialog()
  }, [dialogStage, closeDialog])

  const handleSync = useCallback(
    (scope: HarnessConfigScope) => {
      const backendId = activeBackend.id
      const generation = backendGenerationRef.current
      const key = harnessConfigScopeKey(scope)
      setScopeStatus(key, { busy: true, error: null, notice: null })
      void (async () => {
        const result = await backend.compareHarnessConfig({ scope })
        if (activeBackendIdRef.current !== backendId || backendGenerationRef.current !== generation) return
        if (!result.ok) {
          setScopeStatus(key, { busy: false, error: result.error.message })
          return
        }
        setScopeStatus(key, { busy: false, error: null })
        if (result.value.status === 'synced') {
          if (dialogReview?.scopeKey === key) closeDialog()
          showScopeNotice(key, 'Already in sync', backendId, generation)
          return
        }
        // REQ-021: don't clobber a dialog the user may be actively
        // reviewing (or already mid-outcome on) for a *different* scope —
        // only this scope's own dialog may be opened/replaced here. Check
        // the live ref, not `dialogReview` state, since this closure's
        // `dialogReview` is frozen to whatever it was when this async call
        // started and can't see a dialog a faster concurrent Sync opened
        // since.
        if (openDialogScopeKeyRef.current !== null && openDialogScopeKeyRef.current !== key) {
          showScopeNotice(key, 'Close the current sync review to compare this scope', backendId, generation)
          return
        }
        dialogTokenRef.current += 1
        openDialogScopeKeyRef.current = key
        setDialogAgentName(getAgentInfo(scope.agentKind).displayName)
        setDialogResourceLabel(TABS.find((t) => t.id === scope.resourceType)?.label ?? scope.resourceType)
        setDialogReview(toConfigSyncReview(result.value))
        setDialogStage('idle')
        setDialogActionError(null)
        setDialogActionNotice(null)
        setDialogReviewUsable(true)
        setDialogOpen(true)
      })()
    },
    [activeBackend.id, backend, setScopeStatus, dialogReview, closeDialog, showScopeNotice]
  )

  // TASK-009/TASK-010/TASK-011: one outcome-dispatching handler for both
  // mutation buttons. Every identity/token check in REQ-021 runs after
  // each awaited planner/apply/recovery call before the next request is
  // issued or local UI state is committed.
  const handleOutcomeClick = useCallback(
    (direction: HarnessConfigSyncDirection) => {
      if (!dialogReview || dialogStage !== 'idle' || !dialogReviewUsable) return

      const token = dialogTokenRef.current
      const backendId = activeBackend.id
      const generation = backendGenerationRef.current
      const scope = dialogReview.scope
      const scopeKey = dialogReview.scopeKey
      const displayedReviewKey = dialogReview.reviewKey
      const agentName = dialogAgentName
      const resourceLabel = dialogResourceLabel

      const isStale = (): boolean =>
        dialogTokenRef.current !== token ||
        activeBackendIdRef.current !== backendId ||
        backendGenerationRef.current !== generation

      setDialogStage('planning')
      setDialogActionError(null)
      setDialogActionNotice(null)

      void (async () => {
        const planResult =
          direction === 'sync-to-disk'
            ? await backend.planHarnessConfigSyncToDisk({ scope })
            : await backend.planHarnessConfigAdoptFromDisk({ scope })

        if (isStale()) return

        if (!planResult.ok) {
          setDialogActionError(planResult.error.message)
          setDialogStage('idle')
          return
        }

        const freshPlan = planResult.value
        const decision = decideFreshPlanOutcome(displayedReviewKey, freshPlan)

        if (decision === 'already-synced') {
          closeDialog()
          showScopeNotice(scopeKey, 'Already in sync', backendId, generation)
          return
        }

        if (decision === 'review-refreshed-plan') {
          setDialogReview(toConfigSyncReview(freshPlan))
          setDialogActionNotice('Files changed. Review the refreshed plan and choose an action again.')
          setDialogStage('idle')
          return
        }

        // apply-fresh-plan: a review-equivalent, drift-bearing plan from
        // the direction-specific planner that matches this outcome.
        setDialogStage('applying')
        const applyResult =
          direction === 'sync-to-disk'
            ? await backend.syncHarnessConfigToDisk({
                scope: freshPlan.scope,
                planId: freshPlan.planId,
                confirmed: true
              })
            : await backend.adoptHarnessConfigFromDisk({
                scope: freshPlan.scope,
                planId: freshPlan.planId,
                confirmed: true
              })

        // REQ-021/RISK-004: an apply already dispatched remains a
        // confirmed operation against the backend it was sent to, but a
        // backend switch in the meantime means its response must never
        // touch the (new) current backend's UI.
        if (activeBackendIdRef.current !== backendId || backendGenerationRef.current !== generation) return

        if (applyResult.ok) {
          closeDialog()
          const notice =
            direction === 'sync-to-disk'
              ? `Synced ${agentName} ${resourceLabel} to disk`
              : `Adopted current disk ${resourceLabel} into Tatsu config`
          showScopeNotice(scopeKey, notice, backendId, generation)
          return
        }

        // REQ-017/REQ-018: preserve the original safe apply error, then
        // request one non-authorizing recovery comparison. The consumed
        // plan is never retried or reused — only a brand-new explicit
        // outcome click can produce another direction-bound plan.
        const originalError = applyResult.error.message
        setDialogActionError(originalError)

        const recoveryResult = await backend.compareHarnessConfig({ scope })
        if (activeBackendIdRef.current !== backendId || backendGenerationRef.current !== generation) return

        if (!recoveryResult.ok) {
          setDialogReviewUsable(false)
          setDialogActionError(`${originalError} Unable to refresh this comparison — cancel and start Sync again.`)
          setDialogStage('idle')
          return
        }

        if (recoveryResult.value.status === 'synced') {
          closeDialog()
          setScopeStatus(scopeKey, {
            error: `${originalError} A fresh comparison now reports this scope is in sync.`
          })
          return
        }

        setDialogReview(toConfigSyncReview(recoveryResult.value))
        setDialogReviewUsable(true)
        setDialogActionError(originalError)
        setDialogStage('idle')
      })()
    },
    [
      dialogReview,
      dialogStage,
      dialogReviewUsable,
      activeBackend.id,
      backend,
      dialogAgentName,
      dialogResourceLabel,
      closeDialog,
      showScopeNotice,
      setScopeStatus
    ]
  )

  // ---- Close guard + Escape routing (TASK-013) ----

  const handleClose = useCallback(() => {
    if (!confirmDiscard()) return
    onClose()
  }, [confirmDiscard, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (e.defaultPrevented) return
      if (dialogOpen) return // the dialog owns Escape while it's open
      if (isEditableTarget(e.target)) return
      handleClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialogOpen, handleClose])

  // ---- Editor view + action gating ----

  const editorView: ConfigEditorView = useMemo(() => {
    if (editorMode === 'create' && createScope) {
      const agentInfo = getAgentInfo(createScope.agentKind)
      if (!isScopeSupported(createScope)) {
        const capability = agentInfo.configCapabilities.find((c) => c.resourceType === createScope.resourceType)
        return {
          kind: 'unsupported',
          scope: createScope,
          agentDisplayName: agentInfo.displayName,
          note: capability?.notes ?? 'This harness does not support this resource type.'
        }
      }
      return {
        kind: 'create',
        scope: createScope,
        agentDisplayName: agentInfo.displayName,
        submitLabel: conversionSubmitLabel ?? undefined,
        conversionSource: conversionSource ?? undefined
      }
    }

    if (editorMode === 'edit' && selected && selectedRef) {
      const agentInfo = getAgentInfo(selected.scope.agentKind)
      if (!isScopeSupported(selected.scope)) {
        const capability = agentInfo.configCapabilities.find(
          (c) => c.resourceType === selected.scope.resourceType
        )
        return {
          kind: 'unsupported',
          scope: selected.scope,
          agentDisplayName: agentInfo.displayName,
          note: capability?.notes ?? 'This harness does not support this resource type.'
        }
      }
      if (readBusy) return { kind: 'loading' }
      const badge = findBadge(groupsNoSearch, selected.scope.agentKind, selected.id)
      if (!selectedRef.existsOnDisk) {
        return {
          kind: 'config-only',
          scope: selected.scope,
          agentDisplayName: agentInfo.displayName,
          ref: selectedRef,
          badge
        }
      }
      return {
        kind: 'edit',
        scope: selected.scope,
        agentDisplayName: agentInfo.displayName,
        ref: selectedRef,
        badge
      }
    }

    return { kind: 'empty' }
  }, [editorMode, createScope, selected, selectedRef, readBusy, groupsNoSearch, conversionSubmitLabel, conversionSource])

  const canCreate =
    editorView.kind === 'create' && createName.trim().length > 0 && !mutationBusy
  const canEdit = editorView.kind === 'edit' && !readBusy && !mutationBusy
  const canSave = canEdit && draft !== savedContent
  const canDelete = canEdit

  return (
    <div className="flex flex-col h-full min-h-0 bg-panel">
      <ConfigTabs
        onClose={handleClose}
        tabs={TABS}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        agentFilterOptions={AGENT_FILTER_OPTIONS}
        agentFilter={agentFilter}
        onAgentFilterChange={handleAgentFilterChange}
        searchQuery={searchQuery}
        onSearchChange={handleSearchChange}
      />
      <div className="flex flex-1 min-h-0">
        <div className="w-72 shrink-0 border-r border-border min-h-0 overflow-hidden">
          <ConfigResourceList
            groups={displayGroups}
            searchActive={searchActive}
            sharedError={harnessConfig.error}
            onSelectResource={handleSelectResource}
            onCreate={handleEnterCreate}
            onSync={handleSync}
            onCreateCommand={handleCreateCommand}
            onCreateSkill={handleCreateSkill}
          />
        </div>
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          <ConfigEditor
            view={editorView}
            draft={draft}
            onDraftChange={setDraft}
            nameDraft={createName}
            onNameDraftChange={setCreateName}
            dirty={isDirty}
            busy={mutationBusy || readBusy}
            canEdit={canEdit}
            canSave={canSave}
            canCreate={canCreate}
            canDelete={canDelete}
            error={actionError}
            fontFamily={settings.terminalFontFamily}
            fontSize={settings.terminalFontSize}
            onSave={() => {
              if (canSave) void handleSave()
            }}
            onCreate={() => {
              if (canCreate) void handleSubmitCreate()
            }}
            onDelete={() => {
              if (canDelete) void handleDelete()
            }}
            onCancel={handleCancelCreate}
            onReset={handleResetDraft}
          />
        </div>
      </div>
      <ConfigSyncDialog
        open={dialogOpen}
        review={dialogReview}
        agentDisplayName={dialogAgentName}
        resourceLabel={dialogResourceLabel}
        stage={dialogStage}
        reviewUsable={dialogReviewUsable}
        actionError={dialogActionError}
        actionNotice={dialogActionNotice}
        onSyncToDisk={() => handleOutcomeClick('sync-to-disk')}
        onAdoptFromDisk={() => handleOutcomeClick('adopt-from-disk')}
        onCancel={handleDialogCancel}
      />
    </div>
  )
}

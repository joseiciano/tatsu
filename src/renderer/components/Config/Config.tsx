import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useBackend } from '../../backend'
import { useActiveBackend, useHarnessConfig, useSettings } from '../../store'
import { getAgentInfo, isHarnessConfigCapabilityEnabled, type AgentInfo } from '../../../shared/agent-registry'
import {
  harnessConfigScopeKey,
  type HarnessConfigComparison,
  type HarnessConfigFileRef,
  type HarnessConfigRequestError,
  type HarnessConfigResourceType,
  type HarnessConfigScope,
  type HarnessConfigScopeKey,
  type ManagedHarnessKind
} from '../../../shared/state/harness-config'
import { ConfigTabs } from './ConfigTabs'
import { ConfigResourceList, buildConfigResourceGroups } from './ConfigResourceList'
import { ConfigEditor } from './ConfigEditor'
import { ConfigSyncDialog } from './ConfigSyncDialog'
import type {
  ConfigAgentFilter,
  ConfigAgentFilterOption,
  ConfigDriftBadge,
  ConfigEditorView,
  ConfigProps,
  ConfigResourceGroup,
  ConfigSelection,
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

function requestFailureMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'The request failed'
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
  const [readFailed, setReadFailed] = useState(false)
  const [mutationBusy, setMutationBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const [scopeStatus, setScopeStatusState] = useState<
    Partial<Record<HarnessConfigScopeKey, ScopeStatus>>
  >({})

  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogComparison, setDialogComparison] = useState<HarnessConfigComparison | null>(null)

  // Session bookkeeping — plain refs so they never themselves trigger a
  // render; every async chain captures these at call time and re-checks
  // them after every await (REQ-009, RISK-004).
  const backendGenerationRef = useRef(0)
  const activeBackendIdRef = useRef(activeBackend.id)
  const readTokenRef = useRef(0)
  const scannedRef = useRef<Map<string, Set<HarnessConfigScopeKey>>>(new Map())
  const pendingScanRef = useRef<Map<string, Set<HarnessConfigScopeKey>>>(new Map())
  const syncNoticeTimeoutsRef = useRef<Map<HarnessConfigScopeKey, number>>(new Map())

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

  const invalidateRead = useCallback(() => {
    readTokenRef.current += 1
    setReadBusy(false)
    setReadFailed(false)
  }, [])

  const resetPageLocalState = useCallback(() => {
    invalidateRead()
    setSelected(null)
    setSelectedRef(null)
    setEditorMode('empty')
    setCreateScope(null)
    setCreateName('')
    setDraft('')
    setSavedContent('')
    setMutationBusy(false)
    setActionError(null)
    setScopeStatusState({})
    setDialogOpen(false)
    setDialogComparison(null)
  }, [invalidateRead])

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
      } catch (err) {
        if (activeBackendIdRef.current !== backendId || backendGenerationRef.current !== generation) return
        setScopeStatus(key, { busy: false, error: requestFailureMessage(err) })
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
        let error: string | null
        try {
          const result = await backend.compareHarnessConfig({ scope })
          error = result.ok ? null : result.error.message
        } catch (err) {
          error = requestFailureMessage(err)
        }
        if (activeBackendIdRef.current !== backendId || backendGenerationRef.current !== generation) return
        setScopeStatus(key, { error })
      }
    },
    [backend, setScopeStatus]
  )

  const rescanAfterFailedApply = useCallback(
    async (
      error: HarnessConfigRequestError,
      agentKind: ManagedHarnessKind,
      resourceTypes: readonly HarnessConfigResourceType[],
      backendId: string,
      generation: number
    ) => {
      if (!error.requiresRescan && !error.applied?.length) return
      for (const resourceType of resourceTypes) {
        const scope: HarnessConfigScope = { agentKind, resourceType }
        try {
          await backend.scanHarnessConfig({ scope })
        } catch {
          // refreshComparisons below surfaces any persistent transport failure.
        }
        if (activeBackendIdRef.current !== backendId || backendGenerationRef.current !== generation) return
      }
      await refreshComparisons(agentKind, resourceTypes, backendId, generation)
    },
    [backend, refreshComparisons]
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
          notice: status?.notice ?? null
        }
      }),
    [baseGroups, scopeStatus]
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
    invalidateRead()
    setSelected(null)
    setSelectedRef(null)
    setEditorMode('empty')
    setDraft('')
    setSavedContent('')
  }, [harnessConfig.resources, harnessConfig.comparisons, selected, invalidateRead])

  // ---- Tab / filter / search transitions (REQ-025) ----

  const clearSelectionAndEditor = useCallback(() => {
    invalidateRead()
    setSelected(null)
    setSelectedRef(null)
    setEditorMode('empty')
    setCreateScope(null)
    setCreateName('')
    setDraft('')
    setSavedContent('')
    setActionError(null)
  }, [invalidateRead])

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
        selected.id === id &&
        !readFailed
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
      setReadFailed(false)

      if (!ref.existsOnDisk) {
        readTokenRef.current += 1
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
        const isCurrent = (): boolean =>
          activeBackendIdRef.current === backendId &&
          backendGenerationRef.current === generation &&
          readTokenRef.current === token
        let result: Awaited<ReturnType<typeof backend.readHarnessConfigFile>>
        try {
          result = await backend.readHarnessConfigFile({ scope, id })
        } catch (err) {
          if (!isCurrent()) return
          setReadBusy(false)
          setReadFailed(true)
          setActionError(requestFailureMessage(err))
          return
        }
        if (!isCurrent()) return
        if (!result.ok) {
          setReadBusy(false)
          setReadFailed(true)
          setActionError(result.error.message)
          return
        }
        setSelectedRef(result.value.ref)
        setDraft(result.value.content)
        setSavedContent(result.value.content)
        setReadBusy(false)
      })()
    },
    [selected, readFailed, confirmDiscard, groupsNoSearch, backend, activeBackend.id]
  )

  // ---- Create ----

  const handleEnterCreate = useCallback(
    (scope: HarnessConfigScope) => {
      if (!confirmDiscard()) return
      invalidateRead()
      setSelected(null)
      setSelectedRef(null)
      setCreateScope(scope)
      setCreateName('')
      setDraft('')
      setSavedContent('')
      setEditorMode('create')
      setActionError(null)
    },
    [confirmDiscard, invalidateRead]
  )

  const handleCancelCreate = useCallback(() => {
    readTokenRef.current += 1
    setCreateScope(null)
    setCreateName('')
    setDraft('')
    setEditorMode('empty')
    setActionError(null)
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
    const editorToken = readTokenRef.current
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
        await rescanAfterFailedApply(applyResult.error, scope.agentKind, affectedResourceTypes(scope, null), backendId, generation)
        return
      }

      const createdId = applyResult.value.applied.find((op) => op.type === 'create')?.id
      const resultingRef = createdId
        ? (applyResult.value.resultingRefs.find((ref) => ref.id === createdId) ?? null)
        : null

      if (readTokenRef.current === editorToken) {
        readTokenRef.current += 1
        setCreateScope(null)
        setCreateName('')

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
      }

      await refreshComparisons(scope.agentKind, affectedResourceTypes(scope, resultingRef), backendId, generation)
    } catch (err) {
      if (activeBackendIdRef.current !== backendId || backendGenerationRef.current !== generation) return
      setActionError(requestFailureMessage(err))
    } finally {
      if (activeBackendIdRef.current === backendId && backendGenerationRef.current === generation) {
        setMutationBusy(false)
        setScopeStatus(scopeKey, { busy: false })
      }
    }
  }, [createScope, createName, draft, mutationBusy, activeBackend.id, backend, refreshComparisons, rescanAfterFailedApply, setScopeStatus])

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
    const editorToken = readTokenRef.current
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
        await rescanAfterFailedApply(
          applyResult.error,
          scope.agentKind,
          affectedResourceTypes(scope, preMutationRef),
          backendId,
          generation
        )
        return
      }

      if (readTokenRef.current === editorToken) {
        const readToken = ++readTokenRef.current
        const readResult = await backend.readHarnessConfigFile({ scope, id })
        if (activeBackendIdRef.current !== backendId || backendGenerationRef.current !== generation) return
        if (readTokenRef.current === readToken) {
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
        }
      }

      await refreshComparisons(
        scope.agentKind,
        affectedResourceTypes(scope, preMutationRef),
        backendId,
        generation
      )
    } catch (err) {
      if (activeBackendIdRef.current !== backendId || backendGenerationRef.current !== generation) return
      setActionError(requestFailureMessage(err))
    } finally {
      if (activeBackendIdRef.current === backendId && backendGenerationRef.current === generation) {
        setMutationBusy(false)
        setScopeStatus(scopeKey, { busy: false })
      }
    }
  }, [selected, selectedRef, draft, savedContent, mutationBusy, activeBackend.id, backend, refreshComparisons, rescanAfterFailedApply, setScopeStatus])

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
    const editorToken = readTokenRef.current
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
        await rescanAfterFailedApply(
          applyResult.error,
          scope.agentKind,
          affectedResourceTypes(scope, preMutationRef),
          backendId,
          generation
        )
        return
      }

      if (readTokenRef.current === editorToken) {
        invalidateRead()
        setSelected(null)
        setSelectedRef(null)
        setEditorMode('empty')
        setDraft('')
        setSavedContent('')
      }

      await refreshComparisons(
        scope.agentKind,
        affectedResourceTypes(scope, preMutationRef),
        backendId,
        generation
      )
    } catch (err) {
      if (activeBackendIdRef.current !== backendId || backendGenerationRef.current !== generation) return
      setActionError(requestFailureMessage(err))
    } finally {
      if (activeBackendIdRef.current === backendId && backendGenerationRef.current === generation) {
        setMutationBusy(false)
        setScopeStatus(scopeKey, { busy: false })
      }
    }
  }, [selected, selectedRef, mutationBusy, activeBackend.id, backend, refreshComparisons, rescanAfterFailedApply, setScopeStatus, invalidateRead])

  const handleResetDraft = useCallback(() => setDraft(savedContent), [savedContent])

  // ---- Sync preview (REQ-027, REQ-028, CON-002) ----

  const handleSync = useCallback(
    (scope: HarnessConfigScope) => {
      const backendId = activeBackend.id
      const generation = backendGenerationRef.current
      const key = harnessConfigScopeKey(scope)
      setScopeStatus(key, { busy: true, error: null, notice: null })
      void (async () => {
        let result: Awaited<ReturnType<typeof backend.compareHarnessConfig>>
        try {
          result = await backend.compareHarnessConfig({ scope })
        } catch (err) {
          if (activeBackendIdRef.current !== backendId || backendGenerationRef.current !== generation) return
          setScopeStatus(key, { busy: false, error: requestFailureMessage(err) })
          return
        }
        if (activeBackendIdRef.current !== backendId || backendGenerationRef.current !== generation) return
        if (!result.ok) {
          setScopeStatus(key, { busy: false, error: result.error.message })
          return
        }
        setScopeStatus(key, { busy: false, error: null })
        if (result.value.status === 'synced') {
          setScopeStatus(key, { notice: 'Synced' })
          const existingTimeout = syncNoticeTimeoutsRef.current.get(key)
          if (existingTimeout !== undefined) window.clearTimeout(existingTimeout)
          const timeoutId = window.setTimeout(() => {
            syncNoticeTimeoutsRef.current.delete(key)
            if (activeBackendIdRef.current !== backendId || backendGenerationRef.current !== generation) return
            setScopeStatus(key, { notice: null })
          }, 2500)
          syncNoticeTimeoutsRef.current.set(key, timeoutId)
          return
        }
        setDialogAgentName(getAgentInfo(scope.agentKind).displayName)
        setDialogResourceLabel(TABS.find((t) => t.id === scope.resourceType)?.label ?? scope.resourceType)
        setDialogComparison(result.value)
        setDialogOpen(true)
      })()
    },
    [activeBackend.id, backend, setScopeStatus]
  )

  const handleCloseDialog = useCallback(() => {
    setDialogOpen(false)
    setDialogComparison(null)
  }, [])

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
      return { kind: 'create', scope: createScope, agentDisplayName: agentInfo.displayName }
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
  }, [editorMode, createScope, selected, selectedRef, readBusy, groupsNoSearch])

  const canCreate =
    editorView.kind === 'create' && createName.trim().length > 0 && !mutationBusy
  const canEdit = editorView.kind === 'edit' && !readBusy && !readFailed && !mutationBusy
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
        comparison={dialogComparison}
        agentDisplayName={dialogAgentName}
        resourceLabel={dialogResourceLabel}
        onClose={handleCloseDialog}
      />
    </div>
  )
}

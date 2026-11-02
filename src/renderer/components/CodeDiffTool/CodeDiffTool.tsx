import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BranchForCompare, CodeDiffFile, CodeDiffFileList, CodeDiffSides } from '../../types'
import { useBackend } from '../../backend'
import { useSettings } from '../../store'
import { useWatchedQuery } from '../../hooks/useWatchedQuery'
import { groupAndSortFiles } from '../ReviewFileTree'
import { CodeDiffSummaryBar, type FetchState, type GroupMode } from './CodeDiffSummaryBar'
import { CodeDiffFileTree, type DisplayGroup } from './CodeDiffFileTree'
import { CodeDiffDiffPane } from './CodeDiffDiffPane'
import { groupByChangeType, stepFile, stepGroup } from './grouping'
import { shouldReloadSides } from './should-reload-sides'

interface CodeDiffToolProps {
  worktreePath: string
  branchName: string
  repoLabel: string
  onClose: () => void
}

const ACTIVE_POLL_MS = 3000
const NAV_IGNORE_SELECTOR = 'input, textarea, select, .monaco-editor, .xterm'

export function shortRefLabel(ref: string): string {
  for (const prefix of ['refs/heads/', 'refs/remotes/', 'refs/tags/']) {
    if (ref.startsWith(prefix)) return ref.slice(prefix.length)
  }
  return /^[0-9a-f]{40,64}$/.test(ref) ? ref.slice(0, 10) : ref
}

function insideIgnored(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(NAV_IGNORE_SELECTOR) != null
}

export function CodeDiffTool({ worktreePath, branchName, repoLabel, onClose }: CodeDiffToolProps): JSX.Element {
  const backend = useBackend()
  const settings = useSettings()
  const rootRef = useRef<HTMLDivElement>(null)

  const [baseRef, setBaseRef] = useState<string | null>(null)
  const [branches, setBranches] = useState<BranchForCompare[]>([])
  const [refError, setRefError] = useState<string | null>(null)
  const [fetchState, setFetchState] = useState<FetchState>({ kind: 'idle' })
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [groupMode, setGroupMode] = useState<GroupMode>('type')

  const resetToDefault = useCallback(() => {
    setRefError(null)
    setFetchState({ kind: 'idle' })
    void backend.getDefaultCompareRef(worktreePath).then((d) => setBaseRef(d.ref))
  }, [backend, worktreePath])

  useEffect(() => {
    resetToDefault()
    void backend.listBranchesForCompare(worktreePath).then(setBranches)
    rootRef.current?.focus()
  }, [backend, worktreePath, resetToDefault])

  const fetcher = useCallback(
    (path: string): Promise<CodeDiffFileList> => backend.getCodeDiffFiles(path, baseRef ?? 'HEAD'),
    [backend, baseRef]
  )
  const { data, refresh } = useWatchedQuery<CodeDiffFileList>({
    worktreePath: baseRef ? worktreePath : null,
    cacheKey: `codeDiff:${baseRef ?? ''}`,
    fetcher,
    fallbackPollMs: ACTIVE_POLL_MS
  })
  const list = data && data.baseRef === baseRef ? data : null

  const groups: DisplayGroup[] = useMemo(() => {
    if (!list) return []
    if (groupMode === 'type') {
      return groupByChangeType(list.files).map((g) => ({ key: g.key, label: g.label, files: g.files }))
    }
    return groupAndSortFiles(list.files).map((g) => ({ key: g.dir || '/', label: g.dir || '/', files: g.files }))
  }, [list, groupMode])

  useEffect(() => {
    if (!list) return
    if (selectedFile && list.files.some((f) => f.path === selectedFile)) return
    setSelectedFile(stepFile(groups, null, 0))
  }, [list, groups, selectedFile])

  const selectedEntry: CodeDiffFile | undefined = list?.files.find((f) => f.path === selectedFile)

  const lastEntryRef = useRef<CodeDiffFile | undefined>(undefined)
  const [reloadToken, setReloadToken] = useState(0)
  useEffect(() => {
    const prev = lastEntryRef.current
    lastEntryRef.current = selectedEntry
    if (prev && selectedEntry && prev.path === selectedEntry.path && shouldReloadSides(prev, selectedEntry)) {
      setReloadToken((t) => t + 1)
    }
  }, [selectedEntry])

  const [sidesState, setSidesState] = useState<{ key: string; sides: CodeDiffSides } | null>(null)
  const [sidesLoading, setSidesLoading] = useState(false)
  const previousPath = selectedEntry?.previousPath
  const sidesKey = baseRef && selectedFile ? `${baseRef}\0${selectedFile}` : null
  useEffect(() => {
    if (!baseRef || !selectedFile || !sidesKey) return
    let cancelled = false
    setSidesLoading(true)
    backend
      .getCodeDiffFileSides(worktreePath, baseRef, selectedFile, previousPath)
      .then((sides) => {
        if (!cancelled) setSidesState({ key: sidesKey, sides })
      })
      .catch((err: Error) => {
        if (!cancelled) setSidesState({ key: sidesKey, sides: failedSides(err.message) })
      })
      .finally(() => {
        if (!cancelled) setSidesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [backend, worktreePath, baseRef, selectedFile, previousPath, sidesKey, reloadToken])
  const sides = sidesState && sidesState.key === sidesKey ? sidesState.sides : null

  const handleSubmitRef = useCallback(
    async (ref: string) => {
      const result = await backend.validateRef(worktreePath, ref)
      if (!result.ok) {
        setRefError(result.error)
        return
      }
      setRefError(null)
      setFetchState({ kind: 'idle' })
      setBaseRef(result.ref)
    },
    [backend, worktreePath]
  )

  const handleFetch = useCallback(async () => {
    if (!baseRef) return
    setFetchState({ kind: 'fetching' })
    const result = await backend.fetchCompareRef(worktreePath, baseRef)
    if (result.ok) {
      setFetchState({ kind: 'idle' })
      refresh()
    } else {
      setFetchState({ kind: 'failed', error: result.error ?? 'Fetch failed' })
    }
  }, [backend, worktreePath, baseRef, refresh])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || insideIgnored(e.target)) return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (insideIgnored(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
    let next: string | null | undefined
    if (e.key === 'j' || e.key === 'ArrowDown') next = stepFile(groups, selectedFile, 1)
    else if (e.key === 'k' || e.key === 'ArrowUp') next = stepFile(groups, selectedFile, -1)
    else if (e.key === ']') next = stepGroup(groups, selectedFile, 1)
    else if (e.key === '[') next = stepGroup(groups, selectedFile, -1)
    else return
    e.preventDefault()
    if (next) setSelectedFile(next)
  }

  const baseLabel = baseRef ? shortRefLabel(baseRef) : ''

  return (
    <div ref={rootRef} tabIndex={-1} onKeyDown={handleKeyDown} className="flex flex-col h-full w-full bg-bg outline-none">
      <CodeDiffSummaryBar
        repoLabel={repoLabel}
        branchName={branchName}
        baseLabel={baseLabel}
        branches={branches}
        refError={refError}
        fetchable={!!baseRef?.startsWith('refs/remotes/origin/')}
        fetchState={fetchState}
        fileCount={list && !list.error ? list.totalFiles : null}
        additions={list?.totalAdditions ?? 0}
        deletions={list?.totalDeletions ?? 0}
        groupMode={groupMode}
        onSubmitRef={handleSubmitRef}
        onResetRef={resetToDefault}
        onFetch={handleFetch}
        onGroupModeChange={setGroupMode}
        onClose={onClose}
      />

      <div className="flex flex-1 min-h-0">
        {!list ? (
          <ListSkeleton />
        ) : list.error ? (
          <ListError error={list.error} baseLabel={baseLabel} onReset={resetToDefault} />
        ) : list.files.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-sm text-faint">
            No changes between <span className="mx-1 font-mono">{baseLabel}</span> and this worktree
          </div>
        ) : (
          <>
            <div className="w-72 shrink-0 border-r border-border overflow-hidden">
              <CodeDiffFileTree
                groups={groups}
                selectedFile={selectedFile}
                showFullPath={groupMode === 'type'}
                hiddenCount={list.totalFiles - list.files.length}
                totalFiles={list.totalFiles}
                onSelectFile={setSelectedFile}
              />
            </div>
            <div className="flex-1 min-w-0">
              <CodeDiffDiffPane
                file={selectedEntry ?? null}
                sides={sides}
                loading={sidesLoading}
                fontFamily={settings.terminalFontFamily || undefined}
                fontSize={settings.terminalFontSize}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function failedSides(error: string): CodeDiffSides {
  return {
    original: '',
    modified: '',
    originalExists: false,
    modifiedExists: false,
    originalBinary: false,
    modifiedBinary: false,
    originalSize: 0,
    modifiedSize: 0,
    modifiedSymlink: false,
    error
  }
}

function ListSkeleton(): JSX.Element {
  return (
    <div className="w-72 shrink-0 border-r border-border p-2 space-y-2" aria-busy="true">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="h-3 rounded bg-panel-raised animate-pulse" style={{ width: `${60 + ((i * 17) % 35)}%` }} />
      ))}
    </div>
  )
}

function ListError({
  error,
  baseLabel,
  onReset
}: {
  error: NonNullable<CodeDiffFileList['error']>
  baseLabel: string
  onReset: () => void
}): JSX.Element {
  const message =
    error === 'invalid-ref' ? (
      <>
        Ref <span className="font-mono">{baseLabel}</span> not found.
      </>
    ) : error === 'no-merge-base' ? (
      <>
        <span className="font-mono">{baseLabel}</span> and this branch share no history.
      </>
    ) : (
      <>This worktree is not known to Tatsu.</>
    )
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-faint">
      <div>{message}</div>
      <button
        onClick={onReset}
        className="px-2 py-1 rounded border border-border text-xs text-fg hover:bg-panel-raised cursor-pointer"
      >
        Reset to default
      </button>
    </div>
  )
}

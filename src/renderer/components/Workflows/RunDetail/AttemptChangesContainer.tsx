import { useEffect, useState } from 'react'
import { useBackend } from '../../../backend'
import type {
  WorkflowAttemptChangedFilesResponse,
  WorkflowAttemptFileDiffResponse
} from '../../../../shared/state/workflows'
import { AttemptChanges, type AttemptChangesState, type AttemptFileDiffState } from './AttemptChanges'
import type { AttemptResultState } from './AttemptResult'

const LOAD_FAILED = 'Could not load the changed files'
const DIFF_FAILED = 'Could not load the file diff'

export interface AttemptChangesContainerProps {
  attemptId: string | null
  attempt: AttemptResultState
  snapshotPending: boolean
}

interface Loaded<T> {
  key: string
  response: T | null
}

function snapshotKey(attemptId: string | null, attempt: AttemptResultState): string | null {
  if (attemptId === null || attempt.kind !== 'ready' || !attempt.attempt) return null
  const { baseSnapshot, headSnapshot } = attempt.attempt
  return baseSnapshot && headSnapshot ? `${attemptId}:${baseSnapshot.commit}:${headSnapshot.commit}` : null
}

function changesState(
  attemptId: string | null,
  attempt: AttemptResultState,
  snapshotPending: boolean,
  key: string | null,
  loaded: Loaded<WorkflowAttemptChangedFilesResponse> | null
): AttemptChangesState {
  if (attemptId === null || attempt.kind === 'none') return { kind: 'none' }
  if (attempt.kind === 'loading') return { kind: 'loading' }
  if (attempt.kind === 'error') return { kind: 'error', message: LOAD_FAILED }
  if (key === null) return snapshotPending ? { kind: 'loading' } : { kind: 'no-snapshot' }
  if (loaded?.key !== key) return { kind: 'loading' }
  const { response } = loaded
  if (response === null) return { kind: 'error', message: LOAD_FAILED }
  if ('error' in response) return { kind: 'error', message: response.error }
  return { kind: 'ready', files: response.files, truncated: response.truncated }
}

function diffState(
  path: string | null,
  key: string | null,
  loaded: Loaded<WorkflowAttemptFileDiffResponse> | null
): AttemptFileDiffState {
  if (path === null || key === null) return { kind: 'idle' }
  if (loaded?.key !== key) return { kind: 'loading', path }
  const { response } = loaded
  if (response === null) return { kind: 'error', path, message: DIFF_FAILED }
  if ('error' in response) return { kind: 'error', path, message: response.error }
  return { kind: 'ready', path, original: response.original, modified: response.modified }
}

export function AttemptChangesContainer({ attemptId, attempt, snapshotPending }: AttemptChangesContainerProps): JSX.Element {
  const backend = useBackend()
  const key = snapshotKey(attemptId, attempt)
  const [loaded, setLoaded] = useState<Loaded<WorkflowAttemptChangedFilesResponse> | null>(null)
  const [picked, setPicked] = useState<{ key: string; path: string } | null>(null)
  const [loadedDiff, setLoadedDiff] = useState<Loaded<WorkflowAttemptFileDiffResponse> | null>(null)

  useEffect(() => {
    if (key === null || attemptId === null) return
    let cancelled = false
    backend
      .getWorkflowAttemptChangedFiles(attemptId)
      .then((response) => {
        if (!cancelled) setLoaded({ key, response })
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key, response: null })
      })
    return () => {
      cancelled = true
    }
  }, [backend, attemptId, key])

  const changes = changesState(attemptId, attempt, snapshotPending, key, loaded)
  const files = changes.kind === 'ready' ? changes.files : null
  const pickedPath = picked !== null && picked.key === key ? picked.path : null
  const selectedPath =
    files === null ? null : (files.find((file) => file.path === pickedPath) ?? files[0] ?? null)?.path ?? null
  const diffKey = key !== null && selectedPath !== null ? `${key}\0${selectedPath}` : null

  useEffect(() => {
    if (diffKey === null || attemptId === null || selectedPath === null) return
    let cancelled = false
    backend
      .getWorkflowAttemptFileDiff(attemptId, selectedPath)
      .then((response) => {
        if (!cancelled) setLoadedDiff({ key: diffKey, response })
      })
      .catch(() => {
        if (!cancelled) setLoadedDiff({ key: diffKey, response: null })
      })
    return () => {
      cancelled = true
    }
  }, [backend, attemptId, selectedPath, diffKey])

  const onSelectFile = (path: string): void => {
    if (key !== null) setPicked({ key, path })
  }

  return (
    <AttemptChanges
      changes={changes}
      diff={diffState(selectedPath, diffKey, loadedDiff)}
      selectedPath={selectedPath}
      onSelectFile={onSelectFile}
    />
  )
}

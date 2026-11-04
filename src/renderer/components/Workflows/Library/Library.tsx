import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useBackend } from '../../../backend'
import { useAppState, useWorkflowDefinitions } from '../../../store'
import { DeleteDefinitionDialog } from './DeleteDefinitionDialog'
import { libraryGroups } from './library-groups'
import { LibraryList } from './LibraryList'

export interface LibraryProps {
  activeRepoRoot: string | null
  onRun?: (defId: string) => void
  onEdit?: (defId: string) => void
  onNew?: () => void
}

function failure(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'The request failed'
}

export function Library({ activeRepoRoot, onRun, onEdit, onNew }: LibraryProps): JSX.Element {
  const backend = useBackend()
  const definitions = useWorkflowDefinitions()
  const repoRoots = useAppState((s) => s.worktrees.repoRoots)
  const trust = useAppState((s) => s.workflows.trust)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const groups = useMemo(
    () => libraryGroups({ definitions, repoRoots, activeRepoRoot }),
    [definitions, repoRoots, activeRepoRoot]
  )

  const duplicate = useCallback(
    (defId: string) => {
      const name = definitions[defId]?.name ?? defId
      setBusyId(defId)
      setError(null)
      setStatus(null)
      backend.duplicateWorkflowDefinition(defId).then(
        (result) => {
          if (!mounted.current) return
          setBusyId(null)
          if ('error' in result) setError(`Could not duplicate ${name}: ${result.error}`)
          else setStatus(`Duplicated ${name}`)
        },
        (err: unknown) => {
          if (!mounted.current) return
          setBusyId(null)
          setError(`Could not duplicate ${name}: ${failure(err)}`)
        }
      )
    },
    [backend, definitions]
  )

  const openDelete = useCallback((defId: string) => {
    setDeleteId(defId)
    setDeleteError(null)
    setError(null)
    setStatus(null)
  }, [])

  const cancelDelete = useCallback(() => {
    setDeleteId(null)
    setDeleteError(null)
  }, [])

  const confirmDelete = useCallback(() => {
    if (deleteId === null) return
    const target = deleteId
    const name = definitions[target]?.name ?? target
    setBusyId(target)
    setDeleteError(null)
    backend.deleteWorkflowDefinition(target).then(
      (result) => {
        if (!mounted.current) return
        setBusyId(null)
        if ('error' in result) {
          setDeleteError(result.error)
          return
        }
        setDeleteId(null)
        setStatus(`Deleted ${name}`)
      },
      (err: unknown) => {
        if (!mounted.current) return
        setBusyId(null)
        setDeleteError(failure(err))
      }
    )
  }, [backend, definitions, deleteId])

  const pendingDelete = deleteId === null ? null : definitions[deleteId] ?? null

  return (
    <>
      <LibraryList
        groups={groups}
        trust={trust}
        busyId={busyId}
        error={error}
        status={status}
        onRun={(defId) => onRun?.(defId)}
        onDuplicate={duplicate}
        onDelete={openDelete}
        onEdit={onEdit}
        onNew={onNew}
      />
      {pendingDelete && (
        <DeleteDefinitionDialog
          summary={pendingDelete}
          busy={busyId === pendingDelete.id}
          error={deleteError}
          onConfirm={confirmDelete}
          onCancel={cancelDelete}
        />
      )}
    </>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { useAppState, useWorktreeRepoRoot } from '../../../store'
import { ConfirmDialog, DefinitionEditor, type DefinitionEditorTarget } from '../DefinitionEditor'
import { Library } from '../Library'
import { NeedsYouGroup, type JumpToTabHandler } from '../NeedsYou'
import { createRunListsSelector } from '../run-card-model'
import { RunDetailContainer } from '../RunDetail'
import { RunsTab } from './RunsTab'
import { WorkflowsSection, type WorkflowsTab } from './WorkflowsSection'

const ELAPSED_TICK_MS = 1000

const selectRunLists = createRunListsSelector()

export type WorkflowsExitGuard = (proceed: () => void) => void

export interface WorkflowsViewProps {
  onClose: () => void
  onJumpToTab?: JumpToTabHandler
  onRunWorkflow?: () => void
  onRunDefinition?: (defId: string) => void
  activeWorktreePath?: string | null
  exitGuardRef?: MutableRefObject<WorkflowsExitGuard | null>
}

export function WorkflowsView({
  onClose,
  onJumpToTab,
  onRunWorkflow,
  onRunDefinition,
  activeWorktreePath = null,
  exitGuardRef
}: WorkflowsViewProps): JSX.Element {
  const [tab, setTab] = useState<WorkflowsTab>('runs')
  const [now, setNow] = useState(() => Date.now())
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(null)
  const [returnFocusRunId, setReturnFocusRunId] = useState<string | null>(null)
  const { active, recent } = useAppState((s) => selectRunLists(s.workflows.runs))
  const hasActive = active.length > 0
  const activeRepoRoot = useWorktreeRepoRoot(activeWorktreePath)
  const [editor, setEditor] = useState<{ session: number; target: DefinitionEditorTarget } | null>(null)
  const [pendingExit, setPendingExit] = useState<{ proceed: () => void } | null>(null)
  const editorDirty = useRef(false)
  const editorSession = useRef(0)

  const guardExit = useCallback<WorkflowsExitGuard>((proceed) => {
    if (editorDirty.current) setPendingExit({ proceed })
    else proceed()
  }, [])

  useEffect(() => {
    if (!exitGuardRef) return
    exitGuardRef.current = guardExit
    return () => {
      exitGuardRef.current = null
    }
  }, [exitGuardRef, guardExit])

  const closeEditor = useCallback(() => {
    editorDirty.current = false
    setEditor(null)
  }, [])

  const openEditor = useCallback((target: DefinitionEditorTarget) => {
    editorSession.current += 1
    editorDirty.current = false
    setEditor({ session: editorSession.current, target })
  }, [])

  const editDefinition = useCallback((defId: string) => openEditor({ kind: 'edit', defId }), [openEditor])
  const newDefinition = useCallback(() => openEditor({ kind: 'new' }), [openEditor])
  const setEditorDirty = useCallback((dirty: boolean) => {
    editorDirty.current = dirty
  }, [])
  const leaveEditor = useCallback(() => guardExit(closeEditor), [guardExit, closeEditor])
  const close = useCallback(() => guardExit(onClose), [guardExit, onClose])

  useEffect(() => {
    if (!hasActive) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS)
    return () => clearInterval(timer)
  }, [hasActive])

  const needsYou = useMemo(() => <NeedsYouGroup onJumpToTab={onJumpToTab} />, [onJumpToTab])

  const openRun = useCallback((runId: string) => {
    setSelectedRunId(runId)
    setSelectedAttemptId(null)
    setReturnFocusRunId(null)
  }, [])

  const closeRun = useCallback(() => {
    setReturnFocusRunId(selectedRunId)
    setSelectedRunId(null)
    setSelectedAttemptId(null)
  }, [selectedRunId])

  const changeTab = useCallback(
    (next: WorkflowsTab) => {
      guardExit(() => {
        closeEditor()
        setTab(next)
        setSelectedRunId(null)
        setSelectedAttemptId(null)
        setReturnFocusRunId(null)
      })
    },
    [guardExit, closeEditor]
  )

  const clearReturnFocus = useCallback(() => setReturnFocusRunId(null), [])

  return (
    <WorkflowsSection tab={tab} onTabChange={changeTab} onClose={close}>
      {tab === 'runs' &&
        (selectedRunId ? (
          <RunDetailContainer
            key={selectedRunId}
            runId={selectedRunId}
            now={now}
            selectedAttemptId={selectedAttemptId}
            onSelectAttempt={setSelectedAttemptId}
            onBack={closeRun}
            onJumpToTab={onJumpToTab}
          />
        ) : (
          <RunsTab
            needsYou={needsYou}
            activeIds={active}
            recentIds={recent}
            now={now}
            onOpenRun={openRun}
            focusRunId={returnFocusRunId}
            onFocused={clearReturnFocus}
            onRunWorkflow={onRunWorkflow}
          />
        ))}
      {tab === 'library' &&
        (editor ? (
          <DefinitionEditor
            key={editor.session}
            target={editor.target}
            activeRepoRoot={activeRepoRoot}
            onBack={leaveEditor}
            onDirtyChange={setEditorDirty}
          />
        ) : (
          <Library activeRepoRoot={activeRepoRoot} onRun={onRunDefinition} onEdit={editDefinition} onNew={newDefinition} />
        ))}
      {pendingExit && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          confirmLabel="Discard changes"
          cancelLabel="Keep editing"
          tone="danger"
          onConfirm={() => {
            const { proceed } = pendingExit
            setPendingExit(null)
            closeEditor()
            proceed()
          }}
          onCancel={() => setPendingExit(null)}
        >
          <p>Your edits to this workflow definition have not been saved.</p>
        </ConfirmDialog>
      )}
    </WorkflowsSection>
  )
}

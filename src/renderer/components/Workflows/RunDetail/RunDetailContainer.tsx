import { useCallback, useEffect, useMemo, useState } from 'react'
import { useBackend } from '../../../backend'
import {
  useWorkflowAttempt,
  useWorkflowDefinition,
  useWorkflowRun,
  useWorkflowRunAttempts,
  useWorkflowRunRecordKey,
  useWorkflowStepTabLeaf,
  useWorktreeRepoRoot
} from '../../../store'
import { findWorkflowStepTab } from '../../../workflow-selectors'
import type {
  WorkflowActionResponse,
  WorkflowAttemptRecord,
  WorkflowMarkDonePayload,
  WorkflowRunRecord,
  WorkflowStepStatus
} from '../../../../shared/state/workflows'
import { RetryFromCleanDialog, type JumpToTabHandler } from '../NeedsYou'
import { runCardModel } from '../run-card-model'
import { latestAttemptId, runDetailModel, type RunDetailActionKind } from '../run-detail-model'
import { CancelStepDialog, MarkDoneForm } from '../StepTab'
import { confirmRetryFromClean, runNeedsYouAction } from '../workflow-run-helpers'
import type { AttemptResultState } from './AttemptResult'
import { RunDetail } from './RunDetail'

const ACTION_FAILED = 'Action failed'
const CANCEL_STEP_FAILED = 'Could not cancel the step'

export interface RunDetailContainerProps {
  runId: string
  now: number
  selectedAttemptId: string | null
  onSelectAttempt: (attemptId: string) => void
  onBack: () => void
  onJumpToTab?: JumpToTabHandler
}

interface LoadedRecord {
  runId: string
  record: WorkflowRunRecord | null
  error: boolean
}

type LoadedAttempt = { attemptId: string; attempt: WorkflowAttemptRecord | null } | { attemptId: string; error: true }

function useRunRecord(runId: string, fetchKey: string | null): LoadedRecord | null {
  const backend = useBackend()
  const [loaded, setLoaded] = useState<LoadedRecord | null>(null)
  useEffect(() => {
    if (fetchKey === null) return
    let cancelled = false
    backend
      .getWorkflowRun(runId)
      .then((record) => {
        if (!cancelled) setLoaded({ runId, record, error: false })
      })
      .catch(() => {
        if (!cancelled) setLoaded((prev) => ({ runId, record: prev?.runId === runId ? prev.record : null, error: true }))
      })
    return () => {
      cancelled = true
    }
  }, [backend, runId, fetchKey])
  return loaded?.runId === runId ? loaded : null
}

function useAttemptResult(attemptId: string | null): AttemptResultState {
  const backend = useBackend()
  const sliceAttempt = useWorkflowAttempt(attemptId)
  const [loaded, setLoaded] = useState<LoadedAttempt | null>(null)
  const status = sliceAttempt?.status
  const endedAt = sliceAttempt?.endedAt
  useEffect(() => {
    if (attemptId === null) return
    let cancelled = false
    backend
      .getWorkflowAttemptResult(attemptId)
      .then((attempt) => {
        if (!cancelled) setLoaded({ attemptId, attempt })
      })
      .catch(() => {
        if (!cancelled) setLoaded({ attemptId, error: true })
      })
    return () => {
      cancelled = true
    }
  }, [backend, attemptId, status, endedAt])
  if (attemptId === null) return { kind: 'none' }
  if (loaded?.attemptId !== attemptId) return { kind: 'loading' }
  return 'error' in loaded ? { kind: 'error' } : { kind: 'ready', attempt: loaded.attempt }
}

export function RunDetailContainer({
  runId,
  now,
  selectedAttemptId,
  onSelectAttempt,
  onBack,
  onJumpToTab
}: RunDetailContainerProps): JSX.Element {
  const backend = useBackend()
  const run = useWorkflowRun(runId)
  const summary = useWorkflowDefinition(run?.defId ?? null)
  const attempts = useWorkflowRunAttempts(runId)
  const repoRoot = useWorktreeRepoRoot(run?.worktreePath ?? null)
  const fetchKey = useWorkflowRunRecordKey(runId)
  const loaded = useRunRecord(runId, fetchKey)
  const record = loaded?.record ?? null

  const attemptIds = useMemo(() => new Set(record?.attempts.map((a) => a.attemptId) ?? []), [record])
  const latestId = record ? latestAttemptId(record) : null
  const effectiveAttemptId = selectedAttemptId && attemptIds.has(selectedAttemptId) ? selectedAttemptId : latestId
  const selectedAttempt = record?.attempts.find((a) => a.attemptId === effectiveAttemptId) ?? null
  const attemptResult = useAttemptResult(effectiveAttemptId)

  const tabRef = { runId, stepId: selectedAttempt?.stepId ?? '', attemptId: effectiveAttemptId }
  const leaf = useWorkflowStepTabLeaf(run && selectedAttempt ? run.worktreePath : null, tabRef)
  const tab = leaf ? findWorkflowStepTab(leaf, tabRef) : null

  const statusByStep = useMemo(() => {
    const out: Partial<Record<string, WorkflowStepStatus>> = {}
    for (const [id, step] of Object.entries(run?.steps ?? {})) out[id] = step.status
    return out
  }, [run?.steps])

  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmingClean, setConfirmingClean] = useState(false)
  const [cancelStep, setCancelStep] = useState<{ busy: boolean; error: string | null } | null>(null)
  const [markDoneOpen, setMarkDoneOpen] = useState(false)

  const settle = useCallback(async (call: () => Promise<WorkflowActionResponse>) => {
    setBusy(true)
    setActionError(null)
    try {
      const response = await call()
      if ('error' in response) setActionError(response.error)
    } catch {
      setActionError(ACTION_FAILED)
    } finally {
      setBusy(false)
    }
  }, [])

  const closeConfirmClean = useCallback(() => setConfirmingClean(false), [])
  const closeCancelStep = useCallback(() => setCancelStep(null), [])

  const tabExists = tab !== null && !!onJumpToTab
  const model = useMemo(
    () => (record && run ? runDetailModel({ record, run, tabExists, now }) : null),
    [record, run, tabExists, now]
  )
  const stepId = model?.actionStepId ?? null
  const markDoneAvailable = model?.actions.includes('mark-done') ?? false

  useEffect(() => {
    if (!markDoneAvailable) setMarkDoneOpen(false)
  }, [markDoneAvailable])

  if (!run) {
    return (
      <section aria-label="Run detail" className="flex flex-col gap-3">
        <div>
          <button type="button" onClick={onBack} className="text-xs text-muted hover:text-fg-bright cursor-pointer">
            All runs
          </button>
        </div>
        <p className="text-sm text-faint">This run is no longer available.</p>
      </section>
    )
  }

  const card = runCardModel(run, attempts, summary, now)
  const repoName = repoRoot ? repoRoot.split('/').filter(Boolean).at(-1) ?? repoRoot : null
  const location = repoName ? `${repoName} / ${card.worktreeName}` : card.worktreeName

  const onAction = (kind: RunDetailActionKind): void => {
    switch (kind) {
      case 'jump':
        if (tab && onJumpToTab) onJumpToTab(run.worktreePath, tab.leaf.id, tab.tabId)
        return
      case 'cancel-run':
        void settle(() => backend.cancelWorkflowRun(runId))
        return
      case 'mark-done':
        setMarkDoneOpen((open) => !open)
        return
      case 'retry-from-clean':
        if (stepId) setConfirmingClean(true)
        return
      case 'cancel-step':
        if (stepId) setCancelStep({ busy: false, error: null })
        return
      case 'retry':
      case 'skip':
      case 'resume':
        if (stepId) void settle(() => runNeedsYouAction(backend, kind, runId, stepId))
        return
      default: {
        const _exhaustive: never = kind
        return _exhaustive
      }
    }
  }

  const onConfirmClean = (): void => {
    setConfirmingClean(false)
    if (stepId) void settle(() => confirmRetryFromClean(backend, runId, stepId))
  }

  const onConfirmCancelStep = async (): Promise<void> => {
    if (!stepId) return
    setCancelStep({ busy: true, error: null })
    try {
      const response = await backend.cancelWorkflowStep(runId, stepId)
      setCancelStep('error' in response ? { busy: false, error: response.error } : null)
    } catch {
      setCancelStep({ busy: false, error: CANCEL_STEP_FAILED })
    }
  }

  const markDone = (payload: WorkflowMarkDonePayload): Promise<WorkflowActionResponse> =>
    stepId ? backend.markWorkflowStepDone(runId, stepId, payload) : Promise.resolve({ error: ACTION_FAILED })
  const markDoneStep = record?.definition.steps.find((s) => s.id === stepId)
  const showMarkDone = markDoneOpen && markDoneAvailable && stepId !== null

  return (
    <>
      <RunDetail
        card={card}
        runStatus={run.status}
        location={location}
        worktreePath={run.worktreePath}
        steps={record?.definition.steps ?? null}
        statusByStep={statusByStep}
        model={model}
        loadError={loaded !== null && (loaded.error || loaded.record === null)}
        selectedAttemptId={effectiveAttemptId}
        onSelectAttempt={onSelectAttempt}
        attemptResult={attemptResult}
        busy={busy}
        actionError={actionError}
        markDoneOpen={showMarkDone}
        onAction={onAction}
        onBack={onBack}
        markDoneForm={
          showMarkDone ? (
            <MarkDoneForm key={`${stepId}:${latestId}`} step={markDoneStep} active onSubmit={markDone} />
          ) : null
        }
      />
      {confirmingClean && stepId && (
        <RetryFromCleanDialog stepId={stepId} onConfirm={onConfirmClean} onCancel={closeConfirmClean} />
      )}
      {cancelStep && stepId && (
        <CancelStepDialog
          stepId={stepId}
          busy={cancelStep.busy}
          error={cancelStep.error}
          confirmLabel="Cancel step"
          onConfirm={() => void onConfirmCancelStep()}
          onCancel={closeCancelStep}
        />
      )}
    </>
  )
}

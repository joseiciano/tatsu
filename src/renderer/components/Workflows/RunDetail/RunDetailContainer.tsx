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
  WorkflowRequestChangesPayload,
  WorkflowRunRecord,
  WorkflowStepStatus,
  WorkflowSwapStepPayload
} from '../../../../shared/state/workflows'
import { RaiseBudgetForm, RequestChangesDialog, RetryFromCleanDialog, type JumpToTabHandler } from '../NeedsYou'
import { runCardModel, runCostUsd } from '../run-card-model'
import { latestAttemptId, runDetailModel, type RunDetailActionKind } from '../run-detail-model'
import { CancelStepDialog, MarkDoneForm } from '../StepTab'
import { confirmRetryFromClean, displayStepStatus, runNeedsYouAction } from '../workflow-run-helpers'
import { AttemptChangesContainer } from './AttemptChangesContainer'
import type { AttemptResultState } from './AttemptResult'
import { RunDetail } from './RunDetail'
import { SwapStepDialog } from './SwapStepDialog'

const ACTION_FAILED = 'Action failed'
const CANCEL_STEP_FAILED = 'Could not cancel the step'
const SWAP_FAILED = 'Could not swap the step'
const REQUEST_CHANGES_FAILED = 'Could not request changes'

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

const HEAD_SNAPSHOT_RETRY_MS = [250, 500, 1000, 2000, 4000]
const HEAD_SNAPSHOT_WAIT_WINDOW_MS = 30_000

function awaitsHeadSnapshot(attempt: WorkflowAttemptRecord | null): boolean {
  if (!attempt || attempt.headSnapshot || attempt.endedAt === undefined) return false
  if (attempt.status === 'running' || attempt.status === 'interrupted') return false
  return Date.now() - attempt.endedAt < HEAD_SNAPSHOT_WAIT_WINDOW_MS
}

function useAttemptResult(attemptId: string | null): { state: AttemptResultState; snapshotPending: boolean } {
  const backend = useBackend()
  const sliceAttempt = useWorkflowAttempt(attemptId)
  const [loaded, setLoaded] = useState<LoadedAttempt | null>(null)
  const [retry, setRetry] = useState<{ attemptId: string; tries: number } | null>(null)
  const status = sliceAttempt?.status
  const endedAt = sliceAttempt?.endedAt
  const tries = retry !== null && retry.attemptId === attemptId ? retry.tries : 0
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
  }, [backend, attemptId, status, endedAt, tries])
  const current = loaded?.attemptId === attemptId ? loaded : null
  const currentAttempt = current && 'attempt' in current ? current.attempt : null
  const snapshotPending = awaitsHeadSnapshot(currentAttempt) && tries < HEAD_SNAPSHOT_RETRY_MS.length
  useEffect(() => {
    if (attemptId === null || !snapshotPending) return
    const timer = setTimeout(() => setRetry({ attemptId, tries: tries + 1 }), HEAD_SNAPSHOT_RETRY_MS[tries])
    return () => clearTimeout(timer)
  }, [attemptId, snapshotPending, tries])
  if (attemptId === null) return { state: { kind: 'none' }, snapshotPending: false }
  if (current === null) return { state: { kind: 'loading' }, snapshotPending: false }
  if ('error' in current) return { state: { kind: 'error' }, snapshotPending: false }
  return { state: { kind: 'ready', attempt: current.attempt }, snapshotPending }
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
  const { state: attemptResult, snapshotPending } = useAttemptResult(effectiveAttemptId)

  const tabRef = { runId, stepId: selectedAttempt?.stepId ?? '', attemptId: effectiveAttemptId }
  const leaf = useWorkflowStepTabLeaf(run && selectedAttempt ? run.worktreePath : null, tabRef)
  const tab = leaf ? findWorkflowStepTab(leaf, tabRef) : null

  const runStatus = run?.status
  const statusByStep = useMemo(() => {
    const out: Partial<Record<string, WorkflowStepStatus>> = {}
    if (!runStatus) return out
    for (const [id, step] of Object.entries(run?.steps ?? {})) out[id] = displayStepStatus(runStatus, step.status)
    return out
  }, [run?.steps, runStatus])

  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmingClean, setConfirmingClean] = useState(false)
  const [cancelStep, setCancelStep] = useState<{ busy: boolean; error: string | null } | null>(null)
  const [markDoneOpen, setMarkDoneOpen] = useState(false)
  const [swap, setSwap] = useState<{ busy: boolean; error: string | null } | null>(null)
  const [changes, setChanges] = useState<{ busy: boolean; error: string | null } | null>(null)

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
  const closeSwap = useCallback(() => setSwap(null), [])
  const closeChanges = useCallback(() => setChanges(null), [])

  const tabExists = tab !== null && !!onJumpToTab
  const model = useMemo(
    () => (record && run ? runDetailModel({ record, run, attempts, tabExists, now }) : null),
    [record, run, attempts, tabExists, now]
  )
  const stepId = model?.actionStepId ?? null
  const markDoneAvailable = model?.actions.includes('mark-done') ?? false
  const swapAvailable = model?.actions.includes('swap') ?? false
  const changesAvailable = model?.actions.includes('request-changes') ?? false

  useEffect(() => {
    if (!markDoneAvailable) setMarkDoneOpen(false)
  }, [markDoneAvailable])

  useEffect(() => {
    if (!swapAvailable) setSwap((open) => (open?.busy ? open : null))
  }, [swapAvailable])

  useEffect(() => {
    if (!changesAvailable) setChanges((open) => (open?.busy ? open : null))
  }, [changesAvailable])

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
      case 'raise-budget':
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
      case 'swap':
        if (stepId) setSwap({ busy: false, error: null })
        return
      case 'request-changes':
        if (stepId) setChanges({ busy: false, error: null })
        return
      case 'approve':
      case 'loop-again':
      case 'loop-continue':
      case 'keep-waiting':
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

  const onConfirmSwap = async (payload: WorkflowSwapStepPayload): Promise<void> => {
    if (!stepId) return
    setSwap({ busy: true, error: null })
    try {
      const response = await backend.swapWorkflowStep(runId, stepId, payload)
      setSwap('error' in response ? { busy: false, error: response.error } : null)
    } catch {
      setSwap({ busy: false, error: SWAP_FAILED })
    }
  }

  const onRequestChanges = async (payload: WorkflowRequestChangesPayload): Promise<void> => {
    if (!stepId) return
    setChanges({ busy: true, error: null })
    try {
      const response = await backend.requestWorkflowChanges(runId, stepId, payload)
      setChanges('error' in response ? { busy: false, error: response.error } : null)
    } catch {
      setChanges({ busy: false, error: REQUEST_CHANGES_FAILED })
    }
  }

  const markDone = (payload: WorkflowMarkDonePayload): Promise<WorkflowActionResponse> =>
    stepId ? backend.markWorkflowStepDone(runId, stepId, payload) : Promise.resolve({ error: ACTION_FAILED })
  const markDoneStep = record?.definition.steps.find((s) => s.id === stepId)
  const showMarkDone = markDoneOpen && markDoneAvailable && stepId !== null
  const agentStep = markDoneStep?.kind === 'agent' ? markDoneStep : null

  return (
    <>
      <RunDetail
        card={card}
        runStatus={run.status}
        location={location}
        worktreePath={run.worktreePath}
        steps={record?.definition.steps ?? null}
        statusByStep={statusByStep}
        pausedStepId={run.status === 'paused' && run.pausedReason !== 'budget' ? run.cursorStepId : undefined}
        model={model}
        loadError={loaded !== null && (loaded.error || loaded.record === null)}
        selectedAttemptId={effectiveAttemptId}
        onSelectAttempt={onSelectAttempt}
        attemptResult={attemptResult}
        attemptChanges={
          <AttemptChangesContainer
            attemptId={effectiveAttemptId}
            attempt={attemptResult}
            snapshotPending={snapshotPending}
          />
        }
        busy={busy}
        actionError={actionError}
        markDoneOpen={showMarkDone}
        onAction={onAction}
        onBack={onBack}
        budgetForm={
          <RaiseBudgetForm
            totalUsd={runCostUsd(run, attempts) ?? 0}
            budgetUsd={run.budgetUsd}
            busy={busy}
            inputLabel="New budget in USD"
            buttonLabel="Raise budget"
            onSubmit={(usd) => void settle(() => backend.setWorkflowRunBudget(runId, usd))}
          />
        }
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
      {swap && stepId && agentStep && (
        <SwapStepDialog
          stepId={stepId}
          agent={agentStep.agent}
          model={agentStep.model}
          full={agentStep.permissions === 'full'}
          busy={swap.busy}
          error={swap.error}
          onConfirm={(payload) => void onConfirmSwap(payload)}
          onCancel={closeSwap}
        />
      )}
      {changes && stepId && (
        <RequestChangesDialog
          stepId={stepId}
          busy={changes.busy}
          error={changes.error}
          onSubmit={(payload) => void onRequestChanges(payload)}
          onCancel={closeChanges}
        />
      )}
    </>
  )
}

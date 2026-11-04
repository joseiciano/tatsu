import { useCallback, useEffect, useId, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { useBackend } from '../../../backend'
import {
  useAppState,
  usePausedWorkflowRunIds,
  useWorkflowAttempt,
  useWorkflowDefinition,
  useWorkflowRun,
  useWorkflowStepTabLeaf
} from '../../../store'
import { findWorkflowStepTab } from '../../../workflow-selectors'
import {
  confirmRetryFromClean,
  currentStepId,
  needsYouActions,
  pausedReasonLabel,
  recordStepContext,
  runNeedsYouAction,
  sliceStepContext,
  stepOrderFor,
  type NeedsYouActionKind,
  type RecordStepContext
} from '../workflow-run-helpers'
import type { WorkflowActionResponse, WorkflowRequestChangesPayload } from '../../../../shared/state/workflows'
import { RequestChangesDialog } from './RequestChangesDialog'
import { RetryFromCleanDialog } from './RetryFromCleanDialog'

export type JumpToTabHandler = (worktreePath: string, paneId: string, tabId: string) => void

const ACTION_LABELS: Record<NeedsYouActionKind, string> = {
  jump: 'Jump to tab',
  approve: 'Approve',
  'request-changes': 'Request changes',
  'loop-again': 'Loop again',
  'loop-continue': 'Continue anyway',
  'keep-waiting': 'Keep waiting',
  resume: 'Resume',
  retry: 'Retry',
  'retry-from-clean': 'Retry from clean',
  skip: 'Skip',
  cancel: 'Cancel run'
}

const ACTION_FAILED = 'Action failed'

const STEP_NAMED_ACTIONS: ReadonlySet<NeedsYouActionKind> = new Set([
  'approve',
  'request-changes',
  'loop-again',
  'loop-continue',
  'keep-waiting'
])

function actionAriaLabel(kind: NeedsYouActionKind, stepId: string | null, workflowName: string, worktreeName: string): string {
  const where = `${workflowName} on ${worktreeName}`
  return STEP_NAMED_ACTIONS.has(kind) && stepId ? `${ACTION_LABELS[kind]}: ${stepId}, ${where}` : `${ACTION_LABELS[kind]}: ${where}`
}

function useRecordStepContext(runId: string, fetchKey: string, enabled: boolean): RecordStepContext | null {
  const backend = useBackend()
  const [loaded, setLoaded] = useState<{ key: string; value: RecordStepContext | null } | null>(null)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    backend
      .getWorkflowRun(runId)
      .then((record) => {
        if (!cancelled) setLoaded({ key: fetchKey, value: record ? recordStepContext(record) : null })
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key: fetchKey, value: null })
      })
    return () => {
      cancelled = true
    }
  }, [backend, runId, fetchKey, enabled])
  return enabled && loaded?.key === fetchKey ? loaded.value : null
}

function NeedsYouEntry({ runId, onJumpToTab }: { runId: string; onJumpToTab?: JumpToTabHandler }): JSX.Element | null {
  const backend = useBackend()
  const run = useWorkflowRun(runId)
  const summary = useWorkflowDefinition(run?.defId ?? null)
  const sliceStepId = run ? run.cursorStepId ?? currentStepId(run, stepOrderFor(run, summary)) : null
  const lastAttemptId = (sliceStepId && run?.steps[sliceStepId]?.attemptIds.at(-1)) || null
  const lastAttempt = useWorkflowAttempt(lastAttemptId)
  const sliceContext = run ? sliceStepContext(run, lastAttempt) : null
  const fetched = useRecordStepContext(
    runId,
    `${run?.pausedReason}|${lastAttemptId}|${lastAttempt?.status ?? null}`,
    run !== null && (sliceContext === null || run.pausedReason === 'step-failed')
  )
  const context = fetched ?? sliceContext
  const stepId = context?.stepId ?? sliceStepId
  const tabRef = { runId, stepId: stepId ?? '', attemptId: lastAttemptId }
  const leaf = useWorkflowStepTabLeaf(run && stepId ? run.worktreePath : null, tabRef)
  const tab = leaf ? findWorkflowStepTab(leaf, tabRef) : null
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [changes, setChanges] = useState<{ busy: boolean; error: string | null } | null>(null)

  const settle = useCallback(async (call: () => Promise<WorkflowActionResponse>) => {
    setPending(true)
    setError(null)
    try {
      const response = await call()
      if ('error' in response) setError(response.error)
    } catch {
      setError(ACTION_FAILED)
    } finally {
      setPending(false)
    }
  }, [])

  const closeConfirm = useCallback(() => setConfirming(false), [])
  const closeChanges = useCallback(() => setChanges(null), [])

  const reason = run?.status === 'paused' ? run.pausedReason : undefined
  const actions = reason
    ? needsYouActions({
        reason,
        step: context?.step ?? null,
        attempt: context?.attempt ?? null,
        tabExists: tab !== null && !!onJumpToTab
      })
    : []
  const changesAvailable = actions.includes('request-changes')

  useEffect(() => {
    if (!changesAvailable) setChanges((open) => (open?.busy ? open : null))
  }, [changesAvailable])

  if (!run || !reason) return null
  const workflowName = summary?.name ?? run.defId
  const worktreeName = run.worktreePath.split('/').pop() || run.worktreePath

  const onAction = (kind: NeedsYouActionKind): void => {
    if (kind === 'jump') {
      if (tab && onJumpToTab) onJumpToTab(run.worktreePath, tab.leaf.id, tab.tabId)
      return
    }
    if (!stepId) return
    if (kind === 'retry-from-clean') {
      setConfirming(true)
      return
    }
    if (kind === 'request-changes') {
      setChanges({ busy: false, error: null })
      return
    }
    void settle(() => runNeedsYouAction(backend, kind, runId, stepId))
  }

  const onConfirm = (): void => {
    setConfirming(false)
    if (stepId) void settle(() => confirmRetryFromClean(backend, runId, stepId))
  }

  const onRequestChanges = async (payload: WorkflowRequestChangesPayload): Promise<void> => {
    if (!stepId) return
    setChanges({ busy: true, error: null })
    try {
      const response = await backend.requestWorkflowChanges(runId, stepId, payload)
      setChanges('error' in response ? { busy: false, error: response.error } : null)
    } catch {
      setChanges({ busy: false, error: ACTION_FAILED })
    }
  }

  return (
    <li className="px-3 py-1.5 flex flex-col gap-1 min-w-0">
      <div className="flex items-center gap-1.5 min-w-0">
        <AlertCircle className="icon-xs text-warning shrink-0" aria-hidden="true" />
        <span className="text-sm font-medium text-fg-bright truncate" title={workflowName}>
          {workflowName}
        </span>
      </div>
      <div className="text-xs text-faint truncate" title={run.worktreePath}>
        {worktreeName} · <span className="text-warning">{pausedReasonLabel(reason, stepId ? run.steps[stepId]?.status ?? null : null)}</span>
        {stepId ? ` · ${stepId}` : ''}
      </div>
      <div className="flex flex-wrap gap-1">
        {actions.map((kind) => (
          <button
            key={kind}
            type="button"
            disabled={pending || (kind !== 'jump' && !stepId)}
            onClick={() => onAction(kind)}
            aria-label={actionAriaLabel(kind, stepId, workflowName, worktreeName)}
            aria-haspopup={kind === 'request-changes' ? 'dialog' : undefined}
            className={`text-xs px-1.5 py-0.5 rounded border border-border-strong hover:bg-surface transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
              kind === 'cancel' || kind === 'retry-from-clean' ? 'text-danger' : 'text-fg'
            }`}
          >
            {ACTION_LABELS[kind]}
          </button>
        ))}
      </div>
      {error && (
        <div role="alert" className="text-xs text-danger break-words">
          {error}
        </div>
      )}
      {confirming && stepId && (
        <RetryFromCleanDialog stepId={stepId} onConfirm={onConfirm} onCancel={closeConfirm} />
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
    </li>
  )
}

export function NeedsYouGroup({ onJumpToTab }: { onJumpToTab?: JumpToTabHandler }): JSX.Element | null {
  const labsWorkflows = useAppState((s) => s.settings.labs.workflows)
  const runIds = usePausedWorkflowRunIds()
  const headingId = useId()
  if (!labsWorkflows || runIds.length === 0) return null
  return (
    <section aria-labelledby={headingId} className="mb-1 border-b border-border pb-1">
      <h2 id={headingId} className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-warning">
        NEEDS YOU
        <span className="text-faint ml-auto">{runIds.length}</span>
      </h2>
      <ul>
        {runIds.map((runId) => (
          <NeedsYouEntry key={runId} runId={runId} onJumpToTab={onJumpToTab} />
        ))}
      </ul>
    </section>
  )
}

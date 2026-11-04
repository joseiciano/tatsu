import { basename } from 'path'
import type { Store } from '../store'
import type { StateEvent } from '../../shared/state'
import { pausedReasonLabel, type WorkflowPausedReason } from '../../shared/state/workflows'

export interface WorkflowNotification {
  title: string
  body: string
  onClick: () => void
}

export interface WorkflowNotifierDeps {
  store: Pick<Store, 'getSnapshot' | 'subscribe'>
  notify: ((notification: WorkflowNotification) => void) | null
  openSection: () => void
  log: (category: string, message: string, data?: unknown) => void
}

export interface WorkflowNotifier {
  arm: () => void
  dispose: () => void
}

const FALLBACK_TITLE = 'Workflow'

export function createWorkflowNotifier({ store, notify, openSection, log }: WorkflowNotifierDeps): WorkflowNotifier {
  let armed = false
  const notified = new Map<string, WorkflowPausedReason>()

  const onPaused = (runId: string, reason: WorkflowPausedReason): void => {
    if (!armed || !notify) return
    const { state } = store.getSnapshot()
    if (!state.settings.labs.workflows) return
    const run = state.workflows.runs[runId]
    if (!run || run.status !== 'paused' || run.pausedReason !== reason) return
    if (notified.get(runId) === reason) return
    notified.set(runId, reason)
    const stepStatus = run.cursorStepId ? (run.steps[run.cursorStepId]?.status ?? null) : null
    notify({
      title: state.workflows.definitions[run.defId]?.name ?? FALLBACK_TITLE,
      body: `${pausedReasonLabel(reason, stepStatus)} · ${basename(run.worktreePath)}`,
      onClick: openSection
    })
    log('workflow', 'notification sent', { runId, reason })
  }

  const unsubscribe = store.subscribe((event: StateEvent) => {
    switch (event.type) {
      case 'workflows/runPaused':
        onPaused(event.payload.runId, event.payload.reason)
        return
      case 'workflows/runResumed':
      case 'workflows/runCancelled':
      case 'workflows/runFinished':
        notified.delete(event.payload.runId)
        return
      default:
        return
    }
  })

  return {
    arm: () => {
      armed = true
    },
    dispose: unsubscribe
  }
}

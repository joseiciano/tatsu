import type { WorkflowAttempt, WorkflowRun, WorkflowRunStatus, WorkflowsState } from '../../shared/state/workflows'
import type { PaneLeaf, PaneNode } from '../../shared/state/terminals'

export type PausedRunIdsSelector = (workflows: WorkflowsState) => readonly string[]

export type RunAttemptsSelector = (workflows: WorkflowsState, runId: string) => readonly WorkflowAttempt[]

export interface WorkflowStepTabRef {
  runId: string
  stepId: string
  attemptId: string | null
}

export interface WorkflowStepTabMatch {
  leaf: PaneLeaf
  tabId: string
}

const LIVE_RUN_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set(['queued', 'running', 'paused'])

function pausedAt(run: WorkflowRun, attempts: WorkflowsState['attempts']): number {
  let latest = run.startedAt
  for (const step of Object.values(run.steps)) {
    for (const attemptId of step.attemptIds) {
      const attempt = attempts[attemptId]
      if (attempt) latest = Math.max(latest, attempt.endedAt ?? attempt.startedAt)
    }
  }
  return latest
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

export function createPausedRunIdsSelector(): PausedRunIdsSelector {
  let lastRuns: WorkflowsState['runs'] | null = null
  let lastAttempts: WorkflowsState['attempts'] | null = null
  let lastIds: readonly string[] = []
  return ({ runs, attempts }) => {
    if (runs === lastRuns && attempts === lastAttempts) return lastIds
    lastRuns = runs
    lastAttempts = attempts
    const ids = Object.entries(runs)
      .filter(([, run]) => run.status === 'paused')
      .map(([id, run]) => ({ id, at: pausedAt(run, attempts) }))
      .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(({ id }) => id)
    if (!sameIds(ids, lastIds)) lastIds = ids
    return lastIds
  }
}

const NO_ATTEMPTS: readonly WorkflowAttempt[] = []

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i])
}

export function createRunAttemptsSelector(): RunAttemptsSelector {
  const byRun = new Map<string, readonly WorkflowAttempt[]>()
  return ({ runs, attempts }, runId) => {
    const run = runs[runId]
    if (!run) {
      byRun.delete(runId)
      return NO_ATTEMPTS
    }
    const next: WorkflowAttempt[] = []
    for (const step of Object.values(run.steps)) {
      for (const attemptId of step.attemptIds) {
        const attempt = attempts[attemptId]
        if (attempt) next.push(attempt)
      }
    }
    const previous = byRun.get(runId)
    if (previous && sameItems(previous, next)) return previous
    byRun.set(runId, next)
    return next
  }
}

const liveRunIdsByPath = new WeakMap<WorkflowsState['runs'], Map<string, string>>()

export function selectWorkflowRunIdForWorktree(runs: WorkflowsState['runs'], worktreePath: string): string | null {
  let byPath = liveRunIdsByPath.get(runs)
  if (!byPath) {
    byPath = new Map()
    for (const [id, run] of Object.entries(runs)) {
      if (LIVE_RUN_STATUSES.has(run.status) && !byPath.has(run.worktreePath)) byPath.set(run.worktreePath, id)
    }
    liveRunIdsByPath.set(runs, byPath)
  }
  return byPath.get(worktreePath) ?? null
}

export function findWorkflowStepTab(pane: PaneNode | undefined, ref: WorkflowStepTabRef): WorkflowStepTabMatch | null {
  let fallback: WorkflowStepTabMatch | null = null
  const visit = (node: PaneNode): WorkflowStepTabMatch | null => {
    if (node.type === 'split') return visit(node.children[0]) ?? visit(node.children[1])
    for (const tab of node.tabs) {
      const wf = tab.workflow
      if (!wf || wf.runId !== ref.runId || wf.stepId !== ref.stepId) continue
      if (ref.attemptId !== null && wf.attemptId === ref.attemptId) return { leaf: node, tabId: tab.id }
      fallback = { leaf: node, tabId: tab.id }
    }
    return null
  }
  return (pane && visit(pane)) ?? fallback
}

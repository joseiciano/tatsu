import { agentDisplayName } from '../../../../shared/agent-registry'
import type {
  WorkflowAttempt,
  WorkflowDefinitionSummary,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowsState
} from '../../../../shared/state/workflows'
import { currentStepId, pausedReasonLabel, stepOrderFor } from '../workflow-run-helpers'

export interface RunCardModel {
  name: string
  worktreeName: string
  stepId: string | null
  agent: string | null
  status: string
  elapsed: string
  cost: string
}

export interface RunLists {
  active: readonly string[]
  recent: readonly string[]
}

export type RunListsSelector = (runs: WorkflowsState['runs']) => RunLists

const TERMINAL_RUN_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set(['done', 'failed', 'cancelled'])

export const RUN_STATUS_LABELS: Record<WorkflowRunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  paused: 'Paused',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

const NO_COST = '—'

export function isTerminalRun(run: WorkflowRun): boolean {
  return TERMINAL_RUN_STATUSES.has(run.status)
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

export function formatCost(usd: number | undefined): string {
  if (usd === undefined) return NO_COST
  if (usd > 0 && usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

export function runCostUsd(run: WorkflowRun, attempts: readonly WorkflowAttempt[]): number | undefined {
  if (run.costUsd !== undefined) return run.costUsd
  let total: number | undefined
  for (const attempt of attempts) {
    if (attempt.costUsd !== undefined) total = (total ?? 0) + attempt.costUsd
  }
  return total
}

function costLabel(run: WorkflowRun, attempts: readonly WorkflowAttempt[]): string {
  const cost = runCostUsd(run, attempts)
  if (run.budgetUsd === undefined) return formatCost(cost)
  return `${formatCost(cost ?? 0)} of ${formatCost(run.budgetUsd)}`
}

function cardStepId(run: WorkflowRun, summary: WorkflowDefinitionSummary | null): string | null {
  const order = stepOrderFor(run, summary)
  if (run.status !== 'paused') {
    const runningAgent = order.find((id) => run.steps[id]?.status === 'running' && run.steps[id]?.kind === 'agent')
    if (runningAgent !== undefined) return runningAgent
  }
  if (run.cursorStepId !== undefined && run.steps[run.cursorStepId]) return run.cursorStepId
  return currentStepId(run, order)
}

function stepAgent(run: WorkflowRun, stepId: string | null): string | null {
  const step = stepId ? run.steps[stepId] : undefined
  if (step?.kind === 'shell') return 'Shell'
  if (step?.kind === 'agent' && step.agent) return agentDisplayName(step.agent)
  return null
}

function statusLabel(run: WorkflowRun, stepId: string | null): string {
  if (run.status !== 'paused' || !run.pausedReason) return RUN_STATUS_LABELS[run.status]
  const stepStatus = stepId ? run.steps[stepId]?.status ?? null : null
  return `${RUN_STATUS_LABELS.paused} · ${pausedReasonLabel(run.pausedReason, stepStatus)}`
}

export function runCardModel(
  run: WorkflowRun,
  attempts: readonly WorkflowAttempt[],
  summary: WorkflowDefinitionSummary | null,
  now: number
): RunCardModel {
  const stepId = cardStepId(run, summary)
  const end = isTerminalRun(run) ? run.finishedAt ?? now : now
  return {
    name: summary?.name ?? run.defId,
    worktreeName: run.worktreePath.split('/').filter(Boolean).at(-1) ?? run.worktreePath,
    stepId,
    agent: stepAgent(run, stepId),
    status: statusLabel(run, stepId),
    elapsed: formatElapsed(end - run.startedAt),
    cost: costLabel(run, attempts)
  }
}

function byIdTieBreak(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function activeRunIds(runs: WorkflowsState['runs']): string[] {
  return Object.entries(runs)
    .filter(([, run]) => !isTerminalRun(run))
    .sort(([aId, a], [bId, b]) => b.startedAt - a.startedAt || byIdTieBreak(aId, bId))
    .map(([id]) => id)
}

export function recentRunIds(runs: WorkflowsState['runs']): string[] {
  return Object.entries(runs)
    .filter(([, run]) => isTerminalRun(run))
    .map(([id, run]) => ({ id, at: run.finishedAt ?? run.startedAt }))
    .sort((a, b) => b.at - a.at || byIdTieBreak(a.id, b.id))
    .map(({ id }) => id)
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

export function createRunListsSelector(): RunListsSelector {
  let lastRuns: WorkflowsState['runs'] | null = null
  let last: RunLists = { active: [], recent: [] }
  return (runs) => {
    if (runs === lastRuns) return last
    lastRuns = runs
    const active = activeRunIds(runs)
    const recent = recentRunIds(runs)
    if (!sameIds(active, last.active) || !sameIds(recent, last.recent)) last = { active, recent }
    return last
  }
}

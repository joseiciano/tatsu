import { memo, useCallback, useMemo } from 'react'
import { useWorkflowDefinition, useWorkflowRun, useWorkflowRunAttempts, useWorktreeRepoRoot } from '../../../store'
import { runCardModel } from '../run-card-model'
import { deriveStepStrip, stepOrderFor } from '../workflow-run-helpers'
import { RunCard } from './RunCard'

export interface RunCardContainerProps {
  runId: string
  now?: number
  onOpen?: (runId: string) => void
  focusOnMount?: boolean
  onFocused?: () => void
}

export const RunCardContainer = memo(function RunCardContainer({ runId, now, onOpen, focusOnMount, onFocused }: RunCardContainerProps): JSX.Element | null {
  const run = useWorkflowRun(runId)
  const summary = useWorkflowDefinition(run?.defId ?? null)
  const attempts = useWorkflowRunAttempts(runId)
  const repoRoot = useWorktreeRepoRoot(run?.worktreePath ?? null)
  const steps = useMemo(() => (run ? deriveStepStrip(run, stepOrderFor(run, summary)) : []), [run, summary])
  const open = useCallback(() => onOpen?.(runId), [onOpen, runId])
  if (!run) return null
  const model = runCardModel(run, attempts, summary, now ?? run.finishedAt ?? run.startedAt)
  const repoName = repoRoot ? repoRoot.split('/').filter(Boolean).at(-1) ?? repoRoot : null
  return <RunCard model={model} runStatus={run.status} repoName={repoName} worktreePath={run.worktreePath} steps={steps} onOpen={onOpen ? open : undefined} focusOnMount={focusOnMount} onFocused={onFocused} />
})

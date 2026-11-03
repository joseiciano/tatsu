import { memo, useMemo } from 'react'
import { useWorkflowDefinition, useWorkflowRun, useWorkflowRunAttempts, useWorktreeRepoRoot } from '../../../store'
import { runCardModel } from '../run-card-model'
import { deriveStepStrip, stepOrderFor } from '../workflow-run-helpers'
import { RunCard } from './RunCard'

export interface RunCardContainerProps {
  runId: string
  now?: number
}

export const RunCardContainer = memo(function RunCardContainer({ runId, now }: RunCardContainerProps): JSX.Element | null {
  const run = useWorkflowRun(runId)
  const summary = useWorkflowDefinition(run?.defId ?? null)
  const attempts = useWorkflowRunAttempts(runId)
  const repoRoot = useWorktreeRepoRoot(run?.worktreePath ?? null)
  const steps = useMemo(() => (run ? deriveStepStrip(run, stepOrderFor(run, summary)) : []), [run, summary])
  if (!run) return null
  const model = runCardModel(run, attempts, summary, now ?? run.finishedAt ?? run.startedAt)
  const repoName = repoRoot ? repoRoot.split('/').filter(Boolean).at(-1) ?? repoRoot : null
  return <RunCard model={model} runStatus={run.status} repoName={repoName} worktreePath={run.worktreePath} steps={steps} />
})

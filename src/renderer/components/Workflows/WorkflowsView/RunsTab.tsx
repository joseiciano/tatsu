import { useId, type ReactNode } from 'react'
import { Play } from 'lucide-react'
import { RunCardContainer } from '../RunCard'

export interface RunsTabProps {
  needsYou: ReactNode
  activeIds: readonly string[]
  recentIds: readonly string[]
  now: number
  onOpenRun?: (runId: string) => void
  focusRunId?: string | null
  onFocused?: () => void
  onRunWorkflow?: () => void
}

function RunList({
  label,
  heading,
  ids,
  now,
  empty,
  onOpenRun,
  focusRunId,
  onFocused
}: {
  label: string
  heading: string
  ids: readonly string[]
  now?: number
  empty: string
  onOpenRun?: (runId: string) => void
  focusRunId?: string | null
  onFocused?: () => void
}): JSX.Element {
  const headingId = useId()
  return (
    <section aria-label={label} className="flex flex-col gap-2">
      <h2 id={headingId} className="flex items-center gap-1 text-xs font-medium text-dim">
        {heading}
        <span className="text-faint ml-auto">{ids.length}</span>
      </h2>
      {ids.length === 0 ? (
        <p className="text-sm text-faint">{empty}</p>
      ) : (
        <ul aria-labelledby={headingId} className="flex flex-col gap-2">
          {ids.map((runId) => (
            <li key={runId}>
              <RunCardContainer
                runId={runId}
                now={now}
                onOpen={onOpenRun}
                focusOnMount={runId === focusRunId}
                onFocused={runId === focusRunId ? onFocused : undefined}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function RunsTab({
  needsYou,
  activeIds,
  recentIds,
  now,
  onOpenRun,
  focusRunId,
  onFocused,
  onRunWorkflow
}: RunsTabProps): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      {onRunWorkflow && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => onRunWorkflow()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 cursor-pointer transition-colors"
          >
            <Play className="icon-xs" aria-hidden="true" />
            Run workflow…
          </button>
        </div>
      )}
      {needsYou}
      <RunList
        label="Active runs"
        heading="ACTIVE"
        ids={activeIds}
        now={now}
        onOpenRun={onOpenRun}
        focusRunId={focusRunId}
        onFocused={onFocused}
        empty="No active runs. Start one with Run workflow…, or from a worktree's Run workflow here… menu."
      />
      <RunList
        label="Recent runs"
        heading="RECENT"
        ids={recentIds}
        onOpenRun={onOpenRun}
        focusRunId={focusRunId}
        onFocused={onFocused}
        empty="No finished runs yet."
      />
    </div>
  )
}

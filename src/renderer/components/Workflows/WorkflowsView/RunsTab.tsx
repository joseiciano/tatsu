import { useId, type ReactNode } from 'react'
import { RunCardContainer } from '../RunCard'

export interface RunsTabProps {
  needsYou: ReactNode
  activeIds: readonly string[]
  recentIds: readonly string[]
  now: number
}

function RunList({
  label,
  heading,
  ids,
  now,
  empty
}: {
  label: string
  heading: string
  ids: readonly string[]
  now?: number
  empty: string
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
              <RunCardContainer runId={runId} now={now} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function RunsTab({ needsYou, activeIds, recentIds, now }: RunsTabProps): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      {needsYou}
      <RunList
        label="Active runs"
        heading="ACTIVE"
        ids={activeIds}
        now={now}
        empty="No active runs. Start one from a worktree's Run workflow here… menu."
      />
      <RunList label="Recent runs" heading="RECENT" ids={recentIds} empty="No finished runs yet." />
    </div>
  )
}

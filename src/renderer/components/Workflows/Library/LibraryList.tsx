import { useId } from 'react'
import { Copy, Play, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react'
import type { WorkflowDefinitionSummary } from '../../../../shared/state/workflows'
import { isDefinitionTrusted, type LibraryGroup } from './library-groups'

export interface LibraryListProps {
  groups: LibraryGroup[]
  trust: Record<string, string>
  busyId: string | null
  error: string | null
  status: string | null
  onRun: (defId: string) => void
  onDuplicate: (defId: string) => void
  onDelete: (defId: string) => void
}

const ACTION_CLASS =
  'inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-border-strong text-fg hover:bg-panel-raised cursor-pointer transition-colors aria-disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent'

function stepsLabel(stepIds: readonly string[]): string {
  return stepIds.length === 1 ? '1 step' : `${stepIds.length} steps`
}

function DefinitionRow({
  summary,
  trusted,
  busy,
  onRun,
  onDuplicate,
  onDelete
}: {
  summary: WorkflowDefinitionSummary
  trusted: boolean
  busy: boolean
  onRun: (defId: string) => void
  onDuplicate: (defId: string) => void
  onDelete: (defId: string) => void
}): JSX.Element {
  const reasonId = useId()
  const duplicateBlocked = !trusted
  const isRepo = summary.scope === 'repo'
  return (
    <li className="flex flex-col gap-2 rounded border border-border bg-panel-raised/40 px-3 py-2 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1 flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-fg-bright break-words">{summary.name}</span>
          {isRepo &&
            (trusted ? (
              <span className="inline-flex items-center gap-1 rounded border border-success/40 px-1.5 text-xs text-success">
                <ShieldCheck className="icon-xs" aria-hidden="true" />
                Trusted
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded border border-warning/40 px-1.5 text-xs text-warning">
                <ShieldAlert className="icon-xs" aria-hidden="true" />
                Untrusted
              </span>
            ))}
        </div>
        <p className="text-xs text-dim break-words" title={summary.stepIds.join(', ')}>
          {stepsLabel(summary.stepIds)}
          {summary.stepIds.length > 0 && `: ${summary.stepIds.join(', ')}`}
        </p>
        {summary.issues.length > 0 && (
          <ul aria-label={`Problems in ${summary.name}`} className="flex flex-col gap-0.5">
            {summary.issues.map((issue, i) => (
              <li key={i} className="text-xs text-danger break-words">
                {issue}
              </li>
            ))}
          </ul>
        )}
        {duplicateBlocked && (
          <p id={reasonId} className="text-xs text-faint">
            Trust it from Run before duplicating it.
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap gap-1.5">
        <button
          type="button"
          aria-label={`Run ${summary.name}`}
          aria-disabled={busy || undefined}
          onClick={() => {
            if (!busy) onRun(summary.id)
          }}
          className={ACTION_CLASS}
        >
          <Play className="icon-xs" aria-hidden="true" />
          Run
        </button>
        <button
          type="button"
          aria-label={`Duplicate ${summary.name}`}
          aria-disabled={busy || duplicateBlocked || undefined}
          aria-describedby={duplicateBlocked ? reasonId : undefined}
          onClick={() => {
            if (!busy && !duplicateBlocked) onDuplicate(summary.id)
          }}
          className={ACTION_CLASS}
        >
          <Copy className="icon-xs" aria-hidden="true" />
          Duplicate
        </button>
        <button
          type="button"
          aria-label={`Delete ${summary.name}`}
          aria-disabled={busy || undefined}
          onClick={() => {
            if (!busy) onDelete(summary.id)
          }}
          className={ACTION_CLASS}
        >
          <Trash2 className="icon-xs" aria-hidden="true" />
          Delete
        </button>
      </div>
    </li>
  )
}

function GroupSection({
  group,
  trust,
  busyId,
  onRun,
  onDuplicate,
  onDelete
}: Omit<LibraryListProps, 'groups' | 'error' | 'status'> & { group: LibraryGroup }): JSX.Element {
  const headingId = useId()
  return (
    <section aria-label={group.label} className="flex flex-col gap-2">
      <h2 id={headingId} className="flex items-center gap-1 text-xs font-medium text-dim" title={group.repoRoot ?? undefined}>
        {group.label}
        <span className="text-faint ml-auto">{group.definitions.length}</span>
      </h2>
      {group.definitions.length === 0 ? (
        <p className="text-sm text-faint">
          {group.repoRoot === null
            ? 'No personal workflows yet.'
            : 'No workflows in this repository’s .harness/workflows folder.'}
        </p>
      ) : (
        <ul aria-labelledby={headingId} className="flex flex-col gap-2">
          {group.definitions.map((summary) => (
            <DefinitionRow
              key={summary.id}
              summary={summary}
              trusted={isDefinitionTrusted(summary, trust)}
              busy={busyId !== null}
              onRun={onRun}
              onDuplicate={onDuplicate}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

export function LibraryList({ groups, error, status, ...rest }: LibraryListProps): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      {error && (
        <p role="alert" className="text-xs text-danger break-words">
          {error}
        </p>
      )}
      <p role="status" className="sr-only">
        {status ?? ''}
      </p>
      {groups.map((group) => (
        <GroupSection key={group.key} group={group} {...rest} />
      ))}
    </div>
  )
}

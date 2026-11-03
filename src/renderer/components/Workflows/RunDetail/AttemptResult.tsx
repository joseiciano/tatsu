import { useId } from 'react'
import type { WorkflowAttemptRecord } from '../../../../shared/state/workflows'
import { COMPLETED_BY_LABELS } from '../StepTab'
import { STEP_STATUS_LABELS } from '../workflow-run-helpers'

export type AttemptResultState =
  | { kind: 'none' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; attempt: WorkflowAttemptRecord | null }

export interface AttemptResultProps {
  state: AttemptResultState
}

const PRE_CLASS = 'whitespace-pre-wrap break-words font-mono text-xs text-fg max-h-64 overflow-auto'

export function fieldText(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2) ?? String(value)
}

function AttemptBody({ attempt }: { attempt: WorkflowAttemptRecord }): JSX.Element {
  const completedBy = attempt.metrics.completedBy ?? attempt.result?.completedBy
  const summary = attempt.result?.summary ?? ''
  const fields = Object.entries(attempt.result?.data ?? {})
  const exitCode = attempt.result?.exitCode
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-dim">Step</dt>
        <dd className="text-fg break-words">
          {attempt.stepId} · attempt {attempt.n}
        </dd>
        <dt className="text-dim">Status</dt>
        <dd className="text-fg">{STEP_STATUS_LABELS[attempt.status]}</dd>
        <dt className="text-dim">Completed by</dt>
        <dd className="text-fg">{completedBy ? COMPLETED_BY_LABELS[completedBy] : '—'}</dd>
        {exitCode !== undefined && (
          <>
            <dt className="text-dim">Exit code</dt>
            <dd className="text-fg tabular-nums">{exitCode}</dd>
          </>
        )}
      </dl>
      <div className="flex flex-col gap-1">
        <h4 className="text-xs text-dim">Summary</h4>
        {summary ? (
          <pre aria-label="Attempt summary" className={PRE_CLASS}>
            {summary}
          </pre>
        ) : (
          <p className="text-xs text-faint">No summary.</p>
        )}
      </div>
      {fields.length > 0 && (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs text-dim">Output fields</h4>
          <dl className="flex flex-col gap-2">
            {fields.map(([name, value]) => (
              <div key={name} className="flex flex-col gap-0.5 min-w-0">
                <dt className="text-xs text-fg-bright break-words">{name}</dt>
                <dd>
                  <pre className={PRE_CLASS}>{fieldText(value)}</pre>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  )
}

export function AttemptResult({ state }: AttemptResultProps): JSX.Element {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} aria-busy={state.kind === 'loading' || undefined} className="flex flex-col gap-2 min-w-0">
      <h3 id={headingId} className="text-xs font-medium text-dim">
        Attempt result
      </h3>
      <div className="rounded border border-border bg-surface p-3">
        {state.kind === 'none' && <p className="text-xs text-faint">Select an attempt to see its result.</p>}
        {state.kind === 'loading' && <p className="text-xs text-dim">Loading attempt result…</p>}
        {state.kind === 'error' && (
          <p role="alert" className="text-xs text-danger">
            Could not load the attempt result.
          </p>
        )}
        {state.kind === 'ready' &&
          (state.attempt ? (
            <AttemptBody attempt={state.attempt} />
          ) : (
            <p className="text-xs text-faint">This attempt has no stored result.</p>
          ))}
      </div>
    </section>
  )
}

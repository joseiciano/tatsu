import { useState, type FormEvent } from 'react'
import { WORKFLOW_BUDGET_MAX_USD } from '../../../../shared/state/workflows'
import { budgetFloorUsd, parseBudgetInput, suggestedBudgetUsd } from '../workflow-run-helpers'

export interface RaiseBudgetFormProps {
  totalUsd: number
  budgetUsd: number | undefined
  busy: boolean
  inputLabel: string
  buttonLabel: string
  onSubmit: (budgetUsd: number) => void
}

export function RaiseBudgetForm({
  totalUsd,
  budgetUsd,
  busy,
  inputLabel,
  buttonLabel,
  onSubmit
}: RaiseBudgetFormProps): JSX.Element {
  const [edited, setEdited] = useState<string | null>(null)
  const text = edited ?? suggestedBudgetUsd(totalUsd, budgetUsd).toFixed(2)
  const value = parseBudgetInput(text, totalUsd)

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (value !== null && !busy) onSubmit(value)
  }

  return (
    <form onSubmit={submit} className="flex items-center gap-1">
      <span className="text-xs text-faint" aria-hidden="true">
        $
      </span>
      <input
        type="number"
        inputMode="decimal"
        min={budgetFloorUsd(totalUsd)}
        max={WORKFLOW_BUDGET_MAX_USD}
        step="0.01"
        required
        value={text}
        onChange={(event) => setEdited(event.target.value)}
        aria-label={inputLabel}
        aria-invalid={value === null}
        className="w-20 text-xs px-1 py-0.5 rounded border border-border-strong bg-surface text-fg tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      <button
        type="submit"
        disabled={busy || value === null}
        aria-label={buttonLabel}
        className="text-xs px-1.5 py-0.5 rounded border border-border-strong text-fg hover:bg-surface transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Raise budget
      </button>
    </form>
  )
}

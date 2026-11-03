import { useId } from 'react'
import { Loader2, ShieldCheck } from 'lucide-react'
import type { TrustStepRow } from '../launch-sheet-helpers'

export interface TrustPanelProps {
  source: string
  rows: TrustStepRow[]
  trusting: boolean
  disabled: boolean
  onTrust: () => void
}

export function TrustPanel({ source, rows, trusting, disabled, onTrust }: TrustPanelProps): JSX.Element {
  const headingId = `${useId()}-trust`
  return (
    <section
      aria-labelledby={headingId}
      className="space-y-3 rounded border border-warning/40 bg-warning/10 px-3 py-3"
    >
      <div className="space-y-1">
        <h3 id={headingId} className="text-xs font-semibold text-fg-bright">
          Trust this repo workflow?
        </h3>
        <p className="text-xs text-dim leading-relaxed">
          This definition comes from the repository. Review what it runs before trusting it. Any later edit to the
          file needs a new review.
        </p>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-dim">
            <th scope="col" className="font-medium pb-1">
              Step
            </th>
            <th scope="col" className="font-medium pb-1">
              Agent
            </th>
            <th scope="col" className="font-medium pb-1">
              Permission
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="text-fg align-top">
              <td className="pr-2 py-0.5 font-mono break-all">{row.id}</td>
              <td className="pr-2 py-0.5">{row.agent}</td>
              <td className="py-0.5 break-words">{row.permission}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <pre
        tabIndex={0}
        aria-label="Definition source"
        className="max-h-48 overflow-auto rounded border border-border bg-app/60 px-2.5 py-2 text-xs font-mono text-fg whitespace-pre focus:outline-none focus:border-accent"
      >
        {source}
      </pre>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onTrust}
          disabled={disabled || trusting}
          className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded bg-warning/20 hover:bg-warning/30 text-fg-bright border border-warning/40 cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-default"
        >
          {trusting ? <Loader2 className="icon-xs animate-spin" /> : <ShieldCheck className="icon-xs" />}
          Trust this definition
        </button>
      </div>
    </section>
  )
}

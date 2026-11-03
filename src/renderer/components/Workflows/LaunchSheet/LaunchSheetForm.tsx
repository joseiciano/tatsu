import { useId, useRef } from 'react'
import { Loader2, Play, ShieldAlert, X } from 'lucide-react'
import type { HooksConsent } from '../../../../shared/state/hooks'
import { useFocusTrap } from '../../../hooks/useFocusTrap'
import type { LaunchInputField } from '../launch-sheet-helpers'

export interface LaunchSheetOption {
  id: string
  name: string
  issue: string | null
}

export interface LaunchSheetFormProps {
  worktreeLabel: string
  options: LaunchSheetOption[]
  selectedId: string
  fields: LaunchInputField[]
  inputs: Record<string, string>
  consent: HooksConsent
  installingHooks: boolean
  needsFull: boolean
  allowFull: boolean
  blockReason: string | null
  submitting: boolean
  error: string | null
  onSelect: (id: string) => void
  onInputChange: (name: string, value: string) => void
  onInstallHooks: () => void
  onAllowFullChange: (allowFull: boolean) => void
  onStart: () => void
  onClose: () => void
}

const FIELD_CLASS =
  'w-full bg-app/40 border border-border rounded px-2.5 py-1.5 text-xs text-fg-bright placeholder:text-faint focus:outline-none focus:border-accent disabled:opacity-50'
const LABEL_CLASS = 'block text-xs font-medium text-dim uppercase tracking-wider'

function optionLabel({ name, issue }: LaunchSheetOption): string {
  return issue === null ? name : `${name} (${issue})`
}

export function LaunchSheetForm({
  worktreeLabel,
  options,
  selectedId,
  fields,
  inputs,
  consent,
  installingHooks,
  needsFull,
  allowFull,
  blockReason,
  submitting,
  error,
  onSelect,
  onInputChange,
  onInstallHooks,
  onAllowFullChange,
  onStart,
  onClose
}: LaunchSheetFormProps): JSX.Element {
  const baseId = useId()
  const titleId = `${baseId}-title`
  const reasonId = `${baseId}-reason`

  const dialogRef = useRef<HTMLDivElement | null>(null)
  const selectRef = useRef<HTMLSelectElement | null>(null)

  useFocusTrap(dialogRef, { active: true, onEscape: onClose, initialFocus: selectRef })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app/80 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="bg-panel border border-border rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden flex flex-col max-h-[85vh] outline-none"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-semibold text-fg-bright">
              Run workflow
            </h2>
            <div className="text-xs text-dim truncate">in {worktreeLabel}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-dim hover:text-fg transition-colors cursor-pointer"
            aria-label="Close"
          >
            <X className="icon-sm" />
          </button>
        </div>

        <form
          className="px-5 py-4 space-y-4 overflow-y-auto"
          onSubmit={(e) => {
            e.preventDefault()
            if (blockReason === null) onStart()
          }}
        >
          {options.length === 0 ? (
            <p className="text-xs text-dim leading-relaxed">
              No workflows found. Add a workflow definition to your personal workflows folder, then try again.
            </p>
          ) : (
            <div className="space-y-1.5">
              <label htmlFor={`${baseId}-def`} className={LABEL_CLASS}>
                Workflow
              </label>
              <select
                ref={selectRef}
                id={`${baseId}-def`}
                value={selectedId}
                onChange={(e) => onSelect(e.target.value)}
                disabled={submitting}
                className={`${FIELD_CLASS} cursor-pointer`}
              >
                {selectedId === '' && <option value="">Choose a workflow</option>}
                {options.map((option) => (
                  <option key={option.id} value={option.id} disabled={option.issue !== null}>
                    {optionLabel(option)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {fields.map((field) => {
            const id = `${baseId}-input-${field.name}`
            const common = {
              id,
              value: inputs[field.name] ?? '',
              disabled: submitting,
              required: true,
              spellCheck: false
            }
            return (
              <div key={field.name} className="space-y-1.5">
                <label htmlFor={id} className={LABEL_CLASS}>
                  {field.name}
                  <span className="ml-1.5 normal-case tracking-normal text-faint">{field.type}</span>
                </label>
                {field.control === 'textarea' ? (
                  <textarea
                    {...common}
                    rows={3}
                    onChange={(e) => onInputChange(field.name, e.target.value)}
                    className={`${FIELD_CLASS} resize-y`}
                  />
                ) : (
                  <input
                    {...common}
                    type="text"
                    onChange={(e) => onInputChange(field.name, e.target.value)}
                    className={`${FIELD_CLASS} font-mono`}
                  />
                )}
              </div>
            )
          })}

          {needsFull && (
            <label className="flex items-start gap-2 rounded border border-warning/40 bg-warning/10 px-3 py-2 cursor-pointer">
              <input
                type="checkbox"
                checked={allowFull}
                onChange={(e) => onAllowFullChange(e.target.checked)}
                disabled={submitting}
                className="mt-0.5 icon-base cursor-pointer"
              />
              <span className="text-xs text-fg">
                <span className="flex items-center gap-1 font-medium text-fg-bright">
                  <ShieldAlert className="icon-xs text-warning" />
                  Allow full access for this run
                </span>
                A step in this workflow runs an agent with full permissions.
              </span>
            </label>
          )}

          {consent !== 'accepted' && (
            <div className="flex items-center justify-between gap-3 rounded border border-border bg-app/40 px-3 py-2">
              <span className="text-xs text-dim">Workflows need Tatsu's status hooks installed.</span>
              <button
                type="button"
                onClick={onInstallHooks}
                disabled={installingHooks}
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-default"
              >
                {installingHooks && <Loader2 className="icon-xs animate-spin" />}
                Install hooks
              </button>
            </div>
          )}

          {error !== null && (
            <div role="alert" className="text-xs text-danger break-words">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-1">
            {blockReason !== null && (
              <span id={reasonId} className="text-xs text-dim mr-auto">
                {blockReason}
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-medium rounded text-dim hover:text-fg cursor-pointer transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={blockReason !== null}
              aria-describedby={blockReason !== null ? reasonId : undefined}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-default"
            >
              {submitting ? <Loader2 className="icon-xs animate-spin" /> : <Play className="icon-xs" />}
              Start
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

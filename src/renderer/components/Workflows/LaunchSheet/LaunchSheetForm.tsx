import { useEffect, useId, useRef } from 'react'
import { Loader2, Play, ShieldAlert, X } from 'lucide-react'
import type { HooksConsent } from '../../../../shared/state/hooks'
import { useFocusTrap } from '../../../hooks/useFocusTrap'
import type { ExistingWorktreeOption, LaunchInputField, TrustStepRow } from '../launch-sheet-helpers'
import { TrustPanel } from './TrustPanel'

export interface LaunchSheetOption {
  id: string
  name: string
  issue: string | null
  repo: boolean
}

export interface LaunchSheetTrust {
  source: string
  rows: TrustStepRow[]
  trusting: boolean
}

export type TargetMode = 'new' | 'existing'

export type LaunchSheetTargetView =
  | { kind: 'preset'; label: string }
  | {
      kind: 'choose'
      repos: { root: string; label: string }[]
      repoRoot: string | null
      mode: TargetMode
      branchName: string
      branchInvalid: boolean
      existing: ExistingWorktreeOption[]
      existingPath: string | null
    }

export interface LaunchSheetFormProps {
  target: LaunchSheetTargetView
  options: LaunchSheetOption[]
  selectedId: string
  fields: LaunchInputField[]
  inputs: Record<string, string>
  consent: HooksConsent
  installingHooks: boolean
  needsFull: boolean
  allowFull: boolean
  trust: LaunchSheetTrust | null
  blockReason: string | null
  submitting: boolean
  error: string | null
  onSelect: (id: string) => void
  onRepoChange: (repoRoot: string) => void
  onModeChange: (mode: TargetMode) => void
  onBranchChange: (value: string) => void
  onExistingChange: (worktreePath: string) => void
  onInputChange: (name: string, value: string) => void
  onInstallHooks: () => void
  onAllowFullChange: (allowFull: boolean) => void
  onTrust: () => void
  onStart: () => void
  onClose: () => void
}

const FIELD_CLASS =
  'w-full bg-app/40 border border-border rounded px-2.5 py-1.5 text-xs text-fg-bright placeholder:text-faint focus:outline-none focus:border-accent disabled:opacity-50'
const LABEL_CLASS = 'block text-xs font-medium text-dim uppercase tracking-wider'

function optionLabel({ name, issue, repo }: LaunchSheetOption): string {
  const label = repo ? `${name} (repo)` : name
  return issue === null ? label : `${label} (${issue})`
}

const MODE_OPTIONS: { mode: TargetMode; label: string }[] = [
  { mode: 'new', label: 'New worktree' },
  { mode: 'existing', label: 'Existing worktree' }
]

export function LaunchSheetForm({
  target,
  options,
  selectedId,
  fields,
  inputs,
  consent,
  installingHooks,
  needsFull,
  allowFull,
  trust,
  blockReason,
  submitting,
  error,
  onSelect,
  onRepoChange,
  onModeChange,
  onBranchChange,
  onExistingChange,
  onInputChange,
  onInstallHooks,
  onAllowFullChange,
  onTrust,
  onStart,
  onClose
}: LaunchSheetFormProps): JSX.Element {
  const baseId = useId()
  const titleId = `${baseId}-title`
  const reasonId = `${baseId}-reason`

  const dialogRef = useRef<HTMLDivElement | null>(null)
  const selectRef = useRef<HTMLSelectElement | null>(null)
  const repoRef = useRef<HTMLSelectElement | null>(null)
  const startRef = useRef<HTMLButtonElement | null>(null)
  const trustShown = trust !== null
  const trustWasShown = useRef(trustShown)

  useFocusTrap(dialogRef, {
    active: true,
    onEscape: onClose,
    initialFocus: target.kind === 'preset' ? selectRef : repoRef
  })

  useEffect(() => {
    if (trustWasShown.current && !trustShown && !startRef.current?.disabled) startRef.current?.focus()
    trustWasShown.current = trustShown
  }, [trustShown])

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
            <div className="text-xs text-dim truncate">
              {target.kind === 'preset' ? `in ${target.label}` : 'Choose where it runs'}
            </div>
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
          {target.kind === 'choose' && (
            <fieldset className="space-y-3 rounded border border-border px-3 pt-2 pb-3">
              <legend className={`${LABEL_CLASS} px-1`}>Target</legend>
              {target.repos.length === 0 ? (
                <p className="text-xs text-dim leading-relaxed">Add a repository to Tatsu first.</p>
              ) : (
                <div className="space-y-1.5">
                  <label htmlFor={`${baseId}-repo`} className={LABEL_CLASS}>
                    Repository
                  </label>
                  <select
                    ref={repoRef}
                    id={`${baseId}-repo`}
                    value={target.repoRoot ?? ''}
                    onChange={(e) => onRepoChange(e.target.value)}
                    disabled={submitting}
                    className={`${FIELD_CLASS} cursor-pointer`}
                  >
                    {target.repos.map(({ root, label }) => (
                      <option key={root} value={root} title={root}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div role="radiogroup" aria-label="Where to run" className="flex gap-4">
                {MODE_OPTIONS.map(({ mode, label }) => (
                  <label key={mode} className="flex items-center gap-1.5 text-xs text-fg cursor-pointer">
                    <input
                      type="radio"
                      name={`${baseId}-mode`}
                      value={mode}
                      checked={target.mode === mode}
                      onChange={() => onModeChange(mode)}
                      disabled={submitting}
                      className="icon-base cursor-pointer"
                    />
                    {label}
                  </label>
                ))}
              </div>
              {target.mode === 'new' ? (
                <div className="space-y-1.5">
                  <label htmlFor={`${baseId}-branch`} className={LABEL_CLASS}>
                    Branch name
                  </label>
                  <input
                    id={`${baseId}-branch`}
                    type="text"
                    value={target.branchName}
                    onChange={(e) => onBranchChange(e.target.value)}
                    disabled={submitting}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={target.branchInvalid || undefined}
                    aria-describedby={target.branchInvalid && blockReason !== null ? reasonId : undefined}
                    className={`${FIELD_CLASS} font-mono`}
                  />
                </div>
              ) : target.existing.length === 0 ? (
                <p className="text-xs text-dim leading-relaxed">
                  Every worktree in this repository has a workflow in progress.
                </p>
              ) : (
                <div className="space-y-1.5">
                  <label htmlFor={`${baseId}-existing`} className={LABEL_CLASS}>
                    Worktree
                  </label>
                  <select
                    id={`${baseId}-existing`}
                    value={target.existingPath ?? ''}
                    onChange={(e) => onExistingChange(e.target.value)}
                    disabled={submitting}
                    className={`${FIELD_CLASS} cursor-pointer`}
                  >
                    {target.existing.map(({ path, label }) => (
                      <option key={path} value={path} title={path}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </fieldset>
          )}

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

          {trust !== null && (
            <TrustPanel
              source={trust.source}
              rows={trust.rows}
              trusting={trust.trusting}
              disabled={submitting}
              onTrust={onTrust}
            />
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
              ref={startRef}
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

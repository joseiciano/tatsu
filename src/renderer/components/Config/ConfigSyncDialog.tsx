import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { LinkedBadge } from './ConfigResourceList'
import type {
  ConfigSyncChangedRow,
  ConfigSyncDialogProps,
  ConfigSyncFileRow,
  ConfigSyncFragmentEditRow,
  ConfigSyncFragmentErrorRow,
  ConfigSyncRenderErrorRow
} from './types'
import type { HarnessConfigFragmentResolution } from '../../../shared/state/harness-config'

const STATUS_LABEL: Record<string, string> = {
  synced: 'Synced',
  'config-only': 'Not on disk',
  conflict: 'Out of sync'
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function isTemplateRow(row: ConfigSyncFileRow): boolean {
  return row.ref.source === 'template'
}

function FileRowView({
  row,
  scopeLabel,
  note
}: {
  row: ConfigSyncFileRow
  scopeLabel: string
  note?: string
}): JSX.Element {
  const fromTemplate = isTemplateRow(row)
  return (
    <div className="flex flex-col gap-0.5 rounded border border-border/60 bg-app/30 px-2.5 py-2 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-fg-bright truncate">{row.ref.label}</span>
        <span className="text-xs text-faint shrink-0">{row.sourceLabel}</span>
      </div>
      <span className="text-xs text-dim break-all">{row.ref.relativePath}</span>
      {fromTemplate && row.ref.templateRef && (
        <span className="text-xs text-info break-all">Template: {row.ref.templateRef}</span>
      )}
      {row.ref.linkedFrom && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-faint min-w-0">
          <LinkedBadge linkedFrom={row.ref.linkedFrom} />
          <span className="break-all">{row.ref.linkedFrom}</span>
        </div>
      )}
      {note && <span className="text-xs text-dim">{note}</span>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-faint">
        <span>{scopeLabel}</span>
        <span>{row.updatedAtLabel}</span>
        <span title={row.hashFullLabel} aria-label={row.hashFullLabel}>
          {row.hashShortLabel}
        </span>
      </div>
    </div>
  )
}

function DiffSection({
  title,
  rows,
  emptyLabel,
  scopeLabel
}: {
  title: string
  rows: readonly ConfigSyncFileRow[]
  emptyLabel: string
  scopeLabel: string
}): JSX.Element {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold text-fg-bright uppercase tracking-wide">
        {title} <span className="text-faint normal-case font-normal">({rows.length})</span>
      </h3>
      {rows.length === 0 ? (
        <div className="text-xs text-faint px-2.5 py-2">{emptyLabel}</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((row) => (
            <FileRowView key={row.key} row={row} scopeLabel={scopeLabel} />
          ))}
        </div>
      )}
    </section>
  )
}

function DetachChoice({
  row,
  detach,
  disabled,
  onChange
}: {
  row: ConfigSyncChangedRow
  detach: boolean
  disabled: boolean
  onChange: (id: string, detach: boolean) => void
}): JSX.Element {
  const id = row.config.ref.id
  const name = `config-sync-detach-${id}`
  return (
    <fieldset className="sm:col-span-2 flex flex-col gap-1 px-1 text-xs text-dim">
      <legend className="sr-only">Sync choice for {row.config.ref.label}</legend>
      <span>
        This file differs from {row.config.ref.templateRef ?? 'its template'}. Choose what sync does with it:
      </span>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="radio"
            name={name}
            className="icon-base"
            checked={!detach}
            disabled={disabled}
            onChange={() => onChange(id, false)}
          />
          Overwrite it from the template
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="radio"
            name={name}
            className="icon-base"
            checked={detach}
            disabled={disabled}
            onChange={() => onChange(id, true)}
          />
          Keep the disk file and detach it from the template
        </label>
      </div>
    </fieldset>
  )
}

function ChangedSection({
  rows,
  scopeLabel,
  detachIds,
  choicesDisabled,
  onDetachChange
}: {
  rows: readonly ConfigSyncChangedRow[]
  scopeLabel: string
  detachIds: ReadonlySet<string>
  choicesDisabled: boolean
  onDetachChange: (id: string, detach: boolean) => void
}): JSX.Element {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold text-fg-bright uppercase tracking-wide">
        Content changed <span className="text-faint normal-case font-normal">({rows.length})</span>
      </h3>
      {rows.length === 0 ? (
        <div className="text-xs text-faint px-2.5 py-2">No content-changed files</div>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((pair) => (
            <div
              key={pair.key}
              className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 rounded border border-border/60 p-1.5"
            >
              <FileRowView row={pair.disk} scopeLabel={scopeLabel} />
              <FileRowView row={pair.config} scopeLabel={scopeLabel} />
              {isTemplateRow(pair.config) && (
                <DetachChoice
                  row={pair}
                  detach={detachIds.has(pair.config.ref.id)}
                  disabled={choicesDisabled}
                  onChange={onDetachChange}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function RenderErrorSection({
  rows,
  scopeLabel
}: {
  rows: readonly ConfigSyncRenderErrorRow[]
  scopeLabel: string
}): JSX.Element | null {
  if (rows.length === 0) return null
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold text-danger uppercase tracking-wide">
        Template errors <span className="text-faint normal-case font-normal">({rows.length})</span>
      </h3>
      {rows.map((row) => (
        <div key={row.key} className="flex flex-col gap-1.5 rounded border border-danger/40 p-1.5">
          <div className="text-xs text-fg-bright">{row.templateRef}</div>
          <div className="text-xs text-danger break-words">{row.message}</div>
          <div className="text-xs text-dim">
            This template builds nothing until the error is fixed.{' '}
            {row.held.length > 0
              ? 'Its earlier files stay on disk: sync to disk leaves them alone.'
              : 'Nothing it built earlier is on disk.'}
          </div>
          {row.held.map((held) => (
            <FileRowView key={held.key} row={held} scopeLabel={scopeLabel} />
          ))}
        </div>
      ))}
    </section>
  )
}

function FragmentErrorSection({
  rows,
  scopeLabel
}: {
  rows: readonly ConfigSyncFragmentErrorRow[]
  scopeLabel: string
}): JSX.Element | null {
  if (rows.length === 0) return null
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold text-danger uppercase tracking-wide">
        Fragment errors <span className="text-faint normal-case font-normal">({rows.length})</span>
      </h3>
      {rows.map((row) => (
        <div key={row.key} className="flex flex-col gap-1.5 rounded border border-danger/40 p-1.5">
          <div className="text-xs text-fg-bright">{row.label}</div>
          <span className="text-xs text-dim break-all">{row.relativePath}</span>
          <div className="text-xs text-danger break-words">{row.message}</div>
          <div className="text-xs text-dim">
            Sync to disk leaves this file as it is until its fragment placeholders are fixed.
          </div>
          {row.held && <FileRowView row={row.held} scopeLabel={scopeLabel} />}
        </div>
      ))}
    </section>
  )
}

const FRAGMENT_RESOLUTIONS: ReadonlyArray<{ resolution: HarnessConfigFragmentResolution; label: string; hint: string }> = [
  { resolution: 'overwrite', label: 'Use fragment', hint: 'Replace the edited text with the fragment' },
  { resolution: 'keep-edit', label: 'Save edit to fragment', hint: 'Every file using the fragment gets this text' },
  { resolution: 'detach', label: 'Detach', hint: 'Keep the text here as plain text, no longer linked to the fragment' }
]

function FragmentEditSection({
  rows,
  disabled,
  onResolve
}: {
  rows: readonly ConfigSyncFragmentEditRow[]
  disabled: boolean
  onResolve: (id: string, fragment: string, resolution: HarnessConfigFragmentResolution) => void
}): JSX.Element | null {
  if (rows.length === 0) return null
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold text-fg-bright uppercase tracking-wide">
        Edited fragment sections <span className="text-faint normal-case font-normal">({rows.length})</span>
      </h3>
      {rows.map((row) => (
        <div key={row.key} className="flex flex-col gap-1.5 rounded border border-border/60 p-1.5">
          <div className="text-xs text-fg-bright">{row.label}</div>
          <span className="text-xs text-dim break-all">{row.relativePath}</span>
          {row.fragments.map((fragment) => (
            <div key={fragment} className="flex flex-col gap-1">
              <span className="text-xs text-dim">
                The <span className="text-fg-bright">{fragment}</span> section was edited by hand, so it no
                longer follows the fragment.
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                {FRAGMENT_RESOLUTIONS.map((option) => (
                  <button
                    key={option.resolution}
                    type="button"
                    title={option.hint}
                    disabled={disabled}
                    onClick={() => onResolve(row.id, fragment, option.resolution)}
                    className="px-2 py-1 text-xs rounded bg-app/40 hover:bg-app/60 text-fg-bright border border-border cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
    </section>
  )
}

/** Scoped conflict review + confirmed-apply dialog (Step 9). Stays
 *  presentational: every backend call, plan, and race guard lives in
 *  `Config.tsx` (REQ-010). This component only renders the supplied
 *  review, reports the sync outcome through props, and owns its own
 *  focus/keyboard/ARIA behavior (REQ-024, REQ-025, PAT-001). */
export function ConfigSyncDialog({
  open,
  review,
  agentDisplayName,
  resourceLabel,
  stage,
  reviewUsable,
  actionError,
  actionNotice,
  detachIds,
  onDetachChange,
  onResolveFragmentEdit,
  onSyncToDisk,
  onCancel
}: ConfigSyncDialogProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const dismissDisabled = stage === 'applying'

  // REQ-024: remember the invoking control and move focus to the safe
  // default (Cancel) on open; restore focus to it on unmount if it's
  // still connected to the document.
  useEffect(() => {
    if (!open) return
    restoreFocusRef.current = document.activeElement as HTMLElement | null
    cancelRef.current?.focus()
    return () => {
      const previous = restoreFocusRef.current
      if (previous && document.contains(previous)) previous.focus()
    }
  }, [open])

  // REQ-024/REQ-025: trap Tab/Shift+Tab among enabled controls and route
  // Escape through `onCancel` — the same no-op path as Cancel/backdrop.
  // No Enter handling here: native Enter/Space activation only fires
  // when an action button itself already has focus.
  useEffect(() => {
    if (!open || !dismissDisabled) return
    const panel = panelRef.current
    if (panel && !panel.contains(document.activeElement)) panel.focus()
  }, [open, dismissDisabled])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (dismissDisabled) return
        e.preventDefault()
        e.stopPropagation()
        onCancel()
        return
      }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      if (focusable.length === 0) {
        e.preventDefault()
        panel.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (e.shiftKey) {
        if (active === first || !(active instanceof Node) || !panel.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last || !(active instanceof Node) || !panel.contains(active)) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onCancel, dismissDisabled])

  if (!open || !review) return null

  const mutationsDisabled = stage !== 'idle' || !reviewUsable
  const scopeLabel = `${agentDisplayName} · ${resourceLabel}`
  const titleId = 'config-sync-dialog-title'
  const descId = 'config-sync-dialog-desc'
  const hasLinked =
    review.sections.configOnly.some((row) => row.ref.linkedFrom) ||
    review.sections.changed.some((pair) => pair.disk.ref.linkedFrom || pair.config.ref.linkedFrom)
  const hasTemplateRows =
    review.sections.configOnly.some(isTemplateRow) || review.sections.changed.some((pair) => isTemplateRow(pair.config))
  const busyLabel = stage === 'planning' ? 'Preparing plan…' : stage === 'applying' ? 'Applying…' : null

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center pt-[10vh] px-4 bg-black/40"
      onClick={() => {
        if (!dismissDisabled) onCancel()
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl max-h-[80vh] outline-none bg-surface rounded-xl shadow-2xl border border-border overflow-hidden flex flex-col"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <h2 id={titleId} className="text-sm font-semibold text-fg-bright truncate">
            {scopeLabel}
          </h2>
          <button
            type="button"
            disabled={dismissDisabled}
            onClick={onCancel}
            aria-label="Close"
            className="text-dim hover:text-fg p-1 rounded transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 shrink-0"
          >
            <X className="icon-base" />
          </button>
        </div>

        <div id={descId} className="px-4 py-3 flex flex-col gap-3 text-sm overflow-y-auto min-h-0">
          <div className="text-xs text-dim">
            Status:{' '}
            <span className="text-fg-bright font-medium">
              {STATUS_LABEL[review.status] ?? review.status}
            </span>{' '}
            · Compared {review.timestampLabel}
          </div>

          <div className="flex flex-col gap-1.5 text-xs text-dim bg-app/30 rounded px-2.5 py-2">
            <p>
              <span className="text-fg-bright font-medium">Sync to disk</span> writes template
              output that is missing or out of date and refreshes fragment sections in your files,
              backing up every file before it's overwritten. It never deletes a file.
            </p>
            {hasTemplateRows && (
              <p>
                <span className="text-fg-bright font-medium">Template</span> entries are built from
                a template in the template source folder. For each template file that differs on
                disk, choose to overwrite it from the template or keep the disk file and detach it
                from the template.
              </p>
            )}
            {hasLinked && (
              <p>
                <span className="text-fg-bright font-medium">Linked</span> entries are symbolic links
                into another folder, such as a dotfiles build. Sync to disk writes through the link
                to that folder and keeps the link in place. A build that regenerates that folder can
                overwrite what Tatsu writes.
              </p>
            )}
          </div>

          <DiffSection
            title="Not on disk"
            rows={review.sections.configOnly}
            emptyLabel="No missing files"
            scopeLabel={scopeLabel}
          />
          <ChangedSection
            rows={review.sections.changed}
            scopeLabel={scopeLabel}
            detachIds={detachIds}
            choicesDisabled={mutationsDisabled}
            onDetachChange={onDetachChange}
          />
          <RenderErrorSection rows={review.sections.renderErrors} scopeLabel={scopeLabel} />
          <FragmentErrorSection rows={review.sections.fragmentErrors} scopeLabel={scopeLabel} />
          <FragmentEditSection
            rows={review.sections.fragmentEdits}
            disabled={mutationsDisabled}
            onResolve={onResolveFragmentEdit}
          />

          <div aria-live="polite" className="flex flex-col gap-1">
            {actionNotice && <div className="text-xs text-info">{actionNotice}</div>}
            {actionError && <div className="text-xs text-danger">{actionError}</div>}
            {busyLabel && <div className="text-xs text-dim">{busyLabel}</div>}
          </div>
        </div>

        <div className="px-4 py-3 border-t border-border flex flex-wrap items-center justify-end gap-2 shrink-0">
          <button
            ref={cancelRef}
            type="button"
            disabled={dismissDisabled}
            onClick={onCancel}
            className="px-3 py-1.5 text-xs text-dim hover:text-fg cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={mutationsDisabled}
            aria-busy={stage !== 'idle'}
            onClick={onSyncToDisk}
            className="px-3 py-1.5 text-xs font-medium rounded bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          >
            Sync to disk
          </button>
        </div>
      </div>
    </div>
  )
}

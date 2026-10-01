import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type { ConfigSyncChangedRow, ConfigSyncDialogProps, ConfigSyncFileRow } from './types'

const STATUS_LABEL: Record<string, string> = {
  synced: 'Synced',
  'disk-only': 'Disk only',
  'config-only': 'Config only',
  conflict: 'Conflict'
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function FileRowView({ row, scopeLabel }: { row: ConfigSyncFileRow; scopeLabel: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5 rounded border border-border/60 bg-app/30 px-2.5 py-2 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-fg-bright truncate">{row.ref.label}</span>
        <span className="text-xs text-faint shrink-0">{row.sourceLabel}</span>
      </div>
      <span className="text-xs text-dim break-all">{row.ref.relativePath}</span>
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

function ChangedSection({
  rows,
  scopeLabel
}: {
  rows: readonly ConfigSyncChangedRow[]
  scopeLabel: string
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
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/** Scoped conflict review + confirmed-apply dialog (Step 9). Stays
 *  presentational: every backend call, plan, and race guard lives in
 *  `Config.tsx` (REQ-010). This component only renders the supplied
 *  review, reports the three outcomes through props, and owns its own
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
  onSyncToDisk,
  onAdoptFromDisk,
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
      if (focusable.length === 0) return
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
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl max-h-[80vh] bg-surface rounded-xl shadow-2xl border border-border overflow-hidden flex flex-col"
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
              <span className="text-fg-bright font-medium">Sync Tatsu config to disk</span> creates
              config-only files on disk, overwrites content-changed disk files, and removes
              disk-only files — backing up every existing file before it's overwritten or removed.
            </p>
            <p>
              <span className="text-fg-bright font-medium">
                Adopt current disk files into Tatsu config
              </span>{' '}
              replaces this scope in Tatsu config with the current disk inventory — adding
              disk-only entries, replacing content-changed desired content, and removing
              config-only entries. It performs no harness-directory writes.
            </p>
          </div>

          <DiffSection
            title="Disk only"
            rows={review.sections.diskOnly}
            emptyLabel="No disk-only files"
            scopeLabel={scopeLabel}
          />
          <DiffSection
            title="Config only"
            rows={review.sections.configOnly}
            emptyLabel="No config-only files"
            scopeLabel={scopeLabel}
          />
          <ChangedSection rows={review.sections.changed} scopeLabel={scopeLabel} />

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
            onClick={onAdoptFromDisk}
            className="px-3 py-1.5 text-xs font-medium rounded bg-app/40 hover:bg-app/60 text-fg-bright border border-border cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          >
            Adopt current disk files into Tatsu config
          </button>
          <button
            type="button"
            disabled={mutationsDisabled}
            aria-busy={stage !== 'idle'}
            onClick={onSyncToDisk}
            className="px-3 py-1.5 text-xs font-medium rounded bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          >
            Sync Tatsu config to disk
          </button>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type { ConfigSyncDialogProps } from './types'

const STATUS_LABEL: Record<string, string> = {
  synced: 'Synced',
  'disk-only': 'Disk only',
  'config-only': 'Config only',
  conflict: 'Conflict'
}

/** Read-only Step 7 drift preview. Step 9 extends this with the
 *  confirmed Sync-to-disk / Adopt-from-disk outcomes and detailed
 *  conflict review — this version only reads and closes (REQ-027,
 *  REQ-028, CON-002). */
export function ConfigSyncDialog({
  open,
  comparison,
  agentDisplayName,
  resourceLabel,
  onClose
}: ConfigSyncDialogProps): JSX.Element | null {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    restoreFocusRef.current = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    return () => {
      restoreFocusRef.current?.focus?.()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open || !comparison) return null

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center pt-[15vh] bg-black/40"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Sync preview"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-surface rounded-xl shadow-2xl border border-border overflow-hidden flex flex-col"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-fg-bright">
            {agentDisplayName} · {resourceLabel}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-dim hover:text-fg p-1 rounded transition-colors cursor-pointer"
          >
            <X className="icon-base" />
          </button>
        </div>

        <div className="px-4 py-3 flex flex-col gap-3 text-sm">
          <div className="text-xs text-dim">
            Status:{' '}
            <span className="text-fg-bright font-medium">
              {STATUS_LABEL[comparison.status] ?? comparison.status}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="flex flex-col gap-0.5 bg-app/40 rounded px-2 py-1.5">
              <span className="text-xs text-faint">Disk only</span>
              <span className="text-sm text-warning font-medium">{comparison.diskOnly.length}</span>
            </div>
            <div className="flex flex-col gap-0.5 bg-app/40 rounded px-2 py-1.5">
              <span className="text-xs text-faint">Config only</span>
              <span className="text-sm text-info font-medium">{comparison.configOnly.length}</span>
            </div>
            <div className="flex flex-col gap-0.5 bg-app/40 rounded px-2 py-1.5">
              <span className="text-xs text-faint">Changed</span>
              <span className="text-sm text-danger font-medium">{comparison.changed.length}</span>
            </div>
          </div>
        </div>

        <div className="px-4 py-3 border-t border-border flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-dim hover:text-fg cursor-pointer transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

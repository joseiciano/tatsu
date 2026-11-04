import { useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Loader2 } from 'lucide-react'
import { useFocusTrap } from '../../../hooks/useFocusTrap'

export interface ConfirmDialogProps {
  title: string
  children: ReactNode
  confirmLabel: string
  cancelLabel: string
  tone?: 'danger' | 'default'
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel,
  tone = 'default',
  busy = false,
  onConfirm,
  onCancel
}: ConfirmDialogProps): JSX.Element {
  const titleId = useId()
  const descId = useId()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const cancel = (): void => {
    if (!busy) onCancel()
  }

  useFocusTrap(dialogRef, { active: true, onEscape: cancel, initialFocus: cancelRef })

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center pt-[15vh] px-4 bg-black/40" onClick={cancel}>
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-surface rounded-xl shadow-2xl border border-border flex flex-col outline-none"
      >
        <h2 id={titleId} className="px-4 pt-4 text-sm font-semibold text-fg-bright break-words">
          {title}
        </h2>
        <div id={descId} className="px-4 py-3 flex flex-col gap-2 text-xs text-dim">
          {children}
        </div>
        <div className="px-4 pb-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={cancel}
            aria-disabled={busy || undefined}
            className="text-xs px-3 py-1.5 rounded border border-border-strong text-fg hover:bg-panel-raised cursor-pointer aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => {
              if (!busy) onConfirm()
            }}
            aria-disabled={busy || undefined}
            className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded hover:opacity-90 cursor-pointer aria-disabled:opacity-60 aria-disabled:cursor-not-allowed ${
              tone === 'danger' ? 'bg-danger text-white' : 'bg-accent text-app font-semibold'
            }`}
          >
            {busy && <Loader2 className="icon-xs animate-spin" aria-hidden="true" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

import { useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useFocusTrap } from '../../../hooks/useFocusTrap'

interface CancelStepDialogProps {
  stepId: string
  busy: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
  confirmLabel?: string
}

export function CancelStepDialog({
  stepId,
  busy,
  error,
  onConfirm,
  onCancel,
  confirmLabel = 'Cancel step and close tab'
}: CancelStepDialogProps): JSX.Element {
  const titleId = useId()
  const descId = useId()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const keepRef = useRef<HTMLButtonElement | null>(null)

  const dismiss = (): void => {
    if (!busy) onCancel()
  }

  useFocusTrap(dialogRef, { active: true, onEscape: dismiss, initialFocus: keepRef })

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center pt-[15vh] px-4 bg-black/40" onClick={dismiss}>
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-surface rounded-xl shadow-2xl border border-border flex flex-col outline-none"
      >
        <h2 id={titleId} className="px-4 pt-4 text-sm font-semibold text-fg-bright break-words">
          Cancel step “{stepId}”?
        </h2>
        <div id={descId} className="px-4 py-3 flex flex-col gap-2 text-xs text-dim">
          <p>The step stops and the run pauses until you retry or skip the step.</p>
          {error && (
            <p role="alert" className="text-danger break-words">
              {error}
            </p>
          )}
        </div>
        <div className="px-4 pb-4 flex justify-end gap-2">
          <button
            ref={keepRef}
            type="button"
            onClick={dismiss}
            aria-disabled={busy || undefined}
            className="text-xs px-3 py-1.5 rounded border border-border-strong text-fg hover:bg-panel-raised cursor-pointer aria-disabled:opacity-50 aria-disabled:cursor-default"
          >
            Keep running
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded bg-danger text-white hover:opacity-90 cursor-pointer disabled:opacity-50 disabled:cursor-default"
          >
            {busy ? 'Cancelling…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

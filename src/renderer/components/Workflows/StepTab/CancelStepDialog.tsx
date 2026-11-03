import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'

interface CancelStepDialogProps {
  stepId: string
  busy: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}

export function CancelStepDialog({ stepId, busy, error, onConfirm, onCancel }: CancelStepDialogProps): JSX.Element {
  const titleId = useId()
  const descId = useId()
  const keepRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    keepRef.current?.focus()
    return () => {
      if (previous && document.contains(previous)) previous.focus()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center pt-[15vh] px-4 bg-black/40" onClick={onCancel}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-surface rounded-xl shadow-2xl border border-border flex flex-col"
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
            onClick={onCancel}
            className="text-xs px-3 py-1.5 rounded border border-border-strong text-fg hover:bg-panel-raised cursor-pointer"
          >
            Keep running
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded bg-danger text-white hover:opacity-90 cursor-pointer disabled:opacity-50 disabled:cursor-default"
          >
            {busy ? 'Cancelling…' : 'Cancel step and close tab'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

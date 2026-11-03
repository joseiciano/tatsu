import { useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useFocusTrap } from '../../../hooks/useFocusTrap'

interface RetryFromCleanDialogProps {
  stepId: string
  onConfirm: () => void
  onCancel: () => void
}

export function RetryFromCleanDialog({ stepId, onConfirm, onCancel }: RetryFromCleanDialogProps): JSX.Element {
  const titleId = useId()
  const descId = useId()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)

  useFocusTrap(dialogRef, { active: true, onEscape: onCancel, initialFocus: cancelRef })

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center pt-[15vh] px-4 bg-black/40" onClick={onCancel}>
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
          Retry “{stepId}” from clean?
        </h2>
        <div id={descId} className="px-4 py-3 flex flex-col gap-2 text-xs text-dim">
          <p>
            Uncommitted and untracked changes made since step “{stepId}” started will be discarded before it runs
            again.
          </p>
          <p>A head snapshot of the current worktree is kept, so the discarded changes can still be recovered.</p>
        </div>
        <div className="px-4 pb-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="text-xs px-3 py-1.5 rounded border border-border-strong text-fg hover:bg-panel-raised cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="text-xs px-3 py-1.5 rounded bg-danger text-white hover:opacity-90 cursor-pointer"
          >
            Discard changes and retry
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

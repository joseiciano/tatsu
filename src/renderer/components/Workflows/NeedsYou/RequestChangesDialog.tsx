import { useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useFocusTrap } from '../../../hooks/useFocusTrap'
import { GATE_FEEDBACK_MAX_CHARS, type WorkflowRequestChangesPayload } from '../../../../shared/state/workflows'

export interface RequestChangesDialogProps {
  stepId: string
  busy: boolean
  error: string | null
  onSubmit: (payload: WorkflowRequestChangesPayload) => void
  onCancel: () => void
}

const FIELD_CLASS =
  'w-full bg-app/40 border border-border rounded px-2.5 py-1.5 text-xs text-fg-bright placeholder:text-faint focus:outline-none focus:border-accent disabled:opacity-50'

export function RequestChangesDialog({ stepId, busy, error, onSubmit, onCancel }: RequestChangesDialogProps): JSX.Element {
  const titleId = useId()
  const descId = useId()
  const feedbackId = useId()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const feedbackRef = useRef<HTMLTextAreaElement | null>(null)
  const [feedback, setFeedback] = useState('')
  const [fresh, setFresh] = useState(false)

  const dismiss = (): void => {
    if (!busy) onCancel()
  }

  useFocusTrap(dialogRef, { active: true, onEscape: dismiss, initialFocus: feedbackRef })

  const trimmed = feedback.trim()
  const canSubmit = trimmed !== '' && !busy

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center pt-[15vh] px-4 bg-black/40" onClick={dismiss}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-surface rounded-xl shadow-2xl border border-border flex flex-col outline-none"
      >
        <h2 id={titleId} className="px-4 pt-4 text-sm font-semibold text-fg-bright break-words">
          Request changes to “{stepId}”
        </h2>
        <form
          className="px-4 py-3 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit) onSubmit({ feedback: trimmed, fresh })
          }}
        >
          <p id={descId} className="text-xs text-dim">
            The agent gets your feedback and works on the step again. A fresh session starts without the earlier
            conversation.
          </p>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={feedbackId} className="block text-xs font-medium text-dim">
              Feedback
            </label>
            <textarea
              ref={feedbackRef}
              id={feedbackId}
              value={feedback}
              disabled={busy}
              rows={5}
              maxLength={GATE_FEEDBACK_MAX_CHARS}
              placeholder="What should change?"
              onChange={(e) => setFeedback(e.target.value)}
              className={`${FIELD_CLASS} resize-y`}
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-fg cursor-pointer">
            <input
              type="checkbox"
              checked={fresh}
              disabled={busy}
              onChange={(e) => setFresh(e.target.checked)}
              className="icon-base cursor-pointer"
            />
            Start a fresh session
          </label>
          {error && (
            <p role="alert" className="text-xs text-danger break-words">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={dismiss}
              aria-disabled={busy || undefined}
              className="text-xs px-3 py-1.5 rounded border border-border-strong text-fg hover:bg-panel-raised cursor-pointer aria-disabled:opacity-50 aria-disabled:cursor-default"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="text-xs px-3 py-1.5 rounded bg-accent text-app hover:opacity-90 cursor-pointer disabled:opacity-50 disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {busy ? 'Sending…' : 'Request changes'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}

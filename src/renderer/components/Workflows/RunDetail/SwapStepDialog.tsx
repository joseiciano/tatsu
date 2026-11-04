import { useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ShieldAlert } from 'lucide-react'
import { useFocusTrap } from '../../../hooks/useFocusTrap'
import { agentDisplayName } from '../../../../shared/agent-registry'
import {
  STEP_HARNESS_AGENTS,
  WORKFLOW_STEP_MODEL_MAX_CHARS,
  isWorkflowStepModel,
  type WorkflowSwapStepPayload
} from '../../../../shared/state/workflows'
import type { WorkflowAgent } from '../../../../shared/workflow-def'

export interface SwapStepDialogProps {
  stepId: string
  agent: WorkflowAgent
  model: string | undefined
  full: boolean
  busy: boolean
  error: string | null
  onConfirm: (payload: WorkflowSwapStepPayload) => void
  onCancel: () => void
}

const FIELD_CLASS =
  'w-full bg-app/40 border border-border rounded px-2.5 py-1.5 text-xs text-fg-bright placeholder:text-faint focus:outline-none focus:border-accent disabled:opacity-50'
const LABEL_CLASS = 'block text-xs font-medium text-dim'

export function swapPayload(
  current: { agent: WorkflowAgent; model: string | undefined },
  draft: { agent: WorkflowAgent; model: string; allowFull: boolean }
): WorkflowSwapStepPayload | null {
  const model = draft.model.trim()
  if (model !== '' && !isWorkflowStepModel(model)) return null
  const sameModel = model === '' || model === current.model
  if (draft.agent === current.agent && sameModel) return null
  return {
    agent: draft.agent,
    ...(model === '' ? {} : { model }),
    ...(draft.allowFull ? { allowFull: true } : {})
  }
}

export function SwapStepDialog({
  stepId,
  agent: currentAgent,
  model: currentModel,
  full,
  busy,
  error,
  onConfirm,
  onCancel
}: SwapStepDialogProps): JSX.Element {
  const titleId = useId()
  const descId = useId()
  const agentId = useId()
  const modelId = useId()
  const modelHintId = useId()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const agentRef = useRef<HTMLSelectElement | null>(null)
  const [agent, setAgent] = useState<WorkflowAgent>(currentAgent)
  const [model, setModel] = useState(currentModel ?? '')
  const [allowFull, setAllowFull] = useState(false)

  const dismiss = (): void => {
    if (!busy) onCancel()
  }

  useFocusTrap(dialogRef, { active: true, onEscape: dismiss, initialFocus: agentRef })

  const payload = swapPayload({ agent: currentAgent, model: currentModel }, { agent, model, allowFull })
  const modelInvalid = model.trim() !== '' && !isWorkflowStepModel(model.trim())
  const canSwap = payload !== null && !busy && (!full || allowFull)

  const onAgentChange = (next: WorkflowAgent): void => {
    setAgent(next)
    setModel(next === currentAgent ? (currentModel ?? '') : '')
  }

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
          Swap harness or model for “{stepId}”
        </h2>
        <form
          className="px-4 py-3 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (canSwap && payload) onConfirm(payload)
          }}
        >
          <p id={descId} className="text-xs text-dim">
            The step runs again with the agent and model you pick. Its prompt and permissions stay the same, and the
            rest of the run keeps its definition.
          </p>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={agentId} className={LABEL_CLASS}>
              Agent
            </label>
            <select
              ref={agentRef}
              id={agentId}
              value={agent}
              disabled={busy}
              onChange={(e) => {
                const next = STEP_HARNESS_AGENTS.find((candidate) => candidate === e.target.value)
                if (next) onAgentChange(next)
              }}
              className={`${FIELD_CLASS} cursor-pointer`}
            >
              {STEP_HARNESS_AGENTS.map((option) => (
                <option key={option} value={option}>
                  {agentDisplayName(option)}
                  {option === currentAgent ? ' (current)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={modelId} className={LABEL_CLASS}>
              Model
            </label>
            <input
              id={modelId}
              type="text"
              value={model}
              disabled={busy}
              spellCheck={false}
              maxLength={WORKFLOW_STEP_MODEL_MAX_CHARS}
              placeholder="Agent default"
              aria-invalid={modelInvalid || undefined}
              aria-describedby={modelHintId}
              onChange={(e) => setModel(e.target.value)}
              className={`${FIELD_CLASS} font-mono`}
            />
            <span id={modelHintId} className="text-xs text-faint">
              {modelInvalid ? 'Use a model name without control characters.' : 'Leave empty to use the agent default.'}
            </span>
          </div>
          {full && (
            <label className="flex items-start gap-2 rounded border border-warning/40 bg-warning/10 px-3 py-2 cursor-pointer">
              <input
                type="checkbox"
                checked={allowFull}
                disabled={busy}
                onChange={(e) => setAllowFull(e.target.checked)}
                className="mt-0.5 icon-base cursor-pointer"
              />
              <span className="text-xs text-fg">
                <span className="flex items-center gap-1 font-medium text-fg-bright">
                  <ShieldAlert className="icon-xs text-warning" aria-hidden="true" />
                  Allow full access for {agentDisplayName(agent)}
                </span>
                This step runs its agent with full permissions.
              </span>
            </label>
          )}
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
              disabled={!canSwap}
              className="text-xs px-3 py-1.5 rounded bg-accent text-app hover:opacity-90 cursor-pointer disabled:opacity-50 disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {busy ? 'Swapping…' : 'Swap and retry'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}

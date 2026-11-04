import { useId } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { agentDisplayName } from '../../../../shared/agent-registry'
import { STEP_HARNESS_AGENTS, WORKFLOW_STEP_MODEL_MAX_CHARS } from '../../../../shared/state/workflows'
import type { WorkflowAgent } from '../../../../shared/workflow-def'
import type { OverrideDraft, OverrideRow } from '../launch-sheet-helpers'

export interface OverridesPanelProps {
  rows: OverrideRow[]
  drafts: Record<string, OverrideDraft>
  changedCount: number
  expanded: boolean
  disabled: boolean
  invalidStep: string | null
  reasonId: string
  onToggle: () => void
  onAgentChange: (stepId: string, agent: WorkflowAgent) => void
  onModelChange: (stepId: string, model: string) => void
}

const FIELD_CLASS =
  'w-full bg-app/40 border border-border rounded px-2.5 py-1.5 text-xs text-fg-bright placeholder:text-faint focus:outline-none focus:border-accent disabled:opacity-50'
const AGENT_DEFAULT = 'Agent default'

function fieldView(row: OverrideRow, draft: OverrideDraft | undefined): { agent: WorkflowAgent; model: string; placeholder: string } {
  const agent = draft?.agent ?? row.agent
  const sameAgent = agent === row.agent
  return {
    agent,
    model: draft?.model ?? (sameAgent ? row.model ?? '' : ''),
    placeholder: sameAgent ? row.model ?? AGENT_DEFAULT : AGENT_DEFAULT
  }
}

export function OverridesPanel({
  rows,
  drafts,
  changedCount,
  expanded,
  disabled,
  invalidStep,
  reasonId,
  onToggle,
  onAgentChange,
  onModelChange
}: OverridesPanelProps): JSX.Element {
  const baseId = useId()
  const bodyId = `${baseId}-body`
  const Chevron = expanded ? ChevronDown : ChevronRight
  return (
    <div className="rounded border border-border">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={onToggle}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-dim uppercase tracking-wider hover:text-fg cursor-pointer transition-colors"
      >
        <Chevron className="icon-xs" />
        {changedCount === 0 ? 'Overrides' : `Overrides (${changedCount} changed)`}
      </button>
      <div id={bodyId} hidden={!expanded} className="space-y-3 border-t border-border px-3 pt-2 pb-3">
        {rows.map((row) => {
          const view = fieldView(row, Object.hasOwn(drafts, row.id) ? drafts[row.id] : undefined)
          const agentId = `${baseId}-agent-${row.id}`
          const modelId = `${baseId}-model-${row.id}`
          const invalid = invalidStep === row.id
          return (
            <div key={row.id} className="space-y-1.5">
              <div className="text-xs font-mono text-fg-bright truncate">{row.id}</div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label htmlFor={agentId} className="block text-xs text-dim">
                    Agent for {row.id}
                  </label>
                  <select
                    id={agentId}
                    value={view.agent}
                    disabled={disabled}
                    onChange={(e) => {
                      const next = STEP_HARNESS_AGENTS.find((candidate) => candidate === e.target.value)
                      if (next !== undefined) onAgentChange(row.id, next)
                    }}
                    className={`${FIELD_CLASS} cursor-pointer`}
                  >
                    {STEP_HARNESS_AGENTS.map((option) => (
                      <option key={option} value={option}>
                        {agentDisplayName(option)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label htmlFor={modelId} className="block text-xs text-dim">
                    Model for {row.id}
                  </label>
                  <input
                    id={modelId}
                    type="text"
                    value={view.model}
                    placeholder={view.placeholder}
                    maxLength={WORKFLOW_STEP_MODEL_MAX_CHARS + 1}
                    disabled={disabled}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={invalid || undefined}
                    aria-describedby={invalid ? reasonId : undefined}
                    onChange={(e) => onModelChange(row.id, e.target.value)}
                    className={`${FIELD_CLASS} font-mono`}
                  />
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

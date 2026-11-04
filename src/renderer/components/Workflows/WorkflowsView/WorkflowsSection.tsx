import { useId, type ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'

export const WORKFLOWS_TABS = [
  { id: 'runs', label: 'Runs' },
  { id: 'library', label: 'Library' }
] as const

export type WorkflowsTab = (typeof WORKFLOWS_TABS)[number]['id']

export interface WorkflowsSectionProps {
  tab: WorkflowsTab
  onTabChange: (tab: WorkflowsTab) => void
  onClose: () => void
  children: ReactNode
}

export function WorkflowsSection({ tab, onTabChange, onClose, children }: WorkflowsSectionProps): JSX.Element {
  const baseId = useId()
  const titleId = `${baseId}-title`
  return (
    <div role="region" aria-labelledby={titleId} className="flex flex-col h-full w-full bg-panel">
      <div className="drag-region h-10 shrink-0 border-b border-border relative">
        <button
          onClick={onClose}
          className="no-drag absolute left-4 top-1/2 -translate-y-1/2 flex items-center gap-1.5 text-xs text-muted hover:text-fg-bright transition-colors cursor-pointer"
        >
          <ArrowLeft className="icon-sm" aria-hidden="true" />
          Back
        </button>
        <h1
          id={titleId}
          className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 text-sm font-medium text-fg pointer-events-none"
        >
          Workflows
        </h1>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-4 py-6 sm:px-8">
          <div role="tablist" aria-label="Workflows views" className="flex gap-1 border-b border-border mb-6">
            {WORKFLOWS_TABS.map(({ id, label }) => (
              <button
                key={id}
                role="tab"
                id={`${baseId}-tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`${baseId}-panel-${id}`}
                onClick={() => onTabChange(id)}
                className={`-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors cursor-pointer ${
                  tab === id ? 'border-accent text-fg-bright' : 'border-transparent text-dim hover:text-fg'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`${baseId}-panel-${tab}`} aria-labelledby={`${baseId}-tab-${tab}`}>
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}

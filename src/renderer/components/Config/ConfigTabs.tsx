import { ArrowLeft, Search, X } from 'lucide-react'
import type { ConfigTabsProps } from './types'

export function ConfigTabs({
  onClose,
  tabs,
  activeTab,
  onTabChange,
  agentFilterOptions,
  agentFilter,
  onAgentFilterChange,
  searchQuery,
  onSearchChange
}: ConfigTabsProps): JSX.Element {
  return (
    <div className="flex flex-col shrink-0 border-b border-border">
      <div className="drag-region h-10 shrink-0 relative">
        <button
          onClick={onClose}
          className="no-drag absolute left-20 top-1/2 -translate-y-1/2 flex items-center gap-1.5 text-xs text-muted hover:text-fg-bright transition-colors cursor-pointer"
        >
          <ArrowLeft className="icon-sm" />
          Back
          <kbd className="text-xs text-faint bg-bg px-1.5 py-0.5 rounded border border-border font-mono">
            ESC
          </kbd>
        </button>
        <span className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 text-sm font-medium text-fg pointer-events-none">
          Config
        </span>
      </div>

      <div className="flex items-center gap-3 px-3 py-2 flex-wrap">
        <div role="tablist" aria-label="Resource type" className="flex items-center gap-1 bg-app rounded p-0.5">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={tab.id === activeTab}
              onClick={() => onTabChange(tab.id)}
              className={`px-3 py-1 text-xs rounded cursor-pointer transition-colors ${
                tab.id === activeTab
                  ? 'bg-surface text-fg-bright'
                  : 'text-dim hover:text-fg-bright'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          <label htmlFor="config-agent-filter" className="text-xs text-dim">
            Agent
          </label>
          <select
            id="config-agent-filter"
            value={agentFilter}
            onChange={(e) => onAgentFilterChange(e.target.value as ConfigTabsProps['agentFilter'])}
            className="bg-app border border-border rounded px-2 py-1 text-xs text-fg-bright outline-none focus:border-accent cursor-pointer"
          >
            {agentFilterOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="relative flex-1 min-w-[10rem] max-w-xs">
          <Search className="icon-xs absolute left-2 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search resources…"
            aria-label="Search resources"
            className="w-full bg-app border border-border rounded pl-7 pr-6 py-1 text-xs text-fg-bright placeholder-faint outline-none focus:border-accent"
          />
          {searchQuery && (
            <button
              onClick={() => onSearchChange('')}
              aria-label="Clear search"
              className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-faint hover:text-fg cursor-pointer"
            >
              <X className="icon-2xs" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

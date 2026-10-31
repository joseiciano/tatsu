import { FolderInput, Plus, Puzzle } from 'lucide-react'
import type { HarnessTemplate, HarnessTemplateKind } from '../../../shared/state/harness-config'
import { TEMPLATE_KINDS, TEMPLATE_KIND_LABEL } from './template-editor-model'
import type { ConfigTemplateListProps } from './types'

const KIND_NOUN: Record<HarnessTemplateKind, string> = {
  agent: 'agent template',
  skill: 'skill template',
  command: 'command template'
}

function SectionHeader({
  label,
  createLabel,
  onCreate
}: {
  label: string
  createLabel: string
  onCreate: () => void
}): JSX.Element {
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1.5">
      <span className="text-xs font-medium text-fg-bright flex-1 min-w-0 truncate">{label}</span>
      <button
        type="button"
        title={createLabel}
        aria-label={createLabel}
        onClick={onCreate}
        className="p-1 rounded text-dim hover:text-fg-bright hover:bg-surface-hover cursor-pointer"
      >
        <Plus className="icon-xs" />
      </button>
    </div>
  )
}

function ListRow({
  label,
  detail,
  selected,
  onSelect
}: {
  label: string
  detail: string
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
      className={`w-full text-left px-2.5 py-1.5 rounded transition-colors cursor-pointer ${
        selected ? 'bg-surface text-fg-bright' : 'hover:bg-surface-hover text-fg'
      }`}
    >
      <span className="block text-xs truncate">{label}</span>
      <span className="block text-xs text-faint truncate">{detail}</span>
    </button>
  )
}

function targetSummary(template: HarnessTemplate): string {
  const targets = (['claude', 'codex', 'opencode'] as const).filter((harness) => {
    const block = template.harnesses[harness]
    return block !== undefined && block !== false
  })
  return targets.length > 0 ? targets.join(', ') : 'No targets'
}

export function ConfigTemplateList({
  templates,
  fragments,
  parseErrors,
  searchActive,
  selection,
  onSelectTemplate,
  onSelectFragment,
  onCreateTemplate,
  onCreateFragment,
  onImport
}: ConfigTemplateListProps): JSX.Element {
  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-2.5 py-1.5 border-b border-border">
        <button
          type="button"
          onClick={onImport}
          className="flex items-center gap-1.5 text-xs text-dim hover:text-fg-bright cursor-pointer"
        >
          <FolderInput className="icon-xs" />
          Import existing setup…
        </button>
      </div>
      {parseErrors.length > 0 && (
        <div className="px-2.5 py-2 border-b border-border flex flex-col gap-1">
          <span className="text-xs text-danger">Some source files could not be read:</span>
          {parseErrors.map((error) => (
            <span key={error.relativePath} className="text-xs text-faint break-all">
              {error.relativePath}: {error.message}
            </span>
          ))}
        </div>
      )}
      {TEMPLATE_KINDS.map((kind) => {
        const rows = templates.filter((template) => template.kind === kind)
        return (
          <div key={kind} className="border-b border-border/60" data-testid={`config-templates-${kind}`}>
            <SectionHeader
              label={`${TEMPLATE_KIND_LABEL[kind]} templates`}
              createLabel={`Create ${KIND_NOUN[kind]}`}
              onCreate={() => onCreateTemplate(kind)}
            />
            <div className="flex flex-col gap-0.5 px-1 pb-1.5">
              {rows.map((template) => (
                <ListRow
                  key={template.relativePath}
                  label={template.name}
                  detail={targetSummary(template)}
                  selected={
                    selection?.type === 'template' && selection.kind === kind && selection.name === template.name
                  }
                  onSelect={() => onSelectTemplate(kind, template.name)}
                />
              ))}
              {rows.length === 0 && (
                <span className="px-1.5 py-1 text-xs text-faint">
                  {searchActive ? 'No matching templates' : 'No templates yet'}
                </span>
              )}
            </div>
          </div>
        )
      })}
      <div className="border-b border-border/60" data-testid="config-fragments">
        <SectionHeader label="Fragments" createLabel="Create fragment" onCreate={onCreateFragment} />
        <div className="flex flex-col gap-0.5 px-1 pb-1.5">
          {fragments.map((fragment) => (
            <ListRow
              key={fragment.relativePath}
              label={fragment.name}
              detail={fragment.relativePath}
              selected={selection?.type === 'fragment' && selection.name === fragment.name}
              onSelect={() => onSelectFragment(fragment.name)}
            />
          ))}
          {fragments.length === 0 && (
            <span className="px-1.5 py-1 text-xs text-faint flex items-center gap-1.5">
              <Puzzle className="icon-xs shrink-0" />
              {searchActive ? 'No matching fragments' : 'Fragments hold text shared by several templates'}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

import { Loader2, Trash2 } from 'lucide-react'
import { MonacoEditor } from '../MonacoEditor'
import type { ConfigEditorProps } from './types'

const BADGE_LABEL: Record<string, string> = {
  synced: 'Synced',
  'disk-only': 'Disk only',
  'config-only': 'Config only',
  conflict: 'Conflict'
}

function synthesizeFilePath(absolutePath: string | null, nameDraft: string): string | undefined {
  if (absolutePath) return absolutePath
  const trimmed = nameDraft.trim()
  if (!trimmed) return 'untitled.md'
  return trimmed.includes('.') ? trimmed : `${trimmed}.md`
}

export function ConfigEditor({
  view,
  draft,
  onDraftChange,
  nameDraft,
  onNameDraftChange,
  dirty,
  busy,
  canEdit,
  canSave,
  canCreate,
  canDelete,
  error,
  fontFamily,
  fontSize,
  onSave,
  onCreate,
  onDelete,
  onCancel,
  onReset
}: ConfigEditorProps): JSX.Element {
  if (view.kind === 'empty') {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-faint">
        Select a resource, or use Create in a harness group.
      </div>
    )
  }

  if (view.kind === 'loading') {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-faint gap-2">
        <Loader2 className="icon-sm animate-spin" />
        Loading…
      </div>
    )
  }

  if (view.kind === 'unsupported') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-1.5 text-center px-6">
        <span className="text-xs text-fg">{view.agentDisplayName} does not support this yet</span>
        <span className="text-xs text-faint max-w-sm">{view.note}</span>
      </div>
    )
  }

  if (view.kind === 'config-only') {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <span className="text-sm text-fg-bright truncate">{view.ref.label}</span>
          <span className="text-xs text-info shrink-0">{BADGE_LABEL[view.badge]}</span>
        </div>
        <div className="flex-1 flex items-center justify-center text-center px-6">
          <p className="text-xs text-faint max-w-sm">
            This resource exists only in Tatsu config, not on disk, so its content can&apos;t be
            read or edited here yet. Use Sync on {view.agentDisplayName} to resolve the
            difference before editing it on disk.
          </p>
        </div>
      </div>
    )
  }

  if (view.kind === 'create') {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <label className="text-xs text-dim shrink-0" htmlFor="config-create-name">
            Name
          </label>
          <input
            id="config-create-name"
            type="text"
            value={nameDraft}
            onChange={(e) => onNameDraftChange(e.target.value)}
            placeholder="my-resource"
            className="flex-1 bg-app border border-border rounded px-2 py-1 text-xs text-fg-bright placeholder-faint outline-none focus:border-accent"
          />
          <span className="text-xs text-faint shrink-0">
            in {view.agentDisplayName} — Tatsu chooses the final path
          </span>
        </div>
        {error && <div className="px-3 py-1.5 text-xs text-danger border-b border-border">{error}</div>}
        <div className="flex-1 min-h-0 min-w-0">
          <MonacoEditor
            value={draft}
            filePath={synthesizeFilePath(null, nameDraft)}
            onChange={onDraftChange}
            onSave={canCreate ? onCreate : undefined}
            fontFamily={fontFamily}
            fontSize={fontSize}
          />
        </div>
        <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-border">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-xs text-dim hover:text-fg cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canCreate || busy}
            onClick={onCreate}
            className="px-3 py-1.5 text-xs font-medium rounded bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
          >
            Create
          </button>
        </div>
      </div>
    )
  }

  // view.kind === 'edit'
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <span className="text-sm text-fg-bright truncate">{view.ref.label}</span>
        <span className="text-xs text-dim shrink-0">{BADGE_LABEL[view.badge]}</span>
        {dirty && <span className="text-xs text-warning shrink-0">Unsaved</span>}
        <input
          type="text"
          readOnly
          value={view.ref.absolutePath}
          aria-label="Absolute path"
          onFocus={(e) => e.currentTarget.select()}
          className="flex-1 min-w-0 bg-app border border-border rounded px-2 py-1 text-xs text-faint outline-none"
        />
      </div>
      {error && <div className="px-3 py-1.5 text-xs text-danger border-b border-border">{error}</div>}
      <div className="flex-1 min-h-0 min-w-0">
        <MonacoEditor
          value={draft}
          filePath={view.ref.absolutePath}
          readOnly={!canEdit}
          onChange={onDraftChange}
          onSave={canSave ? onSave : undefined}
          fontFamily={fontFamily}
          fontSize={fontSize}
        />
      </div>
      <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-border">
        <button
          type="button"
          disabled={!canDelete || busy}
          onClick={onDelete}
          aria-label="Delete resource"
          className="mr-auto px-2 py-1.5 text-xs text-danger hover:bg-surface-hover rounded cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 flex items-center gap-1"
        >
          <Trash2 className="icon-xs" />
          Delete
        </button>
        <button
          type="button"
          disabled={!dirty || busy}
          onClick={onReset}
          className="px-3 py-1.5 text-xs text-dim hover:text-fg cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
        >
          Reset
        </button>
        <button
          type="button"
          disabled={!canSave || !dirty || busy}
          onClick={onSave}
          className="px-3 py-1.5 text-xs font-medium rounded bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </div>
  )
}

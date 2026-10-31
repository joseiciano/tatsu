import { Trash2, TriangleAlert } from 'lucide-react'
import { MonacoEditor } from '../MonacoEditor'
import type { ConfigFragmentEditorProps } from './types'

export function ConfigFragmentEditor({
  mode,
  name,
  onNameChange,
  content,
  onContentChange,
  usedBy,
  dirty,
  busy,
  error,
  notice,
  outsideChange,
  fontFamily,
  fontSize,
  onSave,
  onDelete,
  onReset,
  onCancel
}: ConfigFragmentEditorProps): JSX.Element {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <label className="text-xs text-dim shrink-0" htmlFor="fragment-name">
          Fragment
        </label>
        <input
          id="fragment-name"
          type="text"
          value={name}
          readOnly={mode === 'edit'}
          disabled={busy}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="shared-guidelines"
          className="flex-1 min-w-0 bg-app border border-border rounded px-2 py-1 text-xs text-fg-bright placeholder-faint outline-none focus:border-accent"
        />
        {dirty && <span className="text-xs text-warning shrink-0">Unsaved</span>}
      </div>
      <div className="px-3 py-1.5 text-xs text-faint border-b border-border" data-testid="fragment-usage">
        {usedBy.length === 0 ? (
          'Not used by any template yet.'
        ) : (
          <>
            Used by {usedBy.length} template{usedBy.length === 1 ? '' : 's'}: {usedBy.join(', ')}
          </>
        )}
      </div>
      {outsideChange && (
        <div role="alert" className="flex items-start gap-1.5 px-3 py-1.5 text-xs text-warning border-b border-border">
          <TriangleAlert className="icon-xs shrink-0 mt-0.5" />
          {outsideChange === 'changed'
            ? 'This fragment changed in the source folder after you opened it. Saving asks before overwriting; Reset loads the new version.'
            : 'This fragment was removed from the source folder. Saving writes it again.'}
        </div>
      )}
      {error && <div className="px-3 py-1.5 text-xs text-danger border-b border-border whitespace-pre-wrap">{error}</div>}
      {notice && <div className="px-3 py-1.5 text-xs text-success border-b border-border">{notice}</div>}
      <div className="flex-1 min-h-0 min-w-0">
        <MonacoEditor
          value={content}
          filePath="fragment.md"
          readOnly={busy}
          onChange={onContentChange}
          onSave={onSave}
          fontFamily={fontFamily}
          fontSize={fontSize}
        />
      </div>
      <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-border">
        {mode === 'edit' && (
          <button
            type="button"
            disabled={busy}
            onClick={onDelete}
            aria-label="Delete fragment"
            className="mr-auto px-2 py-1.5 text-xs text-danger hover:bg-surface-hover rounded cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 flex items-center gap-1"
          >
            <Trash2 className="icon-xs" />
            Delete
          </button>
        )}
        {mode === 'create' ? (
          <button type="button" onClick={onCancel} className="px-3 py-1.5 text-xs text-dim hover:text-fg cursor-pointer">
            Cancel
          </button>
        ) : (
          <button
            type="button"
            disabled={(!dirty && !outsideChange) || busy}
            onClick={onReset}
            className="px-3 py-1.5 text-xs text-dim hover:text-fg cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reset
          </button>
        )}
        <button
          type="button"
          disabled={busy || name.trim().length === 0 || (mode === 'edit' && !dirty && outsideChange !== 'removed')}
          onClick={onSave}
          className="px-3 py-1.5 text-xs font-medium rounded bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
        >
          {mode === 'create' ? 'Create' : 'Save'}
        </button>
      </div>
    </div>
  )
}

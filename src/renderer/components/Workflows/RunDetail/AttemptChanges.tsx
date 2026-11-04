import { useId } from 'react'
import type { WorkflowAttemptChangedFile } from '../../../../shared/state/workflows'
import { MonacoDiffEditor } from '../../MonacoDiffEditor'

export type AttemptChangesState =
  | { kind: 'none' }
  | { kind: 'loading' }
  | { kind: 'no-snapshot' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; files: readonly WorkflowAttemptChangedFile[]; truncated: boolean }

export type AttemptFileDiffState =
  | { kind: 'idle' }
  | { kind: 'loading'; path: string }
  | { kind: 'error'; path: string; message: string }
  | { kind: 'ready'; path: string; original: string; modified: string }

export interface AttemptChangesProps {
  changes: AttemptChangesState
  diff: AttemptFileDiffState
  selectedPath: string | null
  onSelectFile: (path: string) => void
}

const STATUS_LABELS: Record<WorkflowAttemptChangedFile['status'], string> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted'
}

const STATUS_MARKS: Record<WorkflowAttemptChangedFile['status'], { mark: string; color: string }> = {
  added: { mark: 'A', color: 'text-success' },
  modified: { mark: 'M', color: 'text-warning' },
  deleted: { mark: 'D', color: 'text-danger' }
}

export function changedFileLabel(file: WorkflowAttemptChangedFile): string {
  const counts =
    file.additions === null || file.deletions === null ? 'binary' : `+${file.additions} −${file.deletions}`
  return `${file.path}, ${STATUS_LABELS[file.status]}, ${counts}`
}

function FileList({
  files,
  selectedPath,
  onSelectFile,
  labelledBy
}: {
  files: readonly WorkflowAttemptChangedFile[]
  selectedPath: string | null
  onSelectFile: (path: string) => void
  labelledBy: string
}): JSX.Element {
  return (
    <ul aria-labelledby={labelledBy} className="flex flex-col gap-0.5 max-h-48 overflow-auto">
      {files.map((file) => {
        const selected = file.path === selectedPath
        const { mark, color } = STATUS_MARKS[file.status]
        return (
          <li key={file.path}>
            <button
              type="button"
              aria-pressed={selected}
              aria-label={changedFileLabel(file)}
              onClick={() => onSelectFile(file.path)}
              className={`w-full flex items-center gap-2 rounded border px-2 py-1 text-left text-xs cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                selected ? 'border-accent bg-panel-raised' : 'border-transparent hover:border-border-strong'
              }`}
            >
              <span aria-hidden="true" className={`shrink-0 font-mono ${color}`}>
                {mark}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-fg" title={file.path}>
                {file.path}
              </span>
              <span aria-hidden="true" className="shrink-0 tabular-nums text-dim">
                {file.additions === null || file.deletions === null ? (
                  'binary'
                ) : (
                  <>
                    <span className="text-success">+{file.additions}</span>{' '}
                    <span className="text-danger">−{file.deletions}</span>
                  </>
                )}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function FileDiff({ diff }: { diff: AttemptFileDiffState }): JSX.Element | null {
  const headingId = useId()
  if (diff.kind === 'idle') return null
  return (
    <section aria-labelledby={headingId} aria-busy={diff.kind === 'loading' || undefined} className="flex flex-col gap-1 min-w-0">
      <h4 id={headingId} className="text-xs text-dim truncate" title={diff.path}>
        File diff · <span className="font-mono text-fg">{diff.path}</span>
      </h4>
      {diff.kind === 'loading' && <p className="text-xs text-dim">Loading diff…</p>}
      {diff.kind === 'error' && (
        <p role="alert" className="text-xs text-danger break-words">
          {diff.message}
        </p>
      )}
      {diff.kind === 'ready' && (
        <div className="h-96 min-h-0 rounded border border-border overflow-hidden">
          <MonacoDiffEditor
            key={diff.path}
            original={diff.original}
            modified={diff.modified}
            filePath={diff.path}
            readOnly
            sideBySide
          />
        </div>
      )}
    </section>
  )
}

export function AttemptChanges({ changes, diff, selectedPath, onSelectFile }: AttemptChangesProps): JSX.Element {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} aria-busy={changes.kind === 'loading' || undefined} className="flex flex-col gap-2 min-w-0">
      <h3 id={headingId} className="text-xs font-medium text-dim">
        Changed files
      </h3>
      <div className="flex flex-col gap-3 rounded border border-border bg-surface p-3">
        {changes.kind === 'none' && <p className="text-xs text-faint">Select an attempt to see what it changed.</p>}
        {changes.kind === 'loading' && <p className="text-xs text-dim">Loading changed files…</p>}
        {changes.kind === 'no-snapshot' && <p className="text-xs text-faint">No snapshot for this attempt</p>}
        {changes.kind === 'error' && (
          <p role="alert" className="text-xs text-danger break-words">
            {changes.message}
          </p>
        )}
        {changes.kind === 'ready' &&
          (changes.files.length === 0 ? (
            <p className="text-xs text-faint">No changes in this attempt</p>
          ) : (
            <>
              <FileList files={changes.files} selectedPath={selectedPath} onSelectFile={onSelectFile} labelledBy={headingId} />
              {changes.truncated && (
                <p className="text-xs text-faint">
                  Showing the first {changes.files.length} files; this attempt changed more.
                </p>
              )}
              <FileDiff diff={diff} />
            </>
          ))}
      </div>
    </section>
  )
}

import type { CodeDiffFile, CodeDiffSides } from '../../types'
import { MonacoDiffEditor } from '../MonacoDiffEditor'
import { BADGE_COLOR, badgeFor } from './CodeDiffFileTree'

interface CodeDiffDiffPaneProps {
  file: CodeDiffFile | null
  sides: CodeDiffSides | null
  loading: boolean
  fontFamily?: string
  fontSize?: number
}

function Centered({ tone, children }: { tone: string; children: React.ReactNode }): JSX.Element {
  return <div className={`absolute inset-0 flex items-center justify-center text-sm ${tone}`}>{children}</div>
}

export function CodeDiffDiffPane({ file, sides, loading, fontFamily, fontSize }: CodeDiffDiffPaneProps): JSX.Element {
  if (!file) {
    return <div className="flex h-full items-center justify-center text-sm text-faint">Select a file</div>
  }
  const binary = sides && (sides.originalBinary || sides.modifiedBinary)
  const truncated = sides && (sides.originalTruncated || sides.modifiedTruncated)

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-2 px-3 h-8 border-b border-border bg-panel text-xs">
        <span className={`font-mono ${BADGE_COLOR[file.status]}`}>{badgeFor(file)}</span>
        <span className="truncate font-mono text-fg">
          {file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
        </span>
        {sides?.modifiedSymlink && <span className="text-info">symlink</span>}
        <span className="flex-1" />
        {(file.additions ?? 0) > 0 && <span className="font-mono text-success">+{file.additions}</span>}
        {(file.deletions ?? 0) > 0 && <span className="font-mono text-danger">−{file.deletions}</span>}
      </div>

      {truncated && !binary && (
        <div className="shrink-0 px-3 py-1 text-xs text-warning bg-warning/10 border-b border-border">
          File is larger than 2 MB; showing the first 2 MB
        </div>
      )}

      <div className="flex-1 min-h-0 relative">
        {loading && !sides && <Centered tone="text-faint">Loading diff...</Centered>}
        {sides?.error && <Centered tone="text-danger">{sides.error}</Centered>}
        {sides && !sides.error && binary && <Centered tone="text-faint">Binary file — cannot display diff</Centered>}
        {sides && !sides.error && !binary && (
          <MonacoDiffEditor
            original={sides.original}
            modified={sides.modified}
            filePath={file.path}
            readOnly
            sideBySide
            fontFamily={fontFamily}
            fontSize={fontSize}
          />
        )}
      </div>
    </div>
  )
}

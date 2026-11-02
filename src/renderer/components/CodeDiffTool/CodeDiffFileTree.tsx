import type { CodeDiffFile } from '../../types'

export interface DisplayGroup {
  key: string
  label: string
  files: CodeDiffFile[]
}

interface CodeDiffFileTreeProps {
  groups: DisplayGroup[]
  selectedFile: string | null
  showFullPath: boolean
  hiddenCount: number
  totalFiles: number
  onSelectFile: (path: string) => void
}

export function badgeFor(file: CodeDiffFile): string {
  if (file.copied) return 'C'
  return { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', untracked: 'U' }[file.status]
}

export const BADGE_COLOR: Record<CodeDiffFile['status'], string> = {
  added: 'text-success',
  modified: 'text-warning',
  deleted: 'text-danger',
  renamed: 'text-info',
  untracked: 'text-dim'
}

export function CodeDiffFileTree({
  groups,
  selectedFile,
  showFullPath,
  hiddenCount,
  totalFiles,
  onSelectFile
}: CodeDiffFileTreeProps): JSX.Element {
  return (
    <div className="flex flex-col h-full overflow-y-auto text-xs select-none">
      {groups.map((group) => (
        <div key={group.key}>
          <div className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-dim uppercase tracking-wider bg-panel-raised/50">
            <span className="flex-1 truncate">{group.label}</span>
            <span className="tabular-nums text-faint">{group.files.length}</span>
          </div>
          {group.files.map((file) => {
            const isSelected = file.path === selectedFile
            const name = showFullPath ? file.path : file.path.slice(file.path.lastIndexOf('/') + 1)
            const label = file.previousPath ? `${file.previousPath} → ${name}` : name
            return (
              <div
                key={file.path}
                onClick={() => onSelectFile(file.path)}
                title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
                className={`flex items-center gap-1.5 px-2 py-1 cursor-pointer transition-colors ${
                  isSelected ? 'bg-accent/15 border-l-2 border-accent' : 'border-l-2 border-transparent hover:bg-panel-raised'
                }`}
              >
                <span className={`shrink-0 w-3 font-mono text-xs ${BADGE_COLOR[file.status]}`}>{badgeFor(file)}</span>
                <span className="truncate flex-1 text-fg">{label}</span>
                {(file.additions !== undefined || file.deletions !== undefined) && (
                  <span className="shrink-0 font-mono tabular-nums">
                    {(file.additions ?? 0) > 0 && <span className="text-success">+{file.additions}</span>}
                    {(file.deletions ?? 0) > 0 && <span className="text-danger ml-1">−{file.deletions}</span>}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      ))}
      {hiddenCount > 0 && (
        <div className="px-2 py-2 text-faint">
          Showing {totalFiles - hiddenCount} of {totalFiles} files
        </div>
      )}
    </div>
  )
}

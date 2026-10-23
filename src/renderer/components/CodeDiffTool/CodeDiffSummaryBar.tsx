import { ArrowLeft, Loader2, RefreshCw, RotateCcw } from 'lucide-react'
import { Tooltip } from '../Tooltip'
import { repoNameColor } from '../RepoIcon'
import type { BranchForCompare } from '../../types'
import { BaseRefCombobox } from './BaseRefCombobox'

export type FetchState = { kind: 'idle' } | { kind: 'fetching' } | { kind: 'failed'; error: string }

export type GroupMode = 'type' | 'directory'

interface CodeDiffSummaryBarProps {
  repoLabel: string
  branchName: string
  baseLabel: string
  branches: BranchForCompare[]
  refError: string | null
  fetchable: boolean
  fetchState: FetchState
  fileCount: number | null
  additions: number
  deletions: number
  groupMode: GroupMode
  onSubmitRef: (ref: string) => void
  onResetRef: () => void
  onFetch: () => void
  onGroupModeChange: (mode: GroupMode) => void
  onClose: () => void
}

export function CodeDiffSummaryBar({
  repoLabel,
  branchName,
  baseLabel,
  branches,
  refError,
  fetchable,
  fetchState,
  fileCount,
  additions,
  deletions,
  groupMode,
  onSubmitRef,
  onResetRef,
  onFetch,
  onGroupModeChange,
  onClose
}: CodeDiffSummaryBarProps): JSX.Element {
  return (
    <div className="shrink-0 border-b border-border bg-panel drag-region">
      <div className="h-10 flex items-center gap-3 px-3">
        <Tooltip label="Back to workspace">
          <button onClick={onClose} className="text-faint hover:text-fg transition-colors cursor-pointer no-drag">
            <ArrowLeft className="icon-base" />
          </button>
        </Tooltip>

        <div className="flex items-baseline gap-1.5 text-xs truncate min-w-0">
          <span className={`font-medium ${repoNameColor(repoLabel)}`}>{repoLabel}</span>
          <span className="text-faint">/</span>
          <span className="text-fg-bright font-medium">{branchName}</span>
          <span className="text-faint">vs</span>
        </div>

        <BaseRefCombobox value={baseLabel} options={branches} error={refError} onSubmit={onSubmitRef} />

        <Tooltip label="Reset to default base">
          <button onClick={onResetRef} className="text-faint hover:text-fg transition-colors cursor-pointer no-drag">
            <RotateCcw className="icon-sm" />
          </button>
        </Tooltip>

        {fetchable && (
          <Tooltip label="Fetch the latest base from origin">
            <button
              onClick={onFetch}
              disabled={fetchState.kind === 'fetching'}
              className="flex items-center gap-1 px-2 py-1 rounded border border-border text-xs text-faint hover:text-fg transition-colors cursor-pointer disabled:cursor-default no-drag"
            >
              {fetchState.kind === 'fetching' ? (
                <Loader2 className="icon-xs animate-spin" />
              ) : (
                <RefreshCw className="icon-xs" />
              )}
              Fetch
            </button>
          </Tooltip>
        )}

        {fetchState.kind === 'failed' && (
          <Tooltip label={fetchState.error}>
            <span className="text-xs text-warning truncate">
              Fetch failed — comparing against last fetched <span className="font-mono">{baseLabel}</span>
            </span>
          </Tooltip>
        )}

        <div className="flex-1" />

        {fileCount != null && (
          <div className="flex items-center gap-2 text-xs text-faint">
            <span>
              {fileCount} file{fileCount !== 1 ? 's' : ''}
            </span>
            <span className="text-border">·</span>
            <span className="text-success">+{additions}</span>
            <span className="text-danger">−{deletions}</span>
          </div>
        )}

        <div className="flex items-center rounded border border-border text-xs no-drag">
          {(['type', 'directory'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => onGroupModeChange(mode)}
              aria-pressed={groupMode === mode}
              className={`px-2 py-1 cursor-pointer transition-colors ${
                groupMode === mode ? 'bg-accent/15 text-fg-bright' : 'text-faint hover:text-fg'
              }`}
            >
              {mode === 'type' ? 'By type' : 'By folder'}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

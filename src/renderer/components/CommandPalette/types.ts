import type { Worktree, PtyStatus, PRStatus } from '../../types'
import type { Action, HotkeyBinding } from '../../hotkeys'

export type PaletteMode = 'root' | 'files'

export interface CommandPaletteProps {
  worktrees: Worktree[]
  worktreeStatuses: Record<string, PtyStatus>
  prStatuses: Record<string, PRStatus | null>
  mergedPaths: Record<string, boolean>
  activeWorktreeId: string | null
  resolvedHotkeys: Record<Action, HotkeyBinding>
  initialMode?: PaletteMode
  onClose: () => void
  onSelectWorktree: (path: string) => void
  onAction: (action: Action) => void
  onOpenFile: (filePath: string) => void
  onAddBackend: () => void
}

export type PaletteItem =
  | { kind: 'worktree'; wt: Worktree }
  | { kind: 'action'; action: Action; label: string; hint?: string }
  | { kind: 'open-files'; label: string }
  | { kind: 'add-backend'; label: string }
  | { kind: 'heading'; label: string }
  | { kind: 'recent-worktree'; wt: Worktree }
  | { kind: 'recent-action'; action: Action; label: string; hint?: string }
  | { kind: 'recent-file'; path: string; label: string }

export type FileItem = {
  path: string
  indices: number[]
  recent: boolean
}

export interface PaletteRecent {
  id: string
  type: 'worktree' | 'action' | 'file'
  label: string
  timestamp: number
  worktreePath?: string
}

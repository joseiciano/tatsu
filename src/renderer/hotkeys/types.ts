export type Action =
  | 'nextWorktree'
  | 'prevWorktree'
  | 'worktree1'
  | 'worktree2'
  | 'worktree3'
  | 'worktree4'
  | 'worktree5'
  | 'worktree6'
  | 'worktree7'
  | 'worktree8'
  | 'worktree9'
  | 'backend1'
  | 'backend2'
  | 'backend3'
  | 'backend4'
  | 'backend5'
  | 'backend6'
  | 'backend7'
  | 'backend8'
  | 'backend9'
  | 'newShellTab'
  | 'closeTab'
  | 'renameTab'
  | 'nextTab'
  | 'prevTab'
  | 'newWorktree'
  | 'refreshWorktrees'
  | 'focusTerminal'
  | 'toggleSidebar'
  | 'openPR'
  | 'openInEditor'
  | 'toggleCommandCenter'
  | 'commandPalette'
  | 'fileQuickOpen'
  | 'splitPaneRight'
  | 'splitPaneDown'
  | 'toggleRightColumn'
  | 'toggleSingleScreen'
  | 'togglePerfMonitor'
  | 'hotkeyCheatsheet'
  | 'openReview'
  | 'openSettings'
  | 'uiScaleUp'
  | 'uiScaleDown'
  | 'uiScaleReset'
  | 'cycleWorktreeDetail'

export interface Modifiers {
  cmd?: boolean
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
}

export interface HotkeyBinding {
  key: string
  modifiers: Modifiers
}

export type CategoryId =
  | 'navigation'
  | 'backends'
  | 'worktree-mgmt'
  | 'tabs'
  | 'layout'
  | 'commands'
  | 'overlays'
  | 'external'

export interface HotkeyCategory {
  id: CategoryId
  label: string
  actions: Action[]
  families?: { label: string; summary: string; actions: Action[] }[]
}

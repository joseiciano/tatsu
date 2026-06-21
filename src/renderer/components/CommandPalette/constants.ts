import type { PtyStatus } from '../../types'
import type { Action } from '../../hotkeys'

export const FILE_CACHE_TTL_MS = 10_000
export const MAX_FILE_RESULTS = 100
export const RECENTS_LIMIT = 20
export const PALETTE_RECENTS_KEY = 'tatsu:commandPalette:recents'
export const PALETTE_RECENTS_LIMIT = 3

export const STATUS_COLORS: Record<PtyStatus | 'merged', string> = {
  idle: 'bg-faint',
  processing: 'bg-success animate-pulse',
  waiting: 'bg-warning',
  'needs-approval': 'bg-danger animate-pulse',
  merged: 'bg-accent',
}

export const STATUS_LABELS: Record<PtyStatus | 'merged', string> = {
  idle: 'Idle',
  processing: 'Working...',
  waiting: 'Waiting for input',
  'needs-approval': 'Needs approval',
  merged: 'Merged',
}

export const PR_ICON_COLOR: Record<string, string> = {
  success: 'text-success',
  failure: 'text-danger',
  pending: 'text-warning',
  none: 'text-dim',
}

export const PR_STATE_COLOR: Record<string, string> = {
  open: 'text-success',
  draft: 'text-dim',
  merged: 'text-accent',
  closed: 'text-danger',
}

export const EXCLUDED_ACTIONS: Set<Action> = new Set([
  'worktree1', 'worktree2', 'worktree3', 'worktree4', 'worktree5',
  'worktree6', 'worktree7', 'worktree8', 'worktree9',
  'commandPalette',
  'fileQuickOpen',
])

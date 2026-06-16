import type { Worktree } from '../../shared/state/worktrees'

// Alias so existing imports of WorktreeInfo keep working; the canonical
// shape now lives in src/shared/state/worktrees.ts.
export type WorktreeInfo = Worktree

export interface AddWorktreeOptions {
  /** Explicit base branch to fork from. Overrides fetchRemote detection. */
  baseBranch?: string
  /** If true, fetch the default branch from origin before creating so the
   * new worktree starts at the tip of the latest remote main. Falls back
   * to local HEAD if the fetch fails (e.g. offline). */
  fetchRemote?: boolean
  /** When set, skip `-b` and check out the named branch as-is. Used by
   * the open-PR flow, where the local branch was already created by a
   * `git fetch origin pull/<N>/head:pr-<N>` ahead of this call. */
  checkoutExisting?: boolean
}

export interface ContinueWorktreeResult {
  worktree: WorktreeInfo
  /** Dirty files were stashed and successfully re-applied. */
  stashReapplied: boolean
  /** Dirty files are still in the stash because pop conflicted. */
  stashConflict: boolean
}

export interface ChangedFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
  staged: boolean
  /** Lines added. Undefined for binary files (numstat reports `-`) and
   * untracked files (no diff baseline yet). */
  additions?: number
  /** Lines deleted. Undefined for binary files and untracked files. */
  deletions?: number
}

export type ChangedFilesMode = 'working' | 'branch'

export interface BranchCommit {
  hash: string
  shortHash: string
  subject: string
  author: string
  relativeDate: string
  timestamp: number
  pushed: boolean
}

export interface CommitDiff {
  hash: string
  shortHash: string
  author: string
  authorEmail: string
  date: string
  subject: string
  body: string
  diff: string
}

export interface FileDiffSides {
  original: string
  modified: string
  originalExists: boolean
  modifiedExists: boolean
  modifiedBinary: boolean
  error?: string
}

export type MergeStrategy = 'squash' | 'merge-commit' | 'fast-forward'

export interface MainWorktreeStatus {
  path: string
  currentBranch: string
  baseBranch: string
  isOnBase: boolean
  isDirty: boolean
  /** True when the worktree is ready to accept a merge without any fixups */
  ready: boolean
}

export interface MergeLocalResult {
  ok: true
  strategy: MergeStrategy
  mergedBranch: string
  baseBranch: string
  mainPath: string
}

export interface MergeConflictPreview {
  hasConflict: boolean
  files: string[]
  /** True if git merge-tree isn't supported by the installed git (pre-2.38). */
  unsupported?: boolean
}

export interface FileReadResult {
  content: string | null
  size: number
  binary: boolean
  truncated: boolean
  error?: string
}

export type FileBinaryReadResult =
  | { ok: true; base64: string; mime: string; size: number }
  | { ok: false; error: string }

export interface FileWriteResult {
  ok: boolean
  error?: string
}

export interface WorktreeScriptResult {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
  error?: string
}
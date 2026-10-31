export type CodeDiffStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'

export interface CodeDiffFile {
  path: string
  status: CodeDiffStatus
  previousPath?: string
  copied?: boolean
  additions?: number
  deletions?: number
  /** Worktree file mtime from lstat; undefined for deleted files. */
  mtimeMs?: number
}

export interface CodeDiffFileList {
  files: CodeDiffFile[]
  totalFiles: number
  totalAdditions: number
  totalDeletions: number
  baseRef: string
  mergeBase: string
  headRef: string
  isWorktreeDirty: boolean
  error?: 'invalid-ref' | 'no-merge-base' | 'unknown-worktree'
}

export interface BranchForCompare {
  name: string
  source: 'local' | 'remote' | 'tag'
}

export type ValidateRefResult =
  | { ok: true; ref: string; sha: string; type: 'branch' | 'tag' | 'commit' }
  | { ok: false; error: string }

export interface CodeDiffSides {
  original: string
  modified: string
  originalExists: boolean
  modifiedExists: boolean
  originalBinary: boolean
  modifiedBinary: boolean
  originalSize: number
  modifiedSize: number
  modifiedSymlink: boolean
  /** Set when a side is too large for the side-by-side editor; `original`
   * and `modified` are then empty. `patch` holds git's changed hunks, or
   * null when even those are over the cap. */
  large?: { patch: string | null }
  error?: string
}

export interface DefaultCompareRef {
  ref: string
  fetchable: boolean
}

export interface FetchCompareRefResult {
  ok: boolean
  error?: string
}

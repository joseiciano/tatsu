/** Lifecycle status of a companion Docker container for a worktree.
 *  - `starting`: container created but status not yet verified (e.g. on boot recovery).
 *  - `running`: container is up and accepting `docker exec`.
 *  - `stopped`: container exists but is not running.
 *  - `error`: container creation failed, Docker was unavailable during recovery, or cleanup failed. */
export type WorktreeContainerStatus = 'starting' | 'running' | 'stopped' | 'error'

/** Metadata for a worktree's companion Docker container. Stored in the
 *  worktrees slice and persisted to `config.worktreeContainers` on change. */
export interface WorktreeContainerMetadata {
  /** Docker container ID (from `docker run` output). */
  id: string
  /** Human-readable container name (format: `tatsu-wt-<basename>-<short-hash>`). */
  name: string
  /** Docker image used to create the container. */
  image: string
  /** Working directory inside the container. */
  workdir: string
  /** Shell used for `docker exec` commands. */
  shell: string
  /** Current lifecycle status. */
  status: WorktreeContainerStatus
  /** Error message when `status` is `'error'`. */
  error?: string
}

export interface Worktree {
  path: string
  branch: string
  head: string
  isBare: boolean
  isMain: boolean
  /** Directory birthtime in ms since epoch; 0 if unavailable. */
  createdAt: number
  /** Repo this worktree belongs to. Set after a cross-repo listWorktrees merge. */
  repoRoot: string
  container?: WorktreeContainerMetadata
}

export type PendingStatus = 'creating' | 'setup' | 'setup-failed' | 'error'

export interface PendingWorktree {
  /** Prefixed id like `pending:<uuid>` so the renderer can use it as an
   * activeWorktreeId during the creating/setup screens. */
  id: string
  repoRoot: string
  branchName: string
  status: PendingStatus
  error?: string
  setupLog?: string
  setupExitCode?: number
  /** Real on-disk path once addWorktree resolves. Set before status
   * transitions to 'setup-failed' so the "Continue anyway" path knows
   * where to jump. Also included in the runPending IPC return value on
   * the success path. */
  createdPath?: string
  /** One-shot kickoff prompt for the new Claude tab. In-memory only —
   * stripped before persistence. */
  initialPrompt?: string
  /** One-shot teleport session id for the new Claude tab. In-memory only. */
  teleportSessionId?: string
  agentKind?: 'claude' | 'codex' | 'opencode'
  model?: string
}

export type PendingDeletionPhase =
  | 'running-teardown'
  | 'removing-worktree'
  | 'failed'

export interface PendingDeletion {
  /** The worktree path being deleted — used as the key. */
  path: string
  repoRoot: string
  branch: string
  phase: PendingDeletionPhase
  /** Accumulated teardown script output. Undefined when the repo has no
   * teardown command configured — the renderer uses that to hide the log
   * panel entirely. */
  teardownLog?: string
  /** Teardown script exit code once it has finished. */
  teardownExitCode?: number
  error?: string
}

export interface WorktreesState {
  /** Flat list of worktrees across every known repo. */
  list: Worktree[]
  repoRoots: string[]
  pending: PendingWorktree[]
  /** In-flight deletions, keyed by worktree path. Lives in the store so
   * the UI can animate + stream teardown output and the FSM keeps running
   * if the user navigates away. */
  pendingDeletions: PendingDeletion[]
}

export type WorktreesEvent =
  | { type: 'worktrees/listChanged'; payload: Worktree[] }
  | {
      type: 'worktrees/containerUpdated'
      payload: { path: string; container?: WorktreeContainerMetadata }
    }
  | { type: 'worktrees/reposChanged'; payload: string[] }
  | { type: 'worktrees/pendingAdded'; payload: PendingWorktree }
  | {
      type: 'worktrees/pendingUpdated'
      payload: { id: string; patch: Partial<PendingWorktree> }
    }
  | { type: 'worktrees/pendingRemoved'; payload: string }
  | { type: 'worktrees/pendingDeletionStarted'; payload: PendingDeletion }
  | {
      type: 'worktrees/pendingDeletionUpdated'
      payload: { path: string; patch: Partial<PendingDeletion> }
    }
  | { type: 'worktrees/pendingDeletionRemoved'; payload: string }

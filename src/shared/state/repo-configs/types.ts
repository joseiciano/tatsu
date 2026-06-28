export type RightPanelKey =
  | 'merge'
  | 'pr'
  | 'todos'
  | 'commits'
  | 'changedFiles'
  | 'allFiles'
  | 'cost'
  | 'scratchpad'

export type HiddenRightPanels = Partial<Record<RightPanelKey, boolean>>

export interface RepoConfig {
  version?: number
  setupCommand?: string
  teardownCommand?: string
  mergeStrategy?: 'squash' | 'merge-commit' | 'fast-forward'
  /** @deprecated use hiddenRightPanels.merge. Migrated on load. */
  hideMergePanel?: boolean
  /** @deprecated use hiddenRightPanels.pr. Migrated on load. */
  hidePrPanel?: boolean
  /** Per-panel visibility. A key set to true hides that panel. */
  hiddenRightPanels?: HiddenRightPanels
  /** Order of right-column panels. Unknown / missing keys fall back to
   * DEFAULT_RIGHT_PANEL_ORDER (any key absent from the saved order is
   * appended to the end in canonical order). */
  rightPanelOrder?: RightPanelKey[]
  container?: RepoContainerConfig
}

/** Container configuration for worktree isolation via Docker. Written to
 *  `.harness.json` by the user. Env var values are stored in plaintext —
 *  `.harness.json` is not a secure store for secrets. */
export interface RepoContainerConfig {
  /** Docker image to use (e.g. `node:20-alpine`). Mutually exclusive with `dockerfile`. */
  image?: string
  /** Path to a Dockerfile to build. Mutually exclusive with `image`. Relative paths resolve from repo root. */
  dockerfile?: string
  /** Working directory inside the container. Defaults to `/workspace`. Must be absolute. */
  workdir?: string
  /** Shell to use for `docker exec`. Defaults to `/bin/sh`. */
  shell?: string
  /** Environment variables to pass to the container. Keys must match `^[A-Za-z_][A-Za-z0-9_]*$`. */
  env?: Record<string, string>
  /** Container ports to expose on the host. Bound to `127.0.0.1` only. */
  ports?: number[]
  /** Additional volume mounts. `source` is a host path (relative to repo root or absolute); `target` is a container path. */
  volumes?: Array<{ source: string; target: string }>
  /** When `true`, skip container creation for this repo even if the global setting is on. */
  disabled?: boolean
}

export interface RepoConfigsState {
  /** Per-repo config keyed by repoRoot. Hydrated at boot from each repo's
   * .harness.json file and updated whenever a setRepoConfig call commits. */
  byRepo: Record<string, RepoConfig>
}

export type RepoConfigsEvent =
  | { type: 'repoConfigs/loaded'; payload: Record<string, RepoConfig> }
  | { type: 'repoConfigs/changed'; payload: { repoRoot: string; config: RepoConfig } }
  | { type: 'repoConfigs/removed'; payload: string }

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

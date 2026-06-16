import type { HiddenRightPanels, RepoConfigsState, RightPanelKey } from './types'

export const DEFAULT_RIGHT_PANEL_ORDER: RightPanelKey[] = [
  'merge',
  'pr',
  'commits',
  'changedFiles',
  'allFiles',
  'todos',
  'cost',
  'scratchpad'
]

/** Panels hidden by default unless the user explicitly enables them.
 *  Merged UNDER the saved config in `effectiveHiddenRightPanels` — once a
 *  user toggles a panel here, their choice wins. */
export const DEFAULT_HIDDEN_RIGHT_PANELS: HiddenRightPanels = {
  scratchpad: true
}

export const initialRepoConfigs: RepoConfigsState = {
  byRepo: {}
}

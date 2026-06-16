import type { HiddenRightPanels, RepoConfigsEvent, RepoConfigsState, RepoConfig, RightPanelKey } from './types'
import { DEFAULT_HIDDEN_RIGHT_PANELS, DEFAULT_RIGHT_PANEL_ORDER } from './constants'

/** Read an effective panel order, filling in any keys missing from the
 * saved order with the canonical default order (appended at the end)
 * and dropping any unknown keys. Always returns all six keys exactly
 * once. */
export function effectiveRightPanelOrder(config: RepoConfig | null | undefined): RightPanelKey[] {
  const saved = config?.rightPanelOrder
  if (!saved || saved.length === 0) return [...DEFAULT_RIGHT_PANEL_ORDER]
  const known = new Set<RightPanelKey>(DEFAULT_RIGHT_PANEL_ORDER)
  const seen = new Set<RightPanelKey>()
  const out: RightPanelKey[] = []
  for (const k of saved) {
    if (known.has(k) && !seen.has(k)) {
      out.push(k)
      seen.add(k)
    }
  }
  for (const k of DEFAULT_RIGHT_PANEL_ORDER) {
    if (!seen.has(k)) out.push(k)
  }
  return out
}

/** Read an effective hidden map, migrating legacy hideMergePanel /
 * hidePrPanel fields. Returns a fresh object — safe to mutate.
 *
 * DEFAULT_HIDDEN_RIGHT_PANELS is merged UNDER the saved values, so once
 * the user explicitly toggles a default-hidden panel on, their choice wins. */
export function effectiveHiddenRightPanels(config: RepoConfig | null | undefined): HiddenRightPanels {
  const out: HiddenRightPanels = {
    ...DEFAULT_HIDDEN_RIGHT_PANELS,
    ...(config?.hiddenRightPanels || {})
  }
  if (config?.hideMergePanel && out.merge === undefined) out.merge = true
  if (config?.hidePrPanel && out.pr === undefined) out.pr = true
  return out
}

export function repoConfigsReducer(
  state: RepoConfigsState,
  event: RepoConfigsEvent
): RepoConfigsState {
  switch (event.type) {
    case 'repoConfigs/loaded':
      return { ...state, byRepo: event.payload }
    case 'repoConfigs/changed':
      return {
        ...state,
        byRepo: { ...state.byRepo, [event.payload.repoRoot]: event.payload.config }
      }
    case 'repoConfigs/removed': {
      if (!(event.payload in state.byRepo)) return state
      const { [event.payload]: _dropped, ...rest } = state.byRepo
      void _dropped
      return { ...state, byRepo: rest }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

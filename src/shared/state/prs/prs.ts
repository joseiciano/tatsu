import type { PRsEvent, PRsState, PRStatus } from './types'

/** True if a PR is in a terminal state (merged or closed). Use this any
 * time you need a boolean "is this PR done?" — distinct icon-color sites
 * that need to differentiate merged-vs-closed should still inline. */
export function isPRMerged(pr: PRStatus | null | undefined): boolean {
  return pr?.state === 'merged' || pr?.state === 'closed'
}

/** Canonical "is this worktree merged?" check. A worktree counts as merged
 * if the locally-merged poller flagged it (branch SHA matches a recorded
 * merge SHA — works without a GitHub token), or its PR is in a terminal
 * state. Used by the activity deriver, the cleanup view, and boot-time
 * pane init (sleep-on-boot for merged worktrees). */
export function isWorktreeMerged(prs: PRsState, worktreePath: string): boolean {
  return !!prs.mergedByPath[worktreePath] || isPRMerged(prs.byPath[worktreePath])
}

export function prsReducer(state: PRsState, event: PRsEvent): PRsState {
  switch (event.type) {
    case 'prs/statusChanged':
      return {
        ...state,
        byPath: { ...state.byPath, [event.payload.path]: event.payload.status }
      }
    case 'prs/bulkStatusChanged':
      return { ...state, byPath: event.payload }
    case 'prs/mergedChanged':
      return { ...state, mergedByPath: event.payload }
    case 'prs/loadingChanged':
      return { ...state, loading: event.payload }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

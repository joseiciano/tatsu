import type { WorktreesEvent, WorktreesState } from './types'

export function worktreesReducer(
  state: WorktreesState,
  event: WorktreesEvent
): WorktreesState {
  switch (event.type) {
    case 'worktrees/listChanged':
      return { ...state, list: event.payload }
    case 'worktrees/reposChanged':
      return { ...state, repoRoots: event.payload }
    case 'worktrees/pendingAdded':
      return { ...state, pending: [...state.pending, event.payload] }
    case 'worktrees/pendingUpdated': {
      const i = state.pending.findIndex((p) => p.id === event.payload.id)
      if (i === -1) return state
      const patched = { ...state.pending[i], ...event.payload.patch }
      return {
        ...state,
        pending: [
          ...state.pending.slice(0, i),
          patched,
          ...state.pending.slice(i + 1)
        ]
      }
    }
    case 'worktrees/pendingRemoved':
      return { ...state, pending: state.pending.filter((p) => p.id !== event.payload) }
    case 'worktrees/pendingDeletionStarted':
      return {
        ...state,
        pendingDeletions: [
          ...state.pendingDeletions.filter((d) => d.path !== event.payload.path),
          event.payload
        ]
      }
    case 'worktrees/pendingDeletionUpdated': {
      const i = state.pendingDeletions.findIndex(
        (d) => d.path === event.payload.path
      )
      if (i === -1) return state
      const patched = { ...state.pendingDeletions[i], ...event.payload.patch }
      return {
        ...state,
        pendingDeletions: [
          ...state.pendingDeletions.slice(0, i),
          patched,
          ...state.pendingDeletions.slice(i + 1)
        ]
      }
    }
    case 'worktrees/pendingDeletionRemoved':
      return {
        ...state,
        pendingDeletions: state.pendingDeletions.filter((d) => d.path !== event.payload)
      }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

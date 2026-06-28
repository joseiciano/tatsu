import type { WorktreesEvent, WorktreesState, WorktreeContainerMetadata } from './types'

function containersShallowEqual(a: WorktreeContainerMetadata | undefined, b: WorktreeContainerMetadata | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.id === b.id && a.name === b.name && a.image === b.image && a.workdir === b.workdir && a.shell === b.shell && a.status === b.status && a.error === b.error
}

export function worktreesReducer(
  state: WorktreesState,
  event: WorktreesEvent
): WorktreesState {
  switch (event.type) {
    case 'worktrees/listChanged':
      return { ...state, list: event.payload }
    case 'worktrees/containerUpdated': {
      const i = state.list.findIndex((w) => w.path === event.payload.path)
      if (i === -1) return state
      const current = state.list[i]
      const newContainer = event.payload.container
      if (containersShallowEqual(current.container, newContainer)) return state
      const patched = newContainer
        ? { ...current, container: newContainer }
        : withoutContainer(current)
      return {
        ...state,
        list: [...state.list.slice(0, i), patched, ...state.list.slice(i + 1)]
      }
    }
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
    case 'worktrees/pendingRemoved': {
      const i = state.pending.findIndex((p) => p.id === event.payload)
      if (i === -1) return state
      return { ...state, pending: [...state.pending.slice(0, i), ...state.pending.slice(i + 1)] }
    }
    case 'worktrees/pendingDeletionStarted': {
      const existingIndex = state.pendingDeletions.findIndex((d) => d.path === event.payload.path)
      if (existingIndex === -1) {
        return {
          ...state,
          pendingDeletions: [...state.pendingDeletions, event.payload]
        }
      }
      return {
        ...state,
        pendingDeletions: [
          ...state.pendingDeletions.slice(0, existingIndex),
          ...state.pendingDeletions.slice(existingIndex + 1),
          event.payload
        ]
      }
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
    case 'worktrees/pendingDeletionRemoved': {
      const i = state.pendingDeletions.findIndex((d) => d.path === event.payload)
      if (i === -1) return state
      return {
        ...state,
        pendingDeletions: [...state.pendingDeletions.slice(0, i), ...state.pendingDeletions.slice(i + 1)]
      }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

function withoutContainer(worktree: WorktreesState['list'][number]): WorktreesState['list'][number] {
  if (!worktree.container) return worktree
  const { container: _container, ...rest } = worktree
  void _container
  return rest
}

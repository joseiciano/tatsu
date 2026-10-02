import type { WorktreeContainerMetadata } from '../../../shared/state/worktrees'

export function containerStatusLabel(container: WorktreeContainerMetadata): string {
  if (container.status === 'error') {
    return container.error ? shortContainerError(container.error) : 'Container error'
  }
  return `Container ${container.status}`
}

export function shortContainerError(error: string): string {
  const max = 80
  if (error.length <= max) return error
  return error.slice(0, max - 1) + '…'
}

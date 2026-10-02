import type { WorktreeContainerMetadata } from '../../shared/state/worktrees'
import type { WorktreeContainers } from '../worktree-containers'
import type { RepoConfig } from '../../shared/state/repo-configs'

export interface WorktreeContainerActionsDeps {
  getWorktrees: () => Array<{ path: string; repoRoot: string; container?: WorktreeContainerMetadata }>
  updateContainer: (path: string, next?: WorktreeContainerMetadata) => void
  loadRepoConfig: (repoRoot: string) => RepoConfig
  containers: Pick<WorktreeContainers, 'restartContainer' | 'createForWorktree' | 'resolveContainerConfig'>
}

function truncateError(message: string, max = 160): string {
  if (message.length <= max) return message
  return message.slice(0, max - 1) + '…'
}

function withStatus(container: WorktreeContainerMetadata, status: WorktreeContainerMetadata['status'], error?: string): WorktreeContainerMetadata {
  const next: WorktreeContainerMetadata = { ...container, status }
  if (error) next.error = error
  else delete next.error
  return next
}

export async function restartWorktreeContainer(deps: WorktreeContainerActionsDeps, path: string): Promise<boolean> {
  const wt = deps.getWorktrees().find((w) => w.path === path)
  if (!wt || !wt.container) return false
  const existing = wt.container
  deps.updateContainer(path, withStatus(existing, 'starting'))
  try {
    await deps.containers.restartContainer(existing.id)
    deps.updateContainer(path, withStatus(existing, 'running'))
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    deps.updateContainer(path, withStatus(existing, 'error', truncateError(message)))
    return false
  }
}

export async function recreateWorktreeContainer(deps: WorktreeContainerActionsDeps, path: string): Promise<boolean> {
  const wt = deps.getWorktrees().find((w) => w.path === path)
  if (!wt || !wt.container) return false
  const existing = wt.container
  deps.updateContainer(path, withStatus(existing, 'starting'))
  try {
    const repoConfig = deps.loadRepoConfig(wt.repoRoot)
    if (repoConfig.container?.disabled) {
      deps.updateContainer(path, withStatus(existing, 'error', 'Container config is disabled'))
      return false
    }
    const config = deps.containers.resolveContainerConfig(wt.repoRoot, path, repoConfig.container)
    const created = await deps.containers.createForWorktree(wt.repoRoot, path, config)
    deps.updateContainer(path, { ...created, status: 'running' })
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    deps.updateContainer(path, withStatus(existing, 'error', truncateError(message)))
    return false
  }
}

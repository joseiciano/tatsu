import { describe, expect, it, vi } from 'vitest'
import type { WorktreeContainerMetadata, Worktree } from '../../shared/state/worktrees'
import type { RepoConfig } from '../../shared/state/repo-configs'
import type { WorktreeContainers } from '../worktree-containers'
import { recreateWorktreeContainer, restartWorktreeContainer } from './worktree-container-actions'

function container(overrides: Partial<WorktreeContainerMetadata> = {}): WorktreeContainerMetadata {
  return {
    id: 'container-1',
    name: 'tatsu-wt-feature',
    image: 'node:20-alpine',
    workdir: '/workspace',
    shell: '/bin/sh',
    status: 'running',
    ...overrides
  }
}

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    path: '/repo/wt',
    branch: 'feature',
    head: 'deadbeef',
    isBare: false,
    isMain: false,
    createdAt: 0,
    repoRoot: '/repo',
    container: container(),
    ...overrides
  }
}

function deps(overrides: {
  worktrees?: Worktree[]
  loadRepoConfig?: (repoRoot: string) => RepoConfig
  containers?: Partial<WorktreeContainers>
} = {}) {
  const updates: Array<{ path: string; container?: WorktreeContainerMetadata }> = []
  const containers: Pick<WorktreeContainers, 'restartContainer' | 'createForWorktree' | 'resolveContainerConfig'> = {
    restartContainer: vi.fn().mockResolvedValue(undefined),
    resolveContainerConfig: vi.fn().mockReturnValue({ image: 'node:22-alpine', workdir: '/workspace', shell: '/bin/sh', env: {}, ports: [], volumes: [] }),
    createForWorktree: vi.fn().mockResolvedValue(container({ id: 'container-2', image: 'node:22-alpine' })),
    ...overrides.containers
  }
  return {
    deps: {
      getWorktrees: () => overrides.worktrees ?? [worktree()],
      updateContainer: (path: string, next?: WorktreeContainerMetadata) => updates.push({ path, container: next }),
      loadRepoConfig: overrides.loadRepoConfig ?? (() => ({ container: { image: 'node:22-alpine' } })),
      containers
    },
    updates,
    containers
  }
}

describe('restartWorktreeContainer', () => {
  it('marks a container starting, restarts it, then marks it running', async () => {
    const subject = deps()
    const ok = await restartWorktreeContainer(subject.deps, '/repo/wt')
    expect(ok).toBe(true)
    expect(subject.containers.restartContainer).toHaveBeenCalledWith('container-1')
    expect(subject.updates.map((u) => u.container?.status)).toEqual(['starting', 'running'])
  })

  it('clears stale errors during successful restart recovery', async () => {
    const subject = deps({ worktrees: [worktree({ container: container({ status: 'error', error: 'old failure' }) })] })
    const ok = await restartWorktreeContainer(subject.deps, '/repo/wt')
    expect(ok).toBe(true)
    expect(subject.updates[0].container?.error).toBeUndefined()
    expect(subject.updates[1].container?.error).toBeUndefined()
  })

  it('marks restart failures as recoverable container errors', async () => {
    const subject = deps({ containers: { restartContainer: vi.fn().mockRejectedValue(new Error('boom '.repeat(60))) } })
    const ok = await restartWorktreeContainer(subject.deps, '/repo/wt')
    expect(ok).toBe(false)
    expect(subject.updates.at(-1)?.container?.status).toBe('error')
    expect(subject.updates.at(-1)?.container?.error?.length).toBeLessThanOrEqual(160)
  })
})

describe('recreateWorktreeContainer', () => {
  it('uses current repo config and replaces metadata on success', async () => {
    const subject = deps()
    const ok = await recreateWorktreeContainer(subject.deps, '/repo/wt')
    expect(ok).toBe(true)
    expect(subject.containers.resolveContainerConfig).toHaveBeenCalledWith('/repo', '/repo/wt', { image: 'node:22-alpine' })
    expect(subject.containers.createForWorktree).toHaveBeenCalledWith('/repo', '/repo/wt', { image: 'node:22-alpine', workdir: '/workspace', shell: '/bin/sh', env: {}, ports: [], volumes: [] })
    expect(subject.updates.map((u) => u.container?.id)).toEqual(['container-1', 'container-2'])
  })

  it('surfaces disabled current config as a recoverable error', async () => {
    const subject = deps({ loadRepoConfig: () => ({ container: { disabled: true } }) })
    const ok = await recreateWorktreeContainer(subject.deps, '/repo/wt')
    expect(ok).toBe(false)
    expect(subject.containers.createForWorktree).not.toHaveBeenCalled()
    expect(subject.updates.at(-1)?.container?.status).toBe('error')
    expect(subject.updates.at(-1)?.container?.error).toBe('Container config is disabled')
  })
})

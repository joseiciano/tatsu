import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WorktreeDeletionFSM } from './worktree-deletion-fsm'
import { Store } from '../store'
import { initialState } from '../../shared/state'

vi.mock('../worktree', () => ({
  removeWorktree: vi.fn(async () => undefined),
  runWorktreeScript: vi.fn(async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '' })),
}))
vi.mock('../repo-config', () => ({ loadRepoConfig: vi.fn(() => ({})) }))
vi.mock('../debug', () => ({ log: vi.fn() }))
vi.mock('../perf-log', () => ({ perfLog: vi.fn() }))

import { removeWorktree, runWorktreeScript } from '../worktree'

describe('WorktreeDeletionFSM container cleanup', () => {
  let store: Store

  beforeEach(() => {
    store = new Store(initialState)
    vi.clearAllMocks()
  })

  it('runs teardown inside companion container when one exists', async () => {
    const containers = {
      execInContainer: vi.fn(async (_id: string, _cmd: string, opts: { onOutput?: (chunk: string) => void }) => {
        opts.onOutput?.('container teardown')
        return { stdout: '', stderr: '', exitCode: 0 }
      }),
      stopContainer: vi.fn(async () => undefined),
    }
    store.dispatch({
      type: 'worktrees/listChanged',
      payload: [{
        path: '/repo/wt/feature',
        branch: 'feature',
        head: 'abc',
        isBare: false,
        isMain: false,
        createdAt: 0,
        repoRoot: '/repo',
        container: { id: 'c1', name: 'tw', image: 'n', workdir: '/w', shell: '/bin/sh', status: 'running' }
      }]
    })
    const fsm = new WorktreeDeletionFSM(store, {
      getGlobalTeardownCmd: () => 'pnpm teardown',
      worktreesFSM: { refreshList: vi.fn(async () => undefined) },
      containers,
    } as any)

    await (fsm as any).run({ repoRoot: '/repo', path: '/repo/wt/feature', branch: 'feature' })

    expect(containers.execInContainer).toHaveBeenCalledWith('c1', 'pnpm teardown', expect.objectContaining({ workdir: '/w', shell: '/bin/sh' }))
    expect(runWorktreeScript).not.toHaveBeenCalled()
  })
  it('stops companion container and clears metadata when deleting a worktree', async () => {
    const containers = { stopContainer: vi.fn(async () => undefined) }
    const worktreesFSM = { refreshList: vi.fn(async () => undefined) }
    store.dispatch({
      type: 'worktrees/listChanged',
      payload: [{
        path: '/repo/wt/feature',
        branch: 'feature',
        head: 'abc',
        isBare: false,
        isMain: false,
        createdAt: 0,
        repoRoot: '/repo',
        container: { id: 'c1', name: 'tw', image: 'n', workdir: '/w', shell: '/bin/sh', status: 'running' }
      }]
    })
    const fsm = new WorktreeDeletionFSM(store, {
      getGlobalTeardownCmd: () => '',
      worktreesFSM,
      containers,
    } as any)
    await (fsm as any).run({ repoRoot: '/repo', path: '/repo/wt/feature', branch: 'feature' })
    expect(containers.stopContainer).toHaveBeenCalledWith('c1')
    expect(removeWorktree).toHaveBeenCalledWith('/repo', '/repo/wt/feature', undefined)
    expect(store.getSnapshot().state.worktrees.list[0]?.container).toBeUndefined()
  })

  it('continues deleting worktree when companion container cleanup fails', async () => {
    const containers = { stopContainer: vi.fn(async () => { throw new Error('docker unavailable') }) }
    const worktreesFSM = { refreshList: vi.fn(async () => undefined) }
    store.dispatch({
      type: 'worktrees/listChanged',
      payload: [{
        path: '/repo/wt/feature',
        branch: 'feature',
        head: 'abc',
        isBare: false,
        isMain: false,
        createdAt: 0,
        repoRoot: '/repo',
        container: { id: 'c1', name: 'tw', image: 'n', workdir: '/w', shell: '/bin/sh', status: 'running' }
      }]
    })
    const fsm = new WorktreeDeletionFSM(store, {
      getGlobalTeardownCmd: () => '',
      worktreesFSM,
      containers,
    } as any)

    await (fsm as any).run({ repoRoot: '/repo', path: '/repo/wt/feature', branch: 'feature' })

    expect(containers.stopContainer).toHaveBeenCalledWith('c1')
    expect(removeWorktree).toHaveBeenCalledWith('/repo', '/repo/wt/feature', undefined)
    expect(worktreesFSM.refreshList).toHaveBeenCalled()
    expect(store.getSnapshot().state.worktrees.pendingDeletions).toEqual([])
  })

  it('continues deleting worktree when runWorktreeScript teardown throws', async () => {
    vi.mocked(runWorktreeScript).mockRejectedValueOnce(new Error('script crash'))
    const worktreesFSM = { refreshList: vi.fn(async () => undefined) }
    const fsm = new WorktreeDeletionFSM(store, {
      getGlobalTeardownCmd: () => 'pnpm teardown',
      worktreesFSM,
    } as any)

    await (fsm as any).run({ repoRoot: '/repo', path: '/repo/wt/feature', branch: 'feature' })

    expect(runWorktreeScript).toHaveBeenCalledWith('teardown', 'pnpm teardown', expect.objectContaining({ worktreePath: '/repo/wt/feature' }), expect.any(Function))
    expect(removeWorktree).toHaveBeenCalledWith('/repo', '/repo/wt/feature', undefined)
    expect(worktreesFSM.refreshList).toHaveBeenCalled()
    expect(store.getSnapshot().state.worktrees.pendingDeletions).toEqual([])
  })

  it('continues deleting worktree when execInContainer teardown rejects', async () => {
    const containers = {
      execInContainer: vi.fn(async () => { throw new Error('Docker timeout') }),
      stopContainer: vi.fn(async () => undefined),
    }
    const worktreesFSM = { refreshList: vi.fn(async () => undefined) }
    store.dispatch({
      type: 'worktrees/listChanged',
      payload: [{
        path: '/repo/wt/feature',
        branch: 'feature',
        head: 'abc',
        isBare: false,
        isMain: false,
        createdAt: 0,
        repoRoot: '/repo',
        container: { id: 'c1', name: 'tw', image: 'n', workdir: '/w', shell: '/bin/sh', status: 'running' }
      }]
    })
    const fsm = new WorktreeDeletionFSM(store, {
      getGlobalTeardownCmd: () => 'pnpm teardown',
      worktreesFSM,
      containers,
    } as any)

    await (fsm as any).run({ repoRoot: '/repo', path: '/repo/wt/feature', branch: 'feature' })

    expect(containers.execInContainer).toHaveBeenCalled()
    expect(containers.stopContainer).toHaveBeenCalledWith('c1')
    expect(removeWorktree).toHaveBeenCalledWith('/repo', '/repo/wt/feature', undefined)
    expect(worktreesFSM.refreshList).toHaveBeenCalled()
    expect(store.getSnapshot().state.worktrees.pendingDeletions).toEqual([])
  })

  it('clears container metadata on stopContainer failure before refresh', async () => {
    const containers = {
      stopContainer: vi.fn(async () => { throw new Error('docker daemon down') }),
    }
    const worktreesFSM = { refreshList: vi.fn(async () => undefined) }
    store.dispatch({
      type: 'worktrees/listChanged',
      payload: [{
        path: '/repo/wt/feature',
        branch: 'feature',
        head: 'abc',
        isBare: false,
        isMain: false,
        createdAt: 0,
        repoRoot: '/repo',
        container: { id: 'c1', name: 'tw', image: 'n', workdir: '/w', shell: '/bin/sh', status: 'running' }
      }]
    })
    const fsm = new WorktreeDeletionFSM(store, {
      getGlobalTeardownCmd: () => '',
      worktreesFSM,
      containers,
    } as any)

    await (fsm as any).run({ repoRoot: '/repo', path: '/repo/wt/feature', branch: 'feature' })

    const wt = store.getSnapshot().state.worktrees.list.find((w) => w.path === '/repo/wt/feature')
    expect(wt?.container).toBeUndefined()
    expect(removeWorktree).toHaveBeenCalled()
  })

  it('falls back to host teardown when companion container is stopped', async () => {
    const containers = {
      execInContainer: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      stopContainer: vi.fn(async () => undefined),
    }
    const worktreesFSM = { refreshList: vi.fn(async () => undefined) }
    store.dispatch({
      type: 'worktrees/listChanged',
      payload: [{
        path: '/repo/wt/feature',
        branch: 'feature',
        head: 'abc',
        isBare: false,
        isMain: false,
        createdAt: 0,
        repoRoot: '/repo',
        container: { id: 'c1', name: 'tw', image: 'n', workdir: '/w', shell: '/bin/sh', status: 'stopped' }
      }]
    })
    const fsm = new WorktreeDeletionFSM(store, {
      getGlobalTeardownCmd: () => 'pnpm teardown',
      worktreesFSM,
      containers,
    } as any)

    await (fsm as any).run({ repoRoot: '/repo', path: '/repo/wt/feature', branch: 'feature' })

    expect(containers.execInContainer).not.toHaveBeenCalled()
    expect(runWorktreeScript).toHaveBeenCalledWith('teardown', 'pnpm teardown', expect.objectContaining({ worktreePath: '/repo/wt/feature' }), expect.any(Function))
  })

  it('falls back to host teardown when companion container is in error state', async () => {
    const containers = {
      execInContainer: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      stopContainer: vi.fn(async () => undefined),
    }
    const worktreesFSM = { refreshList: vi.fn(async () => undefined) }
    store.dispatch({
      type: 'worktrees/listChanged',
      payload: [{
        path: '/repo/wt/feature',
        branch: 'feature',
        head: 'abc',
        isBare: false,
        isMain: false,
        createdAt: 0,
        repoRoot: '/repo',
        container: { id: 'c1', name: 'tw', image: 'n', workdir: '/w', shell: '/bin/sh', status: 'error' }
      }]
    })
    const fsm = new WorktreeDeletionFSM(store, {
      getGlobalTeardownCmd: () => 'pnpm teardown',
      worktreesFSM,
      containers,
    } as any)

    await (fsm as any).run({ repoRoot: '/repo', path: '/repo/wt/feature', branch: 'feature' })

    expect(containers.execInContainer).not.toHaveBeenCalled()
    expect(runWorktreeScript).toHaveBeenCalledWith('teardown', 'pnpm teardown', expect.objectContaining({ worktreePath: '/repo/wt/feature' }), expect.any(Function))
  })

  it('marks pending deletion as failed when removeWorktree throws', async () => {
    vi.mocked(removeWorktree).mockRejectedValueOnce(new Error('permission denied'))
    const worktreesFSM = { refreshList: vi.fn(async () => undefined) }
    const fsm = new WorktreeDeletionFSM(store, {
      getGlobalTeardownCmd: () => '',
      worktreesFSM,
    } as any)

    await (fsm as any).run({ repoRoot: '/repo', path: '/repo/wt/feature', branch: 'feature' })

    const pending = store.getSnapshot().state.worktrees.pendingDeletions.find((d) => d.path === '/repo/wt/feature')
    expect(pending?.phase).toBe('failed')
    expect(pending?.error).toBe('permission denied')
    expect(worktreesFSM.refreshList).not.toHaveBeenCalled()
  })

  it('caps and throttles teardown logs', async () => {
    vi.useFakeTimers()
    const dispatchSpy = vi.spyOn(store, 'dispatch')
    vi.mocked(runWorktreeScript).mockImplementationOnce(async (_kind, _cmd, _ctx, onOutput) => {
      onOutput?.('stdout', 'a'.repeat(80_000))
      onOutput?.('stdout', 'b'.repeat(80_000))
      onOutput?.('stdout', 'c')
      return { ok: true, exitCode: 0, stdout: '', stderr: '' }
    })
    const fsm = new WorktreeDeletionFSM(store, {
      getGlobalTeardownCmd: () => 'pnpm teardown',
      worktreesFSM: { refreshList: vi.fn(async () => undefined) },
    } as any)

    const resultPromise = (fsm as any).run({ repoRoot: '/repo', path: '/repo/wt/feature', branch: 'feature' })
    await vi.runAllTimersAsync()
    await resultPromise
    vi.useRealTimers()

    const teardownLogUpdates = dispatchSpy.mock.calls.filter(([event]) => event.type === 'worktrees/pendingDeletionUpdated' && event.payload.path === '/repo/wt/feature' && 'teardownLog' in event.payload.patch)
    expect(teardownLogUpdates.length).toBeLessThanOrEqual(3)
    for (const [event] of teardownLogUpdates) {
      const teardownLog = (event as any).payload.patch.teardownLog
      expect(teardownLog?.length ?? 0).toBeLessThanOrEqual(100_000)
    }
  })
})

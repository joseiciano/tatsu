import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sanitizeHeadBranchForLocal } from '.'
import { WorktreesFSM } from './worktrees-fsm'
import { Store } from '../store'
import { initialState } from '../../shared/state'
import type { WorktreeContainers, CreatedWorktreeContainer } from '../worktree-containers'
import type { PendingOutcome } from './worktrees-fsm'

vi.mock('../worktree', () => ({
  addWorktree: vi.fn(),
  defaultWorktreeDir: vi.fn(() => '/repo/.worktrees'),
  fetchPullRequestRef: vi.fn(),
  listWorktrees: vi.fn(async () => []),
  localBranchExists: vi.fn(async () => false),
  runWorktreeScript: vi.fn(async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '' })),
  symlinkClaudeSettings: vi.fn(),
}))
vi.mock('../repo-config', () => ({ loadRepoConfig: vi.fn(() => ({})) }))
vi.mock('../github', () => ({ getPRMetadata: vi.fn() }))
vi.mock('../build-initial-state', () => ({ hydratePersistedWorktreeContainers: vi.fn((wt: any[], persisted: any, existing: any[] = []) => wt.map((w) => {
  const existingContainer = existing.find((e) => e.path === w.path)?.container
  if (existingContainer) return { ...w, container: existingContainer }
  const container = persisted?.[w.path]
  return container?.id ? { ...w, container: { ...container, status: 'starting', error: 'Container status has not been checked yet.' } } : w
})) }))
vi.mock('../debug', () => ({ log: vi.fn() }))
vi.mock('../perf-log', () => ({ perfLog: vi.fn() }))

import { addWorktree, runWorktreeScript, listWorktrees } from '../worktree'
const mockedAddWorktree = vi.mocked(addWorktree)
const mockedRunWorktreeScript = vi.mocked(runWorktreeScript)
const mockedListWorktrees = vi.mocked(listWorktrees)

describe('sanitizeHeadBranchForLocal', () => {
  it('returns the head ref unchanged for typical names', () => {
    expect(sanitizeHeadBranchForLocal('fix-the-thing')).toBe('fix-the-thing')
    expect(sanitizeHeadBranchForLocal('release_2024.10-rc1')).toBe('release_2024.10-rc1')
  })
  it('preserves slashes', () => {
    expect(sanitizeHeadBranchForLocal('feature/foo')).toBe('feature/foo')
  })
  it('strips control chars', () => {
    expect(sanitizeHeadBranchForLocal('a~b^c?d')).toBe('abcd')
  })
  it('collapses `..`', () => {
    expect(sanitizeHeadBranchForLocal('feature..foo')).toBe('feature.foo')
  })
})

describe('WorktreesFSM container integration', () => {
  let store: Store
  let onWorktreeCreated: ReturnType<typeof vi.fn>

  function makeFSM(containers: WorktreeContainers, opts?: Partial<Record<string, unknown>>) {
    return new WorktreesFSM(store, {
      getRepoRoots: () => ['/repo'],
      getWorktreeSetupCmd: () => 'pnpm install',
      getWorktreeBaseMode: () => 'local',
      containers,
      onWorktreeCreated,
      ...opts,
    } as any)
  }

  beforeEach(() => {
    store = new Store(initialState)
    onWorktreeCreated = vi.fn()
    vi.clearAllMocks()
    mockedAddWorktree.mockResolvedValue({ path: '/repo/wt/test-branch', branch: 'test-branch', head: 'abc123', isBare: false, isMain: false, createdAt: Date.now(), repoRoot: '/repo' })
  })

  it('no container calls when setting off', async () => {
    const containers = { checkDockerAvailable: vi.fn(), resolveContainerConfig: vi.fn(), ensureImage: vi.fn(), createForWorktree: vi.fn(), execInContainer: vi.fn() } as any
    const fsm = makeFSM(containers, { getEnableWorktreeContainers: () => false })
    const result = await fsm.runPending({ id: 'p1', repoRoot: '/repo', branchName: 'test-branch' })
    expect(result.outcome).toBe('success')
    expect(containers.createForWorktree).not.toHaveBeenCalled()
    expect(mockedRunWorktreeScript).toHaveBeenCalled()
  })

  it('passes container.shell to execInContainer', async () => {
    const containers = {
      checkDockerAvailable: vi.fn(async () => ({ ok: true })),
      resolveContainerConfig: vi.fn(() => ({ image: 'n', workdir: '/w', shell: '/bin/sh', env: {}, ports: [], volumes: [] })),
      ensureImage: vi.fn(),
      createForWorktree: vi.fn().mockResolvedValue({ id: 'c1', name: 'tw', image: 'n', workdir: '/w', shell: '/bin/zsh', status: 'running' } as CreatedWorktreeContainer),
      execInContainer: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      stopContainer: vi.fn(),
    }
    const fsm = makeFSM(containers, { getEnableWorktreeContainers: () => true })
    await fsm.runPending({ id: 'p2', repoRoot: '/repo', branchName: 'test-branch' })
    expect(containers.execInContainer).toHaveBeenCalledWith('c1', 'pnpm install', expect.objectContaining({ shell: '/bin/zsh' }))
  })

  it('dispatches setupLog before container create', async () => {
    const containers = {
      checkDockerAvailable: vi.fn(async () => ({ ok: true })),
      resolveContainerConfig: vi.fn(() => ({ image: 'n', workdir: '/w', shell: '/bin/sh', env: {}, ports: [], volumes: [] })),
      ensureImage: vi.fn(),
      createForWorktree: vi.fn().mockRejectedValue(new Error('Docker fail')),
      execInContainer: vi.fn(),
      stopContainer: vi.fn(),
    }
    const fsm = makeFSM(containers, { getEnableWorktreeContainers: () => true })
    const result = await fsm.runPending({ id: 'p3', repoRoot: '/repo', branchName: 'test-branch' })
    expect(result.outcome).toBe('error')
    const pending = store.getSnapshot().state.worktrees.pending.find((p) => p.id === 'p3')
    expect(pending?.setupLog).toBe('Creating Docker container...')
    expect(onWorktreeCreated).not.toHaveBeenCalled()
  })

  it('records createdPath before container creation so retry skips addWorktree', async () => {
    const containers = {
      checkDockerAvailable: vi.fn(async () => ({ ok: true })),
      resolveContainerConfig: vi.fn(() => ({ image: 'n', workdir: '/w', shell: '/bin/sh', env: {}, ports: [], volumes: [] })),
      ensureImage: vi.fn(),
      createForWorktree: vi.fn().mockRejectedValue(new Error('Docker fail')),
      execInContainer: vi.fn(),
      stopContainer: vi.fn(),
    }
    const fsm = makeFSM(containers as any, { getEnableWorktreeContainers: () => true })
    await fsm.runPending({ id: 'p-created-path', repoRoot: '/repo', branchName: 'test-branch', agentKind: 'opencode', model: 'gpt-5.5' })
    const pending = store.getSnapshot().state.worktrees.pending.find((p) => p.id === 'p-created-path')
    expect(pending?.createdPath).toBe('/repo/wt/test-branch')
    expect(pending?.agentKind).toBe('opencode')
    expect(pending?.model).toBe('gpt-5.5')

    mockedAddWorktree.mockClear()
    mockedListWorktrees.mockResolvedValue([{ path: '/repo/wt/test-branch', branch: 'test-branch', head: 'abc', isBare: false, isMain: false, createdAt: 0, repoRoot: '/repo' }])
    containers.createForWorktree.mockResolvedValueOnce({ id: 'c1', name: 'tw', image: 'n', workdir: '/w', shell: '/bin/sh', status: 'running' } as CreatedWorktreeContainer)
    containers.execInContainer.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })

    const result = await fsm.retryPending('p-created-path')
    expect(result.outcome).toBe('success')
    expect(mockedAddWorktree).not.toHaveBeenCalled()
    expect(onWorktreeCreated).toHaveBeenLastCalledWith(expect.objectContaining({ agentKind: 'opencode', model: 'gpt-5.5' }))
  })

  it('setup failure retains container metadata', async () => {
    const containers = {
      checkDockerAvailable: vi.fn(async () => ({ ok: true })),
      resolveContainerConfig: vi.fn(() => ({ image: 'n', workdir: '/w', shell: '/bin/sh', env: {}, ports: [], volumes: [] })),
      ensureImage: vi.fn(),
      createForWorktree: vi.fn().mockResolvedValue({ id: 'c1', name: 'tw', image: 'n', workdir: '/w', shell: '/bin/sh', status: 'running' } as CreatedWorktreeContainer),
      execInContainer: vi.fn().mockResolvedValue({ stdout: '', stderr: 'fail', exitCode: 1 }),
      stopContainer: vi.fn(),
    }
    mockedListWorktrees.mockResolvedValue([{ path: '/repo/wt/test-branch', branch: 'test-branch', head: 'abc', isBare: false, isMain: false, createdAt: 0, repoRoot: '/repo' }])
    const fsm = makeFSM(containers, { getEnableWorktreeContainers: () => true })
    const result = await fsm.runPending({ id: 'p4', repoRoot: '/repo', branchName: 'test-branch' })
    expect(result.outcome).toBe('setup-failed')
    const wt = store.getSnapshot().state.worktrees.list.find((w) => w.path === '/repo/wt/test-branch')
    expect(wt?.container).toBeDefined()
    expect(wt?.container?.status).toBe('running')
  })

  it('marks container stopped when setup leaves it not running', async () => {
    const containers = {
      checkDockerAvailable: vi.fn(async () => ({ ok: true })),
      resolveContainerConfig: vi.fn(() => ({ image: 'n', workdir: '/w', shell: '/bin/sh', env: {}, ports: [], volumes: [] })),
      ensureImage: vi.fn(),
      createForWorktree: vi.fn().mockResolvedValue({ id: 'c-stopped', name: 'tw', image: 'n', workdir: '/w', shell: '/bin/sh', status: 'running' } as CreatedWorktreeContainer),
      execInContainer: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
      isContainerRunning: vi.fn().mockResolvedValue(false),
      stopContainer: vi.fn(),
    }
    mockedListWorktrees.mockResolvedValue([{ path: '/repo/wt/test-branch', branch: 'test-branch', head: 'abc', isBare: false, isMain: false, createdAt: 0, repoRoot: '/repo' }])
    const fsm = makeFSM(containers as any, { getEnableWorktreeContainers: () => true })

    const result = await fsm.runPending({ id: 'p-stopped', repoRoot: '/repo', branchName: 'test-branch' })

    expect(result.outcome).toBe('success')
    expect(containers.isContainerRunning).toHaveBeenCalledWith('c-stopped')
    const wt = store.getSnapshot().state.worktrees.list.find((w) => w.path === '/repo/wt/test-branch')
    expect(wt?.container?.status).toBe('stopped')
  })

  it('checks recovered starting containers after refresh', async () => {
    const containers = {
      checkDockerAvailable: vi.fn(async () => ({ ok: true })),
      resolveContainerConfig: vi.fn(),
      ensureImage: vi.fn(),
      createForWorktree: vi.fn(),
      execInContainer: vi.fn(),
      isContainerRunning: vi.fn().mockResolvedValue(true),
      stopContainer: vi.fn(),
    }
    mockedListWorktrees.mockResolvedValue([{ path: '/repo/wt/recovered', branch: 'recovered', head: 'abc', isBare: false, isMain: false, createdAt: 0, repoRoot: '/repo' }])
    const fsm = makeFSM(containers as any, {
      getPersistedWorktreeContainers: () => ({
        '/repo/wt/recovered': {
          id: 'c-recovered',
          name: 'tw',
          image: 'n',
          workdir: '/w',
          shell: '/bin/sh'
        }
      })
    })

    await fsm.refreshList()
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(containers.isContainerRunning).toHaveBeenCalledWith('c-recovered')
    const wt = store.getSnapshot().state.worktrees.list.find((w) => w.path === '/repo/wt/recovered')
    expect(wt?.container?.status).toBe('running')
    expect(wt?.container?.error).toBeUndefined()
  })

  it('checks recovered starting containers concurrently', async () => {
    const resolvers: Array<(value: boolean) => void> = []
    const containers = {
      checkDockerAvailable: vi.fn(async () => ({ ok: true })),
      resolveContainerConfig: vi.fn(),
      ensureImage: vi.fn(),
      createForWorktree: vi.fn(),
      execInContainer: vi.fn(),
      isContainerRunning: vi.fn(() => new Promise<boolean>((resolve) => { resolvers.push(resolve) })),
      stopContainer: vi.fn(),
    }
    mockedListWorktrees.mockResolvedValue([
      { path: '/repo/wt/one', branch: 'one', head: 'abc', isBare: false, isMain: false, createdAt: 0, repoRoot: '/repo' },
      { path: '/repo/wt/two', branch: 'two', head: 'def', isBare: false, isMain: false, createdAt: 0, repoRoot: '/repo' }
    ])
    const fsm = makeFSM(containers as any, {
      getPersistedWorktreeContainers: () => ({
        '/repo/wt/one': { id: 'c-one', name: 'one', image: 'n', workdir: '/w', shell: '/bin/sh' },
        '/repo/wt/two': { id: 'c-two', name: 'two', image: 'n', workdir: '/w', shell: '/bin/sh' }
      })
    })

    await fsm.refreshList()
    await Promise.resolve()

    expect(containers.isContainerRunning).toHaveBeenCalledTimes(2)
    resolvers.forEach((resolve) => resolve(true))
    await new Promise<void>((resolve) => setImmediate(resolve))
  })

  it('dispatches containerUpdated with starting status immediately after container creation', async () => {
    const containers = {
      checkDockerAvailable: vi.fn(async () => ({ ok: true })),
      resolveContainerConfig: vi.fn(() => ({ image: 'n', workdir: '/w', shell: '/bin/sh', env: {}, ports: [], volumes: [] })),
      ensureImage: vi.fn(),
      createForWorktree: vi.fn().mockResolvedValue({ id: 'c-starting', name: 'tw', image: 'n', workdir: '/w', shell: '/bin/sh', status: 'running' } as CreatedWorktreeContainer),
      execInContainer: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
      stopContainer: vi.fn(),
    }
    mockedListWorktrees.mockResolvedValue([{ path: '/repo/wt/test-branch', branch: 'test-branch', head: 'abc', isBare: false, isMain: false, createdAt: 0, repoRoot: '/repo' }])
    const fsm = makeFSM(containers as any, { getEnableWorktreeContainers: () => true })
    const dispatchSpy = vi.spyOn(store, 'dispatch')
    await fsm.runPending({ id: 'p-starting', repoRoot: '/repo', branchName: 'test-branch' })

    const startingDispatches = dispatchSpy.mock.calls.filter(
      ([e]) => e.type === 'worktrees/containerUpdated' && (e as any).payload.container?.status === 'starting'
    )
    expect(startingDispatches.length).toBe(1)
    expect(startingDispatches[0][0]).toEqual({
      type: 'worktrees/containerUpdated',
      payload: {
        path: '/repo/wt/test-branch',
        container: { id: 'c-starting', name: 'tw', image: 'n', workdir: '/w', shell: '/bin/sh', status: 'starting' }
      }
    })

    const wt = store.getSnapshot().state.worktrees.list.find((w) => w.path === '/repo/wt/test-branch')
    expect(wt?.container).toBeDefined()
    expect(wt?.container?.status).toBe('running')
  })

  it('stops a created container when finishCreate fails', async () => {
    const containers = {
      checkDockerAvailable: vi.fn(async () => ({ ok: true })),
      resolveContainerConfig: vi.fn(() => ({ image: 'n', workdir: '/w', shell: '/bin/sh', env: {}, ports: [], volumes: [] })),
      ensureImage: vi.fn(),
      createForWorktree: vi.fn().mockResolvedValue({ id: 'c-cleanup', name: 'tw', image: 'n', workdir: '/w', shell: '/bin/sh', status: 'running' } as CreatedWorktreeContainer),
      execInContainer: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
      stopContainer: vi.fn().mockResolvedValue(undefined),
    }
    onWorktreeCreated.mockImplementation(() => { throw new Error('pane init failed') })
    mockedListWorktrees.mockResolvedValue([{ path: '/repo/wt/test-branch', branch: 'test-branch', head: 'abc', isBare: false, isMain: false, createdAt: 0, repoRoot: '/repo' }])
    const fsm = makeFSM(containers as any, { getEnableWorktreeContainers: () => true })
    const result = await fsm.runPending({ id: 'p-cleanup', repoRoot: '/repo', branchName: 'test-branch' })
    expect(result.outcome).toBe('error')
    expect(containers.stopContainer).toHaveBeenCalledWith('c-cleanup')
    expect(store.getSnapshot().state.worktrees.list.find((w) => w.path === '/repo/wt/test-branch')?.container).toBeUndefined()
  })

  it('caps and throttles streamed setup logs', async () => {
    vi.useFakeTimers()
    const dispatchSpy = vi.spyOn(store, 'dispatch')
    const containers = {
      checkDockerAvailable: vi.fn(async () => ({ ok: true })),
      resolveContainerConfig: vi.fn(() => ({ image: 'n', workdir: '/w', shell: '/bin/sh', env: {}, ports: [], volumes: [] })),
      ensureImage: vi.fn(),
      createForWorktree: vi.fn().mockResolvedValue({ id: 'c-log', name: 'tw', image: 'n', workdir: '/w', shell: '/bin/sh', status: 'running' } as CreatedWorktreeContainer),
      execInContainer: vi.fn(async (_id: string, _cmd: string, opts: { onOutput?: (chunk: string) => void }) => {
        opts.onOutput?.('a'.repeat(80_000))
        opts.onOutput?.('b'.repeat(80_000))
        opts.onOutput?.('c')
        return { stdout: '', stderr: '', exitCode: 0 }
      }),
      stopContainer: vi.fn(),
    }
    mockedListWorktrees.mockResolvedValue([{ path: '/repo/wt/test-branch', branch: 'test-branch', head: 'abc', isBare: false, isMain: false, createdAt: 0, repoRoot: '/repo' }])
    const fsm = makeFSM(containers as any, { getEnableWorktreeContainers: () => true })
    const resultPromise = fsm.runPending({ id: 'p-log', repoRoot: '/repo', branchName: 'test-branch' })
    await vi.runAllTimersAsync()
    const result = await resultPromise
    vi.useRealTimers()

    expect(result.outcome).toBe('success')
    const setupLogUpdates = dispatchSpy.mock.calls.filter(([event]) => event.type === 'worktrees/pendingUpdated' && event.payload.id === 'p-log' && 'setupLog' in event.payload.patch)
    expect(setupLogUpdates.length).toBeLessThanOrEqual(3)
    for (const [event] of setupLogUpdates) {
      const setupLog = (event as any).payload.patch.setupLog
      expect(setupLog?.length ?? 0).toBeLessThanOrEqual(100_000)
    }
  })

  it('retry resumes setup for an already-created container worktree', async () => {
    const containers = {
      checkDockerAvailable: vi.fn(async () => ({ ok: true })),
      resolveContainerConfig: vi.fn(() => ({ image: 'n', workdir: '/w', shell: '/bin/sh', env: {}, ports: [], volumes: [] })),
      ensureImage: vi.fn(),
      createForWorktree: vi.fn(),
      execInContainer: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
      stopContainer: vi.fn(),
    }
    store.dispatch({
      type: 'worktrees/listChanged',
      payload: [{
        path: '/repo/wt/test-branch',
        branch: 'test-branch',
        head: 'abc',
        isBare: false,
        isMain: false,
        createdAt: 0,
        repoRoot: '/repo',
        container: { id: 'c1', name: 'tw', image: 'n', workdir: '/w', shell: '/bin/sh', status: 'running' }
      }]
    })
    store.dispatch({
      type: 'worktrees/pendingAdded',
      payload: { id: 'p5', repoRoot: '/repo', branchName: 'test-branch', status: 'setup-failed', createdPath: '/repo/wt/test-branch', agentKind: 'codex', model: 'o4' }
    })
    const fsm = makeFSM(containers, { getEnableWorktreeContainers: () => true })
    const result = await fsm.retryPending('p5')
    expect(result.outcome).toBe('success')
    expect(mockedAddWorktree).not.toHaveBeenCalled()
    expect(containers.execInContainer).toHaveBeenCalledWith('c1', 'pnpm install', expect.objectContaining({ workdir: '/w' }))
    expect(onWorktreeCreated).toHaveBeenCalledWith(expect.objectContaining({ agentKind: 'codex', model: 'o4' }))
  })


  it('retry records an error when container recreation fails for an existing worktree', async () => {
    const containers = {
      checkDockerAvailable: vi.fn(async () => ({ ok: true })),
      resolveContainerConfig: vi.fn(() => ({ image: 'n', workdir: '/w', shell: '/bin/sh', env: {}, ports: [], volumes: [] })),
      ensureImage: vi.fn(),
      createForWorktree: vi.fn().mockRejectedValue(new Error('Docker unavailable')),
      execInContainer: vi.fn(),
      stopContainer: vi.fn(),
    }
    store.dispatch({
      type: 'worktrees/listChanged',
      payload: [{
        path: '/repo/wt/test-branch',
        branch: 'test-branch',
        head: 'abc',
        isBare: false,
        isMain: false,
        createdAt: 0,
        repoRoot: '/repo'
      }]
    })
    store.dispatch({
      type: 'worktrees/pendingAdded',
      payload: { id: 'p-retry-error', repoRoot: '/repo', branchName: 'test-branch', status: 'error', createdPath: '/repo/wt/test-branch' }
    })
    const fsm = makeFSM(containers as any, { getEnableWorktreeContainers: () => true })

    const result = await fsm.retryPending('p-retry-error')

    expect(result).toEqual({ id: 'p-retry-error', outcome: 'error', error: 'Docker unavailable' })
    const pending = store.getSnapshot().state.worktrees.pending.find((p) => p.id === 'p-retry-error')
    expect(pending?.status).toBe('error')
    expect(pending?.error).toBe('Docker unavailable')
  })

  it('external worktree setup creates a container and runs setup inside it when enabled', async () => {
    const containers = {
      checkDockerAvailable: vi.fn(async () => ({ ok: true })),
      resolveContainerConfig: vi.fn(() => ({ image: 'n', workdir: '/w', shell: '/bin/sh', env: {}, ports: [], volumes: [] })),
      ensureImage: vi.fn(),
      createForWorktree: vi.fn().mockResolvedValue({ id: 'c-ext', name: 'tw', image: 'n', workdir: '/w', shell: '/bin/sh', status: 'running' } as CreatedWorktreeContainer),
      execInContainer: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
      stopContainer: vi.fn(),
    }
    store.dispatch({
      type: 'worktrees/listChanged',
      payload: [{ path: '/repo/wt/ext', branch: 'ext', head: 'abc', isBare: false, isMain: false, createdAt: 0, repoRoot: '/repo' }]
    })
    const fsm = makeFSM(containers, { getEnableWorktreeContainers: () => true })
    await fsm.runWorktreeSetup({ repoRoot: '/repo', worktreePath: '/repo/wt/ext', branch: 'ext' })
    expect(containers.createForWorktree).toHaveBeenCalledWith('/repo', '/repo/wt/ext', expect.any(Object))
    expect(containers.execInContainer).toHaveBeenCalledWith('c-ext', 'pnpm install', expect.objectContaining({ workdir: '/w' }))
    expect(mockedRunWorktreeScript).not.toHaveBeenCalled()
  })

  it('tracks created container in store with starting status while setup promise is still pending', async () => {
    let resolveExec!: (value: { stdout: string; stderr: string; exitCode: number }) => void
    const containers = {
      checkDockerAvailable: vi.fn(async () => ({ ok: true })),
      resolveContainerConfig: vi.fn(() => ({ image: 'n', workdir: '/w', shell: '/bin/sh', env: {}, ports: [], volumes: [] })),
      ensureImage: vi.fn(),
      createForWorktree: vi.fn().mockResolvedValue({ id: 'c-pending', name: 'tw', image: 'n', workdir: '/w', shell: '/bin/sh', status: 'running' } as CreatedWorktreeContainer),
      execInContainer: vi.fn(() => new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => { resolveExec = resolve })),
      stopContainer: vi.fn(),
    }
    // Seed the worktree into the list before runPending so the
    // containerUpdated dispatch from maybeCreateContainer actually patches it.
    store.dispatch({
      type: 'worktrees/listChanged',
      payload: [{ path: '/repo/wt/test-branch', branch: 'test-branch', head: 'abc', isBare: false, isMain: false, createdAt: 0, repoRoot: '/repo' }]
    })
    mockedListWorktrees.mockResolvedValue([{ path: '/repo/wt/test-branch', branch: 'test-branch', head: 'abc', isBare: false, isMain: false, createdAt: 0, repoRoot: '/repo' }])
    const fsm = makeFSM(containers as any, { getEnableWorktreeContainers: () => true })
    const dispatchSpy = vi.spyOn(store, 'dispatch')

    const runPromise = fsm.runPending({ id: 'p-pending', repoRoot: '/repo', branchName: 'test-branch' })

    // Yield to microtasks so createForWorktree resolves and containerUpdated is dispatched
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    // Container should be tracked in store with 'starting' while setup is still pending
    const wtDuringSetup = store.getSnapshot().state.worktrees.list.find((w) => w.path === '/repo/wt/test-branch')
    expect(wtDuringSetup?.container).toBeDefined()
    expect(wtDuringSetup?.container?.id).toBe('c-pending')
    expect(wtDuringSetup?.container?.status).toBe('starting')

    // Verify the starting dispatch happened — execInContainer has been
    // called (setup started) but its deferred promise hasn't resolved yet,
    // so the store still shows 'starting'.
    expect(containers.execInContainer).toHaveBeenCalled()
    const startingDispatches = dispatchSpy.mock.calls.filter(
      ([e]) => e.type === 'worktrees/containerUpdated' && (e as any).payload.container?.status === 'starting'
    )
    expect(startingDispatches).toHaveLength(1)
    expect(startingDispatches[0][0]).toEqual({
      type: 'worktrees/containerUpdated',
      payload: {
        path: '/repo/wt/test-branch',
        container: { id: 'c-pending', name: 'tw', image: 'n', workdir: '/w', shell: '/bin/sh', status: 'starting' }
      }
    })

    // Now resolve setup
    resolveExec({ stdout: '', stderr: '', exitCode: 0 })
    const result = await runPromise
    expect(result.outcome).toBe('success')

    // After setup, status should be 'running'
    const wtAfterSetup = store.getSnapshot().state.worktrees.list.find((w) => w.path === '/repo/wt/test-branch')
    expect(wtAfterSetup?.container?.status).toBe('running')
  })

  it('stops an external container when store update fails after creation', async () => {
    const containers = {
      checkDockerAvailable: vi.fn(async () => ({ ok: true })),
      resolveContainerConfig: vi.fn(() => ({ image: 'n', workdir: '/w', shell: '/bin/sh', env: {}, ports: [], volumes: [] })),
      ensureImage: vi.fn(),
      createForWorktree: vi.fn().mockResolvedValue({ id: 'c-ext-cleanup', name: 'tw', image: 'n', workdir: '/w', shell: '/bin/sh', status: 'running' } as CreatedWorktreeContainer),
      execInContainer: vi.fn(),
      stopContainer: vi.fn().mockResolvedValue(undefined),
    }
    mockedListWorktrees.mockResolvedValue([{ path: '/repo/wt/ext', branch: 'ext', head: 'abc', isBare: false, isMain: false, createdAt: 0, repoRoot: '/repo' }])
    const originalDispatch = store.dispatch.bind(store)
    vi.spyOn(store, 'dispatch').mockImplementation((event: Parameters<Store['dispatch']>[0]) => {
      if (event.type === 'worktrees/containerUpdated') {
        throw new Error('store update failed')
      }
      return originalDispatch(event)
    })
    const fsm = makeFSM(containers as any, { getEnableWorktreeContainers: () => true })

    await expect(fsm.runWorktreeSetup({ repoRoot: '/repo', worktreePath: '/repo/wt/ext', branch: 'ext' })).rejects.toThrow('store update failed')

    expect(containers.stopContainer).toHaveBeenCalledWith('c-ext-cleanup')
    expect(containers.execInContainer).not.toHaveBeenCalled()
  })
})

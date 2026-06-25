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
vi.mock('../build-initial-state', () => ({ hydratePersistedWorktreeContainers: vi.fn((wt: any) => wt) }))
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
      getWorktreeId: vi.fn(() => 'abc'),
      sanitizeContainerName: vi.fn(() => 'wt'),
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
      getWorktreeId: vi.fn(() => 'abc'),
      sanitizeContainerName: vi.fn(() => 'wt'),
    }
    const fsm = makeFSM(containers, { getEnableWorktreeContainers: () => true })
    const result = await fsm.runPending({ id: 'p3', repoRoot: '/repo', branchName: 'test-branch' })
    expect(result.outcome).toBe('error')
    const pending = store.getSnapshot().state.worktrees.pending.find((p) => p.id === 'p3')
    expect(pending?.setupLog).toBe('Creating Docker container...')
    expect(onWorktreeCreated).not.toHaveBeenCalled()
  })

  it('setup failure retains container metadata', async () => {
    const containers = {
      checkDockerAvailable: vi.fn(async () => ({ ok: true })),
      resolveContainerConfig: vi.fn(() => ({ image: 'n', workdir: '/w', shell: '/bin/sh', env: {}, ports: [], volumes: [] })),
      ensureImage: vi.fn(),
      createForWorktree: vi.fn().mockResolvedValue({ id: 'c1', name: 'tw', image: 'n', workdir: '/w', shell: '/bin/sh', status: 'running' } as CreatedWorktreeContainer),
      execInContainer: vi.fn().mockResolvedValue({ stdout: '', stderr: 'fail', exitCode: 1 }),
      stopContainer: vi.fn(),
      getWorktreeId: vi.fn(() => 'abc'),
      sanitizeContainerName: vi.fn(() => 'wt'),
    }
    mockedListWorktrees.mockResolvedValue([{ path: '/repo/wt/test-branch', branch: 'test-branch', head: 'abc', isBare: false, isMain: false, createdAt: 0, repoRoot: '/repo' }])
    const fsm = makeFSM(containers, { getEnableWorktreeContainers: () => true })
    const result = await fsm.runPending({ id: 'p4', repoRoot: '/repo', branchName: 'test-branch' })
    expect(result.outcome).toBe('setup-failed')
    const wt = store.getSnapshot().state.worktrees.list.find((w) => w.path === '/repo/wt/test-branch')
    expect(wt?.container).toBeDefined()
    expect(wt?.container?.status).toBe('error')
  })
})

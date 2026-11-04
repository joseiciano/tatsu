import { describe, it, expect, vi } from 'vitest'
import { Store } from '../store'
import { sanitizeHeadBranchForLocal, WorktreesFSM } from '.'
import type { Worktree } from '../../shared/state/worktrees'

const CREATED: Worktree = {
  path: '/r/wt',
  branch: 'feat',
  head: 'deadbeef',
  isBare: false,
  isMain: false,
  createdAt: 0,
  repoRoot: ''
}

vi.mock('../worktree', () => ({
  addWorktree: vi.fn(async () => CREATED),
  defaultWorktreeDir: vi.fn(() => '/r/wts'),
  fetchPullRequestRef: vi.fn(async () => {}),
  listWorktrees: vi.fn(async () => [CREATED]),
  localBranchExists: vi.fn(async () => false),
  runWorktreeScript: vi.fn(async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '' })),
  symlinkClaudeSettings: vi.fn()
}))

vi.mock('../github', () => ({
  getPRMetadata: vi.fn(async () => null)
}))

vi.mock('../repo-config', () => ({
  loadRepoConfig: vi.fn(() => ({}))
}))

vi.mock('../debug', () => ({
  log: vi.fn()
}))

vi.mock('../perf-log', () => ({
  perfLog: vi.fn(),
  getPerfLogFilePath: vi.fn(() => '/tmp/perf.log')
}))

describe('sanitizeHeadBranchForLocal', () => {
  it('returns the head ref unchanged for typical names', () => {
    expect(sanitizeHeadBranchForLocal('fix-the-thing')).toBe('fix-the-thing')
    expect(sanitizeHeadBranchForLocal('release_2024.10-rc1')).toBe('release_2024.10-rc1')
  })

  it('preserves slashes — git accepts them and worktree nesting matches fresh-start', () => {
    expect(sanitizeHeadBranchForLocal('feature/foo')).toBe('feature/foo')
    expect(sanitizeHeadBranchForLocal('users/alice/wip')).toBe('users/alice/wip')
  })

  it('strips control chars and other ref-name-illegal punctuation', () => {
    expect(sanitizeHeadBranchForLocal('wip:@{v1.0}')).toBe('wipv1.0}')
    expect(sanitizeHeadBranchForLocal('a~b^c?d')).toBe('abcd')
  })

  it('collapses `..` sequences and trims leading/trailing dashes and dots', () => {
    expect(sanitizeHeadBranchForLocal('feature..foo')).toBe('feature.foo')
    expect(sanitizeHeadBranchForLocal('---weird---')).toBe('---weird---'.replace(/^[-.]+|[-.]+$/g, ''))
    expect(sanitizeHeadBranchForLocal('.leading')).toBe('leading')
  })
})

describe('WorktreesFSM.runPending onWorktreeCreated (TEST-023)', () => {
  it('passes the caller repoRoot and the created branch before the list includes the new worktree', async () => {
    const store = new Store()
    const listHadCreatedAtCall: boolean[] = []
    const onWorktreeCreated = vi.fn((_params: { createdPath: string }) => {
      listHadCreatedAtCall.push(
        store.getSnapshot().state.worktrees.list.some((w) => w.path === CREATED.path)
      )
    })
    const fsm = new WorktreesFSM(store, {
      getRepoRoots: () => ['/r/repo'],
      getWorktreeSetupCmd: () => '',
      getWorktreeBaseMode: () => 'local',
      onWorktreeCreated
    })

    const outcome = await fsm.runPending({
      id: 'pending-1',
      repoRoot: '/r/repo',
      branchName: 'feat',
      initialPrompt: 'go'
    })

    expect(outcome).toEqual({ id: 'pending-1', outcome: 'success', createdPath: CREATED.path })
    expect(onWorktreeCreated).toHaveBeenCalledTimes(1)
    expect(onWorktreeCreated.mock.calls[0][0]).toMatchObject({
      createdPath: CREATED.path,
      repoRoot: '/r/repo',
      branch: 'feat',
      initialPrompt: 'go'
    })
    expect(listHadCreatedAtCall).toEqual([false])
    expect(store.getSnapshot().state.worktrees.list.map((w) => w.path)).toContain(CREATED.path)
  })
})

describe('WorktreesFSM request validation', () => {
  function makeFsm(): { fsm: WorktreesFSM; store: Store; onWorktreeCreated: ReturnType<typeof vi.fn> } {
    const store = new Store()
    const onWorktreeCreated = vi.fn()
    const fsm = new WorktreesFSM(store, {
      getRepoRoots: () => ['/r/repo'],
      getWorktreeSetupCmd: () => '',
      getWorktreeBaseMode: () => 'local',
      onWorktreeCreated
    })
    return { fsm, store, onWorktreeCreated }
  }

  it('refuses a repoRoot that is not a registered repo and records the error on the pending entry', async () => {
    const { fsm, store, onWorktreeCreated } = makeFsm()
    const outcome = await fsm.runPending({ id: 'pending-x', repoRoot: '/etc', branchName: 'feat' })
    expect(outcome).toEqual({ id: 'pending-x', outcome: 'error', error: 'Unknown repository: /etc' })
    expect(onWorktreeCreated).not.toHaveBeenCalled()
    expect(store.getSnapshot().state.worktrees.pending).toMatchObject([
      { id: 'pending-x', status: 'error', error: 'Unknown repository: /etc' }
    ])
  })

  it.each([
    ['../../escape', 'A branch name can’t contain “..”'],
    ['-b', 'A branch name can’t start with “-”'],
    ['HEAD', '“HEAD” is not a valid git branch name']
  ])('refuses the branch name %j without creating a worktree', async (branchName, error) => {
    const { fsm, onWorktreeCreated } = makeFsm()
    const outcome = await fsm.runPending({ id: 'pending-b', repoRoot: '/r/repo', branchName })
    expect(outcome).toEqual({ id: 'pending-b', outcome: 'error', error })
    expect(onWorktreeCreated).not.toHaveBeenCalled()
  })

  it('refuses a PR worktree for an unregistered repoRoot before asking GitHub', async () => {
    const { getPRMetadata } = await import('../github')
    vi.mocked(getPRMetadata).mockClear()
    const { fsm } = makeFsm()
    const outcome = await fsm.runPendingPR({ id: 'pending-pr', repoRoot: '/elsewhere', prNumber: 7 })
    expect(outcome).toEqual({ id: 'pending-pr', outcome: 'error', error: 'Unknown repository: /elsewhere' })
    expect(getPRMetadata).not.toHaveBeenCalled()
  })

  it('re-validates the stored request on retry', async () => {
    const { fsm } = makeFsm()
    await fsm.runPending({ id: 'pending-r', repoRoot: '/nope', branchName: 'feat' })
    const outcome = await fsm.retryPending('pending-r')
    expect(outcome).toEqual({ id: 'pending-r', outcome: 'error', error: 'Unknown repository: /nope' })
  })
})

describe('WorktreesFSM workflow worktrees', () => {
  function makeFsm(): {
    fsm: WorktreesFSM
    store: Store
    reserved: string[]
    released: string[]
  } {
    const store = new Store()
    const reserved: string[] = []
    const released: string[] = []
    const fsm = new WorktreesFSM(store, {
      getRepoRoots: () => ['/r/repo'],
      getWorktreeSetupCmd: () => '',
      getWorktreeBaseMode: () => 'local',
      onWorktreeCreated: vi.fn(),
      onWorkflowWorktreeReserved: (path) => reserved.push(path),
      onWorkflowWorktreeReleased: (path) => released.push(path)
    })
    return { fsm, store, reserved, released }
  }

  it('reserves the worktree path for the workflow before git creates it', async () => {
    const { addWorktree } = await import('../worktree')
    const { fsm, reserved } = makeFsm()
    const reservedAtAdd: string[][] = []
    vi.mocked(addWorktree).mockImplementationOnce(async () => {
      reservedAtAdd.push([...reserved])
      return CREATED
    })

    const outcome = await fsm.runPending({ id: 'pending-w', repoRoot: '/r/repo', branchName: 'feat', workflow: true })

    expect(outcome).toEqual({ id: 'pending-w', outcome: 'success', createdPath: CREATED.path })
    expect(reservedAtAdd).toEqual([['/r/wts/feat']])
  })

  it('reserves nothing for an ordinary worktree', async () => {
    const { fsm, reserved } = makeFsm()
    await fsm.runPending({ id: 'pending-n', repoRoot: '/r/repo', branchName: 'feat' })
    expect(reserved).toEqual([])
  })

  it('releases the reservation when git fails and keeps the workflow flag for retry', async () => {
    const { addWorktree } = await import('../worktree')
    const { fsm, store, reserved, released } = makeFsm()
    vi.mocked(addWorktree).mockRejectedValueOnce(new Error('git said no'))

    const outcome = await fsm.runPending({ id: 'pending-f', repoRoot: '/r/repo', branchName: 'feat', workflow: true })

    expect(outcome).toEqual({ id: 'pending-f', outcome: 'error', error: 'git said no' })
    expect(released).toEqual(['/r/wts/feat'])
    expect(store.getSnapshot().state.worktrees.pending).toMatchObject([{ id: 'pending-f', workflow: true }])

    await fsm.retryPending('pending-f')
    expect(reserved).toEqual(['/r/wts/feat', '/r/wts/feat'])
  })
})

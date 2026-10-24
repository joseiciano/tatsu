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

import { describe, it, expect } from 'vitest'
import {
  initialWorktrees,
  worktreesReducer,
  type PendingDeletion,
  type PendingWorktree,
  type Worktree,
  type WorktreesEvent,
  type WorktreesState
} from '.'

function apply(state: WorktreesState, event: WorktreesEvent): WorktreesState {
  return worktreesReducer(state, event)
}

function stubWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    path: '/tmp/wt/a',
    branch: 'feature/a',
    head: 'deadbeef',
    isBare: false,
    isMain: false,
    createdAt: 0,
    repoRoot: '/tmp/repo',
    ...overrides
  }
}

function stubPending(overrides: Partial<PendingWorktree> = {}): PendingWorktree {
  return {
    id: 'pending:abc',
    repoRoot: '/tmp/repo',
    branchName: 'feature/a',
    status: 'creating',
    ...overrides
  }
}

describe('worktreesReducer', () => {
  it('listChanged replaces the flat list', () => {
    const start: WorktreesState = {
      ...initialWorktrees,
      list: [stubWorktree({ path: '/a' }), stubWorktree({ path: '/b' })]
    }
    const next = apply(start, {
      type: 'worktrees/listChanged',
      payload: [stubWorktree({ path: '/c' })]
    })
    expect(next.list.map((w) => w.path)).toEqual(['/c'])
  })

  it('worktree entries with no container reduce unchanged', () => {
    const worktree = stubWorktree({ path: '/tmp/wt/plain' })
    const start: WorktreesState = {
      ...initialWorktrees,
      list: [worktree]
    }
    const next = apply(start, {
      type: 'worktrees/listChanged',
      payload: [worktree]
    })
    expect(next.list[0].container).toBeUndefined()
  })

  it('containerUpdated patches one worktree and preserves others by reference', () => {
    const a = stubWorktree({ path: '/tmp/wt/a' })
    const b = stubWorktree({ path: '/tmp/wt/b' })
    const c = stubWorktree({ path: '/tmp/wt/c' })
    const start: WorktreesState = {
      ...initialWorktrees,
      list: [a, b, c]
    }
    const next = apply(start, {
      type: 'worktrees/containerUpdated',
      payload: {
        path: '/tmp/wt/b',
        container: {
          id: 'abc123',
          name: 'harness-repo-feature',
          image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
          workdir: '/workspace',
          shell: '/bin/bash',
          status: 'running'
        }
      }
    })
    expect(next.list).not.toBe(start.list)
    expect(next.list[0]).toBe(a)
    expect(next.list[2]).toBe(c)
    expect(next.list[1]).not.toBe(b)
    expect(next.list[1].container?.status).toBe('running')
  })

  it('containerUpdated returns same state when container is shallow-equal', () => {
    const containerMeta = {
      id: 'abc123',
      name: 'harness-repo-feature',
      image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
      workdir: '/workspace',
      shell: '/bin/bash',
      status: 'running' as const
    }
    const worktree = stubWorktree({ path: '/tmp/wt/a', container: containerMeta })
    const start: WorktreesState = {
      ...initialWorktrees,
      list: [worktree]
    }
    const next = apply(start, {
      type: 'worktrees/containerUpdated',
      payload: {
        path: '/tmp/wt/a',
        container: { ...containerMeta }
      }
    })
    expect(next).toBe(start)
    expect(next.list[0]).toBe(worktree)
  })

  it('containerUpdated removes container metadata when cleared', () => {
    const start: WorktreesState = {
      ...initialWorktrees,
      list: [
        stubWorktree({
          path: '/tmp/wt/a',
          container: {
            id: 'abc123',
            name: 'harness-repo-feature',
            image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
            workdir: '/workspace',
            shell: '/bin/bash',
            status: 'running'
          }
        })
      ]
    }

    const next = apply(start, {
      type: 'worktrees/containerUpdated',
      payload: { path: '/tmp/wt/a' }
    })

    expect('container' in next.list[0]).toBe(false)
  })


  it('containerUpdated is a no-op when clearing missing container metadata', () => {
    const worktree = stubWorktree({ path: '/tmp/wt/a' })
    const start: WorktreesState = {
      ...initialWorktrees,
      list: [worktree]
    }

    const next = apply(start, {
      type: 'worktrees/containerUpdated',
      payload: { path: '/tmp/wt/a' }
    })

    expect(next).toBe(start)
    expect(next.list[0]).toBe(worktree)
  })

  it('reposChanged replaces the repoRoots array', () => {
    const next = apply(initialWorktrees, {
      type: 'worktrees/reposChanged',
      payload: ['/tmp/repo1', '/tmp/repo2']
    })
    expect(next.repoRoots).toEqual(['/tmp/repo1', '/tmp/repo2'])
  })

  it('pendingAdded appends to the pending list', () => {
    const a = stubPending({ id: 'pending:a' })
    const b = stubPending({ id: 'pending:b' })
    const s1 = apply(initialWorktrees, { type: 'worktrees/pendingAdded', payload: a })
    const s2 = apply(s1, { type: 'worktrees/pendingAdded', payload: b })
    expect(s2.pending.map((p) => p.id)).toEqual(['pending:a', 'pending:b'])
  })

  it('pendingUpdated merges a partial patch into the matching entry', () => {
    const start: WorktreesState = {
      ...initialWorktrees,
      pending: [
        stubPending({ id: 'pending:a', status: 'creating' }),
        stubPending({ id: 'pending:b', status: 'creating' })
      ]
    }
    const next = apply(start, {
      type: 'worktrees/pendingUpdated',
      payload: { id: 'pending:a', patch: { status: 'setup', setupLog: 'hello' } }
    })
    const a = next.pending.find((p) => p.id === 'pending:a')
    const b = next.pending.find((p) => p.id === 'pending:b')
    expect(a?.status).toBe('setup')
    expect(a?.setupLog).toBe('hello')
    expect(a?.branchName).toBe('feature/a')
    expect(b?.status).toBe('creating')
  })

  it('pendingUpdated on an unknown id is a no-op', () => {
    const start: WorktreesState = {
      ...initialWorktrees,
      pending: [stubPending({ id: 'pending:a' })]
    }
    const next = apply(start, {
      type: 'worktrees/pendingUpdated',
      payload: { id: 'pending:missing', patch: { status: 'error', error: 'nope' } }
    })
    expect(next).toBe(start)
  })

  it('pendingUpdated preserves reference identity for untouched siblings', () => {
    const a = stubPending({ id: 'pending:a' })
    const b = stubPending({ id: 'pending:b' })
    const c = stubPending({ id: 'pending:c' })
    const start: WorktreesState = {
      ...initialWorktrees,
      pending: [a, b, c]
    }
    const next = apply(start, {
      type: 'worktrees/pendingUpdated',
      payload: { id: 'pending:b', patch: { status: 'setup' } }
    })
    expect(next.pending).not.toBe(start.pending)
    expect(next.pending[0]).toBe(a)
    expect(next.pending[2]).toBe(c)
    expect(next.pending[1]).not.toBe(b)
    expect(next.pending[1].status).toBe('setup')
  })

  it('pendingRemoved drops the matching entry', () => {
    const start: WorktreesState = {
      ...initialWorktrees,
      pending: [
        stubPending({ id: 'pending:a' }),
        stubPending({ id: 'pending:b' })
      ]
    }
    const next = apply(start, { type: 'worktrees/pendingRemoved', payload: 'pending:a' })
    expect(next.pending.map((p) => p.id)).toEqual(['pending:b'])
  })

  it('pendingDeletionStarted appends and deduplicates by path', () => {
    const a: PendingDeletion = {
      path: '/tmp/wt/a',
      repoRoot: '/tmp/repo',
      branch: 'feature/a',
      phase: 'running-teardown'
    }
    const b: PendingDeletion = { ...a, path: '/tmp/wt/b' }
    const s1 = apply(initialWorktrees, { type: 'worktrees/pendingDeletionStarted', payload: a })
    const s2 = apply(s1, { type: 'worktrees/pendingDeletionStarted', payload: b })
    expect(s2.pendingDeletions.map((d) => d.path)).toEqual(['/tmp/wt/a', '/tmp/wt/b'])
    // Re-starting the same path replaces the entry (retry behavior).
    const s3 = apply(s2, {
      type: 'worktrees/pendingDeletionStarted',
      payload: { ...a, phase: 'running-teardown', error: undefined }
    })
    expect(s3.pendingDeletions.map((d) => d.path)).toEqual(['/tmp/wt/b', '/tmp/wt/a'])
  })

  it('pendingDeletionStarted preserves reference identity for unrelated entries with no duplicate', () => {
    const a: PendingDeletion = {
      path: '/tmp/wt/a',
      repoRoot: '/tmp/repo',
      branch: 'feature/a',
      phase: 'running-teardown'
    }
    const b: PendingDeletion = { ...a, path: '/tmp/wt/b' }
    const start: WorktreesState = {
      ...initialWorktrees,
      pendingDeletions: [a, b]
    }
    const next = apply(start, {
      type: 'worktrees/pendingDeletionStarted',
      payload: { ...a, path: '/tmp/wt/c', phase: 'running-teardown' }
    })
    expect(next.pendingDeletions[0]).toBe(a)
    expect(next.pendingDeletions[1]).toBe(b)
    expect(next.pendingDeletions).toHaveLength(3)
  })

  it('pendingDeletionStarted replaces and moves duplicate to end', () => {
    const a: PendingDeletion = {
      path: '/tmp/wt/a',
      repoRoot: '/tmp/repo',
      branch: 'feature/a',
      phase: 'removing-worktree'
    }
    const b: PendingDeletion = { ...a, path: '/tmp/wt/b' }
    const start: WorktreesState = {
      ...initialWorktrees,
      pendingDeletions: [a, b]
    }
    const next = apply(start, {
      type: 'worktrees/pendingDeletionStarted',
      payload: { ...a, path: '/tmp/wt/a', phase: 'running-teardown' }
    })
    expect(next.pendingDeletions.map((d) => d.path)).toEqual(['/tmp/wt/b', '/tmp/wt/a'])
    expect(next.pendingDeletions[0]).toBe(b)
  })

  it('pendingDeletionUpdated merges a partial patch into the matching entry', () => {
    const start: WorktreesState = {
      ...initialWorktrees,
      pendingDeletions: [
        {
          path: '/tmp/wt/a',
          repoRoot: '/tmp/repo',
          branch: 'feature/a',
          phase: 'running-teardown'
        }
      ]
    }
    const next = apply(start, {
      type: 'worktrees/pendingDeletionUpdated',
      payload: { path: '/tmp/wt/a', patch: { teardownLog: 'hi', phase: 'removing-worktree' } }
    })
    expect(next.pendingDeletions[0].phase).toBe('removing-worktree')
    expect(next.pendingDeletions[0].teardownLog).toBe('hi')
  })

  it('pendingDeletionUpdated on an unknown path is a no-op', () => {
    const start: WorktreesState = {
      ...initialWorktrees,
      pendingDeletions: [
        { path: '/tmp/wt/a', repoRoot: '/tmp/repo', branch: 'a', phase: 'running-teardown' }
      ]
    }
    const next = apply(start, {
      type: 'worktrees/pendingDeletionUpdated',
      payload: { path: '/tmp/wt/missing', patch: { phase: 'failed' } }
    })
    expect(next).toBe(start)
  })

  it('pendingDeletionUpdated preserves reference identity for untouched siblings', () => {
    const a: PendingDeletion = {
      path: '/tmp/wt/a',
      repoRoot: '/tmp/repo',
      branch: 'a',
      phase: 'running-teardown'
    }
    const b: PendingDeletion = { ...a, path: '/tmp/wt/b' }
    const c: PendingDeletion = { ...a, path: '/tmp/wt/c' }
    const start: WorktreesState = {
      ...initialWorktrees,
      pendingDeletions: [a, b, c]
    }
    const next = apply(start, {
      type: 'worktrees/pendingDeletionUpdated',
      payload: { path: '/tmp/wt/b', patch: { phase: 'removing-worktree' } }
    })
    expect(next.pendingDeletions).not.toBe(start.pendingDeletions)
    expect(next.pendingDeletions[0]).toBe(a)
    expect(next.pendingDeletions[2]).toBe(c)
    expect(next.pendingDeletions[1]).not.toBe(b)
    expect(next.pendingDeletions[1].phase).toBe('removing-worktree')
  })

  it('pendingDeletionRemoved drops the matching entry', () => {
    const start: WorktreesState = {
      ...initialWorktrees,
      pendingDeletions: [
        { path: '/tmp/wt/a', repoRoot: '/tmp/repo', branch: 'a', phase: 'running-teardown' },
        { path: '/tmp/wt/b', repoRoot: '/tmp/repo', branch: 'b', phase: 'running-teardown' }
      ]
    }
    const next = apply(start, {
      type: 'worktrees/pendingDeletionRemoved',
      payload: '/tmp/wt/a'
    })
    expect(next.pendingDeletions.map((d) => d.path)).toEqual(['/tmp/wt/b'])
  })

  it('leaves unrelated slices untouched on each event', () => {
    const start: WorktreesState = {
      list: [stubWorktree()],
      repoRoots: ['/tmp/repo'],
      pending: [stubPending()],
      pendingDeletions: []
    }
    const next = apply(start, { type: 'worktrees/reposChanged', payload: ['/tmp/other'] })
    expect(next.list).toBe(start.list)
    expect(next.pending).toBe(start.pending)
  })
})

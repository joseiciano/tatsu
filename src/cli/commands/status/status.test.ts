import { describe, it, expect } from 'vitest'
import { initialState, type AppState } from '../../../shared/state'
import type { Worktree } from '../../../shared/state/worktrees'
import { buildStatus, renderStatus } from '.'

function worktree(path: string, repoRoot: string): Worktree {
  return { path, repoRoot, branch: 'main', head: 'abc', isBare: false, isMain: false, createdAt: 0 }
}

function stateWith(repoRoots: string[], list: Worktree[]): AppState {
  return { ...initialState, worktrees: { ...initialState.worktrees, repoRoots, list } }
}

const endpoint = { url: 'ws://127.0.0.1:37291', source: 'flag' }

describe('status', () => {
  it('counts worktrees per open repo, keeping repos with none', () => {
    const state = stateWith(
      ['/repo/a', '/repo/b'],
      [worktree('/repo/a', '/repo/a'), worktree('/wt/a-1', '/repo/a'), worktree('/wt/c', '/repo/c')]
    )
    expect(buildStatus(endpoint, state)).toEqual({
      url: 'ws://127.0.0.1:37291',
      source: 'flag',
      repos: [
        { root: '/repo/a', worktrees: 2 },
        { root: '/repo/b', worktrees: 0 }
      ]
    })
  })

  it('renders a header naming the URL and source, then a repo table', () => {
    const status = buildStatus({ url: 'ws://h:1', source: 'env' }, stateWith(['/repo/a'], [worktree('/repo/a', '/repo/a')]))
    expect(renderStatus(status).split('\n')).toEqual([
      'Connected to ws://h:1 (via TATSU_URL/TATSU_TOKEN)',
      '',
      'REPO     WORKTREES',
      '/repo/a  1'
    ])
  })

  it('says so when no repos are open', () => {
    expect(renderStatus(buildStatus(endpoint, stateWith([], [])))).toBe(
      'Connected to ws://127.0.0.1:37291 (via --url/--token)\n\nNo repos open.'
    )
  })
})

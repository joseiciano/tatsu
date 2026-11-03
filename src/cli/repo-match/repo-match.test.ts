import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initialState, type AppState } from '../../shared/state'
import type { Worktree } from '../../shared/state/worktrees'
import { findRepo } from '.'

function worktree(path: string, repoRoot: string): Worktree {
  return { path, repoRoot, branch: 'b', head: 'abc', isBare: false, isMain: path === repoRoot, createdAt: 0 }
}

function stateWith(repoRoots: string[], list: Worktree[]): AppState {
  return { ...initialState, worktrees: { ...initialState.worktrees, repoRoots, list } }
}

describe('findRepo with remote-style paths that do not exist locally', () => {
  const state = stateWith(
    ['/remote/repo-a', '/remote/repo-b'],
    [worktree('/remote/repo-a', '/remote/repo-a'), worktree('/remote/wt/a-feat', '/remote/repo-a')]
  )

  it('matches a repo root exactly', () => {
    expect(findRepo(state, '/remote/repo-b')).toBe('/remote/repo-b')
  })

  it('matches a path nested under a repo root', () => {
    expect(findRepo(state, '/remote/repo-a/src/deep')).toBe('/remote/repo-a')
  })

  it('matches a worktree path outside the root, and paths under it', () => {
    expect(findRepo(state, '/remote/wt/a-feat')).toBe('/remote/repo-a')
    expect(findRepo(state, '/remote/wt/a-feat/pkg')).toBe('/remote/repo-a')
  })

  it('returns null when nothing contains the path', () => {
    expect(findRepo(state, '/remote/wt')).toBeNull()
    expect(findRepo(state, '/remote/repo-a-sibling')).toBeNull()
  })

  it('ignores trailing slashes on the given path', () => {
    expect(findRepo(state, '/remote/repo-b/')).toBe('/remote/repo-b')
  })

  it('ignores worktrees whose repo is not open', () => {
    const closed = stateWith(['/remote/repo-a'], [worktree('/remote/wt/x', '/remote/closed')])
    expect(findRepo(closed, '/remote/wt/x')).toBeNull()
  })
})

describe('findRepo with local paths', () => {
  let dir: string
  let real: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'repo-match-'))
    real = realpathSync(dir)
    mkdirSync(join(real, 'repo', 'src'), { recursive: true })
    symlinkSync(join(real, 'repo'), join(real, 'link'))
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('compares realpaths, so a symlinked spelling matches the realpath in state', () => {
    const state = stateWith([join(real, 'repo')], [worktree(join(real, 'repo'), join(real, 'repo'))])
    expect(findRepo(state, join(real, 'link', 'src'))).toBe(join(real, 'repo'))
  })

  it('compares realpaths, so a symlinked spelling in state matches the realpath given', () => {
    const state = stateWith([join(real, 'link')], [])
    expect(findRepo(state, join(real, 'repo'))).toBe(join(real, 'link'))
  })
})

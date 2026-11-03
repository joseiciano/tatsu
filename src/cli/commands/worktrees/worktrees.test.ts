import { describe, it, expect } from 'vitest'
import { initialState, type AppState } from '../../../shared/state'
import type { PRStatus } from '../../../shared/state/prs'
import type { PaneLeaf, PaneNode, PtyStatus, TerminalTab } from '../../../shared/state/terminals'
import type { PendingWorktree, Worktree } from '../../../shared/state/worktrees'
import { CliError } from '../../errors'
import { agentStatusFor, listRows, renderWorktrees, type WorktreeRow } from '.'

function worktree(path: string, repoRoot: string, branch: string): Worktree {
  return { path, repoRoot, branch, head: 'abc', isBare: false, isMain: path === repoRoot, createdAt: 0 }
}

function pr(number: number, state: PRStatus['state'], checksOverall: PRStatus['checksOverall']): PRStatus {
  return {
    number,
    title: 't',
    state,
    url: `https://github.com/o/r/pull/${number}`,
    branch: 'b',
    author: null,
    checks: [],
    checksOverall,
    hasConflict: false,
    reviews: [],
    reviewDecision: 'none',
    baseBranch: 'main',
    isDefaultBase: true,
    assignees: [],
    linkedIssues: [],
    labels: []
  }
}

function tab(id: string, type: TerminalTab['type']): TerminalTab {
  return { id, type, label: id }
}

function leaf(id: string, tabs: TerminalTab[]): PaneLeaf {
  return { type: 'leaf', id, tabs, activeTabId: tabs[0]?.id ?? '' }
}

function split(a: PaneNode, b: PaneNode): PaneNode {
  return { type: 'split', id: `${a.id}+${b.id}`, direction: 'horizontal', children: [a, b], ratio: 0.5 }
}

function pending(id: string, repoRoot: string, branchName: string, status: PendingWorktree['status'], createdPath?: string): PendingWorktree {
  return { id, repoRoot, branchName, status, ...(createdPath ? { createdPath } : {}) }
}

interface Fixture {
  repoRoots: string[]
  list: Worktree[]
  pending?: PendingWorktree[]
  prs?: Record<string, PRStatus | null>
  panes?: Record<string, PaneNode>
  statuses?: Record<string, PtyStatus>
}

function stateWith(f: Fixture): AppState {
  return {
    ...initialState,
    worktrees: { ...initialState.worktrees, repoRoots: f.repoRoots, list: f.list, pending: f.pending ?? [] },
    prs: { ...initialState.prs, byPath: f.prs ?? {} },
    terminals: { ...initialState.terminals, panes: f.panes ?? {}, statuses: f.statuses ?? {} }
  }
}

const A = '/remote/a'
const B = '/remote/b'

describe('agentStatusFor', () => {
  it('returns null when the worktree has no panes', () => {
    expect(agentStatusFor(stateWith({ repoRoots: [], list: [] }), '/x')).toBeNull()
  })

  it('returns null when only non-agent tabs have a status', () => {
    const state = stateWith({
      repoRoots: [],
      list: [],
      panes: { '/x': leaf('p', [tab('sh', 'shell'), tab('ag', 'agent')]) },
      statuses: { sh: 'needs-approval' }
    })
    expect(agentStatusFor(state, '/x')).toBeNull()
  })

  it('picks the most urgent status across agent and chat tabs in nested splits', () => {
    const state = stateWith({
      repoRoots: [],
      list: [],
      panes: {
        '/x': split(
          leaf('l1', [tab('a1', 'agent'), tab('s1', 'shell')]),
          split(leaf('l2', [tab('c1', 'json-claude')]), leaf('l3', [tab('a2', 'agent')]))
        )
      },
      statuses: { a1: 'processing', s1: 'needs-approval', c1: 'idle', a2: 'waiting' }
    })
    expect(agentStatusFor(state, '/x')).toBe('waiting')
  })

  it.each([
    [['idle', 'processing'], 'processing'],
    [['processing', 'waiting'], 'waiting'],
    [['waiting', 'needs-approval', 'idle'], 'needs-approval']
  ] as const)('ranks %j as %s', (statuses, expected) => {
    const tabs = statuses.map((_, i) => tab(`t${i}`, 'agent'))
    const state = stateWith({
      repoRoots: [],
      list: [],
      panes: { '/x': leaf('p', tabs) },
      statuses: Object.fromEntries(statuses.map((s, i) => [`t${i}`, s]))
    })
    expect(agentStatusFor(state, '/x')).toBe(expected)
  })
})

describe('listRows', () => {
  it('joins the PR by path and gives null for a missing or null PR entry', () => {
    const state = stateWith({
      repoRoots: [A],
      list: [worktree(A, A, 'main'), worktree('/wt/a-feat', A, 'feat'), worktree('/wt/a-fix', A, 'fix')],
      prs: { '/wt/a-feat': pr(12, 'draft', 'pending'), '/wt/a-fix': null }
    })
    expect(listRows(state)).toEqual([
      { path: A, branch: 'main', repo: A, isMain: true, pr: null, agent: null },
      {
        path: '/wt/a-feat',
        branch: 'feat',
        repo: A,
        isMain: false,
        pr: { number: 12, state: 'draft', checks: 'pending', url: 'https://github.com/o/r/pull/12' },
        agent: null
      },
      { path: '/wt/a-fix', branch: 'fix', repo: A, isMain: false, pr: null, agent: null }
    ])
  })

  it('fills agent from the worktree panes', () => {
    const state = stateWith({
      repoRoots: [A],
      list: [worktree(A, A, 'main')],
      panes: { [A]: leaf('p', [tab('t', 'json-claude')]) },
      statuses: { t: 'needs-approval' }
    })
    expect(listRows(state)[0].agent).toBe('needs-approval')
  })

  it('orders by repoRoots order, then the main worktree, then branch name', () => {
    const state = stateWith({
      repoRoots: [B, A],
      list: [
        worktree('/wt/a-zed', A, 'zed'),
        worktree('/wt/b-beta', B, 'beta'),
        worktree(A, A, 'main'),
        worktree('/wt/a-alpha', A, 'alpha'),
        worktree(B, B, 'trunk')
      ]
    })
    expect(listRows(state).map((r) => r.path)).toEqual([B, '/wt/b-beta', A, '/wt/a-alpha', '/wt/a-zed'])
  })

  it('puts a setup-failed entry present in both list and pending on one row', () => {
    const state = stateWith({
      repoRoots: [A],
      list: [worktree(A, A, 'main'), worktree('/wt/a-feat', A, 'feat')],
      pending: [pending('pending:1', A, 'feat', 'setup-failed', '/wt/a-feat')]
    })
    const rows = listRows(state)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toEqual({ path: '/wt/a-feat', branch: 'feat', repo: A, isMain: false, pr: null, agent: null, pending: 'setup-failed' })
    expect(rows[0]).not.toHaveProperty('pending')
  })

  it('appends unmatched pending entries to their repo group', () => {
    const state = stateWith({
      repoRoots: [A, B],
      list: [worktree(A, A, 'main'), worktree(B, B, 'main')],
      pending: [pending('pending:1', A, 'new-one', 'creating'), pending('pending:2', A, 'new-two', 'setup', '/wt/a-new-two')]
    })
    expect(listRows(state)).toEqual([
      { path: A, branch: 'main', repo: A, isMain: true, pr: null, agent: null },
      { path: '', branch: 'new-one', repo: A, isMain: false, pr: null, agent: null, pending: 'creating' },
      { path: '/wt/a-new-two', branch: 'new-two', repo: A, isMain: false, pr: null, agent: null, pending: 'setup' },
      { path: B, branch: 'main', repo: B, isMain: true, pr: null, agent: null }
    ])
  })

  it('filters to the repo containing --repo, matching a worktree path', () => {
    const state = stateWith({
      repoRoots: [A, B],
      list: [worktree(A, A, 'main'), worktree('/wt/a-feat', A, 'feat'), worktree(B, B, 'main')],
      pending: [pending('pending:1', B, 'b-new', 'creating')]
    })
    expect(listRows(state, { repo: '/wt/a-feat/src' }).map((r) => r.path)).toEqual([A, '/wt/a-feat'])
    expect(listRows(state, { repo: B }).map((r) => r.branch)).toEqual(['main', 'b-new'])
  })

  it('throws a usage error when --repo matches no open repo', () => {
    const state = stateWith({ repoRoots: [A], list: [worktree(A, A, 'main')] })
    let error: unknown
    try {
      listRows(state, { repo: '/elsewhere' })
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(CliError)
    expect(error).toMatchObject({ code: 'usage', details: { repoRoots: [A] } })
  })
})

describe('renderWorktrees', () => {
  const home = '/home/me'
  const row = (over: Partial<WorktreeRow>): WorktreeRow => ({
    path: `${home}/repo`,
    branch: 'main',
    repo: `${home}/repo`,
    isMain: true,
    pr: null,
    agent: null,
    ...over
  })

  it('prints one table with ~ paths and no repo header for a single repo', () => {
    const rows = [
      row({}),
      row({
        path: `${home}/wt/feat`,
        branch: 'feat',
        isMain: false,
        agent: 'needs-approval',
        pr: { number: 7, state: 'open', checks: 'failure', url: 'u' }
      })
    ]
    expect(renderWorktrees(rows, { home }).split('\n')).toEqual([
      'BRANCH  AGENT           PR       CHECKS   PATH',
      'main    -               -        -        ~/repo',
      'feat    needs-approval  #7 open  failure  ~/wt/feat'
    ])
  })

  it('shows the pending status in the agent column and a dash for an unknown path', () => {
    const rows = [row({ path: '', branch: 'new', isMain: false, pending: 'creating' })]
    expect(renderWorktrees(rows, { home }).split('\n')[1]).toBe('new     creating  -   -       -')
  })

  it('adds a repo header above each group when more than one repo is shown', () => {
    const rows = [row({}), row({ path: '/srv/other', repo: '/srv/other', branch: 'trunk' })]
    expect(renderWorktrees(rows, { home }).split('\n')).toEqual([
      'BRANCH  AGENT  PR  CHECKS  PATH',
      '',
      '~/repo',
      'main    -      -   -       ~/repo',
      '',
      '/srv/other',
      'trunk   -      -   -       /srv/other'
    ])
  })

  it('says so when there are no worktrees', () => {
    expect(renderWorktrees([], { home })).toBe('No worktrees.')
  })
})

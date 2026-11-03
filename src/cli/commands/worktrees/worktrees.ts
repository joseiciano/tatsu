import { homedir } from 'node:os'
import type { AppState } from '../../../shared/state'
import type { PRStatus } from '../../../shared/state/prs'
import { getLeaves, type PtyStatus } from '../../../shared/state/terminals'
import type { PendingStatus, Worktree } from '../../../shared/state/worktrees'
import { CliError } from '../../errors'
import { formatTable } from '../../output'
import { findRepo } from '../../repo-match'
import type { Command } from '..'

export type AgentStatus = PtyStatus

export interface WorktreeRow {
  path: string
  branch: string
  repo: string
  isMain: boolean
  pr: { number: number; state: PRStatus['state']; checks: PRStatus['checksOverall']; url: string } | null
  agent: AgentStatus | null
  pending?: PendingStatus
}

const URGENCY: Record<AgentStatus, number> = { idle: 0, processing: 1, waiting: 2, 'needs-approval': 3 }

export function agentStatusFor(state: AppState, path: string): AgentStatus | null {
  const root = state.terminals.panes[path]
  if (!root) return null
  let best: AgentStatus | null = null
  for (const leaf of getLeaves(root)) {
    for (const tab of leaf.tabs) {
      if (tab.type !== 'agent' && tab.type !== 'json-claude') continue
      const status = state.terminals.statuses[tab.id]
      if (status && (best === null || URGENCY[status] > URGENCY[best])) best = status
    }
  }
  return best
}

function prFor(state: AppState, path: string): WorktreeRow['pr'] {
  const pr = state.prs.byPath[path]
  return pr ? { number: pr.number, state: pr.state, checks: pr.checksOverall, url: pr.url } : null
}

function byMainThenBranch(a: Worktree, b: Worktree): number {
  if (a.isMain !== b.isMain) return a.isMain ? -1 : 1
  if (a.branch !== b.branch) return a.branch < b.branch ? -1 : 1
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

export function listRows(state: AppState, filter: { repo?: string } = {}): WorktreeRow[] {
  let repos = state.worktrees.repoRoots
  if (filter.repo !== undefined) {
    const match = findRepo(state, filter.repo)
    if (match === null) {
      throw new CliError('usage', `no open repo contains ${filter.repo}`, { repoRoots: state.worktrees.repoRoots })
    }
    repos = [match]
  }

  const { list, pending } = state.worktrees
  const rows: WorktreeRow[] = []
  for (const repo of repos) {
    const worktrees = list.filter((wt) => wt.repoRoot === repo).sort(byMainThenBranch)
    for (const wt of worktrees) {
      const entry = pending.find((p) => p.createdPath === wt.path)
      rows.push({
        path: wt.path,
        branch: wt.branch,
        repo,
        isMain: wt.isMain,
        pr: prFor(state, wt.path),
        agent: agentStatusFor(state, wt.path),
        ...(entry ? { pending: entry.status } : {})
      })
    }
    const listed = new Set(worktrees.map((wt) => wt.path))
    for (const entry of pending) {
      if (entry.repoRoot !== repo || (entry.createdPath !== undefined && listed.has(entry.createdPath))) continue
      const path = entry.createdPath ?? ''
      rows.push({
        path,
        branch: entry.branchName,
        repo,
        isMain: false,
        pr: path ? prFor(state, path) : null,
        agent: path ? agentStatusFor(state, path) : null,
        pending: entry.status
      })
    }
  }
  return rows
}

function tilde(path: string, home: string): string {
  if (!path) return '-'
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`
  return path
}

export function renderWorktrees(rows: readonly WorktreeRow[], { home }: { home: string }): string {
  if (rows.length === 0) return 'No worktrees.'
  const cells = rows.map((row) => [
    row.branch || '-',
    row.pending ?? row.agent ?? '-',
    row.pr ? `#${row.pr.number} ${row.pr.state}` : '-',
    row.pr?.checks ?? '-',
    tilde(row.path, home)
  ])
  const [header, ...lines] = formatTable([['BRANCH', 'AGENT', 'PR', 'CHECKS', 'PATH'], ...cells]).split('\n')
  const grouped = new Set(rows.map((row) => row.repo)).size > 1
  if (!grouped) return [header, ...lines].join('\n')
  const out = [header]
  rows.forEach((row, i) => {
    if (i === 0 || rows[i - 1].repo !== row.repo) out.push('', tilde(row.repo, home))
    out.push(lines[i])
  })
  return out.join('\n')
}

export const worktreesCommand: Command = {
  name: 'worktrees',
  summary: 'List worktrees with their branch, agent status and PR',
  usage: 'worktrees [--repo <path>]',
  options: {
    repo: { type: 'string', valueName: 'path', description: 'Only list the repo containing this path' }
  },
  async run(ctx) {
    if (ctx.positionals.length > 0) {
      throw new CliError('usage', `unexpected argument '${ctx.positionals[0]}'. Run 'tatsu worktrees --help' for usage.`)
    }
    const repo = typeof ctx.values.repo === 'string' ? ctx.values.repo : undefined
    const client = await ctx.client()
    const state = await client.snapshot()
    const rows = listRows(state, repo === undefined ? {} : { repo })
    const home = ctx.env.HOME ?? homedir()
    ctx.output.result(rows, (value) => renderWorktrees(value, { home }))
  }
}

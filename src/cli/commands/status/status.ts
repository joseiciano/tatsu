import type { AppState } from '../../../shared/state'
import { describeSource } from '../../endpoint'
import { formatTable } from '../../output'
import type { Command } from '..'

export interface StatusResult {
  url: string
  source: string
  repos: { root: string; worktrees: number }[]
}

export function buildStatus(endpoint: { url: string; source: string }, state: AppState): StatusResult {
  const { repoRoots, list } = state.worktrees
  return {
    url: endpoint.url,
    source: endpoint.source,
    repos: repoRoots.map((root) => ({ root, worktrees: list.filter((wt) => wt.repoRoot === root).length }))
  }
}

export function renderStatus(status: StatusResult): string {
  const header = `Connected to ${status.url} (via ${describeSource(status.source)})`
  if (status.repos.length === 0) return `${header}\n\nNo repos open.`
  const rows = [['REPO', 'WORKTREES'], ...status.repos.map((repo) => [repo.root, String(repo.worktrees)])]
  return `${header}\n\n${formatTable(rows)}`
}

export const statusCommand: Command = {
  name: 'status',
  summary: 'Show the connected backend and its open repos',
  usage: 'status',
  options: {},
  async run(ctx) {
    const client = await ctx.client()
    const state = await client.snapshot()
    ctx.output.result(buildStatus(client.endpoint, state), renderStatus)
  }
}

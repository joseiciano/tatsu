import { randomUUID } from 'node:crypto'
import type { AppState } from '../../../shared/state'
import { getLeaves, type AgentKind } from '../../../shared/state/terminals'
import { CliError } from '../../errors'
import { findRepo } from '../../repo-match'
import type { Command, CommandContext } from '..'

export const NEW_TIMEOUT_MS = 600_000

const AGENT_KINDS = ['claude', 'codex', 'opencode', 'pi'] as const satisfies readonly AgentKind[]

const HELP_HINT = "Run 'tatsu new --help' for usage."

export type NewTabType = 'agent' | 'json-claude'

export interface NewResult {
  outcome: 'success'
  path: string
  branch: string
  repo: string
  tab: NewTabType | null
}

interface RunPendingParams {
  id: string
  repoRoot: string
  branchName: string
  initialPrompt?: string
  agentKind?: AgentKind
  model?: string
}

type PendingOutcome =
  | { outcome: 'success'; createdPath: string }
  | { outcome: 'setup-failed'; createdPath: string }
  | { outcome: 'error'; error: string }

interface NewArgs {
  branch: string
  prompt?: string
  agent?: AgentKind
  model?: string
  repo?: string
}

function isAgentKind(value: string): value is AgentKind {
  return (AGENT_KINDS as readonly string[]).includes(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function parseArgs(ctx: CommandContext): NewArgs {
  if (ctx.positionals.length !== 1) {
    throw new CliError('usage', `expected exactly one <branch>. ${HELP_HINT}`)
  }
  const args: NewArgs = { branch: ctx.positionals[0] }
  const agent = nonEmptyString(ctx.values.agent)
  if (agent !== undefined) {
    if (!isAgentKind(agent)) {
      throw new CliError('usage', `--agent must be one of ${AGENT_KINDS.join(', ')} (got '${agent}'). ${HELP_HINT}`)
    }
    args.agent = agent
  }
  const prompt = nonEmptyString(ctx.values.prompt)
  if (prompt !== undefined) args.prompt = prompt
  const model = nonEmptyString(ctx.values.model)
  if (model !== undefined) args.model = model
  const repo = nonEmptyString(ctx.values.repo)
  if (repo !== undefined) args.repo = repo
  return args
}

export function resolveRepo(state: AppState, { repo, cwd }: { repo?: string; cwd: string }): string {
  const { repoRoots } = state.worktrees
  if (repo !== undefined) {
    const match = findRepo(state, repo)
    if (match === null) throw new CliError('usage', `no open repo contains ${repo}`, { repoRoots })
    return match
  }
  const fromCwd = findRepo(state, cwd)
  if (fromCwd !== null) return fromCwd
  if (repoRoots.length === 1) return repoRoots[0]
  const message =
    repoRoots.length === 0
      ? 'no repo is open in Tatsu'
      : `${repoRoots.length} repos are open and none contains the current directory; pass --repo <path>`
  throw new CliError('usage', message, { repoRoots })
}

function isPendingOutcome(value: unknown): value is PendingOutcome {
  if (typeof value !== 'object' || value === null || !('outcome' in value)) return false
  if (value.outcome === 'success' || value.outcome === 'setup-failed') {
    return 'createdPath' in value && typeof value.createdPath === 'string'
  }
  return value.outcome === 'error' && 'error' in value && typeof value.error === 'string'
}

async function runPending(ctx: CommandContext, params: RunPendingParams): Promise<PendingOutcome> {
  const client = await ctx.client()
  let reply: unknown
  try {
    reply = await client.request('worktrees:runPending', params)
  } catch (err) {
    if (err instanceof CliError && err.code === 'timeout') {
      throw new CliError(
        'timeout',
        `${err.message}. Creating '${params.branchName}' continues on the server; run 'tatsu worktrees' before retrying.`
      )
    }
    throw err
  }
  if (!isPendingOutcome(reply)) throw new CliError('request-failed', "backend sent a malformed reply to 'worktrees:runPending'")
  return reply
}

export function tabTypeFor(state: AppState, path: string): NewTabType | null {
  const root = state.terminals.panes[path]
  if (!root) return null
  for (const leaf of getLeaves(root)) {
    for (const tab of leaf.tabs) {
      if (tab.type === 'agent' || tab.type === 'json-claude') return tab.type
    }
  }
  return null
}

export function renderNew(result: NewResult, { prompted }: { prompted: boolean }): string {
  const lines = [`Created ${result.path} (${result.branch})`]
  if (prompted && result.tab === 'json-claude') lines.push('Agent started with your prompt.')
  if (prompted && result.tab === 'agent') {
    lines.push('Agent tab ready with your prompt — it starts when the tab is opened in Tatsu.')
  }
  return lines.join('\n')
}

export const newCommand: Command = {
  name: 'new',
  summary: 'Create a worktree with an agent tab',
  usage: 'new <branch> [--prompt <text>] [--agent <kind>] [--model <id>] [--repo <path>]',
  options: {
    prompt: { type: 'string', valueName: 'text', description: 'First message for the agent' },
    agent: { type: 'string', valueName: 'kind', description: `Agent harness: ${AGENT_KINDS.join('|')} (default: the backend's)` },
    model: { type: 'string', valueName: 'id', description: 'Model for the agent tab' },
    repo: { type: 'string', valueName: 'path', description: 'Repo to branch from (default: the repo containing cwd)' }
  },
  defaultTimeoutMs: NEW_TIMEOUT_MS,
  async run(ctx) {
    const args = parseArgs(ctx)
    const client = await ctx.client()
    const repoRoot = resolveRepo(await client.snapshot(), { repo: args.repo, cwd: process.cwd() })
    const id = `pending:${randomUUID()}`
    const outcome = await runPending(ctx, {
      id,
      repoRoot,
      branchName: args.branch,
      ...(args.prompt !== undefined ? { initialPrompt: args.prompt } : {}),
      ...(args.agent !== undefined ? { agentKind: args.agent } : {}),
      ...(args.model !== undefined ? { model: args.model } : {})
    })
    if (outcome.outcome === 'error') {
      await client.request('worktrees:dismissPending', id).catch(() => undefined)
      throw new CliError('command-failed', outcome.error.trimEnd())
    }
    if (outcome.outcome === 'setup-failed') {
      throw new CliError('command-failed', `setup script failed in ${outcome.createdPath}`, { path: outcome.createdPath })
    }
    const result: NewResult = {
      outcome: 'success',
      path: outcome.createdPath,
      branch: args.branch,
      repo: repoRoot,
      tab: tabTypeFor(await client.snapshot(), outcome.createdPath)
    }
    ctx.output.result(result, (value) => renderNew(value, { prompted: args.prompt !== undefined }))
  }
}

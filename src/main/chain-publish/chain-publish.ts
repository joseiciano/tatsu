import { execFile, type ExecFileException } from 'child_process'
import { parseRemoteUrl, type GitHubApiError } from '../github'
import { scrubCredentials } from '../scrub-credentials'
import type { WorkflowPublishError, WorkflowPublishStage, WorkflowRunRecord } from '../../shared/state/workflows'
import type { RunPublisher } from '../workflow-runner'
import type {
  ChainBase,
  GitErrorKind,
  GitExec,
  PublishItemRequest,
  PublishItemResult,
  WorktreeBaseMode
} from './types'

const GIT_TIMEOUT_MS = 120_000
const GIT_MAX_BUFFER = 16 * 1024 * 1024
const SUBJECT_MAX_CHARS = 72
const TITLE_MAX_CHARS = 256
const BODY_MAX_CHARS = 60_000
const ERROR_MAX_CHARS = 2000
const UNPUBLISHED_PATHS = ['.harness/runs', '.claude/settings.local.json']


export class GitCommandError extends Error {
  constructor(
    readonly kind: GitErrorKind,
    message: string
  ) {
    super(message)
    this.name = 'GitCommandError'
  }
}

function cleanMessage(text: string): string {
  return Array.from(scrubCredentials(text).trim()).slice(0, ERROR_MAX_CHARS).join('')
}

function truncateCodePoints(text: string, max: number): string {
  const points = Array.from(text)
  return points.length <= max ? text : points.slice(0, max).join('')
}

function gitFailure(args: readonly string[], err: ExecFileException, stderr: string, timeoutMs: number): GitCommandError {
  const command = `git ${args[0] ?? ''}`
  if (err.killed === true) return new GitCommandError('git-timeout', `${command} timed out after ${timeoutMs / 1000}s`)
  const detail = stderr.trim() || err.message
  return new GitCommandError('git-failed', cleanMessage(`${command} failed: ${detail}`))
}

export function createGitExec({
  env = process.env,
  timeoutMs = GIT_TIMEOUT_MS
}: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): GitExec {
  return (args, { cwd }) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        'git',
        [...args],
        {
          cwd,
          env: { ...env, GIT_TERMINAL_PROMPT: '0' },
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: GIT_MAX_BUFFER,
          encoding: 'utf8'
        },
        (err, stdout, stderr) => {
          if (err) reject(gitFailure(args, err, stderr, timeoutMs))
          else resolve(stdout)
        }
      )
      child.stdin?.end()
    })
}

export function commitMessage(summary: string): { subject: string; body: string } {
  const [firstLine = '', ...restLines] = summary.trim().split(/\r?\n/)
  const first = firstLine.trim()
  const rest = restLines.join('\n').trim()
  const subject = truncateCodePoints(first, SUBJECT_MAX_CHARS).trimEnd()
  if (subject === first) return { subject, body: rest }
  return { subject, body: [first, rest].filter(Boolean).join('\n\n') }
}

function lastDoneSummary(record: WorkflowRunRecord, stepId: string): string {
  const attempt = record.attempts.filter((candidate) => candidate.stepId === stepId && candidate.status === 'done').at(-1)
  return attempt?.result?.summary.trim() ?? ''
}

export function runSummary(record: WorkflowRunRecord): string {
  const done = record.definition.steps.filter((step) => record.steps[step.id] === 'done').at(-1)
  const summary = done ? lastDoneSummary(record, done.id) : ''
  return summary || `Workflow ${record.definition.name} on ${record.chain?.item.title ?? ''}`.trimEnd()
}

export function pullRequestBody(record: WorkflowRunRecord, summary: string): string {
  const lines = record.definition.steps.map((step) => {
    const status = record.steps[step.id] ?? 'pending'
    const attempt = record.attempts.filter((candidate) => candidate.stepId === step.id).at(-1)
    const [first = ''] = (attempt?.result?.summary ?? '').trim().split(/\r?\n/)
    return first.trim() ? `${step.id}: ${status} — ${first.trim()}` : `${step.id}: ${status}`
  })
  const stackedOn = record.chain?.stackedOn
  const stacked = stackedOn === undefined ? '' : `Stacked on #${stackedOn}\n\n`
  return truncateCodePoints(`${stacked}${summary}\n\n${lines.join('\n')}`, BODY_MAX_CHARS)
}

export function pullRequestTitle(title: string): string {
  return truncateCodePoints(title.trim(), TITLE_MAX_CHARS)
}

async function tryGit(exec: GitExec, args: readonly string[], cwd: string): Promise<string | null> {
  try {
    return (await exec(args, { cwd })).trim()
  } catch {
    return null
  }
}

export async function resolveChainBase({
  repoRoot,
  mode,
  exec
}: {
  repoRoot: string
  mode: WorktreeBaseMode
  exec: GitExec
}): Promise<ChainBase | null> {
  if (mode === 'local') {
    const current = await tryGit(exec, ['symbolic-ref', '--quiet', '--short', 'HEAD'], repoRoot)
    if (!current) return null
    const tracked = await tryGit(exec, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${current}`], repoRoot)
    return tracked ? { ref: current, branch: current } : null
  }
  let remoteRef = await tryGit(exec, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], repoRoot)
  if (!remoteRef?.startsWith('origin/')) {
    remoteRef = null
    for (const candidate of ['origin/main', 'origin/master']) {
      if (await tryGit(exec, ['rev-parse', '--verify', '--quiet', `refs/remotes/${candidate}`], repoRoot)) {
        remoteRef = candidate
        break
      }
    }
  }
  const branch = remoteRef?.slice('origin/'.length)
  if (!remoteRef || !branch || branch === 'HEAD') return null
  await tryGit(exec, ['fetch', '--quiet', 'origin', branch], repoRoot)
  return { ref: remoteRef, branch }
}

function githubMessage(error: GitHubApiError): string {
  switch (error.kind) {
    case 'no-token':
      return 'No GitHub token is configured'
    case 'bad-response':
      return 'GitHub returned an unexpected response'
    case 'invalid-input':
    case 'network':
      return error.message
    case 'http':
      return [`GitHub ${error.status}: ${error.message}`, ...error.errors].join('; ')
    default: {
      const _exhaustive: never = error
      return _exhaustive
    }
  }
}

class PublishStageError extends Error {
  constructor(
    readonly stage: WorkflowPublishStage,
    readonly kind: string,
    message: string
  ) {
    super(message)
  }
}

class PublishCancelled extends Error {}

function failure(stage: WorkflowPublishStage, kind: string, message: string): WorkflowPublishError {
  return { stage, kind, message: cleanMessage(message) }
}

export async function publishItem(request: PublishItemRequest): Promise<PublishItemResult> {
  const { worktreePath, branch, base, signal, exec, github } = request
  const git = async (stage: WorkflowPublishStage, args: readonly string[]): Promise<string> => {
    try {
      return await exec(args, { cwd: worktreePath })
    } catch (err) {
      if (err instanceof GitCommandError) throw new PublishStageError(stage, err.kind, err.message)
      throw new PublishStageError(stage, 'git-failed', `git ${args[0] ?? ''} failed`)
    }
  }
  const checkpoint = (): void => {
    if (signal?.aborted) throw new PublishCancelled()
  }
  try {
    if (!base) {
      throw new PublishStageError('base', 'no-base', 'No base branch is recorded for this item; the repository needs an origin with a default branch')
    }
    if (!branch || branch.startsWith('-')) throw new PublishStageError('push', 'invalid-branch', 'The item branch name is invalid')
    checkpoint()
    const current = await tryGit(exec, ['symbolic-ref', '--quiet', '--short', 'HEAD'], worktreePath)
    if (current !== branch) {
      throw new PublishStageError('commit', 'wrong-branch', `The worktree is not on the item branch ${branch}`)
    }
    const committed = await commitLeftovers(git, request.summary)
    checkpoint()
    const pushed = await pushBranch(git, exec, worktreePath, branch)
    checkpoint()
    const originUrl = await tryGit(exec, ['config', '--get', 'remote.origin.url'], worktreePath)
    const repoInfo = originUrl ? parseRemoteUrl(originUrl) : null
    if (!repoInfo) throw new PublishStageError('pull-request', 'no-repo', 'The origin remote does not name a GitHub repository')
    const { owner, repo } = repoInfo
    const found = await github.findPullRequestByHead({ owner, repo, branch })
    if (!found.ok) throw new PublishStageError('pull-request', `github-${found.error.kind}`, githubMessage(found.error))
    if (found.pr) return { ok: true, pr: found.pr, committed, pushed, created: false }
    checkpoint()
    const created = await github.createPullRequest({
      owner,
      repo,
      head: branch,
      base,
      title: pullRequestTitle(request.title),
      body: request.body,
      draft: request.draft
    })
    if (!created.ok) {
      throw new PublishStageError('pull-request', `github-${created.error.kind}`, githubMessage(created.error))
    }
    return { ok: true, pr: created.pr, committed, pushed, created: true }
  } catch (err) {
    if (err instanceof PublishCancelled) return { ok: false, cancelled: true }
    if (err instanceof PublishStageError) return { ok: false, error: failure(err.stage, err.kind, err.message) }
    return { ok: false, error: failure('pull-request', 'internal', err instanceof Error ? err.name : 'unknown error') }
  }
}

async function commitLeftovers(
  git: (stage: WorkflowPublishStage, args: readonly string[]) => Promise<string>,
  summary: string
): Promise<boolean> {
  const status = await git('commit', ['status', '--porcelain'])
  if (!status.trim()) return false
  await git('commit', ['add', '-A'])
  await git('commit', ['reset', '-q', '--', ...UNPUBLISHED_PATHS])
  const staged = await git('commit', ['diff', '--cached', '--name-only'])
  if (!staged.trim()) return false
  const { subject, body } = commitMessage(summary)
  await git('commit', ['commit', '-m', subject, ...(body ? ['-m', body] : [])])
  return true
}

async function pushBranch(
  git: (stage: WorkflowPublishStage, args: readonly string[]) => Promise<string>,
  exec: GitExec,
  worktreePath: string,
  branch: string
): Promise<boolean> {
  const head = (await git('push', ['rev-parse', 'HEAD'])).trim()
  const remoteHead = await tryGit(exec, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], worktreePath)
  const upstream = await tryGit(exec, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], worktreePath)
  if (remoteHead === head && upstream === `origin/${branch}`) return false
  await git('push', ['push', '-u', 'origin', branch])
  return true
}

export function createRunPublisher({
  exec,
  github,
  draftPrsFor
}: {
  exec: GitExec
  github: PublishItemRequest['github']
  draftPrsFor: (chainId: string) => boolean | undefined
}): RunPublisher {
  return async ({ run, signal }) => {
    const { chain } = run
    if (!chain) return { ok: false, error: failure('pull-request', 'not-a-chain-run', 'The run does not belong to a chain') }
    const draft = draftPrsFor(chain.chainId)
    if (draft === undefined) {
      return { ok: false, error: failure('pull-request', 'unknown-chain', 'The chain record for this run is not available') }
    }
    const summary = runSummary(run)
    const result = await publishItem({
      worktreePath: run.worktreePath,
      branch: chain.item.branch,
      base: chain.item.baseBranch,
      title: chain.item.title,
      summary,
      body: pullRequestBody(run, summary),
      draft,
      signal,
      exec,
      github
    })
    if (result.ok) return { ok: true, pr: result.pr }
    if (result.cancelled) return { ok: false, error: failure('pull-request', 'cancelled', 'Publishing was cancelled') }
    return { ok: false, error: result.error }
  }
}

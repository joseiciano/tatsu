import type { FindPullRequestByHeadInput, FindPullRequestResult, CreatePullRequestInput, PullRequestRef, PullRequestResult } from '../github'
import type { WorkflowPublishError } from '../../shared/state/workflows'

export type GitExec = (args: readonly string[], options: { cwd: string }) => Promise<string>

export type GitErrorKind = 'git-failed' | 'git-timeout'

export interface PublishGithub {
  findPullRequestByHead(input: FindPullRequestByHeadInput): Promise<FindPullRequestResult>
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequestResult>
}

export interface PublishItemRequest {
  worktreePath: string
  branch: string
  base: string
  title: string
  summary: string
  body: string
  draft: boolean
  signal?: AbortSignal
  exec: GitExec
  github: PublishGithub
}

export type PublishItemResult =
  | { ok: true; pr: PullRequestRef; committed: boolean; pushed: boolean; created: boolean }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; error: WorkflowPublishError }

export type WorktreeBaseMode = 'remote' | 'local'

export interface ChainBase {
  ref: string
  branch: string
}

import type { CheckStatus, PRReview, PRStatus } from '../../shared/state/prs'
import type { PRSummary, PRMetadata } from '../../shared/github-types'

export type { CheckStatus, PRReview, PRStatus, PRSummary, PRMetadata }

export interface RepoContext {
  origin: { owner: string; repo: string }
  upstream: { owner: string; repo: string }
}

export interface PRStatusRequest {
  worktreePath: string
  branch: string
  headSha: string
}

export interface ApiPRListItem {
  number: number
  title: string
  state: 'open' | 'closed'
  draft: boolean
  merged_at: string | null
  html_url: string
  user: { login: string; avatar_url: string } | null
  base: { ref: string; repo: { full_name: string } | null } | null
  head: {
    ref: string
    sha: string
    repo: { full_name: string } | null
  }
  assignees: { login: string; avatar_url: string }[] | null
  updated_at: string
}

export interface GraphQLActor {
  login?: string | null
  avatarUrl?: string | null
}

export interface GraphQLPR {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  url: string
  mergedAt: string | null
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  additions: number
  deletions: number
  baseRefName: string
  baseRepository: { defaultBranchRef: { name: string } | null } | null
  headRefOid: string
  headRepository: { nameWithOwner: string } | null
  mergeCommit: { oid: string } | null
  author: GraphQLActor | null
  milestone: { title: string; url: string; state: 'OPEN' | 'CLOSED' } | null
  assignees: { nodes: Array<GraphQLActor | null> | null } | null
  labels: { nodes: Array<{ name: string; color: string; description: string | null } | null> | null } | null
  mergeQueueEntry: { position: number; estimatedTimeToMerge: number | null } | null
  closingIssuesReferences: {
    nodes: Array<{ number: number; title: string; state: 'OPEN' | 'CLOSED'; url: string } | null> | null
  } | null
  reviews: {
    nodes: Array<{
      author: GraphQLActor | null
      state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
      body: string
      submittedAt: string
      url: string
    } | null> | null
  } | null
  commits: {
    nodes: Array<{
      commit: {
        statusCheckRollup: {
          contexts: { nodes: Array<GraphQLCheckContext | null> | null } | null
        } | null
      }
    } | null> | null
  } | null
}

export type GraphQLCheckContext =
  | {
      __typename: 'CheckRun'
      name: string
      status:
        | 'QUEUED'
        | 'IN_PROGRESS'
        | 'COMPLETED'
        | 'WAITING'
        | 'PENDING'
        | 'REQUESTED'
      conclusion:
        | 'SUCCESS'
        | 'FAILURE'
        | 'NEUTRAL'
        | 'CANCELLED'
        | 'SKIPPED'
        | 'TIMED_OUT'
        | 'ACTION_REQUIRED'
        | 'STALE'
        | 'STARTUP_FAILURE'
        | null
      detailsUrl: string | null
      permalink: string | null
      startedAt: string | null
      title: string | null
      summary: string | null
    }
  | {
      __typename: 'StatusContext'
      context: string
      state: 'EXPECTED' | 'ERROR' | 'FAILURE' | 'PENDING' | 'SUCCESS'
      description: string | null
      targetUrl: string | null
      createdAt: string | null
    }

export interface GraphQLBatchResponse {
  data?:
    | ({
        repository?:
          | ({
              defaultBranchRef: { name: string } | null
              milestones: { totalCount: number } | null
            } & Record<string, { nodes: GraphQLPR[] | null } | null>)
          | null
      } & Record<string, { nodes: Array<GraphQLPR | { __typename?: string }> | null } | null>)
    | null
  errors?: Array<{ message: string }> | null
}

export type GitHubMergeMethod = 'merge' | 'squash' | 'rebase'

export interface MergePRResult {
  ok: boolean
  error?: string
  errorCode?: 'unauthorized' | 'method_not_allowed' | 'conflict' | 'unprocessable' | 'unknown'
  sha?: string
}

export type ParentInfo = { owner: string; repo: string } | 'self'
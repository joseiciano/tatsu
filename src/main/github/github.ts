import { execFile } from 'child_process'
import { promisify } from 'util'
import { log, formatErr } from '../debug'
import { getCachedToken, invalidateTokenCache, resolveGitHubToken } from '../github-auth'
import { trackedFetch } from '../github-recorder'
import type { CheckStatus, PRReview, PRStatus } from '../../shared/state/prs'
import type { PRSummary, PRMetadata } from '../../shared/github-types'
import {
  type RepoContext,
  type PRStatusRequest,
  type ApiPRListItem,
  type GraphQLActor,
  type GraphQLPR,
  type GraphQLCheckContext,
  type GraphQLBatchResponse,
  type GitHubMergeMethod,
  type MergePRResult,
  type ParentInfo
} from './types'
import { PR_FRAGMENT } from './constants'

export type { CheckStatus, PRReview, PRStatus, PRSummary, PRMetadata }

const execFileAsync = promisify(execFile)

function parseRemoteUrl(url: string): { owner: string; repo: string } | null {
  const sshMatch = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/)
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] }
  }
  return null
}

export async function getRepoInfo(worktreePath: string): Promise<{ owner: string; repo: string } | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['config', '--get', 'remote.origin.url'],
      { cwd: worktreePath }
    )
    return parseRemoteUrl(stdout.trim())
  } catch {
    return null
  }
}

async function getFirstTagContaining(worktreePath: string, sha: string): Promise<string | null> {
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) return null
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['tag', '--contains', sha, '--sort=version:refname'],
      { cwd: worktreePath }
    )
    const first = stdout.split('\n').map((s) => s.trim()).find((s) => s.length > 0)
    return first ?? null
  } catch {
    return null
  }
}

async function doFetch(url: string, token: string | null): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Tatsu',
    'X-GitHub-Api-Version': '2022-11-28'
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return trackedFetch(url, { headers })
}

async function githubFetch(url: string): Promise<unknown> {
  let token = getCachedToken()
  let res = await doFetch(url, token)
  if (res.status === 401) {
    log('github', '401 from GitHub, re-resolving token')
    invalidateTokenCache()
    const resolved = await resolveGitHubToken()
    token = resolved?.token ?? null
    res = await doFetch(url, token)
  }
  if (!res.ok) {
    const path = url.replace(/^https:\/\/api\.github\.com/, '')
    throw new Error(`GitHub API ${res.status} ${res.statusText} for ${path}`)
  }
  return res.json()
}

const forkParentCache = new Map<string, ParentInfo>()

export async function getRepoContext(worktreePath: string): Promise<RepoContext | null> {
  const origin = await getRepoInfo(worktreePath)
  if (!origin) return null
  const upstream = await resolveQueryRepo(origin)
  return { origin, upstream }
}

async function resolveQueryRepo(
  origin: { owner: string; repo: string }
): Promise<{ owner: string; repo: string }> {
  const key = `${origin.owner}/${origin.repo}`
  const cached = forkParentCache.get(key)
  if (cached === 'self') return origin
  if (cached) return cached
  try {
    const data = (await githubFetch(
      `https://api.github.com/repos/${origin.owner}/${origin.repo}`
    )) as { fork?: boolean; parent?: { owner: { login: string }; name: string } }
    if (data.fork && data.parent) {
      const parent = { owner: data.parent.owner.login, repo: data.parent.name }
      forkParentCache.set(key, parent)
      log('github', `detected fork ${key} → upstream ${parent.owner}/${parent.repo}`)
      return parent
    }
    forkParentCache.set(key, 'self')
    return origin
  } catch (err) {
    log('github', `fork detection failed for ${key}`, formatErr(err))
    return origin
  }
}

async function fetchBehindBy(
  owner: string,
  repo: string,
  baseRef: string,
  headSha: string
): Promise<number | null> {
  try {
    const data = (await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(headSha)}`
    )) as { behind_by?: number } | null
    if (!data || typeof data.behind_by !== 'number') return null
    return data.behind_by
  } catch (err) {
    log('github', `fetchBehindBy failed for ${owner}/${repo} ${baseRef}...${headSha}`, err instanceof Error ? err.message : err)
    return null
  }
}

function computeOverall(checks: CheckStatus[]): PRStatus['checksOverall'] {
  if (checks.length === 0) return 'none'
  if (checks.some((c) => c.state === 'failure' || c.state === 'error')) return 'failure'
  if (checks.some((c) => c.state === 'pending')) return 'pending'
  return 'success'
}

function gqlCheckState(c: Extract<GraphQLCheckContext, { __typename: 'CheckRun' }>): CheckStatus['state'] {
  if (c.conclusion) {
    switch (c.conclusion) {
      case 'SUCCESS':
        return 'success'
      case 'FAILURE':
      case 'TIMED_OUT':
      case 'ACTION_REQUIRED':
      case 'CANCELLED':
      case 'STARTUP_FAILURE':
        return 'failure'
      case 'NEUTRAL':
        return 'neutral'
      case 'SKIPPED':
        return 'skipped'
      case 'STALE':
        return 'neutral'
    }
  }
  if (c.status === 'COMPLETED') return 'success'
  return 'pending'
}

function gqlStatusState(s: Extract<GraphQLCheckContext, { __typename: 'StatusContext' }>['state']): CheckStatus['state'] {
  switch (s) {
    case 'SUCCESS':
      return 'success'
    case 'FAILURE':
    case 'ERROR':
      return 'failure'
    case 'PENDING':
      return 'pending'
    default:
      return 'neutral'
  }
}

export async function fetchPRStatusesForRepo(
  ctx: RepoContext,
  requests: PRStatusRequest[]
): Promise<Map<string, PRStatus | null>> {
  const result = new Map<string, PRStatus | null>()
  if (requests.length === 0) return result

  const token = getCachedToken()
  if (!token) {
    for (const r of requests) result.set(r.worktreePath, null)
    return result
  }

  const queryable = requests.filter((r) => r.branch && r.branch !== '(detached)')
  for (const r of requests) {
    if (!queryable.includes(r)) result.set(r.worktreePath, null)
  }
  if (queryable.length === 0) return result

  const { owner, repo } = ctx.upstream
  const originFull = `${ctx.origin.owner}/${ctx.origin.repo}`

  const varDefs = ['$owner:String!', '$name:String!']
  const repoAliasParts: string[] = []
  const topAliasParts: string[] = []
  const variables: Record<string, string> = { owner, name: repo }
  queryable.forEach((req, i) => {
    varDefs.push(`$branch${i}:String!`)
    variables[`branch${i}`] = req.branch
    repoAliasParts.push(
      `prBr${i}: pullRequests(headRefName: $branch${i}, first: 5, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...PR } }`
    )
    if (/^[0-9a-f]{40}$/i.test(req.headSha)) {
      varDefs.push(`$q${i}:String!`)
      variables[`q${i}`] = `type:pr repo:${owner}/${repo} ${req.headSha}`
      topAliasParts.push(
        `prSearch${i}: search(query: $q${i}, type: ISSUE, first: 5) { nodes { ... on PullRequest { ...PR } } }`
      )
    }
  })
  const query = `query(${varDefs.join(', ')}) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    milestones(first: 1) { totalCount }
    ${repoAliasParts.join('\n    ')}
  }
  ${topAliasParts.join('\n  ')}
}
${PR_FRAGMENT}`

  const res = await trackedFetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Tatsu',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  })
  if (!res.ok) {
    throw new Error(`GitHub GraphQL ${res.status} ${res.statusText}`)
  }
  const json = (await res.json()) as GraphQLBatchResponse
  if (json.errors && json.errors.length > 0) {
    log('github', `GraphQL errors for ${owner}/${repo}`, json.errors.map((e) => e.message).join('; '))
  }
  const repoData = json.data?.repository
  if (!repoData) {
    throw new Error(`GitHub GraphQL: empty repository response for ${owner}/${repo}`)
  }
  const topData = json.data ?? {}

  const hasMilestones = (repoData.milestones?.totalCount ?? 0) > 0

  const defaultBranchName = repoData.defaultBranchRef?.name ?? ''

  const built = await Promise.all(
    queryable.map(async (req, i) => {
      if (defaultBranchName && req.branch === defaultBranchName) {
        return { worktreePath: req.worktreePath, branch: req.branch, status: null as PRStatus | null }
      }
      const brAlias = repoData[`prBr${i}`] as { nodes: GraphQLPR[] | null } | null | undefined
      const searchAlias = topData[`prSearch${i}`] as
        | { nodes: Array<GraphQLPR | { __typename?: string }> | null }
        | null
        | undefined
      const branchNodes = brAlias?.nodes ?? []
      const searchNodes = (searchAlias?.nodes ?? []).filter(
        (n): n is GraphQLPR => !!n && typeof (n as GraphQLPR).number === 'number'
      )
      const pr = resolvePRForWorktree(branchNodes, searchNodes, req.headSha, originFull)
      if (!pr) return { worktreePath: req.worktreePath, branch: req.branch, status: null as PRStatus | null }
      const [behindBy, firstReleaseTag] = await Promise.all([
        pr.state === 'MERGED' || pr.state === 'CLOSED'
          ? Promise.resolve(null)
          : fetchBehindBy(owner, repo, pr.baseRefName, pr.headRefOid),
        pr.state === 'MERGED' && pr.mergeCommit?.oid
          ? getFirstTagContaining(req.worktreePath, pr.mergeCommit.oid)
          : Promise.resolve(null)
      ])
      const status = buildPRStatus(pr, req.branch, behindBy, firstReleaseTag, hasMilestones)
      return { worktreePath: req.worktreePath, branch: req.branch, status }
    })
  )

  const baseBranches = new Set<string>()
  for (const b of built) if (b.status) baseBranches.add(b.status.baseBranch)
  for (const b of built) {
    if (b.status && baseBranches.has(b.branch)) b.status = null
  }

  for (const b of built) result.set(b.worktreePath, b.status)
  return result
}

function resolvePRForWorktree(
  branchNodes: GraphQLPR[],
  searchNodes: GraphQLPR[],
  headSha: string,
  originFull: string
): GraphQLPR | null {
  if (headSha) {
    const bySha =
      branchNodes.find((n) => n.headRefOid === headSha) ??
      searchNodes.find((n) => n.headRefOid === headSha)
    if (bySha) return bySha
  }
  const sameRepo = branchNodes.find((n) => n.headRepository?.nameWithOwner === originFull)
  if (sameRepo) return sameRepo
  return null
}

function buildPRStatus(
  pr: GraphQLPR,
  branchName: string,
  behindBy: number | null,
  firstReleaseTag: string | null,
  hasMilestones: boolean
): PRStatus {
  const byName = new Map<string, CheckStatus>()
  const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []
  for (const c of contexts) {
    if (!c) continue
    const entry: CheckStatus =
      c.__typename === 'CheckRun'
        ? {
            name: c.name,
            state: gqlCheckState(c),
            description: c.title || '',
            summary: c.summary || undefined,
            detailsUrl: c.permalink || c.detailsUrl || undefined,
            startedAt: c.startedAt || undefined
          }
        : {
            name: c.context,
            state: gqlStatusState(c.state),
            description: c.description || '',
            detailsUrl: c.targetUrl || undefined,
            startedAt: c.createdAt || undefined
          }
    const prev = byName.get(entry.name)
    if (!prev || (entry.startedAt ?? '') >= (prev.startedAt ?? '')) {
      byName.set(entry.name, entry)
    }
  }
  const checks: CheckStatus[] = [...byName.values()]

  const reviewNodes = pr.reviews?.nodes ?? []
  const reviews: PRReview[] = []
  for (const r of reviewNodes) {
    if (!r || !r.author?.login || r.state === 'PENDING') continue
    reviews.push({
      user: r.author.login,
      avatarUrl: r.author.avatarUrl || '',
      state: r.state,
      body: r.body || '',
      submittedAt: r.submittedAt,
      htmlUrl: r.url
    })
  }
  const latestByUser = new Map<string, PRReview['state']>()
  for (const r of reviews) latestByUser.set(r.user, r.state)
  const latestStates = [...latestByUser.values()]
  let reviewDecision: PRStatus['reviewDecision'] = 'none'
  if (latestStates.some((s) => s === 'CHANGES_REQUESTED')) reviewDecision = 'changes_requested'
  else if (latestStates.some((s) => s === 'APPROVED')) reviewDecision = 'approved'
  else if (latestStates.length > 0) reviewDecision = 'review_required'

  let state: PRStatus['state']
  if (pr.state === 'MERGED') state = 'merged'
  else if (pr.state === 'CLOSED') state = 'closed'
  else if (pr.isDraft) state = 'draft'
  else state = 'open'

  let hasConflict: boolean | null
  if (pr.mergeable === 'CONFLICTING') hasConflict = true
  else if (pr.mergeable === 'MERGEABLE') hasConflict = false
  else hasConflict = null

  const assignees = (pr.assignees?.nodes ?? [])
    .filter((a): a is GraphQLActor => !!a?.login)
    .map((a) => ({ login: a.login!, avatarUrl: a.avatarUrl ?? '' }))

  const labels = (pr.labels?.nodes ?? [])
    .filter((l): l is { name: string; color: string; description: string | null } => !!l)
    .map((l) => ({
      name: l.name,
      color: l.color,
      description: l.description ?? undefined
    }))

  const linkedIssues = (pr.closingIssuesReferences?.nodes ?? [])
    .filter((n): n is { number: number; title: string; state: 'OPEN' | 'CLOSED'; url: string } => !!n)
    .map((n) => ({
      number: n.number,
      title: n.title,
      state: n.state === 'CLOSED' ? ('closed' as const) : ('open' as const),
      url: n.url
    }))

  const queuePosition = pr.mergeQueueEntry?.position
  const defaultBranch = pr.baseRepository?.defaultBranchRef?.name ?? ''

  return {
    number: pr.number,
    title: pr.title,
    state,
    url: pr.url,
    branch: branchName,
    author: pr.author?.login ? { login: pr.author.login, avatarUrl: pr.author.avatarUrl ?? '' } : null,
    checks,
    checksOverall: computeOverall(checks),
    hasConflict,
    reviews,
    reviewDecision,
    additions: pr.additions,
    deletions: pr.deletions,
    baseBranch: pr.baseRefName,
    isDefaultBase: pr.baseRefName === defaultBranch,
    milestone: pr.milestone
      ? {
          title: pr.milestone.title,
          url: pr.milestone.url,
          state: pr.milestone.state === 'CLOSED' ? 'closed' : 'open'
        }
      : null,
    assignees,
    queuePosition: typeof queuePosition === 'number' && queuePosition > 0 ? queuePosition : undefined,
    queueEstimatedSeconds:
      typeof pr.mergeQueueEntry?.estimatedTimeToMerge === 'number'
        ? pr.mergeQueueEntry.estimatedTimeToMerge
        : undefined,
    behindBy: behindBy ?? undefined,
    linkedIssues,
    labels,
    firstReleaseTag: firstReleaseTag ?? undefined,
    hasMilestones
  }
}

export async function isRepoStarred(token: string, owner: string, repo: string): Promise<boolean | null> {
  try {
    const res = await trackedFetch(`https://api.github.com/user/starred/${owner}/${repo}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Tatsu',
        Authorization: `Bearer ${token}`
      }
    })
    if (res.status === 204) return true
    if (res.status === 404) return false
    return null
  } catch {
    return null
  }
}

export async function unstarRepo(token: string, owner: string, repo: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await trackedFetch(`https://api.github.com/user/starred/${owner}/${repo}`, {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Tatsu',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
    if (res.status === 204) return { ok: true }
    return { ok: false, error: `${res.status} ${res.statusText}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function starRepo(token: string, owner: string, repo: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await trackedFetch(`https://api.github.com/user/starred/${owner}/${repo}`, {
      method: 'PUT',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Tatsu',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Length': '0'
      }
    })
    if (res.status === 204 || res.status === 304) return { ok: true }
    return { ok: false, error: `${res.status} ${res.statusText}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function mergePR(
  token: string,
  owner: string,
  repo: string,
  number: number,
  method: GitHubMergeMethod,
  opts?: { commitTitle?: string; commitMessage?: string }
): Promise<MergePRResult> {
  const body: Record<string, unknown> = { merge_method: method }
  if (opts?.commitTitle !== undefined) body.commit_title = opts.commitTitle
  if (opts?.commitMessage !== undefined) body.commit_message = opts.commitMessage

  let res: Response
  try {
    res = await trackedFetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}/merge`, {
      method: 'PUT',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Tatsu',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log('github', `mergePR fetch failed for ${owner}/${repo}#${number}`, formatErr(err))
    return { ok: false, error: message, errorCode: 'unknown' }
  }

  if (res.status === 200) {
    try {
      const data = (await res.json()) as { sha?: string; merged?: boolean }
      return { ok: true, sha: data.sha }
    } catch {
      return { ok: true }
    }
  }

  let apiMessage = ''
  try {
    const data = (await res.json()) as { message?: string }
    apiMessage = data?.message || ''
  } catch {
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      error: 'Unauthorized — check that your token has repo scope',
      errorCode: 'unauthorized'
    }
  }
  if (res.status === 405) {
    return {
      ok: false,
      error: 'Branch protection forbids this merge method',
      errorCode: 'method_not_allowed'
    }
  }
  if (res.status === 409) {
    return {
      ok: false,
      error: 'PR has merge conflicts — resolve them and try again',
      errorCode: 'conflict'
    }
  }
  if (res.status === 422) {
    return {
      ok: false,
      error: 'PR not in a mergeable state (draft, blocked by checks, etc.)',
      errorCode: 'unprocessable'
    }
  }
  return {
    ok: false,
    error: apiMessage || `${res.status} ${res.statusText}`,
    errorCode: 'unknown'
  }
}

function toPRSummary(pr: ApiPRListItem): PRSummary {
  const baseRepo = pr.base?.repo?.full_name ?? null
  const headRepo = pr.head?.repo?.full_name ?? null
  return {
    number: pr.number,
    title: pr.title,
    author: pr.user
      ? { login: pr.user.login, avatarUrl: pr.user.avatar_url }
      : null,
    baseBranch: pr.base?.ref ?? '',
    headBranch: pr.head?.ref ?? '',
    headSha: pr.head?.sha ?? '',
    headRepoFullName: headRepo,
    isFork: !!baseRepo && !!headRepo && baseRepo !== headRepo,
    updatedAt: pr.updated_at,
    url: pr.html_url,
    draft: pr.draft
  }
}

export async function listOpenPRs(repoRoot: string): Promise<PRSummary[] | null> {
  const repoInfo = await getRepoInfo(repoRoot)
  if (!repoInfo) return null
  const { owner, repo } = repoInfo
  try {
    const list = (await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=50&sort=updated&direction=desc`
    )) as ApiPRListItem[]
    if (!Array.isArray(list)) return null
    return list.map(toPRSummary)
  } catch (err) {
    log('github', `listOpenPRs failed for ${owner}/${repo}`, formatErr(err))
    return null
  }
}

export async function getPRMetadata(
  repoRoot: string,
  prNumber: number
): Promise<PRMetadata | null> {
  const repoInfo = await getRepoInfo(repoRoot)
  if (!repoInfo) return null
  const { owner, repo } = repoInfo
  try {
    const pr = (await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`
    )) as ApiPRListItem
    if (!pr || typeof pr.number !== 'number') return null
    return toPRSummary(pr)
  } catch (err) {
    log('github', `getPRMetadata failed for ${owner}/${repo}#${prNumber}`, formatErr(err))
    return null
  }
}

export async function testToken(token: string): Promise<{ ok: boolean; username?: string; error?: string }> {
  try {
    const res = await trackedFetch('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Tatsu',
        Authorization: `Bearer ${token}`
      }
    })
    if (!res.ok) {
      return { ok: false, error: `${res.status} ${res.statusText}` }
    }
    const data = await res.json() as { login: string }
    return { ok: true, username: data.login }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

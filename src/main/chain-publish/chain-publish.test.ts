import { execFile, spawn, type ChildProcess } from 'child_process'
import { chmodSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { WorkflowRunRecord } from '../../shared/state/workflows'

vi.mock('../debug', () => ({
  log: vi.fn(),
  formatErr: (err: unknown) => (err instanceof Error ? err.message : String(err))
}))

vi.mock('../github-auth', () => ({
  getCachedToken: vi.fn(() => 'stub-token'),
  invalidateTokenCache: vi.fn(),
  resolveGitHubToken: vi.fn(async () => ({ token: 'stub-token', source: 'pat' }))
}))

type ChainPublish = typeof import('.')
type Github = typeof import('../github')

const execFileAsync = promisify(execFile)
const STUB = join(process.cwd(), 'scripts', 'github-stub.mjs')
const TIMEOUT = 60_000
const TEST_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  XDG_CONFIG_HOME: join(tmpdir(), 'chain-publish-no-xdg')
}

let root: string
let bare: string
let repo: string
let stub: ChildProcess
let stubLog: string
let mod: ChainPublish
let github: Github
let worktreeCount = 0

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: TEST_ENV })
  return stdout.trim()
}

function stubRequests(): Array<{ method: string; path: string; body: Record<string, unknown> | null }> {
  return readFileSync(stubLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function pullPosts(): Array<Record<string, unknown>> {
  return stubRequests()
    .filter((entry) => entry.method === 'POST' && entry.path === '/repos/acme/widgets/pulls')
    .map((entry) => entry.body ?? {})
}

async function startStub(): Promise<string> {
  stubLog = join(root, 'stub.jsonl')
  writeFileSync(stubLog, '')
  stub = spawn(process.execPath, [STUB, '--log', stubLog], { stdio: ['ignore', 'pipe', 'inherit'] })
  return new Promise((resolve, reject) => {
    let out = ''
    stub.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
      const line = out.split('\n').find((l) => l.startsWith('http://'))
      if (line) resolve(line.trim())
    })
    stub.on('exit', (code) => reject(new Error(`stub exited ${code}`)))
  })
}

async function addItemWorktree(slug: string): Promise<{ path: string; branch: string }> {
  worktreeCount += 1
  const branch = `wf/smoke/${slug}-0000000${worktreeCount}`
  const path = join(root, 'worktrees', `${slug}-${worktreeCount}`)
  await git(repo, 'worktree', 'add', '-q', '-b', branch, path, 'origin/main')
  return { path, branch }
}

function recordingExec(commitTimeoutMs?: number): { exec: ReturnType<ChainPublish['createGitExec']>; calls: string[][] } {
  const inner = mod.createGitExec({ env: TEST_ENV })
  const commit = commitTimeoutMs === undefined ? inner : mod.createGitExec({ env: TEST_ENV, timeoutMs: commitTimeoutMs })
  const calls: string[][] = []
  return {
    calls,
    exec: (args, options) => {
      calls.push([...args])
      return (args[0] === 'commit' ? commit : inner)(args, options)
    }
  }
}

function realGithub() {
  return { findPullRequestByHead: github.findPullRequestByHead, createPullRequest: github.createPullRequest }
}

function request(path: string, branch: string, overrides: Partial<Parameters<ChainPublish['publishItem']>[0]> = {}) {
  const { exec } = recordingExec()
  return {
    worktreePath: path,
    branch,
    base: 'main',
    title: 'Add login',
    summary: 'Implemented the login form\n\nAdded validation and tests.',
    body: 'Implemented the login form\n\nimplement: done — Implemented the login form',
    draft: true,
    exec,
    github: realGithub(),
    ...overrides
  }
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'chain-publish-')))
  bare = join(root, 'remotes', 'acme', 'widgets.git')
  repo = join(root, 'repo')
  mkdirSync(join(root, 'remotes', 'acme'), { recursive: true })
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env: TEST_ENV })
  await execFileAsync('git', ['init', '-q', '-b', 'main', repo], { env: TEST_ENV })
  await git(repo, 'config', 'user.name', 'Chain Test')
  await git(repo, 'config', 'user.email', 'chain@example.com')
  await git(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'README.md'), 'widgets\n')
  await git(repo, 'add', 'README.md')
  await git(repo, 'commit', '-q', '-m', 'init')
  await git(repo, 'remote', 'add', 'origin', bare)
  await git(repo, 'push', '-q', 'origin', 'main')
  await git(repo, 'remote', 'set-head', 'origin', 'main')
  await git(repo, 'config', 'extensions.worktreeConfig', 'true')
  vi.stubEnv('HARNESS_GITHUB_API_URL', await startStub())
  vi.resetModules()
  github = await import('../github')
  mod = await import('.')
}, TIMEOUT)

afterAll(() => {
  vi.unstubAllEnvs()
  stub?.kill('SIGTERM')
  rmSync(root, { recursive: true, force: true })
})

describe('publishItem on a temp repo with a bare origin and the GitHub stub', () => {
  it('commits leftovers with the summary, pushes the branch and opens one PR', async () => {
    const { path, branch } = await addItemWorktree('add-login')
    writeFileSync(join(path, 'login.ts'), 'export const login = true\n')
    mkdirSync(join(path, '.harness', 'runs', 'run-1'), { recursive: true })
    writeFileSync(join(path, '.harness', 'runs', 'run-1', 'context.md'), 'private run notes\n')
    const { exec, calls } = recordingExec()

    const result = await mod.publishItem(request(path, branch, { exec }))

    expect(result).toEqual({
      ok: true,
      pr: { number: expect.any(Number), url: expect.stringContaining('/acme/widgets/pull/'), draft: true },
      committed: true,
      pushed: true,
      created: true
    })
    expect(await git(path, 'log', '-1', '--format=%s')).toBe('Implemented the login form')
    expect(await git(path, 'log', '-1', '--format=%b')).toBe('Added validation and tests.')
    const committedFiles = (await git(path, 'show', '--name-only', '--format=', 'HEAD')).split('\n')
    expect(committedFiles).toEqual(['login.ts'])
    expect(await git(bare, 'rev-parse', `refs/heads/${branch}`)).toBe(await git(path, 'rev-parse', 'HEAD'))
    expect(await git(path, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')).toBe(`origin/${branch}`)
    expect(calls.flat().some((arg) => /^(--force|-f|--force-with-lease.*|\+.*)$/.test(arg))).toBe(false)
    expect(pullPosts().filter((body) => body.head === branch)).toEqual([
      {
        head: branch,
        base: 'main',
        title: 'Add login',
        body: 'Implemented the login form\n\nimplement: done — Implemented the login form',
        draft: true
      }
    ])

    const retried = await mod.publishItem(request(path, branch))
    expect(retried).toEqual({ ok: true, pr: result.ok ? result.pr : null, committed: false, pushed: false, created: false })
    expect(pullPosts().filter((body) => body.head === branch)).toHaveLength(1)
  }, TIMEOUT)

  it('commits leftovers when .harness/runs is already excluded the way run artifacts exclude it', async () => {
    const { path, branch } = await addItemWorktree('excluded')
    const excludeFile = await git(path, 'rev-parse', '--git-path', 'info/exclude')
    mkdirSync(join(excludeFile, '..'), { recursive: true })
    writeFileSync(excludeFile.startsWith('/') ? excludeFile : join(path, excludeFile), '.harness/runs/\n')
    mkdirSync(join(path, '.harness', 'runs', 'run-2'), { recursive: true })
    writeFileSync(join(path, '.harness', 'runs', 'run-2', 'context.md'), 'notes\n')
    writeFileSync(join(path, 'feature.ts'), 'export {}\n')

    const result = await mod.publishItem(request(path, branch))

    expect(result).toMatchObject({ ok: true, committed: true, pushed: true, created: true })
    expect((await git(path, 'show', '--name-only', '--format=', 'HEAD')).split('\n')).toEqual(['feature.ts'])
  }, TIMEOUT)

  it('leaves a shared .claude/settings.local.json symlink out of the commit', async () => {
    const { path, branch } = await addItemWorktree('settings')
    mkdirSync(join(path, '.claude'), { recursive: true })
    symlinkSync(join(root, 'home-settings.local.json'), join(path, '.claude', 'settings.local.json'))
    writeFileSync(join(path, 'work.ts'), 'export {}\n')

    const result = await mod.publishItem(request(path, branch))

    expect(result).toMatchObject({ ok: true, committed: true })
    expect((await git(path, 'show', '--name-only', '--format=', 'HEAD')).split('\n')).toEqual(['work.ts'])
    expect(await git(bare, 'ls-tree', '-r', '--name-only', branch)).not.toContain('.claude/')
  }, TIMEOUT)

  it('pushes a clean branch whose upstream is still origin/main', async () => {
    const { path, branch } = await addItemWorktree('clean')
    expect(await git(path, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')).toBe('origin/main')

    const result = await mod.publishItem(request(path, branch, { draft: false }))

    expect(result).toMatchObject({ ok: true, committed: false, pushed: true, created: true, pr: { draft: false } })
    expect(await git(bare, 'rev-parse', `refs/heads/${branch}`)).toBe(await git(path, 'rev-parse', 'HEAD'))
  }, TIMEOUT)

  it('fails at the pull-request stage on a stub 422 and keeps the pushed branch', async () => {
    const { path, branch } = await addItemWorktree('fail-pr')
    writeFileSync(join(path, 'x.txt'), 'x\n')

    const result = await mod.publishItem(request(path, branch))

    expect(result).toEqual({
      ok: false,
      error: {
        stage: 'pull-request',
        kind: 'github-http',
        message: `GitHub 422: Validation Failed; stub refused pull request for ${branch}`
      }
    })
    expect(await git(bare, 'rev-parse', `refs/heads/${branch}`)).toBe(await git(path, 'rev-parse', 'HEAD'))
  }, TIMEOUT)

  it('stops before creating a PR once the signal aborts', async () => {
    const { path, branch } = await addItemWorktree('cancelled')
    const controller = new AbortController()
    const { exec: inner } = recordingExec()
    const exec: typeof inner = (args, options) => {
      if (args[0] === 'push') controller.abort()
      return inner(args, options)
    }

    const result = await mod.publishItem(request(path, branch, { exec, signal: controller.signal }))

    expect(result).toEqual({ ok: false, cancelled: true })
    expect(pullPosts().filter((body) => body.head === branch)).toEqual([])
  }, TIMEOUT)

  it('refuses without a recorded base and on the wrong branch', async () => {
    const { path, branch } = await addItemWorktree('guards')
    expect(await mod.publishItem(request(path, branch, { base: '' }))).toMatchObject({
      ok: false,
      error: { stage: 'base', kind: 'no-base' }
    })
    expect(await mod.publishItem(request(path, 'wf/smoke/other-00000099'))).toMatchObject({
      ok: false,
      error: { stage: 'commit', kind: 'wrong-branch' }
    })
  }, TIMEOUT)

  it('runs the user commit hook and turns a hung hook into a git-timeout', async () => {
    const { path, branch } = await addItemWorktree('hook')
    const hooks = join(root, 'hooks')
    mkdirSync(hooks, { recursive: true })
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexec sleep 30\n')
    chmodSync(join(hooks, 'pre-commit'), 0o755)
    await git(path, 'config', '--worktree', 'core.hooksPath', hooks)
    writeFileSync(join(path, 'y.txt'), 'y\n')
    const { exec } = recordingExec(1000)

    const result = await mod.publishItem(request(path, branch, { exec }))

    expect(result).toEqual({
      ok: false,
      error: { stage: 'commit', kind: 'git-timeout', message: 'git commit timed out after 1s' }
    })
  }, TIMEOUT)

  it('scrubs remote credentials from a failed push', async () => {
    const path = join(root, 'creds')
    const branch = 'wf/smoke/creds-00000001'
    await execFileAsync('git', ['clone', '-q', bare, path], { env: TEST_ENV })
    await git(path, 'remote', 'set-url', 'origin', 'https://alice:s3cret-token@127.0.0.1:9/acme/widgets.git')
    await git(path, 'checkout', '-q', '-b', branch)

    const result = await mod.publishItem(request(path, branch))

    expect(result).toMatchObject({ ok: false, error: { stage: 'push', kind: 'git-failed' } })
    const message = result.ok || result.cancelled ? '' : result.error.message
    expect(message).toContain('git push failed')
    expect(message).not.toContain('s3cret-token')
    expect(message).not.toContain('alice')
  }, TIMEOUT)
})

describe('createRunPublisher', () => {
  function chainRun(path: string, branch: string, baseBranch = 'main'): WorkflowRunRecord {
    return {
      runId: 'run-1',
      worktreePath: path,
      definition: { name: 'Smoke', inputs: {}, steps: [{ id: 'build' }] },
      steps: { build: 'done' },
      attempts: [{ stepId: 'build', status: 'done', result: { summary: 'Built the widget' } }],
      chain: { chainId: 'chain-1', item: { id: 'item-1', title: 'Widget', value: 'v', branch, baseBranch } }
    } as unknown as WorkflowRunRecord
  }

  it('publishes a chain run with its item, base and the chain draft flag', async () => {
    const { path, branch } = await addItemWorktree('run-publisher')
    writeFileSync(join(path, 'widget.ts'), 'export {}\n')
    const draftPrsFor = vi.fn(() => false)
    const publish = mod.createRunPublisher({ exec: recordingExec().exec, github: realGithub(), draftPrsFor })

    const result = await publish({ run: chainRun(path, branch), signal: new AbortController().signal })

    expect(result).toEqual({ ok: true, pr: expect.objectContaining({ draft: false }) })
    expect(draftPrsFor).toHaveBeenCalledWith('chain-1')
    expect(await git(path, 'log', '-1', '--format=%s')).toBe('Built the widget')
    expect(pullPosts().filter((body) => body.head === branch)).toEqual([
      { head: branch, base: 'main', title: 'Widget', body: 'Built the widget\n\nbuild: done — Built the widget', draft: false }
    ])
  }, TIMEOUT)

  it('fails without a chain record or a base, and reports a cancel', async () => {
    const { path, branch } = await addItemWorktree('run-publisher-guards')
    const signal = new AbortController().signal
    const unknown = mod.createRunPublisher({ exec: recordingExec().exec, github: realGithub(), draftPrsFor: () => undefined })
    expect(await unknown({ run: chainRun(path, branch), signal })).toMatchObject({ ok: false, error: { kind: 'unknown-chain' } })
    const publish = mod.createRunPublisher({ exec: recordingExec().exec, github: realGithub(), draftPrsFor: () => true })
    expect(await publish({ run: chainRun(path, branch, ''), signal })).toMatchObject({
      ok: false,
      error: { stage: 'base', kind: 'no-base' }
    })
    const aborted = new AbortController()
    aborted.abort()
    expect(await publish({ run: chainRun(path, branch), signal: aborted.signal })).toMatchObject({
      ok: false,
      error: { kind: 'cancelled' }
    })
  }, TIMEOUT)
})

describe('resolveChainBase', () => {
  it('returns origin/HEAD as the cut ref and its branch as the PR base in remote mode', async () => {
    const exec = mod.createGitExec({ env: TEST_ENV })
    expect(await mod.resolveChainBase({ repoRoot: repo, mode: 'remote', exec })).toEqual({ ref: 'origin/main', branch: 'main' })
  }, TIMEOUT)

  it('falls back to origin/main without origin/HEAD and returns null without an origin', async () => {
    const exec = mod.createGitExec({ env: TEST_ENV })
    const other = join(root, 'other')
    await execFileAsync('git', ['clone', '-q', bare, other], { env: TEST_ENV })
    await git(other, 'remote', 'set-head', 'origin', '--delete')
    expect(await mod.resolveChainBase({ repoRoot: other, mode: 'remote', exec })).toEqual({ ref: 'origin/main', branch: 'main' })
    const lonely = join(root, 'lonely')
    await execFileAsync('git', ['init', '-q', '-b', 'main', lonely], { env: TEST_ENV })
    expect(await mod.resolveChainBase({ repoRoot: lonely, mode: 'remote', exec })).toBeNull()
    expect(await mod.resolveChainBase({ repoRoot: lonely, mode: 'local', exec })).toBeNull()
  }, TIMEOUT)

  it('uses the checked-out branch in local mode only when origin has it', async () => {
    const exec = mod.createGitExec({ env: TEST_ENV })
    expect(await mod.resolveChainBase({ repoRoot: repo, mode: 'local', exec })).toEqual({ ref: 'main', branch: 'main' })
  }, TIMEOUT)
})

describe('commit message, summary and body', () => {
  it('cuts the subject to 72 code points without splitting a surrogate pair and keeps the full line in the body', () => {
    const long = `${'a'.repeat(71)}😀tail`
    const { subject, body } = mod.commitMessage(`${long}\nrest of it`)
    expect(Array.from(subject)).toHaveLength(72)
    expect(subject.endsWith('😀')).toBe(true)
    expect(body).toBe(`${long}\n\nrest of it`)
    expect(mod.commitMessage('  one line  ')).toEqual({ subject: 'one line', body: '' })
  })

  it('takes the run summary from the last done step in definition order, else a fallback', () => {
    const record = {
      definition: { name: 'Fix bugs', inputs: {}, steps: [{ id: 'plan' }, { id: 'build' }, { id: 'review' }] },
      steps: { plan: 'done', build: 'done', review: 'skipped' },
      attempts: [
        { stepId: 'plan', status: 'done', result: { summary: 'Planned it' } },
        { stepId: 'build', status: 'failed', result: { summary: 'Broke' } },
        { stepId: 'build', status: 'done', result: { summary: 'Built it\nwith details' } }
      ],
      chain: { chainId: 'c', item: { id: 'i', title: 'Login page', value: 'v', branch: 'b', baseBranch: 'main' } }
    } as unknown as WorkflowRunRecord
    expect(mod.runSummary(record)).toBe('Built it\nwith details')
    expect(mod.pullRequestBody(record, 'Built it')).toBe(
      'Built it\n\nplan: done — Planned it\nbuild: done — Built it\nreview: skipped'
    )
    const empty = { ...record, attempts: [] } as WorkflowRunRecord
    expect(mod.runSummary(empty)).toBe('Workflow Fix bugs on Login page')
  })
})

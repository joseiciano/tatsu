import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkflowRunner, createGitRunArtifacts, type StepAttempt, type WorkflowRunnerDeps } from '.'
import { FakeStepDriver, worktreeFixture, type FakeStartBehavior } from './fake-step-driver'
import { Store } from '../store'
import { createWorkflowRunLookup, createWorkflowRunRecords, type WorkflowRunRecords } from '../workflow-run-records'
import { registerWorkflowsRequestHandlers } from '../workflows-transport'
import { initialState } from '../../shared/state'
import type { WorkflowAttemptRecord, WorkflowDefinitionDetail, WorkflowRunRecord } from '../../shared/state/workflows'
import { validateWorkflowDefinition } from '../../shared/workflow-def'

vi.mock('../perf-log', () => ({
  perfLog: vi.fn(),
  getPerfLogFilePath: vi.fn(() => '/tmp/perf.log')
}))

const WAIT = { timeout: 10_000, interval: 20 }

const SOURCE = `name: handoff
inputs:
  task: { type: text }
steps:
  - id: one
    agent: claude
    prompt: "do {{inputs.task}}"
  - id: two
    agent: claude
    prompt: "follow {{steps.one.summary}}"
`

type Handler = (ctx: unknown, payload: unknown) => unknown

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function definitionDetail(): WorkflowDefinitionDetail {
  const result = validateWorkflowDefinition(SOURCE)
  return {
    ...result,
    source: SOURCE,
    summary: {
      id: 'personal:handoff',
      name: 'handoff',
      scope: 'personal',
      path: '/defs/handoff.yaml',
      hash: 'hash-handoff',
      stepIds: ['one', 'two'],
      issues: []
    }
  }
}

let root: string
let records: WorkflowRunRecords

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'run-artifacts-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function initRepo(repo: string): void {
  execFileSync('git', ['init', '-q', repo])
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 't')
  git(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'init')
}

function setup(worktree: string, agentScript?: (attempt: StepAttempt) => FakeStartBehavior) {
  const store = new Store({
    ...initialState,
    hooks: { ...initialState.hooks, consent: 'accepted' },
    worktrees: { ...initialState.worktrees, list: [worktreeFixture(worktree)] },
    settings: { ...initialState.settings, labs: { ...initialState.settings.labs, workflows: true } }
  })
  const loader: WorkflowRunnerDeps['loader'] = {
    getDefinition: (id) => (id === 'personal:handoff' ? definitionDetail() : null)
  }
  records = createWorkflowRunRecords({ dir: join(root, 'user-data', 'workflow-runs') })
  const agent = new FakeStepDriver('agent', agentScript)
  const shell = new FakeStepDriver('shell')
  const logs: string[] = []
  let ids = 0
  const runner = new WorkflowRunner({
    store,
    loader,
    drivers: { agent, shell },
    now: () => Date.now(),
    newId: () => `id-${++ids}`,
    log: (category, message) => logs.push(`[${category}] ${message}`),
    persist: (run) => records.persist(run),
    artifacts: createGitRunArtifacts()
  })
  runner.reconcile([])
  const handlers = new Map<string, Handler>()
  registerWorkflowsRequestHandlers({
    transport: { onRequest: (name, handler) => handlers.set(name, handler) },
    loader: { reload: () => 0, getDefinition: () => null },
    runs: createWorkflowRunLookup({
      live: (runId) => runner.getRunRecord(runId),
      liveAttemptRunId: (attemptId) => runner.runIdForAttempt(attemptId),
      records,
      attemptRunId: (attemptId) => store.getSnapshot().state.workflows.attempts[attemptId]?.runId
    }),
    runner,
    store,
    persistTrust: () => {},
    inputTrust: async () => 'untrusted',
    log: () => {}
  })
  const call = async (name: string, payload: unknown): Promise<unknown> => {
    const handler = handlers.get(name)
    if (!handler) throw new Error(`no handler ${name}`)
    return handler({}, payload)
  }
  const start = async (): Promise<string> => {
    const result = await runner.start({ defId: 'personal:handoff', worktreePath: worktree, inputs: { task: 'ship' } })
    if (!result.ok) throw new Error(result.reason)
    return result.runId
  }
  const attemptOf = (runId: string, stepId: string): string | undefined =>
    store.getSnapshot().state.workflows.runs[runId]?.steps[stepId]?.attemptIds.at(-1)
  return { store, runner, agent, logs, call, start, attemptOf }
}

describe('runner artifacts against a real git repo', () => {
  it('records snapshots, full results and metrics, writes context.md and keeps it out of git status', async () => {
    const repo = join(root, 'repo')
    execFileSync('git', ['init', '-q', repo])
    git(repo, 'config', 'user.email', 't@t')
    git(repo, 'config', 'user.name', 't')
    git(repo, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(repo, 'README.md'), 'hello\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')

    const ctx = setup(repo)
    const runId = await ctx.start()
    await vi.waitFor(() => expect(ctx.agent.started).toHaveLength(1), WAIT)
    writeFileSync(join(repo, 'one.txt'), 'step one\n')
    const summaryOne = `${'a'.repeat(5000)}-ONE`
    ctx.runner.complete(ctx.attemptOf(runId, 'one') ?? '', {
      status: 'done',
      summary: summaryOne,
      completedBy: 'tool'
    })
    await vi.waitFor(() => expect(ctx.agent.started).toHaveLength(2), WAIT)
    const contextPath = join(repo, '.harness', 'runs', runId, 'context.md')
    expect(readFileSync(contextPath, 'utf8')).toContain(summaryOne)
    ctx.runner.complete(ctx.attemptOf(runId, 'two') ?? '', {
      status: 'done',
      summary: 'two finished',
      completedBy: 'tool',
      data: { ok: true }
    })

    let record: WorkflowRunRecord | null = null
    await vi.waitFor(async () => {
      await records.flush()
      record = (await ctx.call('workflows:getRun', runId)) as WorkflowRunRecord | null
      expect(record?.attempts.every((a) => a.headSnapshot !== undefined)).toBe(true)
    }, WAIT)
    await records.flush()
    const onDisk = JSON.parse(
      readFileSync(join(root, 'user-data', 'workflow-runs', `${runId}.json`), 'utf8')
    ) as WorkflowRunRecord
    expect(onDisk).toEqual(record)

    expect(onDisk).toMatchObject({
      version: 1,
      runId,
      status: 'done',
      inputs: { task: 'ship' },
      contextPath,
      definition: { name: 'handoff' }
    })
    expect(onDisk.timeToFirstDoneMs).toBeGreaterThanOrEqual(0)
    const [one, two] = onDisk.attempts
    expect(one.result?.summary).toBe(summaryOne)
    expect(two.result).toEqual({ status: 'done', summary: 'two finished', completedBy: 'tool', data: { ok: true } })
    for (const attempt of [one, two]) {
      expect(attempt.metrics).toMatchObject({ completedBy: 'tool', continuations: 0, pauses: [] })
      expect(attempt.metrics.wallMs).toBeGreaterThanOrEqual(0)
      for (const snapshot of [attempt.baseSnapshot, attempt.headSnapshot]) {
        if (!snapshot) throw new Error('missing snapshot')
        expect(git(repo, 'rev-parse', snapshot.ref)).toBe(snapshot.commit)
      }
    }
    const parentOf = (sha: string): string => git(repo, 'rev-parse', `${sha}^`)
    expect(git(repo, 'rev-list', '--parents', '-n', '1', one.baseSnapshot?.commit ?? '').split(' ')).toHaveLength(1)
    expect(parentOf(one.headSnapshot?.commit ?? '')).toBe(one.baseSnapshot?.commit)
    expect(parentOf(two.baseSnapshot?.commit ?? '')).toBe(one.headSnapshot?.commit)
    expect(parentOf(two.headSnapshot?.commit ?? '')).toBe(two.baseSnapshot?.commit)
    expect(git(repo, 'ls-tree', '--name-only', one.baseSnapshot?.commit ?? '')).not.toContain('one.txt')
    expect(git(repo, 'ls-tree', '--name-only', one.headSnapshot?.commit ?? '')).toContain('one.txt')
    expect(new Set([one.baseSnapshot?.ref, one.headSnapshot?.ref, two.baseSnapshot?.ref, two.headSnapshot?.ref]).size).toBe(4)

    const attemptResult = (await ctx.call('workflows:getAttemptResult', ctx.attemptOf(runId, 'one'))) as WorkflowAttemptRecord
    expect(attemptResult).toEqual(one)

    const context = readFileSync(contextPath, 'utf8')
    expect(context).toContain('## one (attempt 1)')
    expect(context).toContain('## two (attempt 1)')
    expect(context).toContain('two finished')
    const status = git(repo, 'status', '--porcelain', '--untracked-files=all')
    expect(status).toContain('one.txt')
    expect(status).not.toContain('.harness')
    expect(ctx.logs.filter((line) => line.includes('failed'))).toEqual([])
  })

  it('runs the attempt without snapshots when the worktree is not a git repo and logs a warning', async () => {
    const plain = join(root, 'plain')
    execFileSync('mkdir', ['-p', plain])
    const ctx = setup(plain)
    const runId = await ctx.start()
    await vi.waitFor(() => expect(ctx.agent.started).toHaveLength(1), WAIT)
    ctx.runner.complete(ctx.attemptOf(runId, 'one') ?? '', { status: 'done', summary: 's', completedBy: 'tool' })
    await vi.waitFor(() => expect(ctx.agent.started).toHaveLength(2), WAIT)
    ctx.runner.complete(ctx.attemptOf(runId, 'two') ?? '', { status: 'done', summary: 's', completedBy: 'tool' })
    await vi.waitFor(() => expect(ctx.logs.filter((l) => l.includes('head snapshot skipped'))).toHaveLength(2), WAIT)

    expect(ctx.store.getSnapshot().state.workflows.runs[runId].status).toBe('done')
    await records.flush()
    const record = (await ctx.call('workflows:getRun', runId)) as WorkflowRunRecord
    for (const attempt of record.attempts) {
      expect(attempt.status).toBe('done')
      expect('baseSnapshot' in attempt).toBe(false)
      expect('headSnapshot' in attempt).toBe(false)
    }
    expect(ctx.logs).toContain('[workflow] run artifacts unavailable')
    expect(ctx.logs.filter((l) => l === '[workflow] base snapshot skipped')).toHaveLength(2)
    expect(existsSync(join(plain, '.harness'))).toBe(false)
  })
})

describe('retry from clean against a real git repo', () => {
  async function failedFirstAttempt() {
    const repo = join(root, 'repo')
    initRepo(repo)
    const seen: string[] = []
    const ctx = setup(repo, () => {
      seen.push(readFileSync(join(repo, 'README.md'), 'utf8'))
      return 'ok'
    })
    const runId = await ctx.start()
    await vi.waitFor(() => expect(ctx.agent.started).toHaveLength(1), WAIT)
    writeFileSync(join(repo, 'README.md'), 'edited by the step\n')
    writeFileSync(join(repo, 'extra.txt'), 'new file\n')
    ctx.runner.complete(ctx.attemptOf(runId, 'one') ?? '', { status: 'failed', summary: 'no', completedBy: 'tool' })
    return { repo, seen, ctx, runId }
  }

  it('restores the base snapshot before the new attempt starts and keeps the failed head ref', async () => {
    const { repo, seen, ctx, runId } = await failedFirstAttempt()

    expect(await ctx.runner.retryFromClean(runId, 'one')).toEqual({ ok: true })
    await vi.waitFor(() => expect(ctx.agent.started).toHaveLength(2), WAIT)

    expect(seen).toEqual(['hello\n', 'hello\n'])
    expect(existsSync(join(repo, 'extra.txt'))).toBe(false)
    const record = ctx.runner.getRunRecord(runId)
    expect(record?.attempts.map((attempt) => [attempt.n, attempt.status])).toEqual([
      [1, 'failed'],
      [2, 'running']
    ])
    const head = record?.attempts[0].headSnapshot
    if (!head) throw new Error('missing head snapshot')
    expect(git(repo, 'rev-parse', head.ref)).toBe(head.commit)
    expect(git(repo, 'show', `${head.commit}:extra.txt`)).toBe('new file')
    expect(ctx.agent.started[1]).toMatchObject({ stepId: 'one', n: 2 })
  })

  it('refuses every other action, cancel included, while the restore runs', async () => {
    const { repo, ctx, runId } = await failedFirstAttempt()

    const pending = ctx.runner.retryFromClean(runId, 'one')
    expect(ctx.runner.retryStep(runId, 'one')).toEqual({ ok: false, reason: 'busy' })
    expect(await ctx.runner.retryFromClean(runId, 'one')).toEqual({ ok: false, reason: 'busy' })
    expect(ctx.runner.cancelRun(runId)).toEqual({ ok: false, reason: 'busy' })
    expect(await pending).toEqual({ ok: true })

    await vi.waitFor(() => expect(ctx.agent.started).toHaveLength(2), WAIT)
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('hello\n')
    expect(ctx.runner.cancelRun(runId)).toEqual({ ok: true })
  })

  it('refuses when the last attempt has no base snapshot', async () => {
    const plain = join(root, 'plain')
    execFileSync('mkdir', ['-p', plain])
    const ctx = setup(plain)
    const runId = await ctx.start()
    await vi.waitFor(() => expect(ctx.agent.started).toHaveLength(1), WAIT)
    ctx.runner.complete(ctx.attemptOf(runId, 'one') ?? '', { status: 'failed', summary: 'no', completedBy: 'tool' })
    expect(await ctx.runner.retryFromClean(runId, 'one')).toEqual({ ok: false, reason: 'no-snapshot' })
    expect(ctx.agent.started).toHaveLength(1)
  })
})

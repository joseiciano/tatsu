import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerWorkflowChainRequestHandlers, registerWorkflowsRequestHandlers, type WorkflowActionsRunner } from '.'
import { Store } from '../store'
import {
  WorkflowRunner,
  type InputTrustFetcher,
  type MarkDoneRequest,
  type RequestChangesRequest,
  type StartRunRequest,
  type SwapStepRequest,
  type StartRunResult,
  type StepActionResult,
  type StepDriver
} from '../workflow-runner'
import { initialState } from '../../shared/state'
import type { CodexHookTrustSummary } from '../../shared/state/hooks'
import { createWorkflowDefsLoader, repoKeyOf, type WorkflowDefsLoader, type WorkflowWatchFn } from '../workflow-defs-loader'
import { createWorkflowRunLookup, createWorkflowRunRecords, type WorkflowRunRecords } from '../workflow-run-records'
import {
  GATE_FEEDBACK_MAX_CHARS,
  type WorkflowAttemptRecord,
  type WorkflowDefinitionDetail,
  type WorkflowLoopCapAction,
  type WorkflowRunRecord,
  type WorkflowsEvent
} from '../../shared/state/workflows'
import { validateWorkflowDefinition } from '../../shared/workflow-def'
import { takeSnapshot } from '../workflow-snapshots'
import type { PersistedWorkflowTrust } from '../persistence'
import type { StartChainRequest } from '../workflow-chains'

vi.mock('../perf-log', () => ({
  perfLog: vi.fn(),
  getPerfLogFilePath: vi.fn(() => '/tmp/perf.log')
}))

const noWatch: WorkflowWatchFn = () => ({ close: () => {}, on: () => undefined })

const VALID_YAML = `name: Valid flow
steps:
  - id: plan
    agent: claude
    prompt: Plan it
`

const FULL_YAML = `name: Full flow
steps:
  - id: plan
    agent: claude
    permissions: full
    prompt: Plan it
`

const ISSUE_FULL_YAML = `name: Issue flow
inputs:
  ticket: { type: issue }
steps:
  - id: plan
    agent: claude
    permissions: full
    prompt: Fix {{inputs.ticket}}
`

const CODEX_YAML = `name: Codex flow
steps:
  - id: plan
    agent: codex
    permissions: read-only
    prompt: Plan it
`

type Handler = (ctx: unknown, ...args: unknown[]) => unknown

class FakeTransport {
  readonly handlers = new Map<string, Handler>()

  onRequest(name: string, handler: Handler): void {
    this.handlers.set(name, handler)
  }

  async call(name: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(name)
    if (!handler) throw new Error(`no handler for ${name}`)
    return handler({ clientId: 'client-1' }, ...args)
  }
}

let dir: string
let dispatched: WorkflowsEvent[]
let transport: FakeTransport
let records: WorkflowRunRecords
let liveRuns: Map<string, WorkflowRunRecord>
let attemptRuns: Map<string, string>
let runner: FakeRunner
let logs: string[]
let inputTrust: ReturnType<typeof vi.fn<InputTrustFetcher>>
let store: Store

type RunnerCall = [method: string, ...args: unknown[]]

class FakeRunner implements WorkflowActionsRunner {
  readonly calls: RunnerCall[] = []
  startResult: StartRunResult = { ok: true, runId: 'run-new' }
  actionResult: StepActionResult = { ok: true }
  throwOn?: string

  private record(method: string, ...args: unknown[]): void {
    this.calls.push([method, ...args])
    if (this.throwOn === method) throw new Error(`boom ${method}`)
  }

  async start(request: StartRunRequest): Promise<StartRunResult> {
    this.record('start', request)
    return this.startResult
  }

  cancelRun(runId: string): StepActionResult {
    this.record('cancelRun', runId)
    return this.actionResult
  }

  cancelStep(runId: string, stepId: string): StepActionResult {
    this.record('cancelStep', runId, stepId)
    return this.actionResult
  }

  retryStep(runId: string, stepId: string): StepActionResult {
    this.record('retryStep', runId, stepId)
    return this.actionResult
  }

  async retryFromClean(runId: string, stepId: string): Promise<StepActionResult> {
    this.record('retryFromClean', runId, stepId)
    return this.actionResult
  }

  skipStep(runId: string, stepId: string): StepActionResult {
    this.record('skipStep', runId, stepId)
    return this.actionResult
  }

  markDone(runId: string, stepId: string, request: MarkDoneRequest): StepActionResult {
    this.record('markDone', runId, stepId, request)
    return this.actionResult
  }

  swapStep(runId: string, stepId: string, request: SwapStepRequest): StepActionResult {
    this.record('swapStep', runId, stepId, request)
    return this.actionResult
  }

  resumeStep(runId: string, stepId: string): StepActionResult {
    this.record('resumeStep', runId, stepId)
    return this.actionResult
  }

  approveGate(runId: string, stepId: string): StepActionResult {
    this.record('approveGate', runId, stepId)
    return this.actionResult
  }

  requestChanges(runId: string, stepId: string, request: RequestChangesRequest): StepActionResult {
    this.record('requestChanges', runId, stepId, request)
    return this.actionResult
  }

  resolveLoopCap(runId: string, stepId: string, action: WorkflowLoopCapAction): StepActionResult {
    this.record('resolveLoopCap', runId, stepId, action)
    return this.actionResult
  }

  keepWaiting(runId: string, stepId: string): StepActionResult {
    this.record('keepWaiting', runId, stepId)
    return this.actionResult
  }

  setBudget(runId: string, budgetUsd: number): StepActionResult {
    this.record('setBudget', runId, budgetUsd)
    return this.actionResult
  }

  retryPublish(runId: string): StepActionResult {
    this.record('retryPublish', runId)
    return this.actionResult
  }
}

function attempt(attemptId: string, summary: string): WorkflowAttemptRecord {
  return {
    attemptId,
    stepId: 'plan',
    n: 1,
    status: 'done',
    startedAt: 1,
    endedAt: 2,
    result: { status: 'done', summary, completedBy: 'tool' },
    metrics: { completedBy: 'tool', continuations: 0, pauses: [], wallMs: 1 }
  }
}

function runRecord(runId: string, attempts: WorkflowAttemptRecord[]): WorkflowRunRecord {
  return {
    version: 1,
    runId,
    defId: 'personal:plan',
    defHash: 'hash',
    definition: { name: 'plan', inputs: {}, steps: [] },
    inputs: {},
    worktreePath: '/wt',
    contextPath: `/wt/.harness/runs/${runId}/context.md`,
    status: 'done',
    cursor: 1,
    steps: { plan: 'done' },
    startedAt: 1,
    finishedAt: 3,
    attempts
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workflows-transport-'))
  dispatched = []
  transport = new FakeTransport()
  liveRuns = new Map()
  attemptRuns = new Map()
  const loader = createWorkflowDefsLoader({ dir, dispatch: (event) => dispatched.push(event), log: () => {}, watch: noWatch })
  records = createWorkflowRunRecords({ dir: join(dir, 'workflow-runs'), log: () => {} })
  const runs = createWorkflowRunLookup({
    live: (runId) => liveRuns.get(runId) ?? null,
    liveAttemptRunId: (attemptId) =>
      [...liveRuns.values()].find((run) => run.attempts.some((a) => a.attemptId === attemptId))?.runId,
    records,
    attemptRunId: (attemptId) => attemptRuns.get(attemptId)
  })
  runner = new FakeRunner()
  logs = []
  inputTrust = vi.fn<InputTrustFetcher>(async () => 'untrusted')
  store = new Store({
    ...initialState,
    worktrees: {
      ...initialState.worktrees,
      repoRoots: ['/repo'],
      list: [{ path: '/wt/a', branch: 'main', head: 'abc', isBare: false, isMain: false, createdAt: 0, repoRoot: '/repo' }]
    },
    settings: { ...initialState.settings, labs: { ...initialState.settings.labs, workflows: true } }
  })
  registerWorkflowsRequestHandlers({
    transport,
    loader,
    runs,
    runner,
    store,
    persistTrust: () => {},
    inputTrust,
    log: (category, message, data) => logs.push(`[${category}] ${message} ${JSON.stringify(data ?? {})}`)
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('workflows:reloadDefinitions', () => {
  it('rescans the directory, dispatches the summaries and returns the count', async () => {
    expect(await transport.call('workflows:reloadDefinitions')).toBe(0)
    writeFileSync(join(dir, 'plan.yaml'), VALID_YAML)
    writeFileSync(join(dir, 'other.yml'), VALID_YAML)

    expect(await transport.call('workflows:reloadDefinitions')).toBe(2)

    expect(dispatched).toHaveLength(2)
    const last = dispatched[1]
    if (last.type !== 'workflows/definitionsLoaded') throw new Error('no definitions dispatched')
    expect(last.payload.definitions.map((d) => d.id)).toEqual(['personal:other', 'personal:plan'])
  })
})

describe('workflows:getDefinition', () => {
  it('returns the source and diagnostics for a known id', async () => {
    writeFileSync(join(dir, 'plan.yaml'), VALID_YAML)
    await transport.call('workflows:reloadDefinitions')

    const detail = (await transport.call('workflows:getDefinition', 'personal:plan')) as WorkflowDefinitionDetail

    expect(detail.source).toBe(VALID_YAML)
    expect(detail.diagnostics).toEqual([])
    expect(detail.summary.id).toBe('personal:plan')
    expect(detail.parsed?.name).toBe('Valid flow')
  })

  it('reflects edits made on disk after the scan', async () => {
    const file = join(dir, 'plan.yaml')
    writeFileSync(file, VALID_YAML)
    await transport.call('workflows:reloadDefinitions')
    writeFileSync(file, 'name: [unclosed\n')

    const detail = (await transport.call('workflows:getDefinition', 'personal:plan')) as WorkflowDefinitionDetail

    expect(detail.source).toBe('name: [unclosed\n')
    expect(detail.parsed).toBeUndefined()
    expect(detail.diagnostics.length).toBeGreaterThan(0)
  })

  it('returns null for an unknown id, a path-like id or a non-string payload', async () => {
    writeFileSync(join(dir, 'plan.yaml'), VALID_YAML)
    await transport.call('workflows:reloadDefinitions')

    expect(await transport.call('workflows:getDefinition', 'personal:missing')).toBeNull()
    expect(await transport.call('workflows:getDefinition', join(dir, 'plan.yaml'))).toBeNull()
    expect(await transport.call('workflows:getDefinition', '../../etc/passwd')).toBeNull()
    expect(await transport.call('workflows:getDefinition', { id: 'personal:plan' })).toBeNull()
  })
})

describe('workflows:getRun and workflows:getAttemptResult', () => {
  it('returns a finished run and its attempt in full from disk', async () => {
    const summary = 'y'.repeat(5000)
    const run = runRecord('run-1', [attempt('att-1', summary)])
    records.persist(run)
    await records.flush()
    attemptRuns.set('att-1', 'run-1')

    expect(await transport.call('workflows:getRun', 'run-1')).toEqual(run)
    const result = (await transport.call('workflows:getAttemptResult', 'att-1')) as WorkflowAttemptRecord
    expect(result.result?.summary).toBe(summary)
  })

  it('prefers the live in-memory record over disk', async () => {
    records.persist(runRecord('run-1', []))
    await records.flush()
    const live = { ...runRecord('run-1', [attempt('att-2', 'live')]), status: 'running' as const }
    liveRuns.set('run-1', live)
    attemptRuns.set('att-2', 'run-1')

    expect(await transport.call('workflows:getRun', 'run-1')).toEqual(live)
    expect(await transport.call('workflows:getAttemptResult', 'att-2')).toEqual(live.attempts[0])
  })

  it('resolves an attempt of a run no longer in the slice from disk', async () => {
    const run = runRecord('run-evicted', [attempt('att-old', 'kept on disk')])
    records.persist(run)
    await records.flush()

    const result = (await transport.call('workflows:getAttemptResult', 'att-old')) as WorkflowAttemptRecord
    expect(result).toEqual(run.attempts[0])
  })

  it('resolves an attempt of a live run that the slice does not map', async () => {
    const live = { ...runRecord('run-live', [attempt('att-live', 'in memory')]), status: 'running' as const }
    liveRuns.set('run-live', live)

    expect(await transport.call('workflows:getAttemptResult', 'att-live')).toEqual(live.attempts[0])
  })

  it('resolves attempts after a restart with a fresh lookup over the existing records dir', async () => {
    const runDir = join(dir, 'workflow-runs')
    const run = runRecord('run-before', [attempt('att-a', 'first'), attempt('att-b', 'second')])
    records.persist(run)
    await records.flush()

    const fresh = createWorkflowRunLookup({
      live: () => null,
      liveAttemptRunId: () => undefined,
      records: createWorkflowRunRecords({ dir: runDir, log: () => {} }),
      attemptRunId: () => undefined
    })
    expect(await fresh.getAttemptResult('att-b')).toEqual(run.attempts[1])
    expect(await fresh.getAttemptResult('att-a')).toEqual(run.attempts[0])
    expect(await fresh.getAttemptResult('att-missing')).toBeNull()
    expect(await fresh.getAttemptResult('../run-before')).toBeNull()
  })

  it('returns null for unknown, path-like and non-string ids', async () => {
    records.persist(runRecord('run-1', [attempt('att-1', 'x')]))
    await records.flush()
    attemptRuns.set('att-1', 'run-1')
    attemptRuns.set('att-orphan', 'run-missing')

    expect(await transport.call('workflows:getRun', 'run-missing')).toBeNull()
    expect(await transport.call('workflows:getRun', '../workflow-runs/run-1')).toBeNull()
    expect(await transport.call('workflows:getRun', { runId: 'run-1' })).toBeNull()
    expect(await transport.call('workflows:getAttemptResult', 'att-unknown')).toBeNull()
    expect(await transport.call('workflows:getAttemptResult', 'att-orphan')).toBeNull()
    expect(await transport.call('workflows:getAttemptResult', 42)).toBeNull()
  })
})

describe('workflows:getAttemptChangedFiles and workflows:getAttemptFileDiff', () => {
  const gitEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t'
  }
  const fixtureGit = (cwd: string, args: string[]): string =>
    execFileSync('git', args, { cwd, env: gitEnv }).toString().trim()

  let repo: string

  beforeEach(() => {
    repo = join(realpathSync(dir), 'repo')
    mkdirSync(repo)
    fixtureGit(repo, ['init', '-q', '-b', 'main'])
    fixtureGit(repo, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(repo, 'notes.md'), 'one\n')
    fixtureGit(repo, ['add', '-A'])
    fixtureGit(repo, ['commit', '-q', '-m', 'base'])
  })

  async function snapshottedAttempt(
    runId: string,
    attemptId: string,
    change: () => void
  ): Promise<WorkflowAttemptRecord> {
    const baseSnapshot = await takeSnapshot({ worktree: repo, runId, stepId: 'plan', n: 0 })
    change()
    const headSnapshot = await takeSnapshot({ worktree: repo, runId, stepId: 'plan', n: 1, parent: baseSnapshot.commit })
    return {
      ...attempt(attemptId, 'changed'),
      baseSnapshot: { commit: baseSnapshot.commit, ref: baseSnapshot.ref },
      headSnapshot: { commit: headSnapshot.commit, ref: headSnapshot.ref }
    }
  }

  async function persistRun(runId: string, attempts: WorkflowAttemptRecord[], worktreePath = repo): Promise<void> {
    records.persist({ ...runRecord(runId, attempts), worktreePath })
    await records.flush()
  }

  it('lists the files an uncommitted attempt changed and diffs one of them', async () => {
    const changed = await snapshottedAttempt('run-diff', 'att-diff', () => {
      writeFileSync(join(repo, 'smoke.txt'), 'smoke\n')
      writeFileSync(join(repo, 'notes.md'), 'one\ntwo\n')
    })
    await persistRun('run-diff', [changed])

    expect(await transport.call('workflows:getAttemptChangedFiles', 'att-diff')).toEqual({
      files: [
        { path: 'notes.md', status: 'modified', additions: 1, deletions: 0 },
        { path: 'smoke.txt', status: 'added', additions: 1, deletions: 0 }
      ],
      truncated: false
    })
    expect(await transport.call('workflows:getAttemptFileDiff', 'att-diff', 'smoke.txt')).toEqual({
      original: '',
      modified: 'smoke\n'
    })
    expect(await transport.call('workflows:getAttemptFileDiff', 'att-diff', 'notes.md')).toEqual({
      original: 'one\n',
      modified: 'one\ntwo\n'
    })
  })

  it('returns the deleted side as empty text', async () => {
    const changed = await snapshottedAttempt('run-del', 'att-del', () => unlinkSync(join(repo, 'notes.md')))
    await persistRun('run-del', [changed])

    expect(await transport.call('workflows:getAttemptFileDiff', 'att-del', 'notes.md')).toEqual({
      original: 'one\n',
      modified: ''
    })
  })

  it('returns an error for an unknown or malformed attempt id', async () => {
    expect(await transport.call('workflows:getAttemptChangedFiles', 'att-unknown')).toEqual({ error: 'Unknown attempt' })
    expect(await transport.call('workflows:getAttemptChangedFiles', '../run-1')).toEqual({ error: 'Unknown attempt' })
    expect(await transport.call('workflows:getAttemptFileDiff', 42, 'smoke.txt')).toEqual({ error: 'Unknown attempt' })
  })

  it('returns no-snapshot for an attempt without a head snapshot', async () => {
    const { headSnapshot: _head, ...running } = await snapshottedAttempt('run-open', 'att-open', () => {})
    await persistRun('run-open', [{ ...running, status: 'running' }])

    expect(await transport.call('workflows:getAttemptChangedFiles', 'att-open')).toEqual({
      error: 'No snapshot for this attempt'
    })
  })

  it('returns snapshot missing once the snapshot ref is deleted', async () => {
    const changed = await snapshottedAttempt('run-gone', 'att-gone', () => writeFileSync(join(repo, 'smoke.txt'), 'x\n'))
    await persistRun('run-gone', [changed])
    fixtureGit(repo, ['update-ref', '-d', changed.headSnapshot?.ref ?? ''])

    expect(await transport.call('workflows:getAttemptChangedFiles', 'att-gone')).toEqual({ error: 'snapshot missing' })
    expect(await transport.call('workflows:getAttemptFileDiff', 'att-gone', 'smoke.txt')).toEqual({
      error: 'snapshot missing'
    })
  })

  it('refuses snapshot refs outside this attempt and commits that do not match the ref', async () => {
    const changed = await snapshottedAttempt('run-tamper', 'att-tamper', () => writeFileSync(join(repo, 'smoke.txt'), 'x\n'))
    const otherBase = changed.baseSnapshot?.commit ?? ''
    fixtureGit(repo, ['update-ref', 'refs/heads/elsewhere', otherBase])
    const foreignRef = { ...changed, attemptId: 'att-foreign', headSnapshot: { commit: otherBase, ref: 'refs/heads/elsewhere' } }
    const wrongCommit = {
      ...changed,
      attemptId: 'att-wrong',
      headSnapshot: { commit: otherBase, ref: changed.headSnapshot?.ref ?? '' }
    }
    await persistRun('run-tamper', [foreignRef, wrongCommit])

    expect(await transport.call('workflows:getAttemptChangedFiles', 'att-foreign')).toEqual({ error: 'snapshot missing' })
    expect(await transport.call('workflows:getAttemptChangedFiles', 'att-wrong')).toEqual({ error: 'snapshot missing' })
  })

  it('refuses a path outside the attempt’s changed files', async () => {
    const changed = await snapshottedAttempt('run-path', 'att-path', () => writeFileSync(join(repo, 'smoke.txt'), 'x\n'))
    await persistRun('run-path', [changed])
    const notChanged = { error: 'That file is not among this attempt’s changes' }

    expect(await transport.call('workflows:getAttemptFileDiff', 'att-path', 'notes.md')).toEqual(notChanged)
    expect(await transport.call('workflows:getAttemptFileDiff', 'att-path', '../../etc/passwd')).toEqual(notChanged)
    expect(await transport.call('workflows:getAttemptFileDiff', 'att-path', join(repo, 'smoke.txt'))).toEqual(notChanged)
    expect(await transport.call('workflows:getAttemptFileDiff', 'att-path', 'smoke.txt\0x')).toEqual({ error: 'invalid request' })
    expect(await transport.call('workflows:getAttemptFileDiff', 'att-path', { path: 'smoke.txt' })).toEqual({
      error: 'invalid request'
    })
  })

  it('refuses binary and oversized files', async () => {
    const changed = await snapshottedAttempt('run-big', 'att-big', () => {
      writeFileSync(join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 0]))
      writeFileSync(join(repo, 'huge.txt'), 'x\n'.repeat(600 * 1024))
    })
    await persistRun('run-big', [changed])

    const listed = await transport.call('workflows:getAttemptChangedFiles', 'att-big')
    expect(listed).toEqual({
      files: [
        { path: 'blob.bin', status: 'added', additions: null, deletions: null },
        { path: 'huge.txt', status: 'added', additions: 600 * 1024, deletions: 0 }
      ],
      truncated: false
    })
    expect(await transport.call('workflows:getAttemptFileDiff', 'att-big', 'blob.bin')).toEqual({
      error: 'Binary file; no text diff to show'
    })
    expect(await transport.call('workflows:getAttemptFileDiff', 'att-big', 'huge.txt')).toEqual({
      error: 'File too large to show'
    })
  })

  it('returns an error when the run’s worktree is gone', async () => {
    const changed = await snapshottedAttempt('run-wt', 'att-wt', () => writeFileSync(join(repo, 'smoke.txt'), 'x\n'))
    await persistRun('run-wt', [changed], join(dir, 'missing-worktree'))

    expect(await transport.call('workflows:getAttemptChangedFiles', 'att-wt')).toEqual({
      error: 'The worktree for this run is gone'
    })
  })
})

const RUN = 'run-1'
const STEP = 'plan'

describe('workflow action requests', () => {
  it.each<[string, unknown[], RunnerCall]>([
    [
      'workflows:startRun',
      [{ defId: 'personal:plan', worktreePath: '/wt/a', inputs: { task: 'ship' } }],
      ['start', { defId: 'personal:plan', worktreePath: '/wt/a', inputs: { task: 'ship' } }]
    ],
    ['workflows:cancelRun', [RUN], ['cancelRun', RUN]],
    ['workflows:cancelStep', [RUN, STEP], ['cancelStep', RUN, STEP]],
    ['workflows:retryStep', [RUN, STEP], ['retryStep', RUN, STEP]],
    ['workflows:retryFromClean', [RUN, STEP, { confirmed: true }], ['retryFromClean', RUN, STEP]],
    ['workflows:skipStep', [RUN, STEP], ['skipStep', RUN, STEP]],
    [
      'workflows:markDone',
      [RUN, STEP, { summary: 'by hand', fields: { verdict: 'pass' } }],
      ['markDone', RUN, STEP, { summary: 'by hand', fields: { verdict: 'pass' } }]
    ],
    ['workflows:resumeStep', [RUN, STEP], ['resumeStep', RUN, STEP]],
    ['workflows:approveGate', [RUN, STEP], ['approveGate', RUN, STEP]],
    ['workflows:resolveLoopCap', [RUN, STEP, 'again'], ['resolveLoopCap', RUN, STEP, 'again']],
    ['workflows:resolveLoopCap', [RUN, STEP, 'continue'], ['resolveLoopCap', RUN, STEP, 'continue']],
    ['workflows:keepWaiting', [RUN, STEP], ['keepWaiting', RUN, STEP]],
    ['workflows:setBudget', [RUN, 2.5], ['setBudget', RUN, 2.5]],
    ['workflows:retryPublish', [RUN], ['retryPublish', RUN]],
    ['workflows:setBudget', [RUN, 10000], ['setBudget', RUN, 10000]],
    ['workflows:setBudget', [RUN, 0.01], ['setBudget', RUN, 0.01]],
    [
      'workflows:requestChanges',
      [RUN, STEP, { feedback: 'tighten the plan', fresh: false }],
      ['requestChanges', RUN, STEP, { feedback: 'tighten the plan', fresh: false }]
    ],
    [
      'workflows:requestChanges',
      [RUN, STEP, { feedback: 'é'.repeat(GATE_FEEDBACK_MAX_CHARS), fresh: true }],
      ['requestChanges', RUN, STEP, { feedback: 'é'.repeat(GATE_FEEDBACK_MAX_CHARS), fresh: true }]
    ],
    [
      'workflows:swapStep',
      [RUN, STEP, { agent: 'codex', model: 'gpt-5', allowFull: true }],
      ['swapStep', RUN, STEP, { agent: 'codex', model: 'gpt-5', allowFull: true }]
    ],
    [
      'workflows:startRun',
      [{ defId: 'personal:plan', worktreePath: '/wt/a', inputs: {}, overrides: { plan: { agent: 'codex', model: 'm' } } }],
      ['start', { defId: 'personal:plan', worktreePath: '/wt/a', inputs: {}, overrides: { plan: { agent: 'codex', model: 'm' } } }]
    ]
  ])('%s parses a valid payload and calls the runner', async (name, args, expected) => {
    const response = await transport.call(name, ...args)
    expect(response).toEqual(name === 'workflows:startRun' ? { runId: 'run-new' } : { ok: true })
    expect(runner.calls).toEqual([expected])
  })

  it('defaults startRun inputs and markDone fields to empty objects', async () => {
    await transport.call('workflows:startRun', { defId: 'personal:plan', worktreePath: '/wt/a' })
    await transport.call('workflows:markDone', RUN, STEP, { summary: 's' })
    expect(runner.calls).toEqual([
      ['start', { defId: 'personal:plan', worktreePath: '/wt/a', inputs: {} }],
      ['markDone', RUN, STEP, { summary: 's', fields: {} }]
    ])
  })

  it('passes allowFull to the runner only when it is exactly true', async () => {
    const base = { defId: 'personal:plan', worktreePath: '/wt/a', inputs: {} }
    await transport.call('workflows:startRun', { ...base, allowFull: true })
    await transport.call('workflows:startRun', { ...base, allowFull: false })
    expect(runner.calls).toEqual([
      ['start', { ...base, allowFull: true }],
      ['start', base]
    ])
  })

  it('passes autopilot to the runner only when it is exactly true', async () => {
    const base = { defId: 'personal:plan', worktreePath: '/wt/a', inputs: {} }
    await transport.call('workflows:startRun', { ...base, autopilot: true })
    await transport.call('workflows:startRun', { ...base, autopilot: false })
    expect(runner.calls).toEqual([
      ['start', { ...base, autopilot: true }],
      ['start', base]
    ])
  })

  it('passes a budget to the runner only when the payload has one', async () => {
    const base = { defId: 'personal:plan', worktreePath: '/wt/a', inputs: {} }
    await transport.call('workflows:startRun', { ...base, budgetUsd: 0.5 })
    await transport.call('workflows:startRun', { ...base, budgetUsd: 10000 })
    await transport.call('workflows:startRun', base)
    expect(runner.calls).toEqual([
      ['start', { ...base, budgetUsd: 0.5 }],
      ['start', { ...base, budgetUsd: 10000 }],
      ['start', base]
    ])
  })

  const badBudgets: unknown[] = [
    '1',
    '0.5',
    true,
    null,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0,
    -0,
    -1,
    10000.01,
    1e9,
    [1],
    { usd: 1 }
  ]

  it.each(badBudgets)('rejects a startRun budget of %s', async (budgetUsd) => {
    const payload = { defId: 'personal:plan', worktreePath: '/wt/a', budgetUsd }
    expect(await transport.call('workflows:startRun', payload)).toEqual({ error: 'invalid request' })
    expect(runner.calls).toEqual([])
  })

  it.each([...badBudgets, undefined])('rejects a setBudget amount of %s', async (budgetUsd) => {
    expect(await transport.call('workflows:setBudget', RUN, budgetUsd)).toEqual({ error: 'invalid request' })
    expect(runner.calls).toEqual([])
  })

  it('maps setBudget refusals to fixed messages', async () => {
    runner.actionResult = { ok: false, reason: 'unknown-run' }
    expect(await transport.call('workflows:setBudget', RUN, 1)).toEqual({ error: 'Unknown or finished run' })
    runner.actionResult = { ok: false, reason: 'labs-off' }
    expect(await transport.call('workflows:setBudget', RUN, 1)).toEqual({ error: 'Workflows are turned off in Labs' })
  })

  const badIds: unknown[] = [undefined, null, 42, '', '../run', 'a/b', 'x'.repeat(129), { runId: RUN }, [RUN]]
  const badStartPayloads: unknown[] = [
    undefined,
    null,
    'personal:plan',
    [],
    { defId: 'personal:plan' },
    { defId: 7, worktreePath: '/wt/a' },
    { defId: '', worktreePath: '/wt/a' },
    { defId: 'x'.repeat(257), worktreePath: '/wt/a' },
    { defId: 'personal:plan', worktreePath: '/wt/a', inputs: [] },
    { defId: 'personal:plan', worktreePath: '/wt/a', inputs: { task: 1 } },
    { defId: 'personal:plan', worktreePath: '/wt/a', inputs: null },
    Object.create({ defId: 'personal:plan', worktreePath: '/wt/a' }),
    { defId: 'personal:plan', worktreePath: '/wt/a', allowFull: 'true' },
    { defId: 'personal:plan', worktreePath: '/wt/a', allowFull: 1 },
    { defId: 'personal:plan', worktreePath: '/wt/a', allowFull: null },
    { defId: 'personal:plan', worktreePath: '/wt/a', autopilot: 'true' },
    { defId: 'personal:plan', worktreePath: '/wt/a', autopilot: 1 },
    { defId: 'personal:plan', worktreePath: '/wt/a', autopilot: null },
    { defId: 'personal:plan', worktreePath: '/wt/a', inputsUntrusted: false },
    { defId: 'personal:plan', worktreePath: '/wt/a', trusted: true },
    {
      defId: 'personal:plan',
      worktreePath: '/wt/a',
      chain: { chainId: 'c', item: { id: 'i', title: 't', value: 'v', branch: 'b', baseBranch: 'main' } }
    },
    { defId: 'personal:plan', worktreePath: '/wt/a', chain: undefined },
    { defId: 'personal:plan', worktreePath: '/wt/a', definition: { steps: [] } },
    new Map([['defId', 'personal:plan']])
  ]
  const badMarkDone: unknown[] = [
    undefined,
    'done',
    [],
    { fields: {} },
    { summary: 1 },
    { summary: 's', fields: [] },
    { summary: 's', fields: 'x' },
    { summary: 's', fields: null },
    Object.create({ summary: 's' })
  ]

  const badOverrides: unknown[] = [
    null,
    [],
    'codex',
    { plan: null },
    { plan: {} },
    { plan: 'codex' },
    { plan: { agent: 7 } },
    { plan: { agent: '' } },
    { plan: { agent: 'x'.repeat(33) } },
    { plan: { model: '' } },
    { plan: { model: '   ' } },
    { plan: { model: 'm'.repeat(201) } },
    { plan: { model: 'a\nb' } },
    { plan: { agent: 'codex', permissions: 'full' } },
    { plan: { agent: 'codex', allow: ['Bash(*)'] } },
    { '../plan': { agent: 'codex' } },
    Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`s${i}`, { agent: 'codex' }])),
    Object.create({ plan: { agent: 'codex' } })
  ]

  it.each(badOverrides)('rejects startRun overrides %#', async (overrides) => {
    const payload = { defId: 'personal:plan', worktreePath: '/wt/a', inputs: {}, overrides }
    expect(await transport.call('workflows:startRun', payload)).toEqual({ error: 'invalid request' })
    expect(runner.calls).toEqual([])
  })

  const badSwapPayloads: unknown[] = [
    undefined,
    null,
    'codex',
    [],
    {},
    { allowFull: true },
    { agent: 7 },
    { agent: '' },
    { model: '' },
    { model: 'm'.repeat(201) },
    { model: 'a\u0007b' },
    { agent: 'codex', allowFull: 'true' },
    { agent: 'codex', permissions: 'full' },
    { agent: 'codex', allow: [] },
    Object.create({ agent: 'codex' })
  ]

  it.each(badSwapPayloads)('rejects swapStep payload %#', async (payload) => {
    expect(await transport.call('workflows:swapStep', RUN, STEP, payload)).toEqual({ error: 'invalid request' })
    expect(runner.calls).toEqual([])
  })

  it.each(badIds)('rejects swapStep ids %#', async (id) => {
    expect(await transport.call('workflows:swapStep', id, STEP, { agent: 'codex' })).toEqual({ error: 'invalid request' })
    expect(await transport.call('workflows:swapStep', RUN, id, { agent: 'codex' })).toEqual({ error: 'invalid request' })
    expect(runner.calls).toEqual([])
  })

  it('maps swapStep refusals to their messages', async () => {
    runner.actionResult = { ok: false, reason: 'codex-hooks-untrusted' }
    expect(await transport.call('workflows:swapStep', RUN, STEP, { agent: 'codex' })).toEqual({
      error: 'Open a Codex tab and run /hooks'
    })
    runner.actionResult = { ok: false, reason: 'full-permission-unconfirmed' }
    expect(await transport.call('workflows:swapStep', RUN, STEP, { model: 'm' })).toEqual({
      error: 'This step has full access; confirm full access for the new agent'
    })
  })

  it.each(badStartPayloads)('rejects startRun payload %#', async (payload) => {
    expect(await transport.call('workflows:startRun', payload)).toEqual({ error: 'invalid request' })
    expect(runner.calls).toEqual([])
  })

  it.each(badIds)('rejects run id %#', async (runId) => {
    for (const name of ['workflows:cancelRun', 'workflows:retryStep', 'workflows:markDone']) {
      expect(await transport.call(name, runId, STEP, { summary: 's' })).toEqual({ error: 'invalid request' })
    }
    expect(runner.calls).toEqual([])
  })

  it.each(badIds)('rejects step id %#', async (stepId) => {
    for (const name of [
      'workflows:cancelStep',
      'workflows:retryStep',
      'workflows:skipStep',
      'workflows:resumeStep',
      'workflows:markDone'
    ]) {
      expect(await transport.call(name, RUN, stepId, { summary: 's' })).toEqual({ error: 'invalid request' })
    }
    expect(await transport.call('workflows:retryFromClean', RUN, stepId, { confirmed: true })).toEqual({
      error: 'invalid request'
    })
    expect(runner.calls).toEqual([])
  })

  const badRequestChanges: unknown[] = [
    undefined,
    null,
    'fix it',
    [],
    {},
    { feedback: 'fix it' },
    { fresh: false },
    { feedback: 'fix it', fresh: 'false' },
    { feedback: 'fix it', fresh: 0 },
    { feedback: 'fix it', fresh: null },
    { feedback: 7, fresh: false },
    { feedback: '', fresh: false },
    { feedback: '  \n\t ', fresh: false },
    { feedback: '\x1b\x07\x9b', fresh: false },
    { feedback: 'x'.repeat(GATE_FEEDBACK_MAX_CHARS + 1), fresh: false },
    { feedback: 'fix it', fresh: false, prompt: 'other' },
    { feedback: 'fix it', fresh: false, allowFull: true },
    Object.create({ feedback: 'fix it', fresh: false }),
    new Map([['feedback', 'fix it']])
  ]

  it.each(badRequestChanges)('rejects requestChanges payload %#', async (payload) => {
    expect(await transport.call('workflows:requestChanges', RUN, STEP, payload)).toEqual({ error: 'invalid request' })
    expect(runner.calls).toEqual([])
  })

  it.each(badIds)('rejects gate request ids %#', async (id) => {
    const changes = { feedback: 'fix it', fresh: false }
    expect(await transport.call('workflows:approveGate', id, STEP)).toEqual({ error: 'invalid request' })
    expect(await transport.call('workflows:approveGate', RUN, id)).toEqual({ error: 'invalid request' })
    expect(await transport.call('workflows:requestChanges', id, STEP, changes)).toEqual({ error: 'invalid request' })
    expect(await transport.call('workflows:requestChanges', RUN, id, changes)).toEqual({ error: 'invalid request' })
    expect(runner.calls).toEqual([])
  })

  it.each<unknown>(['', 'Again', 'continue ', 'raise', true, 1, null, undefined, ['again'], { action: 'again' }])(
    'rejects resolveLoopCap action %#',
    async (action) => {
      expect(await transport.call('workflows:resolveLoopCap', RUN, STEP, action)).toEqual({ error: 'invalid request' })
      expect(runner.calls).toEqual([])
    }
  )

  it.each(badIds)('rejects resolveLoopCap ids %#', async (id) => {
    expect(await transport.call('workflows:resolveLoopCap', id, STEP, 'continue')).toEqual({ error: 'invalid request' })
    expect(await transport.call('workflows:resolveLoopCap', RUN, id, 'continue')).toEqual({ error: 'invalid request' })
    expect(runner.calls).toEqual([])
  })

  it.each(badIds)('rejects retryPublish run ids %#', async (id) => {
    expect(await transport.call('workflows:retryPublish', id)).toEqual({ error: 'invalid request' })
    expect(runner.calls).toEqual([])
  })

  it('maps retryPublish refusals to fixed messages', async () => {
    runner.actionResult = { ok: false, reason: 'unknown-run' }
    expect(await transport.call('workflows:retryPublish', RUN)).toEqual({ error: 'Unknown or finished run' })
    runner.actionResult = { ok: false, reason: 'not-paused' }
    expect(await transport.call('workflows:retryPublish', RUN)).toEqual({ error: 'The run is not paused' })
    runner.actionResult = { ok: false, reason: 'busy' }
    expect(await transport.call('workflows:retryPublish', RUN)).toEqual({
      error: 'Another action is still running for this run'
    })
  })

  it('refuses retryPublish while Labs workflows are off without calling the runner', async () => {
    store.dispatch({ type: 'settings/labsChanged', payload: { workflows: false } })
    expect(await transport.call('workflows:retryPublish', RUN)).toEqual({ error: 'Workflows are turned off in Labs' })
    expect(runner.calls).toEqual([])
  })

  it.each(badIds)('rejects setBudget run ids %#', async (id) => {
    expect(await transport.call('workflows:setBudget', id, 1)).toEqual({ error: 'invalid request' })
    expect(runner.calls).toEqual([])
  })

  it.each(badIds)('rejects keepWaiting ids %#', async (id) => {
    expect(await transport.call('workflows:keepWaiting', id, STEP)).toEqual({ error: 'invalid request' })
    expect(await transport.call('workflows:keepWaiting', RUN, id)).toEqual({ error: 'invalid request' })
    expect(runner.calls).toEqual([])
  })

  it('maps keep-waiting refusals to fixed messages', async () => {
    runner.actionResult = { ok: false, reason: 'not-timed-out' }
    expect(await transport.call('workflows:keepWaiting', RUN, STEP)).toEqual({ error: 'This step has not timed out' })
    runner.actionResult = { ok: false, reason: 'labs-off' }
    expect(await transport.call('workflows:keepWaiting', RUN, STEP)).toEqual({ error: 'Workflows are turned off in Labs' })
  })

  it('maps loop-cap refusals to fixed messages', async () => {
    runner.actionResult = { ok: false, reason: 'not-at-loop-cap' }
    expect(await transport.call('workflows:resolveLoopCap', RUN, STEP, 'again')).toEqual({
      error: 'This step is not waiting at its loop cap'
    })
    runner.actionResult = { ok: false, reason: 'labs-off' }
    expect(await transport.call('workflows:resolveLoopCap', RUN, STEP, 'continue')).toEqual({
      error: 'Workflows are turned off in Labs'
    })
  })

  it('maps gate refusals to fixed messages', async () => {
    const changes = { feedback: 'fix it', fresh: false }
    runner.actionResult = { ok: false, reason: 'not-awaiting-gate' }
    expect(await transport.call('workflows:approveGate', RUN, STEP)).toEqual({ error: 'This step is not waiting at its gate' })
    expect(await transport.call('workflows:requestChanges', RUN, STEP, changes)).toEqual({
      error: 'This step is not waiting at its gate'
    })
    runner.actionResult = { ok: false, reason: 'not-continuable-step' }
    expect(await transport.call('workflows:requestChanges', RUN, STEP, changes)).toEqual({
      error: 'Only agent steps can continue their session'
    })
    runner.actionResult = { ok: false, reason: 'labs-off' }
    expect(await transport.call('workflows:approveGate', RUN, STEP)).toEqual({ error: 'Workflows are turned off in Labs' })
  })

  it.each(badMarkDone)('rejects markDone payload %#', async (payload) => {
    expect(await transport.call('workflows:markDone', RUN, STEP, payload)).toEqual({ error: 'invalid request' })
    expect(runner.calls).toEqual([])
  })

  it.each<unknown>([undefined, {}, { confirmed: 'true' }, { confirmed: 1 }, { confirmed: false }, true, [true]])(
    'refuses retryFromClean without confirmed: true (%#)',
    async (confirmation) => {
      expect(await transport.call('workflows:retryFromClean', RUN, STEP, confirmation)).toEqual({
        error: 'Retry from clean needs explicit confirmation'
      })
      expect(runner.calls).toEqual([])
    }
  )

  it('maps refusals to fixed messages and lists declared output errors', async () => {
    runner.startResult = { ok: false, reason: 'starting' }
    expect(await transport.call('workflows:startRun', { defId: 'personal:plan', worktreePath: '/wt/a' })).toEqual({
      error: 'Tatsu is still starting; try again'
    })
    runner.startResult = { ok: false, reason: 'parallel-writer' }
    expect(await transport.call('workflows:startRun', { defId: 'personal:plan', worktreePath: '/wt/a' })).toEqual({
      error: 'Steps that can run at the same time must not write; make them read-only or order them with "needs"'
    })
    runner.actionResult = { ok: false, reason: 'no-session' }
    expect(await transport.call('workflows:resumeStep', RUN, STEP)).toEqual({
      error: 'The attempt has no stored session to resume; use Retry instead'
    })
    runner.actionResult = { ok: false, reason: 'awaiting-approval' }
    expect(await transport.call('workflows:retryStep', RUN, STEP)).toEqual({
      error: 'The agent is waiting for approval in its tab; approve it or cancel the step first'
    })
    runner.actionResult = {
      ok: false,
      reason: 'invalid-output',
      errors: [
        { field: 'verdict', message: 'Required' },
        { field: '', message: 'Fields must be declared step outputs' }
      ]
    }
    expect(await transport.call('workflows:markDone', RUN, STEP, { summary: 's', fields: {} })).toEqual({
      error: 'Invalid step output: verdict: Required; Fields must be declared step outputs'
    })
  })

  it('returns an internal error instead of throwing and logs only the error class', async () => {
    runner.throwOn = 'retryFromClean'
    expect(await transport.call('workflows:retryFromClean', RUN, STEP, { confirmed: true })).toEqual({
      error: 'internal error'
    })
    runner.throwOn = 'start'
    expect(await transport.call('workflows:startRun', { defId: 'personal:plan', worktreePath: '/wt/a' })).toEqual({
      error: 'internal error'
    })
    expect(logs).toEqual([
      '[workflow] request failed workflows:retryFromClean {"error":"Error"}',
      '[workflow] request failed workflows:startRun {"error":"Error"}'
    ])
  })
})

describe('workflows:checkInputTrust', () => {
  it('returns only the server verdict for a known repo root or worktree', async () => {
    expect(await transport.call('workflows:checkInputTrust', '/repo', 'issue', '7')).toEqual({ trusted: false })
    inputTrust.mockResolvedValueOnce('trusted')
    expect(await transport.call('workflows:checkInputTrust', '/wt/a', 'pr', '12')).toEqual({ trusted: true })
    expect(inputTrust.mock.calls).toEqual([
      ['/repo', 'issue', '7'],
      ['/wt/a', 'pr', '12']
    ])
    expect(logs).toContain('[workflow] input trust checked untrusted {"type":"issue","number":"7"}')
  })

  it('refuses a path that is not a known repo root or worktree without looking anything up', async () => {
    expect(await transport.call('workflows:checkInputTrust', '/elsewhere', 'issue', '7')).toEqual({
      error: 'Unknown repository'
    })
    expect(await transport.call('workflows:checkInputTrust', '/repo/', 'issue', '7')).toEqual({
      error: 'Unknown repository'
    })
    expect(inputTrust).not.toHaveBeenCalled()
  })

  it.each<unknown[]>([
    [7, 'issue', '7'],
    ['', 'issue', '7'],
    ['/repo', 'file', '7'],
    ['/repo', 'ISSUE', '7'],
    ['/repo', 'issue', 7],
    ['/repo', 'issue', '0'],
    ['/repo', 'issue', '7/../../user'],
    ['/repo', 'issue', '12345678901'],
    ['/repo', 'issue']
  ])('rejects malformed arguments %#', async (...args) => {
    expect(await transport.call('workflows:checkInputTrust', ...args)).toEqual({ error: 'invalid request' })
    expect(inputTrust).not.toHaveBeenCalled()
  })

  it('refuses while Labs workflows are off', async () => {
    store.dispatch({ type: 'settings/labsChanged', payload: { workflows: false } })
    expect(await transport.call('workflows:checkInputTrust', '/repo', 'issue', '7')).toEqual({
      error: 'Workflows are turned off in Labs'
    })
    expect(inputTrust).not.toHaveBeenCalled()
  })
})

describe('workflows:startRun against the runner', () => {
  const idleDriver = (): StepDriver => ({
    start: (attempt) => ({ executionId: `exec-${attempt.attemptId}` }),
    continue: () => {},
    cancel: () => {},
    onEvent: () => () => {}
  })
  function realRunner(
    options: {
      labs?: boolean
      consent?: 'accepted' | 'pending'
      yaml?: string
      codexTrust?: CodexHookTrustSummary
      loader?: Pick<WorkflowDefsLoader, 'getDefinition'>
      inputTrust?: InputTrustFetcher
      persisted?: WorkflowRunRecord[]
    } = {}
  ) {
    const store = new Store({
      ...initialState,
      hooks: { ...initialState.hooks, consent: options.consent ?? 'accepted', codexTrust: options.codexTrust ?? null },
      worktrees: {
        ...initialState.worktrees,
        list: [{ path: '/wt/a', branch: 'main', head: 'abc', isBare: false, isMain: false, createdAt: 0, repoRoot: '/wt/a' }]
      },
      settings: {
        ...initialState.settings,
        labs: { ...initialState.settings.labs, workflows: options.labs ?? true }
      }
    })
    const yaml = options.yaml ?? VALID_YAML
    const detail = { ...validateWorkflowDefinition(yaml), source: yaml }
    const live = new WorkflowRunner({
      store,
      loader: options.loader ?? {
        getDefinition: (id) =>
          id === 'personal:plan'
            ? {
                ...detail,
                summary: {
                  id: 'personal:plan',
                  name: 'plan',
                  scope: 'personal',
                  path: '/defs/plan.yaml',
                  hash: 'h',
                  stepIds: ['plan'],
                  issues: []
                }
              }
            : null
      },
      drivers: { agent: idleDriver(), shell: idleDriver() },
      now: () => 1,
      newId: (() => {
        let n = 0
        return () => `id-${++n}`
      })(),
      log: () => {},
      persist: (run) => options.persisted?.push(structuredClone(run)),
      ...(options.inputTrust === undefined ? {} : { inputTrust: options.inputTrust })
    })
    live.reconcile([])
    const own = new FakeTransport()
    registerWorkflowsRequestHandlers({
      transport: own,
      loader: createWorkflowDefsLoader({ dir, dispatch: () => {}, log: () => {}, watch: noWatch }),
      runs: createWorkflowRunLookup({
        live: () => null,
        liveAttemptRunId: () => undefined,
        records,
        attemptRunId: () => undefined
      }),
      runner: live,
      store,
      persistTrust: () => {},
      inputTrust: options.inputTrust ?? (async () => 'untrusted'),
      log: () => {}
    })
    return Object.assign(own, { runner: live, store })
  }
  const payload = { defId: 'personal:plan', worktreePath: '/wt/a', inputs: {} }

  it('approves a gated step and requests changes on it through the real runner', async () => {
    const yaml = `${VALID_YAML}    gate: approve\n  - id: check\n    kind: shell\n    run: "true"\n`
    const own = realRunner({ yaml })
    const { runId } = (await own.call('workflows:startRun', payload)) as { runId: string }
    await new Promise((resolve) => setTimeout(resolve, 0))
    const changes = { feedback: 'add tests', fresh: false }
    expect(await own.call('workflows:approveGate', runId, 'plan')).toEqual({ error: 'This step is not waiting at its gate' })
    const steps = () => own.store.getSnapshot().state.workflows.runs[runId].steps
    own.runner.complete(steps().plan.attemptIds[0], { status: 'done', summary: 'p', completedBy: 'tool' })
    expect(steps().plan.status).toBe('awaiting-gate')

    expect(await own.call('workflows:requestChanges', runId, 'plan', changes)).toEqual({ ok: true })
    expect(steps().plan.status).toBe('running')
    own.runner.complete(steps().plan.attemptIds[1], { status: 'done', summary: 'p2', completedBy: 'tool' })
    expect(steps().plan.status).toBe('awaiting-gate')
    expect(await own.call('workflows:approveGate', runId, 'plan')).toEqual({ ok: true })
    expect(steps().plan.status).toBe('done')
    expect(steps().check.status).toBe('running')
    expect(await own.call('workflows:approveGate', runId, 'plan')).toEqual({ error: 'This step is not waiting at its gate' })
    expect(await own.call('workflows:requestChanges', runId, 'check', changes)).toEqual({
      error: 'This step is not waiting at its gate'
    })
  })

  it('resolves a loop cap through the real runner: refused before the cap, then continue starts the dependents', async () => {
    const yaml = `${VALID_YAML}  - id: review
    agent: claude
    permissions: read-only
    prompt: Review it
    output:
      verdict: { enum: [pass, fail] }
    loop: { back_to: plan, until: { field: verdict, equals: pass }, max: 1 }
  - id: check
    kind: shell
    run: "true"
`
    const own = realRunner({ yaml })
    const { runId } = (await own.call('workflows:startRun', payload)) as { runId: string }
    await new Promise((resolve) => setTimeout(resolve, 0))
    const notAtCap = { error: 'This step is not waiting at its loop cap' }
    expect(await own.call('workflows:resolveLoopCap', runId, 'review', 'continue')).toEqual(notAtCap)
    const steps = () => own.store.getSnapshot().state.workflows.runs[runId].steps
    own.runner.complete(steps().plan.attemptIds[0], { status: 'done', summary: 'p', completedBy: 'tool' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    own.runner.complete(steps().review.attemptIds[0], {
      status: 'done',
      summary: 'r',
      completedBy: 'tool',
      data: { verdict: 'fail' }
    })
    expect(own.store.getSnapshot().state.workflows.runs[runId].pausedReason).toBe('loop-cap')
    expect(await own.call('workflows:resolveLoopCap', runId, 'plan', 'continue')).toEqual(notAtCap)
    expect(await own.call('workflows:resolveLoopCap', runId, 'review', 'continue')).toEqual({ ok: true })
    expect(steps().check.status).toBe('running')
    expect(await own.call('workflows:resolveLoopCap', runId, 'review', 'again')).toEqual(notAtCap)
  })

  it('ignores no client trust claim: the server lookup caps an untrusted issue run', async () => {
    const lookup = vi.fn<InputTrustFetcher>(async () => 'untrusted')
    const persisted: WorkflowRunRecord[] = []
    const own = realRunner({ yaml: ISSUE_FULL_YAML, inputTrust: lookup, persisted })
    const issuePayload = { ...payload, inputs: { ticket: '7' } }
    expect(await own.call('workflows:startRun', { ...issuePayload, inputsUntrusted: false })).toEqual({
      error: 'invalid request'
    })
    expect(await own.call('workflows:startRun', { ...issuePayload, trusted: true, allowFull: true })).toEqual({
      error: 'invalid request'
    })
    expect(lookup).not.toHaveBeenCalled()
    expect(await own.call('workflows:startRun', issuePayload)).toEqual({ runId: 'id-1' })
    expect(lookup).toHaveBeenCalledWith('/wt/a', 'issue', '7')
    const record = persisted.at(-1)
    expect(record?.inputsUntrusted).toBe(true)
    expect(record?.definition.steps[0]).toMatchObject({ permissions: 'edit' })
  })

  it('turns autopilot off server-side for an untrusted issue run, with no client override', async () => {
    const persisted: WorkflowRunRecord[] = []
    const own = realRunner({ yaml: ISSUE_FULL_YAML, inputTrust: async () => 'untrusted', persisted })
    const issuePayload = { ...payload, inputs: { ticket: '7' }, autopilot: true }
    expect(await own.call('workflows:startRun', { ...issuePayload, autopilotOverride: true })).toEqual({
      error: 'invalid request'
    })
    expect(await own.call('workflows:startRun', issuePayload)).toEqual({ runId: 'id-1' })
    expect(persisted.at(-1)?.inputsUntrusted).toBe(true)
    expect(persisted.at(-1)?.autopilot).toBeUndefined()
  })

  it('still needs allowFull for a full step on autopilot', async () => {
    const persisted: WorkflowRunRecord[] = []
    const own = realRunner({ yaml: ISSUE_FULL_YAML, inputTrust: async () => 'trusted', persisted })
    const issuePayload = { ...payload, inputs: { ticket: '7' }, autopilot: true }
    expect(await own.call('workflows:startRun', issuePayload)).toEqual({
      error: 'This workflow has a full-access step; confirm full access to start it'
    })
    expect(await own.call('workflows:startRun', { ...issuePayload, allowFull: true })).toEqual({ runId: 'id-1' })
    expect(persisted.at(-1)?.autopilot).toBe(true)
  })

  it('still asks for full access when the server lookup trusts the issue author', async () => {
    const own = realRunner({ yaml: ISSUE_FULL_YAML, inputTrust: async () => 'trusted' })
    const issuePayload = { ...payload, inputs: { ticket: '7' } }
    expect(await own.call('workflows:startRun', issuePayload)).toEqual({
      error: 'This workflow has a full-access step; confirm full access to start it'
    })
    expect(await own.call('workflows:startRun', { ...issuePayload, allowFull: true })).toEqual({ runId: 'id-1' })
  })

  it('returns the labs-off error', async () => {
    expect(await realRunner({ labs: false }).call('workflows:startRun', payload)).toEqual({
      error: 'Workflows are turned off in Labs'
    })
  })

  it('refuses a repo definition as untrusted before any run starts', async () => {
    const repo = join(dir, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, '.harness', 'workflows'), { recursive: true })
    writeFileSync(join(repo, '.harness', 'workflows', 'shared.yaml'), VALID_YAML)
    const repoLoader = createWorkflowDefsLoader({
      dir: join(dir, 'personal'),
      dispatch: () => {},
      log: () => {},
      watch: noWatch,
      repoRoots: [repo]
    })
    repoLoader.reload()
    const defId = `repo:${repoKeyOf(repo)}:shared`
    expect(repoLoader.getDefinition(defId)?.summary.scope).toBe('repo')

    const own = realRunner({ loader: repoLoader })
    expect(await own.call('workflows:startRun', { ...payload, defId })).toEqual({
      error: 'Trust this definition before running it'
    })
    expect(await own.call('workflows:startRun', payload)).toEqual({ error: 'Unknown workflow definition' })
  })

  it('returns the hooks consent error while consent is pending', async () => {
    expect(await realRunner({ consent: 'pending' }).call('workflows:startRun', payload)).toEqual({
      error: 'Accept the hooks install before running agent steps'
    })
  })

  it('returns the Codex hooks error until Codex trusts the hooks, then starts', async () => {
    const message = { error: 'Open a Codex tab and run /hooks' }
    expect(await realRunner({ yaml: CODEX_YAML }).call('workflows:startRun', payload)).toEqual(message)
    const review: CodexHookTrustSummary = { state: 'needs-review', reviewEvents: ['Stop'] }
    expect(await realRunner({ yaml: CODEX_YAML, codexTrust: review }).call('workflows:startRun', payload)).toEqual(message)
    const ok: CodexHookTrustSummary = { state: 'ok', reviewEvents: [] }
    expect(await realRunner({ yaml: CODEX_YAML, codexTrust: ok }).call('workflows:startRun', payload)).toEqual({
      runId: 'id-1'
    })
  })

  it('checks Codex hooks trust on an override and refuses unknown override steps and agents', async () => {
    const codex = { ...payload, overrides: { plan: { agent: 'codex', model: 'gpt-test' } } }
    expect(await realRunner().call('workflows:startRun', codex)).toEqual({ error: 'Open a Codex tab and run /hooks' })
    expect(await realRunner().call('workflows:startRun', { ...payload, overrides: { ship: { agent: 'codex' } } })).toEqual({
      error: 'A step override names a step that is not an agent step, or has an invalid model'
    })
    expect(await realRunner().call('workflows:startRun', { ...payload, overrides: { plan: { agent: 'pi' } } })).toEqual({
      error: 'A step override names an agent that cannot run workflow steps'
    })
    const ok: CodexHookTrustSummary = { state: 'ok', reviewEvents: [] }
    expect(await realRunner({ codexTrust: ok }).call('workflows:startRun', codex)).toEqual({ runId: 'id-1' })
  })

  it('returns the busy worktree error for a second run', async () => {
    const own = realRunner()
    expect(await own.call('workflows:startRun', payload)).toEqual({ runId: 'id-1' })
    expect(await own.call('workflows:startRun', payload)).toEqual({
      error: 'A workflow is already running in this worktree'
    })
  })

  it('refuses a full-access step without allowFull and starts it with allowFull true', async () => {
    const own = realRunner({ yaml: FULL_YAML })
    expect(await own.call('workflows:startRun', payload)).toEqual({
      error: 'This workflow has a full-access step; confirm full access to start it'
    })
    expect(await own.call('workflows:startRun', { ...payload, allowFull: false })).toEqual({
      error: 'This workflow has a full-access step; confirm full access to start it'
    })
    expect(await own.call('workflows:startRun', { ...payload, allowFull: 'true' })).toEqual({ error: 'invalid request' })
    expect(await own.call('workflows:startRun', { ...payload, allowFull: true })).toEqual({ runId: 'id-1' })
  })

  it('returns the unknown worktree and missing input errors without echoing the input', async () => {
    const own = realRunner()
    const response = await own.call('workflows:startRun', { ...payload, worktreePath: '/secret/elsewhere' })
    expect(response).toEqual({ error: 'Unknown worktree' })
    expect(await own.call('workflows:startRun', { ...payload, inputs: { nope: 'secret-value' } })).toEqual({
      error: 'The workflow inputs are invalid'
    })
  })
})

describe('workflows:trustDefinition', () => {
  function sha256(text: string): string {
    return createHash('sha256').update(text).digest('hex')
  }

  function trustHarness(options: { labs?: boolean } = {}) {
    const repo = join(dir, 'trust-repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, '.harness', 'workflows'), { recursive: true })
    const file = join(repo, '.harness', 'workflows', 'shared.yaml')
    writeFileSync(file, VALID_YAML)
    const personal = join(dir, 'trust-personal')
    mkdirSync(personal, { recursive: true })
    writeFileSync(join(personal, 'mine.yaml'), VALID_YAML)
    const repoLoader = createWorkflowDefsLoader({
      dir: personal,
      dispatch: () => {},
      log: () => {},
      watch: noWatch,
      repoRoots: [repo]
    })
    repoLoader.reload()
    const store = new Store({
      ...initialState,
      settings: {
        ...initialState.settings,
        labs: { ...initialState.settings.labs, workflows: options.labs ?? true }
      }
    })
    const persisted: PersistedWorkflowTrust[] = []
    const order: string[] = []
    store.subscribe((event) => order.push(event.type))
    const own = new FakeTransport()
    registerWorkflowsRequestHandlers({
      transport: own,
      loader: repoLoader,
      runs: createWorkflowRunLookup({
        live: () => null,
        liveAttemptRunId: () => undefined,
        records,
        attemptRunId: () => undefined
      }),
      runner,
      store,
      persistTrust: (entry) => {
        order.push('persist')
        persisted.push(entry)
      },
      inputTrust: async () => 'untrusted',
      log: () => {}
    })
    const defId = `repo:${repoKeyOf(repo)}:shared`
    return { own, store, persisted, order, repo, file, defId }
  }

  it('persists the entry, then dispatches trustGranted for the current hash', async () => {
    const h = trustHarness()
    const hash = sha256(VALID_YAML)

    expect(await h.own.call('workflows:trustDefinition', h.defId, hash)).toEqual({ ok: true })

    expect(h.persisted).toEqual([{ repoRoot: h.repo, path: realpathSync(h.file), hash }])
    expect(h.order).toEqual(['persist', 'workflows/trustGranted'])
    expect(h.store.getSnapshot().state.workflows.trust).toEqual({ [h.defId]: hash })
  })

  it('refuses a stale hash after the file changed and records nothing', async () => {
    const h = trustHarness()
    const seen = sha256(VALID_YAML)
    writeFileSync(h.file, FULL_YAML)

    expect(await h.own.call('workflows:trustDefinition', h.defId, seen)).toEqual({
      error: 'The workflow definition changed on disk; review it again before trusting it'
    })
    expect(h.persisted).toEqual([])
    expect(h.store.getSnapshot().state.workflows.trust).toEqual({})
  })

  it('refuses personal and unknown definitions, malformed arguments and Labs off', async () => {
    const h = trustHarness()
    const hash = sha256(VALID_YAML)
    expect(await h.own.call('workflows:trustDefinition', 'personal:mine', hash)).toEqual({
      error: 'Only repo workflow definitions need trust'
    })
    expect(await h.own.call('workflows:trustDefinition', 'repo:000000000000:nope', hash)).toEqual({
      error: 'Unknown workflow definition'
    })
    expect(await h.own.call('workflows:trustDefinition', h.defId, hash.toUpperCase())).toEqual({
      error: 'invalid request'
    })
    expect(await h.own.call('workflows:trustDefinition', h.defId, 'abc')).toEqual({ error: 'invalid request' })
    expect(await h.own.call('workflows:trustDefinition', { defId: h.defId }, hash)).toEqual({
      error: 'invalid request'
    })
    expect(h.persisted).toEqual([])

    const off = trustHarness({ labs: false })
    expect(await off.own.call('workflows:trustDefinition', off.defId, hash)).toEqual({
      error: 'Workflows are turned off in Labs'
    })
    expect(off.persisted).toEqual([])
  })

  it('lets a trusted repo definition start through the real runner, and refuses it again after an edit', async () => {
    const h = trustHarness()
    const runnerLoader = createWorkflowDefsLoader({
      dir: join(dir, 'trust-personal'),
      dispatch: () => {},
      log: () => {},
      watch: noWatch,
      repoRoots: [h.repo]
    })
    runnerLoader.reload()
    const live = new WorkflowRunner({
      store: h.store,
      loader: runnerLoader,
      drivers: {
        agent: { start: (a) => ({ executionId: `exec-${a.attemptId}` }), continue: () => {}, cancel: () => {}, onEvent: () => () => {} },
        shell: { start: (a) => ({ executionId: `exec-${a.attemptId}` }), continue: () => {}, cancel: () => {}, onEvent: () => () => {} }
      },
      now: () => 1,
      newId: () => 'run-trusted',
      log: () => {}
    })
    live.reconcile([])
    h.store.dispatch({ type: 'hooks/consentChanged', payload: 'accepted' })
    h.store.dispatch({
      type: 'worktrees/listChanged',
      payload: [{ path: '/wt/a', branch: 'main', head: 'abc', isBare: false, isMain: false, createdAt: 0, repoRoot: '/wt/a' }]
    })
    const start = { defId: h.defId, worktreePath: '/wt/a', inputs: {} }
    expect(await live.start(start)).toEqual({ ok: false, reason: 'untrusted-definition' })

    expect(await h.own.call('workflows:trustDefinition', h.defId, sha256(VALID_YAML))).toEqual({ ok: true })
    writeFileSync(h.file, FULL_YAML)
    expect(await live.start({ ...start, allowFull: true })).toEqual({ ok: false, reason: 'untrusted-definition' })
    writeFileSync(h.file, VALID_YAML)
    expect(await live.start(start)).toEqual({ ok: true, runId: 'run-trusted' })
  })
})

describe('workflows:saveDefinition, duplicateDefinition and deleteDefinition', () => {
  function sha256(text: string): string {
    return createHash('sha256').update(text).digest('hex')
  }

  function libraryHarness(options: { labs?: boolean } = {}) {
    const repo = join(dir, 'lib-repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, '.harness', 'workflows'), { recursive: true })
    const file = join(repo, '.harness', 'workflows', 'shared.yaml')
    writeFileSync(file, VALID_YAML)
    const personal = join(dir, 'lib-personal')
    const own = new FakeTransport()
    const libStore = new Store({
      ...initialState,
      worktrees: { ...initialState.worktrees, repoRoots: [repo] },
      settings: { ...initialState.settings, labs: { ...initialState.settings.labs, workflows: options.labs ?? true } }
    })
    const loader = createWorkflowDefsLoader({
      dir: personal,
      dispatch: (event) => libStore.dispatch(event),
      log: () => {},
      watch: noWatch,
      repoRoots: [repo]
    })
    loader.reload()
    registerWorkflowsRequestHandlers({
      transport: own,
      loader,
      runs: createWorkflowRunLookup({ live: () => null, liveAttemptRunId: () => undefined, records, attemptRunId: () => undefined }),
      runner,
      store: libStore,
      persistTrust: () => {},
      inputTrust: async () => 'untrusted',
      log: () => {}
    })
    const repoDefId = `repo:${repoKeyOf(repo)}:shared`
    const definitions = () => libStore.getSnapshot().state.workflows.definitions
    return { own, store: libStore, repo, file, personal, repoDefId, definitions }
  }

  it('saves in each scope, dispatches the summary and returns its id', async () => {
    const h = libraryHarness()

    expect(await h.own.call('workflows:saveDefinition', { scope: 'personal', name: 'Mine', source: VALID_YAML })).toEqual({ defId: 'personal:mine' })
    expect(await h.own.call('workflows:saveDefinition', { scope: 'repo', repoRoot: h.repo, name: 'team', source: VALID_YAML })).toEqual({
      defId: `repo:${repoKeyOf(h.repo)}:team`
    })

    expect(readFileSync(join(h.personal, 'mine.yaml'), 'utf8')).toBe(VALID_YAML)
    expect(readFileSync(join(h.repo, '.harness', 'workflows', 'team.yaml'), 'utf8')).toBe(VALID_YAML)
    expect(h.definitions()['personal:mine']?.path).toBe(join(h.personal, 'mine.yaml'))
    expect(h.definitions()[`repo:${repoKeyOf(h.repo)}:team`]?.repoRoot).toBe(h.repo)
  })

  it('makes a trusted repo definition untrusted once its source is saved with new content', async () => {
    const h = libraryHarness()
    h.store.dispatch({ type: 'workflows/trustGranted', payload: { defId: h.repoDefId, hash: sha256(VALID_YAML) } })

    expect(
      await h.own.call('workflows:saveDefinition', { scope: 'repo', repoRoot: h.repo, defId: h.repoDefId, name: 'shared', source: FULL_YAML })
    ).toEqual({ defId: h.repoDefId })

    const { definitions, trust } = h.store.getSnapshot().state.workflows
    expect(definitions[h.repoDefId].hash).toBe(sha256(FULL_YAML))
    expect(trust[h.repoDefId]).toBe(sha256(VALID_YAML))
  })

  it('rejects unknown keys, malformed payloads, an unknown repo and Labs off', async () => {
    const h = libraryHarness()
    const save = (payload: unknown) => h.own.call('workflows:saveDefinition', payload)
    const base = { scope: 'personal', name: 'x', source: VALID_YAML }

    for (const payload of [
      { ...base, extra: 1 },
      { ...base, scope: 'team' },
      { ...base, repoRoot: h.repo },
      { ...base, scope: 'repo' },
      { ...base, name: '' },
      { ...base, name: 'n'.repeat(201) },
      { ...base, source: '' },
      { ...base, source: 3 },
      { ...base, defId: 7 },
      'x',
      null
    ]) {
      expect(await save(payload)).toEqual({ error: 'invalid request' })
    }
    expect(await save({ scope: 'repo', repoRoot: join(dir, 'elsewhere'), name: 'x', source: VALID_YAML })).toEqual({ error: 'Unknown repository' })
    expect(await save({ ...base, name: '---' })).toEqual({ error: 'The name needs at least one letter or digit' })
    expect(await save({ scope: 'repo', repoRoot: h.repo, name: '../../escape', source: VALID_YAML })).toEqual({
      error: 'The name must not contain a slash, a backslash, NUL or "..", or start with a dot'
    })
    expect(await save({ ...base, name: 'shared-dup', source: 'x'.repeat(256 * 1024 + 1) })).toEqual({ error: 'The workflow definition is larger than 256 KB' })

    const off = libraryHarness({ labs: false })
    expect(await off.own.call('workflows:saveDefinition', base)).toEqual({ error: 'Workflows are turned off in Labs' })
    expect(await off.own.call('workflows:duplicateDefinition', 'personal:x')).toEqual({ error: 'Workflows are turned off in Labs' })
    expect(await off.own.call('workflows:deleteDefinition', off.repoDefId)).toEqual({ error: 'Workflows are turned off in Labs' })
    expect(readFileSync(off.file, 'utf8')).toBe(VALID_YAML)
  })

  it('refuses overwriting another file without its defId', async () => {
    const h = libraryHarness()
    expect(await h.own.call('workflows:saveDefinition', { scope: 'repo', repoRoot: h.repo, name: 'Shared', source: FULL_YAML })).toEqual({
      error: 'A workflow file with that name already exists'
    })
    expect(readFileSync(h.file, 'utf8')).toBe(VALID_YAML)
  })

  it('duplicates a repo definition only when it is trusted at its current hash', async () => {
    const h = libraryHarness()

    expect(await h.own.call('workflows:duplicateDefinition', h.repoDefId)).toEqual({ error: 'Trust this repo definition before duplicating it' })
    h.store.dispatch({ type: 'workflows/trustGranted', payload: { defId: h.repoDefId, hash: sha256(FULL_YAML) } })
    expect(await h.own.call('workflows:duplicateDefinition', h.repoDefId)).toEqual({ error: 'Trust this repo definition before duplicating it' })
    expect(h.definitions()['personal:valid-flow-copy']).toBeUndefined()

    h.store.dispatch({ type: 'workflows/trustGranted', payload: { defId: h.repoDefId, hash: sha256(VALID_YAML) } })
    expect(await h.own.call('workflows:duplicateDefinition', h.repoDefId)).toEqual({ defId: 'personal:valid-flow-copy' })
    expect(await h.own.call('workflows:duplicateDefinition', 'personal:valid-flow-copy')).toEqual({ defId: 'personal:valid-flow-copy-copy' })
    expect(h.definitions()['personal:valid-flow-copy']).toMatchObject({ name: 'Valid flow-copy', scope: 'personal' })
    expect(await h.own.call('workflows:duplicateDefinition', { defId: h.repoDefId })).toEqual({ error: 'invalid request' })
  })

  it('deletes only the named definition and refuses unknown ids', async () => {
    const h = libraryHarness()
    await h.own.call('workflows:saveDefinition', { scope: 'personal', name: 'keep', source: VALID_YAML })
    await h.own.call('workflows:saveDefinition', { scope: 'personal', name: 'drop', source: VALID_YAML })

    expect(await h.own.call('workflows:deleteDefinition', 'personal:drop')).toEqual({ ok: true })
    expect(await h.own.call('workflows:deleteDefinition', 'personal:drop')).toEqual({ error: 'Unknown workflow definition' })
    expect(await h.own.call('workflows:deleteDefinition', '../keep')).toEqual({ error: 'Unknown workflow definition' })
    expect(await h.own.call('workflows:deleteDefinition', 5)).toEqual({ error: 'invalid request' })

    expect(Object.keys(h.definitions()).sort()).toEqual(['personal:keep', h.repoDefId].sort())
    expect(readFileSync(join(h.personal, 'keep.yaml'), 'utf8')).toBe(VALID_YAML)
    expect(await h.own.call('workflows:deleteDefinition', h.repoDefId)).toEqual({ ok: true })
    expect(() => readFileSync(h.file)).toThrow()
  })
})

describe('workflows:startChain', () => {
  const ITEM_YAML = `name: Item flow
inputs:
  name: { type: text }
  notes: { type: text }
item_input: name
steps:
  - id: say
    kind: shell
    run: echo {{item.title}}
`
  const ISSUE_ITEM_YAML = `name: Issue items
inputs:
  ticket: { type: issue }
item_input: ticket
steps:
  - id: say
    kind: shell
    run: echo {{item.value}}
`
  const idle = (): StepDriver => ({
    start: (attempt) => ({ executionId: `exec-${attempt.attemptId}` }),
    continue: () => {},
    cancel: () => {},
    onEvent: () => () => {}
  })

  function detailOf(id: string, yaml: string, scope: 'personal' | 'repo' = 'personal'): WorkflowDefinitionDetail {
    const validated = validateWorkflowDefinition(yaml)
    return {
      ...validated,
      source: yaml,
      summary: {
        id,
        name: validated.definition?.name ?? 'broken',
        scope,
        ...(scope === 'repo' ? { repoRoot: '/repo' } : {}),
        path: `/defs/${id}.yaml`,
        hash: 'h',
        stepIds: [],
        issues: []
      }
    }
  }

  const DETAILS: Record<string, WorkflowDefinitionDetail> = {
    'personal:items': detailOf('personal:items', ITEM_YAML),
    'personal:issues': detailOf('personal:issues', ISSUE_ITEM_YAML),
    'personal:plain': detailOf('personal:plain', VALID_YAML),
    'personal:broken': detailOf('personal:broken', 'name: Broken\nsteps: nope\n'),
    'repo:untrusted': detailOf('repo:untrusted', ITEM_YAML, 'repo'),
    'personal:agent-items': detailOf(
      'personal:agent-items',
      `name: Agent items\ninputs:\n  name: { type: text }\nitem_input: name\nsteps:\n  - id: plan\n    agent: claude\n    permissions: read-only\n    prompt: Do {{item.title}}\n`
    ),
    'personal:writers': writersDetail(),
    'personal:full-items': detailOf(
      'personal:full-items',
      `name: Full items\ninputs:\n  name: { type: text }\nitem_input: name\nsteps:\n  - id: plan\n    agent: claude\n    permissions: full\n    prompt: Do {{item.title}}\n`
    )
  }

  function writersDetail(): WorkflowDefinitionDetail {
    const yaml = `name: Writers\ninputs:\n  name: { type: text }\nitem_input: name\nsteps:\n  - id: a\n    kind: shell\n    run: echo a\n    parallel_safe: true\n  - id: b\n    kind: shell\n    run: echo b\n    parallel_safe: true\n    needs: []\n`
    const detail = detailOf('personal:writers', yaml)
    const definition = detail.definition
    if (!definition) throw new Error('writers fixture must validate')
    const steps = definition.steps.map((step) => (step.id === 'b' && step.kind === 'shell' ? { ...step, parallel_safe: false } : step))
    return { ...detail, definition: { ...definition, steps } }
  }

  function chainHarness(options: { labs?: boolean; consent?: 'accepted' | 'pending' } = {}) {
    const own = new FakeTransport()
    const chainStore = new Store({
      ...initialState,
      hooks: { ...initialState.hooks, consent: options.consent ?? 'accepted' },
      settings: { ...initialState.settings, labs: { ...initialState.settings.labs, workflows: options.labs ?? true } }
    })
    const loader = { getDefinition: (id: string) => (Object.hasOwn(DETAILS, id) ? DETAILS[id] : null) }
    const live = new WorkflowRunner({
      store: chainStore,
      loader,
      drivers: { agent: idle(), shell: idle() },
      now: () => 1,
      newId: () => 'run-x',
      log: () => {}
    })
    live.reconcile([])
    const starts: StartChainRequest[] = []
    const chainLogs: string[] = []
    registerWorkflowChainRequestHandlers({
      transport: own,
      loader,
      runner: live,
      chains: {
        start: (request) => {
          starts.push(request)
          return 'chain-new'
        }
      },
      store: chainStore,
      getRepoRoots: () => ['/repo'],
      log: (_category, message) => chainLogs.push(message)
    })
    return { own, starts, chainLogs }
  }

  const valid = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    defId: 'personal:items',
    repoRoot: '/repo',
    mode: 'independent',
    items: [{ title: 'First', value: 'one' }, { title: 'Second', value: 'two', origin: { kind: 'issue', number: 7 } }],
    inputs: { notes: 'n' },
    ...overrides
  })

  it('starts the chain with the parsed request and returns its id', async () => {
    const h = chainHarness()
    expect(await h.own.call('workflows:startChain', valid({ autopilot: true, allowFull: false, draftPrs: true }))).toEqual({
      chainId: 'chain-new'
    })
    expect(h.starts).toEqual([
      {
        defId: 'personal:items',
        definitionName: 'Item flow',
        repoRoot: '/repo',
        mode: 'independent',
        items: [{ title: 'First', value: 'one' }, { title: 'Second', value: 'two', origin: { kind: 'issue', number: 7 } }],
        inputs: { notes: 'n' },
        autopilot: true,
        draftPrs: true
      }
    ])
  })

  it('accepts numeric item values for an issue-typed item_input', async () => {
    const h = chainHarness()
    const payload = valid({ defId: 'personal:issues', inputs: {}, items: [{ title: 'Bug', value: '42' }] })
    expect(await h.own.call('workflows:startChain', payload)).toEqual({ chainId: 'chain-new' })
    expect(h.starts[0].draftPrs).toBe(false)
  })

  it('accepts exactly 50 items and a 200-character title', async () => {
    const h = chainHarness()
    const items = Array.from({ length: 50 }, (_, i) => ({ title: i === 0 ? 'x'.repeat(200) : `t${i}`, value: 'v' }))
    expect(await h.own.call('workflows:startChain', valid({ items }))).toEqual({ chainId: 'chain-new' })
  })

  const INVALID = { error: 'invalid request' }
  it.each<[string, unknown, unknown]>([
    ['an unknown top-level key', valid({ budgetUsd: 5 }), INVALID],
    ['an unknown item key', valid({ items: [{ title: 'a', value: 'b', branch: 'wf/x' }] }), INVALID],
    ['an unknown origin key', valid({ items: [{ title: 'a', value: 'b', origin: { kind: 'issue', number: 1, url: 'x' } }] }), INVALID],
    ['a non-object payload', 'chain', INVALID],
    ['no items', valid({ items: [] }), INVALID],
    ['51 items', valid({ items: Array.from({ length: 51 }, () => ({ title: 't', value: 'v' })) }), INVALID],
    ['items that are not an array', valid({ items: { 0: { title: 't', value: 'v' } } }), INVALID],
    ['a title over 200 characters', valid({ items: [{ title: 'x'.repeat(201), value: 'v' }] }), INVALID],
    ['a blank title', valid({ items: [{ title: '  ', value: 'v' }] }), INVALID],
    ['a value over the input cap', valid({ items: [{ title: 't', value: 'v'.repeat(64 * 1024 + 1) }] }), INVALID],
    ['a non-string value', valid({ items: [{ title: 't', value: 3 }] }), INVALID],
    ['an origin with an unknown kind', valid({ items: [{ title: 't', value: 'v', origin: { kind: 'commit', number: 1 } }] }), INVALID],
    ['an origin number given as a string', valid({ items: [{ title: 't', value: 'v', origin: { kind: 'pr', number: '1' } }] }), INVALID],
    ['an origin number of zero', valid({ items: [{ title: 't', value: 'v', origin: { kind: 'pr', number: 0 } }] }), INVALID],
    ['a missing mode', valid({ mode: undefined }), INVALID],
    ['a non-boolean flag', valid({ draftPrs: 'yes' }), INVALID],
    ['a non-string input', valid({ inputs: { notes: 1 } }), INVALID],
    ['malformed overrides', valid({ overrides: { say: 'opus' } }), INVALID],
    ['stacked mode', valid({ mode: 'stacked' }), { error: 'Stacked chains are not supported yet' }],
    ['an unknown repo root', valid({ repoRoot: '/repo/' }), { error: 'Unknown repository' }],
    ['an unknown definition', valid({ defId: 'personal:nope' }), { error: 'Unknown workflow definition' }],
    ['an untrusted repo definition', valid({ defId: 'repo:untrusted' }), { error: 'Trust this definition before running it' }],
    ['an invalid definition', valid({ defId: 'personal:broken' }), { error: 'The workflow definition is invalid' }],
    [
      'a definition without item_input',
      valid({ defId: 'personal:plain', inputs: {} }),
      { error: 'The workflow definition has no item_input, so it cannot run over a list of items' }
    ],
    [
      'a non-numeric value for an issue-typed item_input',
      valid({ defId: 'personal:issues', inputs: {}, items: [{ title: 'Bug', value: '42' }, { title: 'x', value: 'abc' }] }),
      { error: 'Each item of this workflow must be an issue or pull request number' }
    ],
    ['inputs that set the item_input key', valid({ inputs: { notes: 'n', name: 'x' } }), { error: 'The workflow inputs are invalid' }],
    ['an unknown input', valid({ inputs: { notes: 'n', other: 'x' } }), { error: 'The workflow inputs are invalid' }],
    ['a missing required input', valid({ inputs: {} }), { error: 'A required workflow input is missing' }],
    ['a blank item value', valid({ items: [{ title: 't', value: 'v' }, { title: 'u', value: ' ' }] }), { error: 'A required workflow input is missing' }],
    [
      'an override on a shell step',
      valid({ overrides: { say: { model: 'opus' } } }),
      { error: 'A step override names a step that is not an agent step, or has an invalid model' }
    ]
  ])('refuses %s before starting anything', async (_name, payload, expected) => {
    const h = chainHarness()
    expect(await h.own.call('workflows:startChain', payload)).toEqual(expected)
    expect(h.starts).toEqual([])
  })

  it('refuses an agent-step chain while hooks consent is pending, before creating anything', async () => {
    const h = chainHarness({ consent: 'pending' })
    const payload = valid({ defId: 'personal:agent-items', inputs: {} })
    expect(await h.own.call('workflows:startChain', payload)).toEqual({ error: 'Accept the hooks install before running agent steps' })
    expect(h.starts).toEqual([])
    expect(await h.own.call('workflows:startChain', valid({ inputs: { notes: 'n' } }))).toEqual({ chainId: 'chain-new' })
  })

  it('refuses a full-access definition without allowFull before starting anything, and starts it with allowFull', async () => {
    const h = chainHarness()
    const payload = valid({ defId: 'personal:full-items', inputs: {} })
    expect(await h.own.call('workflows:startChain', payload)).toEqual({
      error: 'This workflow has a full-access step; confirm full access to start it'
    })
    expect(await h.own.call('workflows:startChain', { ...payload, allowFull: false })).toEqual({
      error: 'This workflow has a full-access step; confirm full access to start it'
    })
    expect(h.starts).toEqual([])
    expect(await h.own.call('workflows:startChain', { ...payload, allowFull: true })).toEqual({ chainId: 'chain-new' })
    expect(h.starts).toHaveLength(1)
  })

  it('refuses a definition whose writing steps can run at the same time', async () => {
    const h = chainHarness()
    expect(await h.own.call('workflows:startChain', valid({ defId: 'personal:writers', inputs: {} }))).toEqual({
      error: 'Steps that can run at the same time must not write; make them read-only or order them with "needs"'
    })
    expect(h.starts).toEqual([])
  })

  it('refuses while Labs workflows is off', async () => {
    const h = chainHarness({ labs: false })
    expect(await h.own.call('workflows:startChain', valid())).toEqual({ error: 'Workflows are turned off in Labs' })
    expect(h.starts).toEqual([])
  })

  it('returns an internal error without leaking the throw when the scheduler throws', async () => {
    const own = new FakeTransport()
    const chainLogs: string[] = []
    registerWorkflowChainRequestHandlers({
      transport: own,
      loader: { getDefinition: (id: string) => (Object.hasOwn(DETAILS, id) ? DETAILS[id] : null) },
      runner: { checkStart: () => null },
      chains: {
        start: () => {
          throw new Error('secret failure')
        }
      },
      store,
      getRepoRoots: () => ['/repo'],
      log: (_category, message, data) => chainLogs.push(`${message} ${JSON.stringify(data)}`)
    })
    expect(await own.call('workflows:startChain', valid())).toEqual({ error: 'internal error' })
    expect(chainLogs.join('\n')).not.toContain('secret')
  })
})

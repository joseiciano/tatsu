import { createHash } from 'crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerWorkflowsRequestHandlers, type WorkflowActionsRunner } from '.'
import { Store } from '../store'
import {
  WorkflowRunner,
  type MarkDoneRequest,
  type StartRunRequest,
  type StartRunResult,
  type StepActionResult,
  type StepDriver
} from '../workflow-runner'
import { initialState } from '../../shared/state'
import type { CodexHookTrustSummary } from '../../shared/state/hooks'
import { createWorkflowDefsLoader, repoKeyOf, type WorkflowDefsLoader, type WorkflowWatchFn } from '../workflow-defs-loader'
import { createWorkflowRunLookup, createWorkflowRunRecords, type WorkflowRunRecords } from '../workflow-run-records'
import type {
  WorkflowAttemptRecord,
  WorkflowDefinitionDetail,
  WorkflowRunRecord,
  WorkflowsEvent
} from '../../shared/state/workflows'
import { validateWorkflowDefinition } from '../../shared/workflow-def'
import type { PersistedWorkflowTrust } from '../persistence'

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

  start(request: StartRunRequest): StartRunResult {
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

  resumeStep(runId: string, stepId: string): StepActionResult {
    this.record('resumeStep', runId, stepId)
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
  registerWorkflowsRequestHandlers({
    transport,
    loader,
    runs,
    runner,
    store: new Store(initialState),
    persistTrust: () => {},
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
    ['workflows:resumeStep', [RUN, STEP], ['resumeStep', RUN, STEP]]
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
      log: () => {}
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
      log: () => {}
    })
    return own
  }
  const payload = { defId: 'personal:plan', worktreePath: '/wt/a', inputs: {} }

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
    expect(live.start(start)).toEqual({ ok: false, reason: 'untrusted-definition' })

    expect(await h.own.call('workflows:trustDefinition', h.defId, sha256(VALID_YAML))).toEqual({ ok: true })
    writeFileSync(h.file, FULL_YAML)
    expect(live.start({ ...start, allowFull: true })).toEqual({ ok: false, reason: 'untrusted-definition' })
    writeFileSync(h.file, VALID_YAML)
    expect(live.start(start)).toEqual({ ok: true, runId: 'run-trusted' })
  })
})

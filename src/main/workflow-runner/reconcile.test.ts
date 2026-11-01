import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    setPath: () => {},
    isPackaged: false
  }
}))

vi.mock('../perf-log', () => ({
  perfLog: vi.fn(),
  getPerfLogFilePath: vi.fn(() => '/tmp/perf.log')
}))

import { Store } from '../store'
import { buildInitialAppState } from '../build-initial-state'
import { loadRunRecordsSync } from '../workflow-run-records'
import { WorkflowRunner, type WorkflowRunnerDeps } from '.'
import { FakeStepDriver } from './fake-step-driver'
import type { Config } from '../persistence'
import type {
  WorkflowAttemptRecord,
  WorkflowDefinitionDetail,
  WorkflowRunRecord,
  WorkflowStepStatus
} from '../../shared/state/workflows'
import { validateWorkflowDefinition, type ResolvedDefinition } from '../../shared/workflow-def'

const TWO_AGENT = `name: two-agent
steps:
  - id: plan
    agent: claude
    prompt: "plan"
  - id: build
    agent: claude
    prompt: "build"
`
const ONE_AGENT = `name: one-agent
steps:
  - id: plan
    agent: claude
    prompt: "plan"
`

function definitionOf(source: string): ResolvedDefinition {
  const { definition } = validateWorkflowDefinition(source)
  if (!definition) throw new Error('fixture definition invalid')
  return definition
}

function attempt(attemptId: string, patch: Partial<WorkflowAttemptRecord> = {}): WorkflowAttemptRecord {
  return {
    attemptId,
    stepId: 'plan',
    n: 1,
    status: 'running',
    startedAt: 5,
    metrics: { continuations: 0, pauses: [] },
    ...patch
  }
}

function record(runId: string, patch: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    version: 1,
    runId,
    defId: 'personal:one-agent',
    defHash: 'hash-one-agent',
    definition: definitionOf(ONE_AGENT),
    inputs: {},
    worktreePath: `/wt/${runId}`,
    contextPath: `/wt/${runId}/.harness/runs/${runId}/context.md`,
    status: 'running',
    cursor: 0,
    steps: { plan: 'pending' },
    startedAt: 10,
    attempts: [],
    ...patch
  }
}

const emptyConfig: Config = { windowBounds: null, repoRoots: [] }

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reconcile-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface BootOptions {
  cap?: number
  alive?: ReadonlySet<string>
  loader?: WorkflowRunnerDeps['loader']
  labs?: boolean
}

function boot(onDisk: Array<WorkflowRunRecord | { file: string; raw: string }>, options: BootOptions = {}) {
  for (const entry of onDisk) {
    if ('raw' in entry) writeFileSync(join(dir, entry.file), entry.raw)
    else writeFileSync(join(dir, `${entry.runId}.json`), JSON.stringify(entry))
  }
  const logs: string[] = []
  const log: WorkflowRunnerDeps['log'] = (category, message, data) =>
    logs.push(`[${category}] ${message} ${JSON.stringify(data ?? {})}`)
  const records = loadRunRecordsSync(dir, log)
  const initial = buildInitialAppState(emptyConfig, { hasGithubToken: false, workflowRuns: records })
  const store = new Store({
    ...initial,
    settings: {
      ...initial.settings,
      labs: { workflows: options.labs ?? true },
      workflows: { maxConcurrentAgents: options.cap ?? 4 }
    }
  })
  const agent = new FakeStepDriver('agent')
  const shell = new FakeStepDriver('shell')
  const persisted: WorkflowRunRecord[] = []
  const probed: string[] = []
  let clock = 1000
  let ids = 0
  const runner = new WorkflowRunner({
    store,
    loader: options.loader ?? { getDefinition: () => null },
    drivers: { agent, shell },
    now: () => ++clock,
    newId: () => `id-${++ids}`,
    log,
    persist: (run) => persisted.push(structuredClone(run)),
    hasExecution: (executionId) => {
      probed.push(executionId)
      return options.alive?.has(executionId) ?? false
    }
  })
  const wf = () => store.getSnapshot().state.workflows
  const lastPersisted = (runId: string): WorkflowRunRecord | undefined =>
    persisted.filter((run) => run.runId === runId).at(-1)
  const stepStatus = (runId: string, stepId: string): WorkflowStepStatus | undefined =>
    wf().runs[runId]?.steps[stepId]?.status
  return { records, store, runner, agent, shell, logs, persisted, probed, wf, lastPersisted, stepStatus }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('boot hydration plus reconcile', () => {
  it('interrupts dead running attempts, requeues queued steps, keeps paused runs and caps finished runs', async () => {
    const finished: WorkflowRunRecord[] = []
    for (let i = 0; i < 60; i++) {
      const runId = `done-${String(i).padStart(2, '0')}`
      finished.push(record(runId, { status: 'done', steps: { plan: 'done' }, cursor: 1, finishedAt: 100 + i }))
    }
    const interrupted = record('run-a', {
      defId: 'personal:two-agent',
      definition: definitionOf(TWO_AGENT),
      steps: { plan: 'running', build: 'pending' },
      startedAt: 10,
      attempts: [attempt('att-a1', { executionId: 'pty-dead' })]
    })
    const queued = record('run-b', { steps: { plan: 'queued' }, startedAt: 20 })
    const paused = record('run-c', {
      status: 'paused',
      pausedReason: 'step-failed',
      steps: { plan: 'failed' },
      startedAt: 30,
      attempts: [
        attempt('att-c1', {
          status: 'failed',
          endedAt: 8,
          result: { status: 'failed', summary: 'nope', completedBy: 'tool' },
          metrics: { continuations: 0, pauses: [{ reason: 'step-failed', at: 8 }] }
        })
      ]
    })
    const ctx = boot([interrupted, queued, paused, ...finished, { file: 'corrupt.json', raw: '{"x": ' }])
    const pausedBefore = ctx.wf().runs['run-c']

    ctx.runner.reconcile(ctx.records)
    await flush()

    const runs = Object.entries(ctx.wf().runs)
    expect(runs.filter(([, run]) => run.status === 'done')).toHaveLength(50)
    expect(ctx.wf().runs['done-09']).toBeUndefined()
    expect(ctx.wf().runs['done-10']).toBeDefined()
    expect(ctx.logs).toContain('[workflow] run record skipped unreadable {"file":"corrupt.json"}')

    expect(ctx.wf().runs['run-a']).toMatchObject({ status: 'paused', pausedReason: 'interrupted' })
    expect(ctx.stepStatus('run-a', 'plan')).toBe('interrupted')
    expect(ctx.stepStatus('run-a', 'build')).toBe('pending')
    expect(ctx.wf().attempts['att-a1']).toMatchObject({ status: 'interrupted', endedAt: expect.any(Number) })
    const recordA = ctx.lastPersisted('run-a')
    expect(recordA).toMatchObject({ status: 'paused', pausedReason: 'interrupted', steps: { plan: 'interrupted' } })
    expect(recordA?.attempts[0]).toMatchObject({
      status: 'interrupted',
      endedAt: expect.any(Number),
      metrics: { pauses: [{ reason: 'interrupted', at: expect.any(Number) }] }
    })
    expect(ctx.probed).toEqual(['pty-dead'])

    expect(ctx.agent.started.map((started) => `${started.runId}/${started.stepId}`)).toEqual(['run-b/plan'])
    expect(ctx.stepStatus('run-b', 'plan')).toBe('running')
    expect(ctx.wf().runs['run-b'].steps.plan.attemptIds).toHaveLength(1)
    expect(ctx.lastPersisted('run-b')?.attempts).toHaveLength(1)

    expect(ctx.wf().runs['run-c']).toBe(pausedBefore)
    expect(ctx.lastPersisted('run-c')).toBeUndefined()

    const reconciled = ctx.logs.filter((line) => line.includes('run reconciled'))
    expect(reconciled).toEqual([
      '[workflow] run reconciled interrupted {"runId":"run-a"}',
      '[workflow] run reconciled requeued {"runId":"run-b"}',
      '[workflow] run reconciled paused {"runId":"run-c"}'
    ])
  })
})

describe('WorkflowRunner.reconcile', () => {
  it('treats a running attempt without an execution id as interrupted without probing', () => {
    const ctx = boot([record('run-a', { steps: { plan: 'running' }, attempts: [attempt('att-1')] })])
    ctx.runner.reconcile(ctx.records)
    expect(ctx.probed).toEqual([])
    expect(ctx.wf().attempts['att-1'].status).toBe('interrupted')
    expect(ctx.wf().runs['run-a']).toMatchObject({ status: 'paused', pausedReason: 'interrupted' })
  })

  it('switches a needs-input pause with a dead PTY to interrupted', () => {
    const ctx = boot([
      record('run-a', {
        status: 'paused',
        pausedReason: 'needs-input',
        steps: { plan: 'running' },
        attempts: [
          attempt('att-1', {
            executionId: 'pty-dead',
            result: { status: 'needs-input', summary: 'which db?', completedBy: 'tool' },
            metrics: { continuations: 0, pauses: [{ reason: 'needs-input', at: 6 }] }
          })
        ]
      })
    ])
    ctx.runner.reconcile(ctx.records)
    expect(ctx.wf().runs['run-a']).toMatchObject({ status: 'paused', pausedReason: 'interrupted' })
    expect(ctx.wf().attempts['att-1']).toMatchObject({ status: 'interrupted', summaryPreview: '' })
    expect(ctx.stepStatus('run-a', 'plan')).toBe('interrupted')
    expect(ctx.lastPersisted('run-a')?.attempts[0].metrics.pauses.map((pause) => pause.reason)).toEqual([
      'needs-input',
      'interrupted'
    ])
  })

  it('reattaches a running attempt whose PTY is still alive and keeps its agent slot', async () => {
    const ctx = boot(
      [
        record('run-a', {
          steps: { plan: 'running' },
          startedAt: 10,
          attempts: [attempt('att-1', { executionId: 'pty-live' })]
        }),
        record('run-b', { steps: { plan: 'queued' }, startedAt: 20 })
      ],
      { cap: 1, alive: new Set(['pty-live']) }
    )
    ctx.runner.reconcile(ctx.records)
    await flush()
    expect(ctx.wf().attempts['att-1'].status).toBe('running')
    expect(ctx.agent.started).toEqual([])
    expect(ctx.logs).toContain('[workflow] run reconciled attached {"runId":"run-a"}')

    ctx.agent.emit({ type: 'exited', executionId: 'pty-live', code: 1 })
    await flush()
    expect(ctx.wf().attempts['att-1'].status).toBe('failed')
    expect(ctx.agent.started.map((started) => started.runId)).toEqual(['run-b'])
  })

  it('reschedules waiting runs in run start order, not record order', async () => {
    const ctx = boot(
      [
        record('run-late', { steps: { plan: 'pending' }, startedAt: 30 }),
        record('run-early', { steps: { plan: 'queued' }, startedAt: 10 }),
        record('run-mid', { steps: { plan: 'queued' }, startedAt: 20 })
      ],
      { cap: 1 }
    )
    ctx.runner.reconcile(ctx.records)
    await flush()
    expect(ctx.agent.started.map((started) => started.runId)).toEqual(['run-early'])
    expect(ctx.stepStatus('run-late', 'plan')).toBe('queued')

    ctx.runner.complete(ctx.wf().runs['run-early'].steps.plan.attemptIds[0], {
      status: 'done',
      summary: 'ok',
      completedBy: 'tool'
    })
    await flush()
    expect(ctx.agent.started.map((started) => started.runId)).toEqual(['run-early', 'run-mid'])
  })

  it('adopts runs from their stored definition so retry and busy checks work without the loader', async () => {
    const ctx = boot([record('run-a', { steps: { plan: 'running' }, attempts: [attempt('att-1')] })])
    ctx.runner.reconcile(ctx.records)
    expect(ctx.runner.runIdForAttempt('att-1')).toBe('run-a')
    expect(ctx.runner.getRunRecord('run-a')?.status).toBe('paused')

    expect(ctx.runner.retry('run-a')).toBe(true)
    await flush()
    expect(ctx.agent.started).toHaveLength(1)
    expect(ctx.agent.started[0]).toMatchObject({ runId: 'run-a', stepId: 'plan', n: 2 })
    expect(ctx.wf().runs['run-a'].status).toBe('running')
  })

  it('finishes a non-paused run whose cursor is past its last step', () => {
    const ctx = boot([record('run-a', { steps: { plan: 'done' }, cursor: 1 })])
    ctx.runner.reconcile(ctx.records)
    expect(ctx.wf().runs['run-a'].status).toBe('done')
  })

  it('persists the execution id on the attempt once the driver starts it', async () => {
    const source = validateWorkflowDefinition(ONE_AGENT)
    const detail: WorkflowDefinitionDetail = {
      ...source,
      source: ONE_AGENT,
      summary: {
        id: 'personal:one-agent',
        name: 'one-agent',
        scope: 'personal',
        path: '/defs/one-agent.yaml',
        hash: 'hash-one-agent',
        stepIds: ['plan'],
        issues: []
      }
    }
    const ctx = boot([], { loader: { getDefinition: () => detail } })
    const started = ctx.runner.start({ defId: 'personal:one-agent', worktreePath: '/wt/x', inputs: {} })
    if (!started.ok) throw new Error(started.reason)
    await flush()
    expect(ctx.lastPersisted(started.runId)?.attempts[0].executionId).toBe('agent-exec-1')
  })
})

describe('WorkflowRunner.reconcile with labs off', () => {
  const setLabs = (ctx: ReturnType<typeof boot>, workflows: boolean) => {
    const { settings } = ctx.store.getSnapshot().state
    ctx.store.dispatch({ type: 'settings/labsChanged', payload: { ...settings.labs, workflows } })
  }

  it('holds queued and pending runs as interrupted instead of starting them', async () => {
    const ctx = boot(
      [
        record('run-q', { steps: { plan: 'queued' }, startedAt: 10 }),
        record('run-p', { steps: { plan: 'pending' }, startedAt: 20 }),
        record('run-dead', { steps: { plan: 'running' }, startedAt: 30, attempts: [attempt('att-dead')] })
      ],
      { labs: false }
    )
    ctx.runner.reconcile(ctx.records)
    await flush()

    expect(ctx.agent.started).toEqual([])
    expect(ctx.shell.started).toEqual([])
    for (const runId of ['run-q', 'run-p']) {
      expect(ctx.wf().runs[runId]).toMatchObject({ status: 'paused', pausedReason: 'interrupted' })
      expect(ctx.stepStatus(runId, 'plan')).toBe('pending')
      expect(ctx.lastPersisted(runId)).toMatchObject({ status: 'paused', pausedReason: 'interrupted' })
      expect(ctx.logs).toContain(`[workflow] run reconciled held {"runId":"${runId}"}`)
    }
    expect(ctx.wf().attempts['att-dead'].status).toBe('interrupted')
    expect(ctx.wf().runs['run-dead']).toMatchObject({ status: 'paused', pausedReason: 'interrupted' })
  })

  it('refuses retry while labs is off and recovers a held step with no attempt once it is on', async () => {
    const ctx = boot([record('run-p', { steps: { plan: 'pending' } })], { labs: false })
    ctx.runner.reconcile(ctx.records)
    expect(ctx.runner.retry('run-p')).toBe(false)
    await flush()
    expect(ctx.agent.started).toEqual([])

    setLabs(ctx, true)
    expect(ctx.runner.retry('run-p')).toBe(true)
    await flush()
    expect(ctx.agent.started).toHaveLength(1)
    expect(ctx.agent.started[0]).toMatchObject({ runId: 'run-p', stepId: 'plan', n: 1 })
    expect(ctx.wf().runs['run-p'].status).toBe('running')
  })

  it('holds the next step of a reattached run when labs was turned off', async () => {
    const ctx = boot(
      [
        record('run-a', {
          defId: 'personal:two-agent',
          definition: definitionOf(TWO_AGENT),
          steps: { plan: 'running', build: 'pending' },
          attempts: [attempt('att-1', { executionId: 'pty-live' })]
        })
      ],
      { labs: false, alive: new Set(['pty-live']) }
    )
    ctx.runner.reconcile(ctx.records)
    ctx.runner.complete('att-1', { status: 'done', summary: 'ok', completedBy: 'tool' })
    await flush()
    expect(ctx.agent.started).toEqual([])
    expect(ctx.stepStatus('run-a', 'build')).toBe('pending')
    expect(ctx.wf().runs['run-a']).toMatchObject({ status: 'paused', pausedReason: 'interrupted' })
  })
})

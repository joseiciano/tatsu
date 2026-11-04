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
import { WorkflowRunner, createClaudeStepDriver, type StepDriver, type WorkflowRunnerDeps } from '.'
import { currentStepId, FakeStepDriver, worktreeFixture } from './fake-step-driver'
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
const ONE_SHELL = `name: one-shell
steps:
  - id: plan
    kind: shell
    run: "true"
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
  agentDriver?: (store: Store) => StepDriver
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
    hooks: { ...initial.hooks, consent: 'accepted' },
    worktrees: { ...initial.worktrees, list: [worktreeFixture('/wt/x')] },
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
    drivers: { agent: options.agentDriver?.(store) ?? agent, shell },
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

  it('fails a reattached Claude attempt when its PTY exits, though this driver never started it', async () => {
    const exitListeners = new Set<(id: string, code: number, signal?: number) => void>()
    const removedMarkers: string[] = []
    const agentDriver = (store: Store): StepDriver =>
      createClaudeStepDriver({
        addTab: () => {},
        hasTerminal: () => false,
        onExit: (listener) => {
          exitListeners.add(listener)
          return () => exitListeners.delete(listener)
        },
        kill: () => {},
        onStopEvent: () => () => {},
        onPromptSubmit: () => () => {},
        store,
        checkFolderTrust: async () => ({ status: 'trusted' }),
        writeMarker: () => {},
        removeMarker: (id) => {
          removedMarkers.push(id)
        },
        writePromptFile: async () => {},
        write: () => {},
        newTabId: () => 'unused',
        newSessionId: () => 'unused',
        log: () => {}
      })
    const ctx = boot(
      [record('run-a', { steps: { plan: 'running' }, attempts: [attempt('att-1', { executionId: 'claude-live' })] })],
      { alive: new Set(['claude-live']), agentDriver }
    )
    ctx.runner.reconcile(ctx.records)
    await flush()
    for (const listener of [...exitListeners]) listener('claude-live', 2)
    expect(ctx.wf().attempts['att-1']).toMatchObject({ status: 'failed', completedBy: 'exit' })
    expect(ctx.lastPersisted('run-a')?.attempts[0].result).toMatchObject({ exitCode: 2 })
    expect(removedMarkers).toEqual(['claude-live'])
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

    expect(ctx.runner.retryStep('run-a', currentStepId(ctx.runner, 'run-a'))).toEqual({ ok: true })
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
    ctx.runner.reconcile(ctx.records)
    const started = await ctx.runner.start({ defId: 'personal:one-agent', worktreePath: '/wt/x', inputs: {} })
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
    expect(ctx.runner.retryStep('run-p', currentStepId(ctx.runner, 'run-p'))).toEqual({ ok: false, reason: 'labs-off' })
    await flush()
    expect(ctx.agent.started).toEqual([])

    setLabs(ctx, true)
    expect(ctx.runner.retryStep('run-p', currentStepId(ctx.runner, 'run-p'))).toEqual({ ok: true })
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

describe('WorkflowRunner.resumeStep', () => {
  const SESSION = '11111111-1111-4111-8111-111111111111'
  const interrupted = (patch: Partial<WorkflowAttemptRecord> = {}) =>
    record('run-a', {
      steps: { plan: 'running' },
      attempts: [attempt('att-1', { executionId: 'pty-dead', sessionId: SESSION, ...patch })]
    })

  it('starts attempt n+1 with the stored session id of an interrupted Claude attempt', async () => {
    const ctx = boot([interrupted()])
    ctx.runner.reconcile(ctx.records)
    expect(ctx.runner.resumeStep('run-a', 'plan')).toEqual({ ok: true })
    await flush()
    expect(ctx.agent.started).toHaveLength(1)
    expect(ctx.agent.started[0]).toMatchObject({ runId: 'run-a', stepId: 'plan', n: 2, resumeSessionId: SESSION })
    expect(ctx.wf().runs['run-a'].status).toBe('running')
  })

  it('keeps the stored session when the resumed step waits in the agent queue', async () => {
    const ctx = boot([interrupted(), record('run-b', { steps: { plan: 'pending' }, startedAt: 1 })], { cap: 1 })
    ctx.runner.reconcile(ctx.records)
    await flush()
    expect(ctx.agent.started.map((started) => started.runId)).toEqual(['run-b'])
    expect(ctx.runner.resumeStep('run-a', 'plan')).toEqual({ ok: true })
    expect(ctx.stepStatus('run-a', 'plan')).toBe('queued')
    ctx.runner.complete(ctx.wf().runs['run-b'].steps.plan.attemptIds[0], {
      status: 'done',
      summary: 'ok',
      completedBy: 'tool'
    })
    await flush()
    expect(ctx.agent.started[1]).toMatchObject({ runId: 'run-a', n: 2, resumeSessionId: SESSION })
  })

  it.each([
    ['no stored session', undefined],
    ['a stored session that is not a uuid', '$(touch /tmp/pwned)']
  ])('suggests retry when the interrupted attempt has %s', (_name, sessionId) => {
    const ctx = boot([interrupted({ sessionId })])
    ctx.runner.reconcile(ctx.records)
    expect(ctx.runner.resumeStep('run-a', 'plan')).toEqual({ ok: false, reason: 'no-session' })
    expect(ctx.agent.started).toEqual([])
  })

  it('refuses a shell step, a failed attempt and a step that is not current', async () => {
    const shell = boot([
      record('run-a', {
        definition: definitionOf(ONE_SHELL),
        steps: { plan: 'running' },
        attempts: [attempt('att-1', { sessionId: SESSION })]
      })
    ])
    shell.runner.reconcile(shell.records)
    expect(shell.runner.resumeStep('run-a', 'plan')).toEqual({ ok: false, reason: 'not-resumable-step' })

    const failed = boot([
      record('run-a', {
        status: 'paused',
        pausedReason: 'step-failed',
        steps: { plan: 'failed' },
        attempts: [attempt('att-1', { status: 'failed', endedAt: 6, sessionId: SESSION })]
      })
    ])
    failed.runner.reconcile(failed.records)
    expect(failed.runner.resumeStep('run-a', 'plan')).toEqual({ ok: false, reason: 'not-interrupted' })
    expect(failed.runner.resumeStep('run-a', 'build')).toEqual({ ok: false, reason: 'wrong-step' })
    expect(failed.runner.resumeStep('run-zz', 'plan')).toEqual({ ok: false, reason: 'unknown-run' })
    await flush()
    expect([...shell.shell.started, ...failed.agent.started]).toEqual([])
  })
})

describe('v1 records keep their cursor meaning', () => {
  it('reconciles paused, interrupted, queued and mid-run records with the cursor on the paused or earliest open step', async () => {
    const twoAgent = definitionOf(TWO_AGENT)
    const ctx = boot([
      record('run-int', {
        definition: twoAgent,
        steps: { plan: 'done', build: 'running' },
        cursor: 1,
        startedAt: 10,
        attempts: [
          attempt('att-p', { status: 'done', endedAt: 6 }),
          attempt('att-b', { stepId: 'build', executionId: 'pty-dead' })
        ]
      }),
      record('run-q', { definition: twoAgent, steps: { plan: 'queued', build: 'pending' }, startedAt: 20 }),
      record('run-p', {
        definition: twoAgent,
        status: 'paused',
        pausedReason: 'step-failed',
        steps: { plan: 'done', build: 'failed' },
        cursor: 1,
        startedAt: 30,
        attempts: [
          attempt('att-p2', { status: 'done', endedAt: 6 }),
          attempt('att-b2', { stepId: 'build', status: 'failed', endedAt: 7 })
        ]
      }),
      record('run-m', {
        definition: twoAgent,
        steps: { plan: 'done', build: 'pending' },
        cursor: 1,
        startedAt: 40,
        attempts: [attempt('att-p3', { status: 'done', endedAt: 6 })]
      })
    ])
    ctx.runner.reconcile(ctx.records)
    await flush()

    expect(ctx.wf().runs['run-int']).toMatchObject({ status: 'paused', pausedReason: 'interrupted', cursorStepId: 'build' })
    expect(ctx.stepStatus('run-int', 'build')).toBe('interrupted')
    expect(ctx.lastPersisted('run-int')?.cursor).toBe(1)

    expect(ctx.wf().runs['run-q']).toMatchObject({ status: 'running', cursorStepId: 'plan' })
    expect(ctx.stepStatus('run-q', 'plan')).toBe('running')
    expect(ctx.lastPersisted('run-q')?.cursor).toBe(0)

    expect(ctx.wf().runs['run-p']).toMatchObject({ status: 'paused', pausedReason: 'step-failed', cursorStepId: 'build' })
    expect(ctx.runner.getRunRecord('run-p')?.cursor).toBe(1)

    expect(ctx.wf().runs['run-m']).toMatchObject({ status: 'running', cursorStepId: 'build' })
    expect(ctx.stepStatus('run-m', 'build')).toBe('running')
    expect(ctx.agent.started.map((started) => `${started.runId}/${started.stepId}`)).toEqual(['run-q/plan', 'run-m/build'])

    expect(ctx.runner.markDone('run-p', 'build', { summary: 'fixed', fields: {} })).toEqual({ ok: true })
    expect(ctx.wf().runs['run-p']).toMatchObject({ status: 'done', cursorStepId: 'build' })
    expect(ctx.lastPersisted('run-p')?.cursor).toBe(2)
  })
})

const FAN_IN = `name: fan-in
steps:
  - id: a
    agent: claude
    prompt: "a"
    permissions: read-only
  - id: b
    agent: claude
    prompt: "b"
    permissions: read-only
    needs: []
  - id: c
    agent: claude
    prompt: "c"
    needs: [a, b]
`

function fanInDefinition(): ResolvedDefinition {
  const { definition } = validateWorkflowDefinition(FAN_IN)
  if (!definition) throw new Error('fan-in fixture invalid')
  return definition
}

function fanInRecord(runId: string, patch: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return record(runId, { definition: fanInDefinition(), steps: { a: 'pending', b: 'pending', c: 'pending' }, ...patch })
}

function runEvents(ctx: ReturnType<typeof boot>): string[] {
  const seen: string[] = []
  ctx.store.subscribe((event) => {
    if (event.type === 'workflows/runPaused') seen.push(`runPaused ${event.payload.reason}`)
    else if (event.type === 'workflows/runResumed') seen.push('runResumed')
    else if (event.type === 'workflows/cursorChanged') seen.push(`cursorChanged ${event.payload.stepId}`)
  })
  return seen
}

const userDone = { summary: 'by hand', fields: {} }

describe('WorkflowRunner per-step scheduling', () => {
  it('tracks and removes two queue entries of one run independently', async () => {
    const ctx = boot(
      [
        record('run-x', {
          steps: { plan: 'running' },
          startedAt: 5,
          attempts: [attempt('att-x', { executionId: 'pty-live' })]
        }),
        fanInRecord('run-q', { steps: { a: 'queued', b: 'queued', c: 'pending' }, startedAt: 10 })
      ],
      { cap: 1, alive: new Set(['pty-live']) }
    )
    ctx.runner.reconcile(ctx.records)
    await flush()
    expect(ctx.agent.started).toEqual([])
    expect([ctx.stepStatus('run-q', 'a'), ctx.stepStatus('run-q', 'b')]).toEqual(['queued', 'queued'])

    expect(ctx.runner.cancelStep('run-q', 'b')).toEqual({ ok: true })
    expect([ctx.stepStatus('run-q', 'a'), ctx.stepStatus('run-q', 'b')]).toEqual(['queued', 'cancelled'])
    expect(ctx.runner.skipStep('run-q', 'b')).toEqual({ ok: true })
    expect(ctx.wf().runs['run-q'].status).toBe('running')
    expect(ctx.stepStatus('run-q', 'a')).toBe('queued')

    ctx.agent.emit({ type: 'exited', executionId: 'pty-live', code: 1 })
    await flush()
    expect(ctx.agent.started.map((started) => `${started.runId}/${started.stepId}`)).toEqual(['run-q/a'])

    ctx.runner.complete(ctx.wf().runs['run-q'].steps.a.attemptIds[0], { status: 'done', summary: 'ok', completedBy: 'tool' })
    await flush()
    expect(ctx.agent.started.map((started) => `${started.runId}/${started.stepId}`)).toEqual(['run-q/a', 'run-q/c'])
    expect(ctx.wf().runs['run-q'].cursorStepId).toBe('c')
  })

  it('resumes a run with two step pauses only after both clear, acting on a non-first step first', async () => {
    const ctx = boot([
      fanInRecord('run-p', {
        steps: { a: 'running', b: 'running', c: 'pending' },
        attempts: [
          attempt('att-a', { stepId: 'a', executionId: 'pty-a' }),
          attempt('att-b', { stepId: 'b', executionId: 'pty-b' })
        ]
      })
    ])
    const seen = runEvents(ctx)
    ctx.runner.reconcile(ctx.records)
    await flush()

    expect(ctx.wf().runs['run-p']).toMatchObject({ status: 'paused', pausedReason: 'interrupted', cursorStepId: 'a' })
    expect([ctx.stepStatus('run-p', 'a'), ctx.stepStatus('run-p', 'b')]).toEqual(['interrupted', 'interrupted'])
    expect(seen).toEqual(['runPaused interrupted'])
    const persisted = ctx.lastPersisted('run-p')
    expect(persisted?.attempts.map((a) => a.metrics.pauses.map((pause) => pause.reason))).toEqual([
      ['interrupted'],
      ['interrupted']
    ])

    expect(ctx.runner.markDone('run-p', 'c', userDone)).toEqual({ ok: false, reason: 'wrong-step' })
    expect(ctx.runner.markDone('run-p', 'b', userDone)).toEqual({ ok: true })
    expect(ctx.stepStatus('run-p', 'b')).toBe('done')
    expect(ctx.wf().runs['run-p']).toMatchObject({ status: 'paused', pausedReason: 'interrupted' })
    expect(ctx.agent.started).toEqual([])

    expect(ctx.runner.markDone('run-p', 'a', userDone)).toEqual({ ok: true })
    await flush()
    expect(seen).toEqual(['runPaused interrupted', 'runResumed', 'cursorChanged c'])
    expect(ctx.agent.started.map((started) => started.stepId)).toEqual(['c'])
    expect(ctx.wf().runs['run-p']).toMatchObject({ status: 'running', cursorStepId: 'c' })
  })

  it('moves the run reason and cursor to the next pause when the head pause clears', async () => {
    const ctx = boot([
      fanInRecord('run-p', {
        status: 'paused',
        pausedReason: 'step-failed',
        steps: { a: 'failed', b: 'running', c: 'pending' },
        attempts: [
          attempt('att-a', { stepId: 'a', status: 'failed', endedAt: 6 }),
          attempt('att-b', { stepId: 'b', executionId: 'pty-b' })
        ]
      })
    ])
    const seen = runEvents(ctx)
    ctx.runner.reconcile(ctx.records)
    expect(ctx.wf().runs['run-p']).toMatchObject({ status: 'paused', pausedReason: 'step-failed', cursorStepId: 'a' })
    expect(seen).toEqual([])
    expect(ctx.lastPersisted('run-p')?.attempts[1].metrics.pauses.map((pause) => pause.reason)).toEqual(['interrupted'])

    expect(ctx.runner.retryStep('run-p', 'b')).toEqual({ ok: true })
    await flush()
    expect(ctx.agent.started.map((started) => started.stepId)).toEqual(['b'])
    expect(ctx.wf().runs['run-p']).toMatchObject({ status: 'paused', pausedReason: 'step-failed' })

    expect(ctx.runner.skipStep('run-p', 'a')).toEqual({ ok: true })
    expect(seen).toEqual(['runResumed', 'cursorChanged b'])
    expect(ctx.wf().runs['run-p']).toMatchObject({ status: 'running', cursorStepId: 'b' })
  })

  it('requeues a queued step of a paused run so it launches once the run resumes', async () => {
    const ctx = boot([
      fanInRecord('run-p', {
        status: 'paused',
        pausedReason: 'step-failed',
        steps: { a: 'queued', b: 'cancelled', c: 'pending' },
        cursor: 1
      })
    ])
    ctx.runner.reconcile(ctx.records)
    await flush()
    expect(ctx.logs).toContain('[workflow] run reconciled paused {"runId":"run-p"}')
    expect(ctx.agent.started).toEqual([])

    expect(ctx.runner.skipStep('run-p', 'b')).toEqual({ ok: true })
    await flush()
    expect(ctx.agent.started.map((started) => `${started.runId}/${started.stepId}`)).toEqual(['run-p/a'])
    expect(ctx.stepStatus('run-p', 'a')).toBe('running')
  })

  it('reattaches every live running attempt of a run and pauses each on its own', async () => {
    const ctx = boot(
      [
        fanInRecord('run-l', {
          steps: { a: 'running', b: 'running', c: 'pending' },
          attempts: [
            attempt('att-a', { stepId: 'a', executionId: 'pty-a' }),
            attempt('att-b', { stepId: 'b', executionId: 'pty-b' })
          ]
        })
      ],
      { alive: new Set(['pty-a', 'pty-b']) }
    )
    ctx.runner.reconcile(ctx.records)
    expect(ctx.logs).toContain('[workflow] run reconciled attached {"runId":"run-l"}')
    expect(ctx.runner.liveExecutionIds().sort()).toEqual(['pty-a', 'pty-b'])

    ctx.agent.emit({ type: 'needsApproval', executionId: 'pty-b' })
    expect(ctx.wf().runs['run-l']).toMatchObject({ status: 'paused', pausedReason: 'needs-approval', cursorStepId: 'b' })
    ctx.agent.emit({ type: 'exited', executionId: 'pty-a', code: 1 })
    expect(ctx.stepStatus('run-l', 'a')).toBe('failed')
    expect(ctx.wf().runs['run-l']).toMatchObject({ status: 'paused', pausedReason: 'needs-approval' })

    ctx.agent.emit({ type: 'promptSubmitted', executionId: 'pty-b' })
    expect(ctx.wf().runs['run-l']).toMatchObject({ status: 'paused', pausedReason: 'step-failed', cursorStepId: 'a' })
    expect(ctx.runner.getRunRecord('run-l')?.attempts.map((a) => a.metrics.pauses.map((pause) => pause.reason))).toEqual([
      ['step-failed'],
      ['needs-approval']
    ])
  })
})

const GATED_FAN_IN = FAN_IN.replace('    prompt: "a"\n', '    prompt: "a"\n    gate: approve\n').replace(
  '    prompt: "b"\n',
  '    prompt: "b"\n    gate: approve\n'
)

function gatedFanInRecord(runId: string, patch: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  const { definition } = validateWorkflowDefinition(GATED_FAN_IN)
  if (!definition) throw new Error('gated fan-in fixture invalid')
  return record(runId, {
    definition,
    status: 'paused',
    pausedReason: 'gate',
    cursor: 0,
    steps: { a: 'awaiting-gate', b: 'awaiting-gate', c: 'pending' },
    attempts: [
      attempt('att-a', { stepId: 'a', status: 'done', endedAt: 6, executionId: 'pty-a', sessionId: SESSION_A, result: { status: 'done', summary: 'a done', completedBy: 'tool' }, metrics: { continuations: 0, pauses: [{ reason: 'gate', at: 6 }] } }),
      attempt('att-b', { stepId: 'b', status: 'done', endedAt: 7, executionId: 'pty-b', result: { status: 'done', summary: 'b done', completedBy: 'tool' }, metrics: { continuations: 0, pauses: [{ reason: 'gate', at: 7 }] } })
    ],
    ...patch
  })
}

const SESSION_A = '0f8fad5b-d9cb-469f-a165-70867728950e'

describe('WorkflowRunner gates after a restart', () => {
  const ONE_GATED = ONE_AGENT.replace('    prompt: "plan"\n', '    prompt: "plan"\n    gate: approve\n') + '  - id: check\n    kind: shell\n    run: "true"\n'

  function gatedRecord(): WorkflowRunRecord {
    return record('run-g', {
      definition: definitionOf(ONE_GATED),
      status: 'paused',
      pausedReason: 'gate',
      cursor: 0,
      steps: { plan: 'awaiting-gate', check: 'pending' },
      attempts: [
        attempt('att-1', {
          status: 'done',
          endedAt: 6,
          executionId: 'pty-gone',
          sessionId: SESSION_A,
          result: { status: 'done', summary: 'planned', completedBy: 'tool' },
          metrics: { continuations: 0, pauses: [{ reason: 'gate', at: 6 }] }
        })
      ]
    })
  }

  it('reconciles a gate-paused v1 record without changing it, then approves it', async () => {
    const onDisk = gatedRecord()
    const ctx = boot([onDisk])
    const seen = runEvents(ctx)
    ctx.runner.reconcile(ctx.records)
    await flush()
    expect(ctx.logs).toContain('[workflow] run reconciled paused {"runId":"run-g"}')
    expect(ctx.persisted).toEqual([])
    expect(ctx.runner.getRunRecord('run-g')).toEqual(onDisk)
    expect(ctx.wf().runs['run-g']).toMatchObject({ status: 'paused', pausedReason: 'gate' })
    expect(ctx.stepStatus('run-g', 'plan')).toBe('awaiting-gate')
    expect(ctx.wf().attempts['att-1']).toMatchObject({ status: 'done' })
    expect(ctx.agent.started).toEqual([])
    expect(seen).toEqual([])

    expect(ctx.runner.approveGate('run-g', 'plan')).toEqual({ ok: true })
    await flush()
    expect(ctx.stepStatus('run-g', 'plan')).toBe('done')
    expect(ctx.shell.started.map((started) => started.stepId)).toEqual(['check'])
    expect(ctx.lastPersisted('run-g')).toMatchObject({ status: 'running', steps: { plan: 'done', check: 'running' } })

    const again = boot([])
    again.runner.reconcile([ctx.lastPersisted('run-g') as WorkflowRunRecord])
    expect(again.runner.approveGate('run-g', 'plan')).toEqual({ ok: false, reason: 'not-awaiting-gate' })
  })

  it('requests changes after a restart by resuming the recorded session with the feedback', async () => {
    const ctx = boot([gatedRecord()])
    ctx.runner.reconcile(ctx.records)
    expect(ctx.runner.requestChanges('run-g', 'plan', { feedback: 'add tests', fresh: false })).toEqual({ ok: true })
    await flush()
    expect(ctx.agent.continued).toEqual([])
    expect(ctx.agent.started).toHaveLength(1)
    expect(ctx.agent.started[0]).toMatchObject({ stepId: 'plan', n: 2, resumeSessionId: SESSION_A, prompt: 'add tests' })
    expect(ctx.wf().runs['run-g'].status).toBe('running')
  })

  it('seeds a gate pause for every step awaiting its gate and keeps their ended attempts', async () => {
    const ctx = boot([gatedFanInRecord('run-f')])
    const seen = runEvents(ctx)
    ctx.runner.reconcile(ctx.records)
    expect(ctx.wf().attempts['att-a'].status).toBe('done')
    expect(ctx.wf().attempts['att-b'].status).toBe('done')
    expect(ctx.runner.approveGate('run-f', 'a')).toEqual({ ok: true })
    await flush()
    expect(ctx.wf().runs['run-f']).toMatchObject({ status: 'paused', pausedReason: 'gate', cursorStepId: 'b' })
    expect(ctx.agent.started).toEqual([])
    expect(ctx.runner.approveGate('run-f', 'b')).toEqual({ ok: true })
    await flush()
    expect(ctx.agent.started.map((started) => started.stepId)).toEqual(['c'])
    expect(seen).toEqual(['cursorChanged b', 'cursorChanged c', 'runResumed'])
  })

  it('launches request changes on one gated sibling while the other gate still holds the run', async () => {
    const ctx = boot([gatedFanInRecord('run-f')], { alive: new Set(['pty-a']) })
    ctx.runner.reconcile(ctx.records)
    expect(ctx.runner.requestChanges('run-f', 'a', { feedback: 'again', fresh: false })).toEqual({ ok: true })
    await flush()
    expect(ctx.agent.continued).toEqual([expect.objectContaining({ executionId: 'pty-a', prompt: 'again' })])
    expect(ctx.stepStatus('run-f', 'a')).toBe('running')
    expect(ctx.wf().runs['run-f']).toMatchObject({ status: 'paused', pausedReason: 'gate', cursorStepId: 'b' })
    expect(ctx.stepStatus('run-f', 'b')).toBe('awaiting-gate')
  })

  it('launches a queued request changes once a slot frees while the other gate still holds the run', async () => {
    const ctx = boot(
      [
        record('run-x', { steps: { plan: 'running' }, startedAt: 5, attempts: [attempt('att-x', { executionId: 'pty-live' })] }),
        gatedFanInRecord('run-f', { startedAt: 10 })
      ],
      { cap: 1, alive: new Set(['pty-live']) }
    )
    ctx.runner.reconcile(ctx.records)
    expect(ctx.runner.requestChanges('run-f', 'a', { feedback: 'again', fresh: false })).toEqual({ ok: true })
    expect(ctx.stepStatus('run-f', 'a')).toBe('queued')
    ctx.agent.emit({ type: 'exited', executionId: 'pty-live', code: 1 })
    await flush()
    expect(ctx.agent.started.map((started) => `${started.runId}/${started.stepId}`)).toEqual(['run-f/a'])
    expect(ctx.agent.started[0]).toMatchObject({ resumeSessionId: SESSION_A, prompt: 'again' })
    expect(ctx.stepStatus('run-f', 'b')).toBe('awaiting-gate')
    expect(ctx.wf().runs['run-f']).toMatchObject({ status: 'paused', pausedReason: 'gate' })
  })

  it('keeps a queued step without a continuation blocked while another step holds the run, until that gate is approved', async () => {
    const ctx = boot(
      [
        record('run-x', { steps: { plan: 'running' }, startedAt: 5, attempts: [attempt('att-x', { executionId: 'pty-live' })] }),
        gatedFanInRecord('run-f', {
          startedAt: 10,
          steps: { a: 'awaiting-gate', b: 'queued', c: 'pending' },
          attempts: gatedFanInRecord('run-f').attempts.slice(0, 1)
        })
      ],
      { cap: 1, alive: new Set(['pty-live']) }
    )
    ctx.runner.reconcile(ctx.records)
    ctx.agent.emit({ type: 'exited', executionId: 'pty-live', code: 1 })
    await flush()
    expect(ctx.agent.started).toEqual([])
    expect(ctx.stepStatus('run-f', 'b')).toBe('queued')
    expect(ctx.runner.approveGate('run-f', 'a')).toEqual({ ok: true })
    await flush()
    expect(ctx.agent.started.map((started) => `${started.runId}/${started.stepId}`)).toEqual(['run-f/b'])
  })

  it('keeps a queued continuation blocked while its own step is paused', async () => {
    const ctx = boot([
      gatedFanInRecord('run-f', {
        pausedReason: 'step-failed',
        steps: { a: 'queued', b: 'awaiting-gate', c: 'pending' },
        attempts: gatedFanInRecord('run-f').attempts.slice(1),
        continuations: { a: { prompt: 'again' } }
      })
    ])
    ctx.runner.reconcile(ctx.records)
    await flush()
    expect(ctx.agent.started).toEqual([])
    expect(ctx.stepStatus('run-f', 'a')).toBe('queued')
  })
})

describe('WorkflowRunner loops after a restart', () => {
  const LOOP_CAP = `name: loop-cap
steps:
  - id: build
    agent: claude
    prompt: "build"
  - id: review
    agent: claude
    permissions: read-only
    prompt: "review"
    output:
      verdict: { enum: [pass, fail] }
    loop: { back_to: build, until: { field: verdict, equals: pass }, max: 2 }
  - id: after
    kind: shell
    run: "true"
`
  const SESSION_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

  function pass(stepId: 'build' | 'review', n: number, summary: string, patch: Partial<WorkflowAttemptRecord> = {}): WorkflowAttemptRecord {
    return attempt(`att-${stepId}-${n}`, {
      stepId,
      n,
      status: 'done',
      startedAt: 5 + n,
      endedAt: 6 + n,
      executionId: `pty-${stepId}-${n}`,
      sessionId: stepId === 'build' ? SESSION_A : SESSION_B,
      result: { status: 'done', summary, completedBy: 'tool', ...(stepId === 'review' ? { data: { verdict: 'fail' } } : {}) },
      ...patch
    })
  }

  function loopRecord(patch: Partial<WorkflowRunRecord>): WorkflowRunRecord {
    return record('run-l', {
      defId: 'personal:loop-cap',
      definition: definitionOf(LOOP_CAP),
      ...patch
    })
  }

  function cappedRecord(): WorkflowRunRecord {
    return loopRecord({
      status: 'paused',
      pausedReason: 'loop-cap',
      cursor: 1,
      steps: { build: 'done', review: 'done', after: 'pending' },
      attempts: [
        pass('build', 1, 'built-1'),
        pass('review', 1, 'review-1'),
        pass('build', 2, 'built-2'),
        pass('review', 2, 'review-2', { metrics: { continuations: 0, pauses: [{ reason: 'loop-cap', at: 9 }] } })
      ]
    })
  }

  it('keeps a loop-cap pause on the looping step across a restart and continues anyway into the dependents', async () => {
    const onDisk = cappedRecord()
    const ctx = boot([onDisk])
    ctx.runner.reconcile(ctx.records)
    await flush()
    expect(ctx.logs).toContain('[workflow] run reconciled paused {"runId":"run-l"}')
    expect(ctx.runner.getRunRecord('run-l')).toEqual(onDisk)
    expect(ctx.wf().runs['run-l']).toMatchObject({ status: 'paused', pausedReason: 'loop-cap', cursorStepId: 'review' })
    expect(ctx.runner.resolveLoopCap('run-l', 'after', 'continue')).toEqual({ ok: false, reason: 'not-at-loop-cap' })
    expect(ctx.runner.resolveLoopCap('run-l', 'review', 'continue')).toEqual({ ok: true })
    await flush()
    expect(ctx.shell.started.map((started) => started.stepId)).toEqual(['after'])
    expect(ctx.agent.started).toEqual([])
    expect(ctx.lastPersisted('run-l')).toMatchObject({ status: 'running', steps: { review: 'done', after: 'running' } })
  })

  it('loops again after a restart by resuming the back_to step with the loop feedback', async () => {
    const ctx = boot([cappedRecord()])
    ctx.runner.reconcile(ctx.records)
    expect(ctx.runner.resolveLoopCap('run-l', 'review', 'again')).toEqual({ ok: true })
    await flush()
    expect(ctx.agent.started).toHaveLength(1)
    expect(ctx.agent.started[0]).toMatchObject({
      stepId: 'build',
      n: 3,
      resumeSessionId: SESSION_A,
      prompt: 'Your previous result was:\nbuilt-2\n\nAddress this feedback from review:\nreview-2'
    })
    expect(ctx.wf().runs['run-l']).toMatchObject({ status: 'running', cursorStepId: 'build' })
    ctx.runner.complete(ctx.agent.started[0].attemptId, { status: 'done', summary: 'built-3', completedBy: 'tool' })
    await flush()
    expect(ctx.agent.started[1]).toMatchObject({ stepId: 'review', n: 3, resumeSessionId: SESSION_B })
    ctx.runner.complete(ctx.agent.started[1].attemptId, { status: 'done', summary: 'review-3', completedBy: 'tool', data: { verdict: 'fail' } })
    await flush()
    expect(ctx.wf().runs['run-l']).toMatchObject({ status: 'paused', pausedReason: 'loop-cap', cursorStepId: 'review' })
    expect(ctx.shell.started).toEqual([])
  })

  it('launches a queued loop continuation recorded before the restart', async () => {
    const ctx = boot([
      loopRecord({
        cursor: 0,
        steps: { build: 'queued', review: 'pending', after: 'pending' },
        attempts: [pass('build', 1, 'built-1'), pass('review', 1, 'review-1')],
        continuations: { build: { prompt: 'fix it' } }
      })
    ])
    ctx.runner.reconcile(ctx.records)
    await flush()
    expect(ctx.logs).toContain('[workflow] run reconciled requeued {"runId":"run-l"}')
    expect(ctx.agent.started).toHaveLength(1)
    expect(ctx.agent.started[0]).toMatchObject({ stepId: 'build', n: 2, resumeSessionId: SESSION_A, prompt: 'fix it' })
    expect(ctx.runner.getRunRecord('run-l')?.continuations).toBeUndefined()
    ctx.runner.complete(ctx.agent.started[0].attemptId, { status: 'done', summary: 'built-2', completedBy: 'tool' })
    await flush()
    expect(ctx.agent.started[1]).toMatchObject({
      stepId: 'review',
      n: 2,
      resumeSessionId: SESSION_B,
      prompt: 'Your previous result was:\nreview-1\n\nAddress this feedback from review:\nreview-1'
    })
  })

  it('interrupts a span step that was running mid-loop and still re-enters the looping step after a retry', async () => {
    const ctx = boot([
      loopRecord({
        cursor: 0,
        steps: { build: 'running', review: 'pending', after: 'pending' },
        attempts: [
          pass('build', 1, 'built-1'),
          pass('review', 1, 'review-1'),
          attempt('att-build-2', { stepId: 'build', n: 2, startedAt: 9, executionId: 'pty-dead', sessionId: SESSION_A })
        ]
      })
    ])
    ctx.runner.reconcile(ctx.records)
    await flush()
    expect(ctx.wf().runs['run-l']).toMatchObject({ status: 'paused', pausedReason: 'interrupted', cursorStepId: 'build' })
    expect(ctx.stepStatus('run-l', 'review')).toBe('pending')
    expect(ctx.agent.started).toEqual([])
    expect(ctx.runner.resumeStep('run-l', 'build')).toEqual({ ok: true })
    await flush()
    expect(ctx.agent.started[0]).toMatchObject({ stepId: 'build', n: 3, resumeSessionId: SESSION_A })
    ctx.runner.complete(ctx.agent.started[0].attemptId, { status: 'done', summary: 'built-2', completedBy: 'tool' })
    await flush()
    expect(ctx.agent.started[1]).toMatchObject({
      stepId: 'review',
      n: 2,
      resumeSessionId: SESSION_B,
      prompt: 'Your previous result was:\nreview-1\n\nAddress this feedback from review:\nreview-1'
    })
    ctx.runner.complete(ctx.agent.started[1].attemptId, { status: 'done', summary: 'review-2', completedBy: 'tool', data: { verdict: 'pass' } })
    await flush()
    expect(ctx.shell.started.map((started) => started.stepId)).toEqual(['after'])
  })
})

import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { registerWorkflowsRequestHandlers } from '.'
import { createWorkflowDefsLoader } from '../workflow-defs-loader'
import { createWorkflowRunLookup, createWorkflowRunRecords, type WorkflowRunRecords } from '../workflow-run-records'
import type {
  WorkflowAttemptRecord,
  WorkflowDefinitionDetail,
  WorkflowRunRecord,
  WorkflowsEvent
} from '../../shared/state/workflows'

const VALID_YAML = `name: Valid flow
steps:
  - id: plan
    agent: claude
    prompt: Plan it
`

type Handler = (ctx: unknown, payload: unknown) => unknown

class FakeTransport {
  readonly handlers = new Map<string, Handler>()

  onRequest(name: string, handler: Handler): void {
    this.handlers.set(name, handler)
  }

  async call(name: string, payload?: unknown): Promise<unknown> {
    const handler = this.handlers.get(name)
    if (!handler) throw new Error(`no handler for ${name}`)
    return handler({ clientId: 'client-1' }, payload)
  }
}

let dir: string
let dispatched: WorkflowsEvent[]
let transport: FakeTransport
let records: WorkflowRunRecords
let liveRuns: Map<string, WorkflowRunRecord>
let attemptRuns: Map<string, string>

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
  const loader = createWorkflowDefsLoader({ dir, dispatch: (event) => dispatched.push(event), log: () => {} })
  records = createWorkflowRunRecords({ dir: join(dir, 'workflow-runs'), log: () => {} })
  const runs = createWorkflowRunLookup({
    live: (runId) => liveRuns.get(runId) ?? null,
    liveAttemptRunId: (attemptId) =>
      [...liveRuns.values()].find((run) => run.attempts.some((a) => a.attemptId === attemptId))?.runId,
    records,
    attemptRunId: (attemptId) => attemptRuns.get(attemptId)
  })
  registerWorkflowsRequestHandlers({ transport, loader, runs })
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

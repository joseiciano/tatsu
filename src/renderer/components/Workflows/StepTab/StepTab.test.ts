import { describe, expect, it } from 'vitest'
import {
  buildMarkDoneFields,
  cancelStepThenClose,
  initialMarkDoneValues,
  markDonePayload,
  stepTabCloseDecision,
  stepTabOverlayMode,
  type MarkDoneField
} from '.'
import type { TerminalTab } from '../../../../shared/state/terminals'
import type {
  WorkflowAttempt,
  WorkflowAttemptRecord,
  WorkflowAttemptStatus,
  WorkflowPausedReason,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowStepStatus
} from '../../../../shared/state/workflows'
import type { ResolvedAgentStep, ResolvedShellStep, WorkflowOutputSchema } from '../../../../shared/workflow-def'

const WORKFLOW = { runId: 'run-1', stepId: 'fix', attemptId: 'att-2' }
const stepTab: TerminalTab = { id: 't1', type: 'agent', label: '⚙ fix · Claude', workflow: WORKFLOW }
const plainTab: TerminalTab = { id: 't2', type: 'agent', label: 'Claude' }

function sliceAttempt(status: WorkflowAttemptStatus): WorkflowAttempt {
  return { runId: 'run-1', stepId: 'fix', n: 2, status, summaryPreview: '', startedAt: 1 }
}

describe('stepTabCloseDecision', () => {
  it.each<[string, TerminalTab, WorkflowAttempt | null, 'confirm-cancel' | 'close']>([
    ['running attempt', stepTab, sliceAttempt('running'), 'confirm-cancel'],
    ['done attempt', stepTab, sliceAttempt('done'), 'close'],
    ['failed attempt', stepTab, sliceAttempt('failed'), 'close'],
    ['cancelled attempt', stepTab, sliceAttempt('cancelled'), 'close'],
    ['interrupted attempt', stepTab, sliceAttempt('interrupted'), 'close'],
    ['attempt unknown to this client (evicted run)', stepTab, null, 'close'],
    ['non-step tab', plainTab, null, 'close'],
    ['non-step tab even with a running attempt passed', plainTab, sliceAttempt('running'), 'close']
  ])('%s -> %s', (_name, tab, attempt, expected) => {
    expect(stepTabCloseDecision(tab, attempt)).toBe(expected)
  })
})

function agentStep(id: string, output?: WorkflowOutputSchema): ResolvedAgentStep {
  return { id, kind: 'agent', agent: 'claude', prompt: 'go', permissions: 'edit', allow: [], needs: [], output }
}

function attemptRecord(attemptId: string, stepId: string, status: WorkflowAttemptStatus): WorkflowAttemptRecord {
  return { attemptId, stepId, n: 1, status, startedAt: 1, metrics: { continuations: 0, pauses: [] } }
}

interface RunOpts {
  status?: WorkflowRunStatus
  reason?: WorkflowPausedReason
  cursor?: number
  stepStatus?: WorkflowStepStatus
  attempts?: WorkflowAttemptRecord[]
}

function runRecord({
  status = 'paused',
  reason = 'step-failed',
  cursor = 1,
  stepStatus = 'failed',
  attempts = [attemptRecord('att-1', 'fix', 'failed'), attemptRecord('att-2', 'fix', 'failed')]
}: RunOpts = {}): WorkflowRunRecord {
  return {
    version: 1,
    runId: 'run-1',
    defId: 'personal:d',
    defHash: 'h',
    definition: { name: 'd', inputs: {}, steps: [agentStep('plan'), agentStep('fix'), agentStep('ship')] },
    inputs: {},
    worktreePath: '/wt',
    contextPath: '/wt/.harness/runs/run-1/context.md',
    status,
    ...(status === 'paused' ? { pausedReason: reason } : {}),
    cursor,
    steps: { plan: 'done', fix: stepStatus, ship: 'pending' },
    startedAt: 1,
    attempts: [attemptRecord('att-0', 'plan', 'done'), ...attempts]
  }
}

describe('stepTabOverlayMode', () => {
  const failed = attemptRecord('att-2', 'fix', 'failed')
  it.each<[string, TerminalTab, WorkflowAttemptRecord | null, WorkflowRunRecord | null, string]>([
    ['non-step tab', plainTab, null, null, 'default'],
    ['step tab before the records load', stepTab, null, null, 'result'],
    ['step-failed pause on this attempt', stepTab, failed, runRecord(), 'result-with-mark-done'],
    ['needs-input pause on this attempt', stepTab, failed, runRecord({ reason: 'needs-input' }), 'result-with-mark-done'],
    ['cancelled step', stepTab, failed, runRecord({ stepStatus: 'cancelled' }), 'result-with-mark-done'],
    ['interrupted step', stepTab, failed, runRecord({ stepStatus: 'interrupted' }), 'result-with-mark-done'],
    ['needs-input with the attempt still live', stepTab, failed, runRecord({ reason: 'needs-input', stepStatus: 'running' }), 'result-with-mark-done'],
    ['timeout with the attempt still live', stepTab, failed, runRecord({ reason: 'timeout', stepStatus: 'running' }), 'result-with-mark-done'],
    ['other pause reason', stepTab, failed, runRecord({ reason: 'interrupted' }), 'result'],
    ['needs-approval pause', stepTab, failed, runRecord({ reason: 'needs-approval' }), 'result'],
    ['run is running', stepTab, failed, runRecord({ status: 'running' }), 'result'],
    ['run finished', stepTab, failed, runRecord({ status: 'failed' }), 'result'],
    ['cursor on another step', stepTab, failed, runRecord({ cursor: 2 }), 'result'],
    ['step already done', stepTab, failed, runRecord({ stepStatus: 'done' }), 'result'],
    [
      'older attempt of the paused step',
      stepTab,
      failed,
      runRecord({ attempts: [attemptRecord('att-2', 'fix', 'failed'), attemptRecord('att-3', 'fix', 'failed')] }),
      'result'
    ]
  ])('%s -> %s', (_name, tab, attempt, run, expected) => {
    expect(stepTabOverlayMode(tab, attempt, run)).toBe(expected)
  })

  it('never yields default for a step tab', () => {
    const runs = [null, runRecord(), runRecord({ status: 'done' }), runRecord({ reason: 'trust' })]
    for (const run of runs) expect(stepTabOverlayMode(stepTab, failed, run)).not.toBe('default')
  })
})

const OUTPUT: WorkflowOutputSchema = {
  fields: {
    title: { type: 'string' },
    count: { type: 'number' },
    ok: { type: 'boolean' },
    level: { enum: ['low', 2, true] },
    tags: { type: 'array', items: { type: 'string' } },
    sizes: { type: 'array', items: { type: 'number' } },
    note: {}
  },
  required: ['title', 'count']
}

describe('buildMarkDoneFields', () => {
  it('maps each output field kind to an input descriptor', () => {
    expect(buildMarkDoneFields(agentStep('fix', OUTPUT))).toEqual<MarkDoneField[]>([
      { kind: 'text', name: 'title', required: true },
      { kind: 'number', name: 'count', required: true },
      { kind: 'boolean', name: 'ok', required: false },
      { kind: 'enum', name: 'level', required: false, options: ['low', 2, true] },
      { kind: 'list', name: 'tags', required: false, itemType: 'string' },
      { kind: 'list', name: 'sizes', required: false, itemType: 'number' },
      { kind: 'text', name: 'note', required: false }
    ])
  })

  it('gives a summary-only form to shell steps and steps without outputs', () => {
    const shell: ResolvedShellStep = { id: 'test', kind: 'shell', run: 'pnpm test', needs: [] }
    expect(buildMarkDoneFields(shell)).toEqual([])
    expect(buildMarkDoneFields(agentStep('fix'))).toEqual([])
    expect(buildMarkDoneFields(undefined)).toEqual([])
  })

  it('drops reserved and forbidden names', () => {
    const step = agentStep('fix', { fields: { status: {}, summary: {}, constructor: {}, real: {} } })
    expect(buildMarkDoneFields(step).map((f) => f.name)).toEqual(['real'])
  })

  it('treats a typed field with an enum as an enum', () => {
    const step = agentStep('fix', { fields: { size: { type: 'number', enum: [1, 2] } } })
    expect(buildMarkDoneFields(step)).toEqual([{ kind: 'enum', name: 'size', required: false, options: [1, 2] }])
  })
})

describe('markDonePayload', () => {
  const step = agentStep('fix', OUTPUT)
  const fields = buildMarkDoneFields(step)

  it('starts from blank values with unchecked booleans', () => {
    expect(initialMarkDoneValues(fields)).toEqual({
      title: '',
      count: '',
      ok: false,
      level: '',
      tags: '',
      sizes: '',
      note: ''
    })
  })

  it('serialises every field kind to the markDone payload', () => {
    const result = markDonePayload(step, 'fixed by hand', {
      title: 'Fix',
      count: ' 3 ',
      ok: true,
      level: '1',
      tags: 'a\n\n b \n',
      sizes: '1\n2.5',
      note: 'n'
    })
    expect(result).toEqual({
      ok: true,
      payload: {
        summary: 'fixed by hand',
        fields: { title: 'Fix', count: 3, ok: true, level: 2, tags: ['a', 'b'], sizes: [1, 2.5], note: 'n' }
      }
    })
  })

  it('omits blank optional fields and sends unchecked booleans as false', () => {
    const result = markDonePayload(step, 's', { ...initialMarkDoneValues(fields), title: 'T', count: '0' })
    expect(result).toEqual({ ok: true, payload: { summary: 's', fields: { title: 'T', count: 0, ok: false } } })
  })

  it('maps enum options by index back to their original scalar', () => {
    const values = { ...initialMarkDoneValues(fields), title: 'T', count: '1' }
    const pick = (level: string): unknown => {
      const r = markDonePayload(step, 's', { ...values, level })
      return r.ok ? r.payload.fields.level : r
    }
    expect([pick('0'), pick('1'), pick('2')]).toEqual(['low', 2, true])
  })

  it('reports required, number and list item errors per field', () => {
    const result = markDonePayload(step, 's', {
      ...initialMarkDoneValues(fields),
      count: 'many',
      sizes: '1\nlots'
    })
    expect(result).toEqual({
      ok: false,
      errors: { count: 'Expected a number', sizes: 'Expected a number', title: 'Required' }
    })
  })

  it('requires a summary', () => {
    const result = markDonePayload(agentStep('fix'), '', {})
    expect(result).toEqual({ ok: false, errors: { summary: 'Required' } })
  })

  it('sends a summary-only payload for steps without outputs', () => {
    const shell: ResolvedShellStep = { id: 'test', kind: 'shell', run: 'x', needs: [] }
    expect(markDonePayload(shell, 'ran it myself', {})).toEqual({
      ok: true,
      payload: { summary: 'ran it myself', fields: {} }
    })
  })
})

describe('cancelStepThenClose', () => {
  it('closes only after the cancel succeeds', async () => {
    const calls: string[] = []
    const error = await cancelStepThenClose(
      async () => {
        calls.push('cancel')
        return { ok: true }
      },
      () => calls.push('close')
    )
    expect(error).toBeNull()
    expect(calls).toEqual(['cancel', 'close'])
  })

  it('keeps the tab and returns the error when the cancel is refused', async () => {
    let closed = false
    const error = await cancelStepThenClose(
      async () => ({ error: 'The step is not running or queued' }),
      () => {
        closed = true
      }
    )
    expect(error).toBe('The step is not running or queued')
    expect(closed).toBe(false)
  })

  it('keeps the tab when the request throws', async () => {
    let closed = false
    const error = await cancelStepThenClose(
      async () => {
        throw new Error('offline')
      },
      () => {
        closed = true
      }
    )
    expect(error).toBe('Could not cancel the step')
    expect(closed).toBe(false)
  })
})

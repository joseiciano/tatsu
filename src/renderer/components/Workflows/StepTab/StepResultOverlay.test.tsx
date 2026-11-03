// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StepResultOverlay } from './StepResultOverlay'
import type { WorkflowAttemptRecord, WorkflowRun, WorkflowRunRecord } from '../../../../shared/state/workflows'

const { backendApi, slice } = vi.hoisted(() => ({
  backendApi: {
    getWorkflowAttemptResult: vi.fn(),
    getWorkflowRun: vi.fn(),
    markWorkflowStepDone: vi.fn()
  },
  slice: { run: null as WorkflowRun | null }
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../backend', () => ({ useBackend: () => backendApi }))
vi.mock('../../../store', () => ({
  useWorkflowAttempt: () => null,
  useWorkflowRun: () => slice.run
}))

const WORKFLOW = { runId: 'run-1', stepId: 'fix', attemptId: 'att-1' }

const ATTEMPT: WorkflowAttemptRecord = {
  attemptId: 'att-1',
  stepId: 'fix',
  n: 1,
  status: 'failed',
  startedAt: 1,
  endedAt: 2,
  result: { status: 'failed', summary: 'Tests still fail', completedBy: 'exit' },
  metrics: { completedBy: 'exit', continuations: 0, pauses: [] }
}

function record(status: WorkflowRunRecord['status']): WorkflowRunRecord {
  return {
    version: 1,
    runId: 'run-1',
    defId: 'personal:d',
    defHash: 'h',
    definition: {
      name: 'd',
      inputs: {},
      steps: [{ id: 'fix', kind: 'agent', agent: 'claude', prompt: 'go', permissions: 'edit', allow: [], needs: [] }]
    },
    inputs: {},
    worktreePath: '/wt',
    contextPath: '/wt/ctx.md',
    status,
    ...(status === 'paused' ? { pausedReason: 'step-failed' as const } : {}),
    cursor: 0,
    steps: { fix: 'failed' },
    startedAt: 1,
    attempts: [ATTEMPT]
  }
}

function sliceRun(status: WorkflowRun['status']): WorkflowRun {
  return { defId: 'personal:d', defHash: 'h', worktreePath: '/wt', status, startedAt: 1, steps: {} }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  backendApi.getWorkflowAttemptResult.mockReset().mockResolvedValue(ATTEMPT)
  backendApi.getWorkflowRun.mockReset().mockResolvedValue(record('paused'))
  backendApi.markWorkflowStepDone.mockReset().mockResolvedValue({ ok: true })
  slice.run = sliceRun('paused')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(): Promise<void> {
  await act(async () => {
    root.render(<StepResultOverlay workflow={WORKFLOW} title="Claude exited." />)
  })
}

describe('StepResultOverlay', () => {
  it('shows the attempt result and a Mark done form for the paused step, never a new session', async () => {
    await render()
    const text = container.textContent ?? ''
    expect(text).toContain('Claude exited.')
    expect(text).toContain('failed')
    expect(text).toContain('process exit')
    expect(text).toContain('Tests still fail')
    expect(text).not.toContain('Start a new session')
    expect(container.querySelector('form[aria-label="Mark step done"]')).not.toBeNull()
  })

  it('calls markDone for the tab step', async () => {
    await render()
    const summary = container.querySelector('textarea')
    await act(async () => {
      if (!summary) return
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(summary, 'did it')
      summary.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click()
    })
    expect(backendApi.markWorkflowStepDone).toHaveBeenCalledWith('run-1', 'fix', { summary: 'did it', fields: {} })
  })

  it('refetches when the run changes in the slice and drops the form once the run moves on', async () => {
    await render()
    backendApi.getWorkflowRun.mockResolvedValue(record('running'))
    slice.run = sliceRun('running')
    await render()
    expect(backendApi.getWorkflowRun).toHaveBeenCalledTimes(2)
    expect(container.querySelector('form')).toBeNull()
    expect(container.textContent).toContain('Tests still fail')
  })

  it('shows the Mark done completion once the user marks the exited step done', async () => {
    const markedDone: WorkflowAttemptRecord = {
      attemptId: 'att-2',
      stepId: 'fix',
      n: 2,
      status: 'done',
      startedAt: 3,
      endedAt: 3,
      result: { status: 'done', summary: 'Fixed by hand', completedBy: 'user' },
      metrics: { continuations: 0, pauses: [] }
    }
    backendApi.getWorkflowRun.mockResolvedValue({ ...record('done'), steps: { fix: 'done' }, attempts: [ATTEMPT, markedDone] })
    slice.run = sliceRun('done')
    await render()
    const text = container.textContent ?? ''
    expect(text).toContain('you (Mark done)')
    expect(text).toContain('Fixed by hand')
    expect(text).not.toContain('process exit')
    expect(container.querySelector('form')).toBeNull()
  })
})

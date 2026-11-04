// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StepStripLine } from './StepStrip'
import { deriveStepStrip } from '../workflow-run-helpers'
import type { WorkflowRun, WorkflowStepStatus } from '../../../../shared/state/workflows'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ORDER = ['plan', 'left', 'right', 'join']

function run(steps: Record<string, WorkflowStepStatus>): WorkflowRun {
  return {
    defId: 'personal:diamond',
    defHash: 'h1',
    worktreePath: '/wt/a',
    status: 'running',
    startedAt: 1,
    steps: Object.fromEntries(Object.entries(steps).map(([id, status]) => [id, { status, attemptIds: [] }]))
  }
}

describe('StepStripLine', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('announces and draws every running branch as running', () => {
    const entries = deriveStepStrip(run({ plan: 'done', left: 'running', right: 'running', join: 'pending' }), ORDER)
    act(() => root.render(<StepStripLine entries={entries} />))
    const strip = host.querySelector('[role="img"]')
    expect(strip?.getAttribute('aria-label')).toBe('Workflow steps: plan done, left running, right running, join pending')
    expect(strip?.textContent).toBe('plan ✓ → left ● → right ● → join ○')
  })
})

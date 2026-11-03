import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { Server } from 'http'
import { getControlServerInfo, startControlServer, type ControlServerDeps, type WorkflowStepControl } from '.'
import { CONTROL_WORKFLOW_MAX_BODY_BYTES } from './constants'
import { outputJsonSchema, type StepOutputValue, type WorkflowOutputSchema } from '../../shared/workflow-def'
import type { StopCheckDecision, WorkflowExecutionStep } from '../workflow-runner'

vi.mock('../debug', () => ({ log: vi.fn() }))

const output: WorkflowOutputSchema = {
  fields: { verdict: { enum: ['pass', 'fail'] }, notes: { type: 'array', items: { type: 'string' } } },
  required: ['verdict']
}

class FakeWorkflow implements WorkflowStepControl {
  labs = true
  readonly steps = new Map<string, WorkflowExecutionStep>()
  readonly completed: Array<{ terminalId: string; value: StepOutputValue }> = []
  readonly stopChecks: Array<{ terminalId: string; stopHookActive: boolean }> = []
  decision: StopCheckDecision = 'block'

  enabled(): boolean {
    return this.labs
  }

  stepFor(terminalId: string): WorkflowExecutionStep | null {
    return this.labs ? (this.steps.get(terminalId) ?? null) : null
  }

  complete(terminalId: string, value: StepOutputValue): { ok: true } | { ok: false; reason: 'not-a-step' | 'already-completed' } {
    const step = this.steps.get(terminalId)
    if (!step) return { ok: false, reason: 'not-a-step' }
    if (step.ended) return { ok: false, reason: 'already-completed' }
    this.completed.push({ terminalId, value })
    this.steps.set(terminalId, { attemptId: step.attemptId, stepId: step.stepId, ended: true })
    return { ok: true }
  }

  stopCheck(terminalId: string, stopHookActive: boolean): StopCheckDecision {
    this.stopChecks.push({ terminalId, stopHookActive })
    return this.decision
  }
}

const unused = (): never => {
  throw new Error('not used by workflow routes')
}

const workflow = new FakeWorkflow()
let withWorkflow = true

const deps: ControlServerDeps = {
  getRepoRoots: () => [],
  getWorktreeBase: () => 'local',
  getPrReviewPrompt: () => '',
  broadcast: () => {},
  runWorktreeSetup: unused,
  runPendingPRWorktree: unused,
  resolveCallerScope: () => null,
  getBrowserPerms: () => ({ enabled: false, mode: 'view' }),
  browser: new Proxy({} as ControlServerDeps['browser'], { get: () => unused }),
  shell: new Proxy({} as ControlServerDeps['shell'], { get: () => unused }),
  get workflow() {
    return withWorkflow ? workflow : undefined
  }
}

let server: Server
let base = ''
let token = ''

beforeAll(async () => {
  server = await startControlServer(deps)
  const info = getControlServerInfo()
  if (!info) throw new Error('control server did not start')
  base = `http://127.0.0.1:${info.port}`
  token = info.token
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

beforeEach(() => {
  withWorkflow = true
  workflow.labs = true
  workflow.steps.clear()
  workflow.completed.length = 0
  workflow.stopChecks.length = 0
  workflow.decision = 'block'
  workflow.steps.set('term-a', { attemptId: 'att-a', stepId: 'review', output, ended: false })
  workflow.steps.set('term-b', { attemptId: 'att-b', stepId: 'review', output, ended: false })
})

async function call(
  method: 'GET' | 'POST',
  path: string,
  { terminalId, body }: { terminalId?: string; body?: string | Record<string, unknown> } = {}
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(terminalId === undefined ? {} : { 'X-Harness-Terminal-Id': terminalId })
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) })
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

describe('GET /workflow/step', () => {
  it('returns the attempt and the input schema for a step terminal', async () => {
    expect(await call('GET', '/workflow/step', { terminalId: 'term-a' })).toEqual({
      status: 200,
      json: { attemptId: 'att-a', stepId: 'review', inputSchema: outputJsonSchema({ output }) }
    })
  })

  it.each([
    { name: 'a non-step terminal', terminalId: 'term-x', prepare: () => {}, error: 'not a workflow step' },
    {
      name: 'an ended attempt',
      terminalId: 'term-a',
      prepare: () => workflow.steps.set('term-a', { attemptId: 'att-a', stepId: 'review', ended: true }),
      error: 'not a workflow step'
    },
    { name: 'labs off', terminalId: 'term-a', prepare: () => (workflow.labs = false), error: 'workflows disabled' },
    { name: 'no workflow seam', terminalId: 'term-a', prepare: () => (withWorkflow = false), error: 'workflows disabled' }
  ])('is 404 for $name', async ({ terminalId, prepare, error }) => {
    prepare()
    expect(await call('GET', '/workflow/step', { terminalId })).toEqual({ status: 404, json: { error } })
  })

  it('needs the terminal id header', async () => {
    expect((await call('GET', '/workflow/step')).status).toBe(400)
  })

  it('needs the bearer token', async () => {
    const res = await fetch(`${base}/workflow/step`, { headers: { 'X-Harness-Terminal-Id': 'term-a' } })
    expect(res.status).toBe(401)
  })
})

describe('POST /workflow/complete', () => {
  it('passes a validated result to complete', async () => {
    const res = await call('POST', '/workflow/complete', {
      terminalId: 'term-a',
      body: { summary: 'fine', verdict: 'pass', notes: ['a'] }
    })
    expect(res).toEqual({ status: 200, json: { ok: true } })
    expect(workflow.completed).toEqual([
      { terminalId: 'term-a', value: { status: 'done', summary: 'fine', data: { verdict: 'pass', notes: ['a'] } } }
    ])
  })

  it("never lets terminal B complete terminal A's attempt", async () => {
    const res = await call('POST', '/workflow/complete', {
      terminalId: 'term-b',
      body: { attemptId: 'att-a', stepId: 'review', status: 'failed', summary: 'x', verdict: 'fail' }
    })
    expect(res.status).toBe(200)
    expect(workflow.completed).toEqual([
      { terminalId: 'term-b', value: { status: 'failed', summary: 'x', data: { verdict: 'fail' } } }
    ])
    expect(workflow.steps.get('term-a')?.ended).toBe(false)
  })

  it('keeps attemptId and stepId when the step declares them as output fields', async () => {
    const declared: WorkflowOutputSchema = { fields: { attemptId: { type: 'string' }, stepId: { type: 'string' } } }
    workflow.steps.set('term-b', { attemptId: 'att-b', stepId: 'review', output: declared, ended: false })
    const res = await call('POST', '/workflow/complete', {
      terminalId: 'term-b',
      body: { summary: 's', attemptId: 'att-a', stepId: 'other' }
    })
    expect(res).toEqual({ status: 200, json: { ok: true } })
    expect(workflow.completed).toEqual([
      { terminalId: 'term-b', value: { status: 'done', summary: 's', data: { attemptId: 'att-a', stepId: 'other' } } }
    ])
    expect(workflow.steps.get('term-a')?.ended).toBe(false)
    expect(workflow.steps.get('term-b')?.ended).toBe(true)
  })

  it('is 400 with field errors for an invalid body', async () => {
    const res = await call('POST', '/workflow/complete', {
      terminalId: 'term-a',
      body: { status: 'skipped', verdict: 'maybe', extra: 1 }
    })
    expect(res).toEqual({
      status: 400,
      json: {
        error: 'invalid step result',
        fields: [
          { field: 'status', message: 'Expected one of: "done", "failed", "needs-input"' },
          { field: 'summary', message: 'Required' },
          { field: 'verdict', message: 'Expected one of: "pass", "fail"' },
          { field: 'extra', message: 'Unknown field' }
        ]
      }
    })
    expect(workflow.completed).toEqual([])
  })

  it.each([
    { name: 'malformed JSON', body: '{"summary":', error: 'invalid JSON' },
    { name: 'a JSON array', body: '[]', error: 'invalid step result' },
    { name: 'JSON null', body: 'null', error: 'invalid step result' }
  ])('is 400 for $name', async ({ body, error }) => {
    const res = await call('POST', '/workflow/complete', { terminalId: 'term-a', body })
    expect(res.status).toBe(400)
    expect(res.json).toMatchObject({ error })
    expect(workflow.completed).toEqual([])
  })

  it('is 413 for an oversize body', async () => {
    const body = JSON.stringify({ summary: 'x'.repeat(CONTROL_WORKFLOW_MAX_BODY_BYTES), verdict: 'pass' })
    const res = await call('POST', '/workflow/complete', { terminalId: 'term-a', body })
    expect(res).toEqual({ status: 413, json: { error: 'request body too large' } })
    expect(workflow.completed).toEqual([])
  })

  it('is 409 when the attempt already completed', async () => {
    const body = { summary: 'ok', verdict: 'pass' }
    expect((await call('POST', '/workflow/complete', { terminalId: 'term-a', body })).status).toBe(200)
    expect(await call('POST', '/workflow/complete', { terminalId: 'term-a', body })).toEqual({
      status: 409,
      json: { error: 'step already completed' }
    })
  })

  it.each([
    { name: 'a non-step terminal', terminalId: 'term-x', prepare: () => {}, error: 'not a workflow step' },
    { name: 'labs off', terminalId: 'term-a', prepare: () => (workflow.labs = false), error: 'workflows disabled' }
  ])('is 404 for $name', async ({ terminalId, prepare, error }) => {
    prepare()
    const res = await call('POST', '/workflow/complete', { terminalId, body: { summary: 'ok', verdict: 'pass' } })
    expect(res).toEqual({ status: 404, json: { error } })
    expect(workflow.completed).toEqual([])
  })

  it('does not pollute Object.prototype through the body', async () => {
    const res = await call('POST', '/workflow/complete', {
      terminalId: 'term-a',
      body: '{"summary":"s","verdict":"pass","__proto__":{"polluted":true}}'
    })
    expect(res.status).toBe(400)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('POST /workflow/stop-check', () => {
  const BLOCK = {
    decision: 'block',
    reason: 'Call complete_step with your result, or with status needs-input and what you need.'
  }

  it('returns the block reply, resolving the attempt from the header and reading only stop_hook_active', async () => {
    const body = { session_id: 's', stop_hook_active: false, terminalId: 'term-b', attemptId: 'att-b' }
    expect(await call('POST', '/workflow/stop-check', { terminalId: 'term-a', body })).toEqual({
      status: 200,
      json: BLOCK
    })
    expect(workflow.stopChecks).toEqual([{ terminalId: 'term-a', stopHookActive: false }])
  })

  it.each([
    { name: 'true', value: true, expected: true },
    { name: 'the string "true"', value: 'true', expected: false },
    { name: 'missing', value: undefined, expected: false }
  ])('passes stop_hook_active $name as $expected', async ({ value, expected }) => {
    await call('POST', '/workflow/stop-check', { terminalId: 'term-a', body: { stop_hook_active: value } })
    expect(workflow.stopChecks).toEqual([{ terminalId: 'term-a', stopHookActive: expected }])
  })

  it('returns {} when the runner declines to continue', async () => {
    workflow.decision = 'none'
    expect(await call('POST', '/workflow/stop-check', { terminalId: 'term-a', body: {} })).toEqual({
      status: 200,
      json: {}
    })
  })

  it.each([
    { name: 'labs off', prepare: () => (workflow.labs = false) },
    { name: 'no workflow seam', prepare: () => (withWorkflow = false) }
  ])('returns {} without asking the runner when $name', async ({ prepare }) => {
    prepare()
    expect(await call('POST', '/workflow/stop-check', { terminalId: 'term-a', body: {} })).toEqual({
      status: 200,
      json: {}
    })
    expect(workflow.stopChecks).toEqual([])
  })

  it('is 405 for GET, 400 without the terminal header, 413 for an oversize body', async () => {
    expect((await call('GET', '/workflow/stop-check', { terminalId: 'term-a' })).status).toBe(405)
    expect((await call('POST', '/workflow/stop-check', { body: {} })).status).toBe(400)
    const big = JSON.stringify({ pad: 'x'.repeat(CONTROL_WORKFLOW_MAX_BODY_BYTES) })
    expect((await call('POST', '/workflow/stop-check', { terminalId: 'term-a', body: big })).status).toBe(413)
    expect(workflow.stopChecks).toEqual([])
  })

  it('needs the bearer token', async () => {
    const res = await fetch(`${base}/workflow/stop-check`, {
      method: 'POST',
      headers: { 'X-Harness-Terminal-Id': 'term-a' },
      body: '{}'
    })
    expect(res.status).toBe(401)
    expect(workflow.stopChecks).toEqual([])
  })
})

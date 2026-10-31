import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { registerWorkflowsRequestHandlers } from '.'
import { createWorkflowDefsLoader } from '../workflow-defs-loader'
import type { WorkflowDefinitionDetail, WorkflowsEvent } from '../../shared/state/workflows'

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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workflows-transport-'))
  dispatched = []
  transport = new FakeTransport()
  const loader = createWorkflowDefsLoader({ dir, dispatch: (event) => dispatched.push(event), log: () => {} })
  registerWorkflowsRequestHandlers({ transport, loader })
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
    expect(dispatched[1].payload.definitions.map((d) => d.id)).toEqual(['personal:other', 'personal:plan'])
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

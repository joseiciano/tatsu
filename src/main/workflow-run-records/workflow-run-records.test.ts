import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { rename } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createWorkflowRunRecords, type WorkflowRunRecords } from '.'
import type { WorkflowRunRecord } from '../../shared/state/workflows'

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

function record(runId: string, patch: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    version: 1,
    runId,
    defId: 'personal:flow',
    defHash: 'hash',
    definition: { name: 'flow', inputs: {}, steps: [] },
    inputs: { task: 'x' },
    worktreePath: '/wt',
    contextPath: `/wt/.harness/runs/${runId}/context.md`,
    status: 'running',
    cursor: 0,
    steps: {},
    startedAt: 1,
    attempts: [],
    ...patch
  }
}

let dir: string
let records: WorkflowRunRecords
let logs: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'run-records-'))
  logs = []
  records = createWorkflowRunRecords({ dir: join(dir, 'workflow-runs'), log: (_c, m) => logs.push(m) })
  vi.mocked(rename).mockClear()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('workflow run records', () => {
  it('writes a versioned record that reads back identically after a flush', async () => {
    const run = record('run-1', { status: 'done', finishedAt: 9 })
    records.persist(run)
    await records.flush()

    const onDisk = JSON.parse(readFileSync(join(dir, 'workflow-runs', 'run-1.json'), 'utf8'))
    expect(onDisk).toEqual(run)
    expect(onDisk.version).toBe(1)
    expect(await records.read('run-1')).toEqual(run)
    expect(readdirSync(join(dir, 'workflow-runs'))).toEqual(['run-1.json'])
    expect(await records.list()).toEqual(['run-1'])
  })

  it('snapshots the record at persist time so later mutation does not leak in', async () => {
    const run = record('run-1')
    records.persist(run)
    run.status = 'cancelled'
    await records.flush()
    expect((await records.read('run-1'))?.status).toBe('running')
  })

  it('coalesces rapid persists to one in-flight write plus the latest state', async () => {
    const run = record('run-1')
    records.persist({ ...run, cursor: 1 })
    records.persist({ ...run, cursor: 2 })
    records.persist({ ...run, cursor: 3 })
    expect((await records.read('run-1'))?.cursor).toBe(3)
    await records.flush()

    expect(vi.mocked(rename).mock.calls.length).toBeLessThanOrEqual(2)
    expect((await records.read('run-1'))?.cursor).toBe(3)
    const onDisk = JSON.parse(readFileSync(join(dir, 'workflow-runs', 'run-1.json'), 'utf8'))
    expect(onDisk.cursor).toBe(3)
  })

  it('returns null for unknown, invalid, path-like, corrupt or unversioned ids', async () => {
    records.persist(record('run-1'))
    await records.flush()
    const runsDir = join(dir, 'workflow-runs')
    writeFileSync(join(runsDir, 'corrupt.json'), '{not json')
    writeFileSync(join(runsDir, 'old.json'), JSON.stringify({ ...record('old'), version: 0 }))
    writeFileSync(join(runsDir, 'other.json'), JSON.stringify(record('run-1')))

    expect(await records.read('missing')).toBeNull()
    expect(await records.read('../run-1')).toBeNull()
    expect(await records.read('run-1.json')).toBeNull()
    expect(await records.read({ runId: 'run-1' })).toBeNull()
    expect(await records.read('corrupt')).toBeNull()
    expect(await records.read('old')).toBeNull()
    expect(await records.read('other')).toBeNull()
  })

  it('logs and keeps going when a write fails', async () => {
    writeFileSync(join(dir, 'workflow-runs'), 'a file, not a dir')
    records.persist(record('run-1'))
    await records.flush()
    expect(logs).toContain('run record write failed')
    expect(await records.read('run-1')).toBeNull()
  })
})

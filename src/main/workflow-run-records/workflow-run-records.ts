import { randomUUID } from 'crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { userDataDir } from '../paths'
import {
  WORKFLOW_RUN_RECORD_VERSION,
  type WorkflowAttemptRecord,
  type WorkflowRunRecord
} from '../../shared/state/workflows'

export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const RECORD_EXTENSION = '.json'
const TERMINAL_RECORD_STATUSES: ReadonlySet<WorkflowRunRecord['status']> = new Set(['done', 'failed', 'cancelled'])

export interface WorkflowRunRecordsDeps {
  dir: string
  log?: (category: string, message: string, data?: Record<string, string>) => void
}

export interface WorkflowRunRecords {
  persist(record: WorkflowRunRecord): void
  read(runId: unknown): Promise<WorkflowRunRecord | null>
  list(): Promise<string[]>
  flush(): Promise<void>
}

interface Slot {
  latest: WorkflowRunRecord
  pending: boolean
  writing: Promise<void>
}

export function workflowRunsDir(): string {
  return join(userDataDir(), 'workflow-runs')
}

export function isRunId(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value)
}

function isRecordFor(value: unknown, runId: string): value is WorkflowRunRecord {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<WorkflowRunRecord>
  return (
    candidate.version === WORKFLOW_RUN_RECORD_VERSION &&
    candidate.runId === runId &&
    Array.isArray(candidate.attempts)
  )
}

export function createWorkflowRunRecords({ dir, log = () => {} }: WorkflowRunRecordsDeps): WorkflowRunRecords {
  const slots = new Map<string, Slot>()

  const fileFor = (runId: string): string => join(dir, `${runId}${RECORD_EXTENSION}`)

  async function writeAtomic(record: WorkflowRunRecord): Promise<void> {
    const target = fileFor(record.runId)
    const temp = `${target}.${randomUUID()}.tmp`
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(temp, JSON.stringify(record), 'utf8')
      await rename(temp, target)
    } catch {
      log('workflow', 'run record write failed', { runId: record.runId })
      await rm(temp, { force: true }).catch(() => undefined)
    }
  }

  async function drain(runId: string, slot: Slot): Promise<void> {
    while (slot.pending) {
      slot.pending = false
      await writeAtomic(slot.latest)
    }
    if (slots.get(runId) === slot) slots.delete(runId)
  }

  return {
    persist(record) {
      if (!isRunId(record.runId)) {
        log('workflow', 'run record refused invalid id')
        return
      }
      const latest = structuredClone(record)
      const slot = slots.get(record.runId)
      if (slot) {
        slot.latest = latest
        slot.pending = true
        return
      }
      const fresh: Slot = { latest, pending: true, writing: Promise.resolve() }
      slots.set(record.runId, fresh)
      fresh.writing = drain(record.runId, fresh)
    },

    async read(runId) {
      if (!isRunId(runId)) return null
      const slot = slots.get(runId)
      if (slot) return structuredClone(slot.latest)
      let raw: string
      try {
        raw = await readFile(fileFor(runId), 'utf8')
      } catch {
        return null
      }
      try {
        const parsed: unknown = JSON.parse(raw)
        return isRecordFor(parsed, runId) ? parsed : null
      } catch {
        log('workflow', 'run record unreadable', { runId })
        return null
      }
    },

    async list() {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        return []
      }
      return names
        .filter((name) => name.endsWith(RECORD_EXTENSION))
        .map((name) => name.slice(0, -RECORD_EXTENSION.length))
        .filter(isRunId)
        .sort()
    },

    async flush() {
      await Promise.all([...slots.values()].map((slot) => slot.writing))
    }
  }
}

export interface WorkflowRunLookupDeps {
  live: (runId: string) => WorkflowRunRecord | null
  liveAttemptRunId: (attemptId: string) => string | undefined
  records: Pick<WorkflowRunRecords, 'read' | 'list'>
  attemptRunId: (attemptId: string) => string | undefined
}

export interface WorkflowRunLookup {
  getRun(runId: unknown): Promise<WorkflowRunRecord | null>
  getAttemptResult(attemptId: unknown): Promise<WorkflowAttemptRecord | null>
}

export function createWorkflowRunLookup({
  live,
  liveAttemptRunId,
  records,
  attemptRunId
}: WorkflowRunLookupDeps): WorkflowRunLookup {
  const runIdByAttempt = new Map<string, string>()
  const scanned = new Set<string>()

  async function getRun(runId: unknown): Promise<WorkflowRunRecord | null> {
    if (!isRunId(runId)) return null
    return live(runId) ?? (await records.read(runId))
  }

  function attemptIn(run: WorkflowRunRecord | null, attemptId: string): WorkflowAttemptRecord | null {
    return run?.attempts.find((attempt) => attempt.attemptId === attemptId) ?? null
  }

  async function scanDisk(attemptId: string): Promise<WorkflowAttemptRecord | null> {
    for (const runId of await records.list()) {
      if (scanned.has(runId)) continue
      const run = await records.read(runId)
      if (!run) continue
      if (TERMINAL_RECORD_STATUSES.has(run.status)) scanned.add(runId)
      for (const attempt of run.attempts) runIdByAttempt.set(attempt.attemptId, runId)
      const found = attemptIn(run, attemptId)
      if (found) return found
    }
    return null
  }

  return {
    getRun,
    async getAttemptResult(attemptId) {
      if (!isRunId(attemptId)) return null
      const known = runIdByAttempt.get(attemptId) ?? attemptRunId(attemptId) ?? liveAttemptRunId(attemptId)
      if (known !== undefined) {
        const found = attemptIn(await getRun(known), attemptId)
        if (found) {
          runIdByAttempt.set(attemptId, known)
          return found
        }
      }
      return scanDisk(attemptId)
    }
  }
}

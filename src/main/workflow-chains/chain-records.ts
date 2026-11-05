import { randomUUID } from 'crypto'
import { readdirSync, readFileSync } from 'fs'
import { mkdir, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { userDataDir } from '../paths'
import { isRunId } from '../workflow-run-records'
import type { WorkflowLog } from '../workflow-runner'
import { parseStepOverrides } from '../workflows-transport'
import { parseWorkflowRunChainOrigin } from '../../shared/state/workflows'
import {
  WORKFLOW_CHAIN_RECORD_VERSION,
  type ChainItemFailure,
  type WorkflowChainItemRecord,
  type WorkflowChainRecord
} from './types'

const RECORD_EXTENSION = '.json'
const CHAIN_MODES: ReadonlySet<unknown> = new Set(['independent', 'stacked'])
const FINISHED_STATUSES: ReadonlySet<unknown> = new Set(['done', 'failed', 'cancelled'])
const ITEM_FAILURES: ReadonlySet<unknown> = new Set<ChainItemFailure>([
  'branch-invalid',
  'worktree-failed',
  'setup-failed',
  'start-refused',
  'start-threw'
])

export interface WorkflowChainRecords {
  persist(record: WorkflowChainRecord): void
  flush(): Promise<void>
}

interface Slot {
  latest: WorkflowChainRecord
  pending: boolean
  writing: Promise<void>
}

export function workflowChainsDir(): string {
  return join(userDataDir(), 'workflow-chains')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isOptionalPrNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1)
}

function isInputs(value: unknown): boolean {
  return isObject(value) && Object.values(value).every((input) => typeof input === 'string')
}

function isItemRecord(value: unknown): value is WorkflowChainItemRecord {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.value === 'string' &&
    (value.origin === undefined || parseWorkflowRunChainOrigin(value.origin) !== null) &&
    isOptionalString(value.branch) &&
    isOptionalString(value.baseBranch) &&
    isOptionalString(value.worktreePath) &&
    (value.runId === undefined || isRunId(value.runId)) &&
    (value.failed === undefined || ITEM_FAILURES.has(value.failed)) &&
    (value.skipped === undefined || value.skipped === true) &&
    isOptionalString(value.prevItemId) &&
    isOptionalPrNumber(value.stackedOn) &&
    isOptionalPrNumber(value.prNumber)
  )
}

function isChainRecordFor(value: unknown, chainId: string): value is WorkflowChainRecord {
  if (!isObject(value)) return false
  const { items } = value
  const finished = value.finishedAt !== undefined || value.status !== undefined
  return (
    value.version === WORKFLOW_CHAIN_RECORD_VERSION &&
    value.chainId === chainId &&
    typeof value.defId === 'string' &&
    typeof value.definitionName === 'string' &&
    typeof value.repoRoot === 'string' &&
    CHAIN_MODES.has(value.mode) &&
    typeof value.draftPrs === 'boolean' &&
    isInputs(value.inputs) &&
    (value.overrides === undefined || parseStepOverrides(value.overrides) !== null) &&
    (value.autopilot === undefined || value.autopilot === true) &&
    (value.allowFull === undefined || value.allowFull === true) &&
    typeof value.startedAt === 'number' &&
    (!finished || (typeof value.finishedAt === 'number' && FINISHED_STATUSES.has(value.status))) &&
    Array.isArray(items) &&
    items.length > 0 &&
    items.every(isItemRecord) &&
    new Set(items.map(({ id }) => id)).size === items.length
  )
}

export function loadChainRecordsSync(dir: string, log: WorkflowLog): WorkflowChainRecord[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const records: WorkflowChainRecord[] = []
  for (const name of names.sort()) {
    if (!name.endsWith(RECORD_EXTENSION)) continue
    const chainId = name.slice(0, -RECORD_EXTENSION.length)
    if (!isRunId(chainId)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      log('workflow', 'chain record skipped unreadable', { file: name })
      continue
    }
    if (isChainRecordFor(parsed, chainId)) records.push(parsed)
    else log('workflow', 'chain record skipped invalid', { file: name })
  }
  return records
}

export function readWorkflowChainDraftPrs(dir: string, chainId: string): boolean | undefined {
  if (!isRunId(chainId)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(dir, `${chainId}.json`), 'utf8'))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const draftPrs = 'draftPrs' in parsed ? parsed.draftPrs : undefined
  const recordId = 'chainId' in parsed ? parsed.chainId : undefined
  return recordId === chainId && typeof draftPrs === 'boolean' ? draftPrs : undefined
}

export function createWorkflowChainRecords({ dir, log }: { dir: string; log: WorkflowLog }): WorkflowChainRecords {
  const slots = new Map<string, Slot>()

  async function writeAtomic(record: WorkflowChainRecord): Promise<void> {
    const target = join(dir, `${record.chainId}.json`)
    const temp = `${target}.${randomUUID()}.tmp`
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(temp, JSON.stringify(record), 'utf8')
      await rename(temp, target)
    } catch {
      log('workflow', 'chain record write failed', { chainId: record.chainId })
      await rm(temp, { force: true }).catch(() => undefined)
    }
  }

  async function drain(chainId: string, slot: Slot): Promise<void> {
    while (slot.pending) {
      slot.pending = false
      await writeAtomic(slot.latest)
    }
    if (slots.get(chainId) === slot) slots.delete(chainId)
  }

  return {
    persist(record) {
      if (!isRunId(record.chainId)) {
        log('workflow', 'chain record refused invalid id')
        return
      }
      const latest = structuredClone(record)
      const slot = slots.get(record.chainId)
      if (slot) {
        slot.latest = latest
        slot.pending = true
        return
      }
      const fresh: Slot = { latest, pending: true, writing: Promise.resolve() }
      slots.set(record.chainId, fresh)
      fresh.writing = drain(record.chainId, fresh)
    },

    async flush() {
      await Promise.all([...slots.values()].map((slot) => slot.writing))
    }
  }
}

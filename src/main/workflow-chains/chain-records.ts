import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { mkdir, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { userDataDir } from '../paths'
import { isRunId } from '../workflow-run-records'
import type { WorkflowLog } from '../workflow-runner'
import type { WorkflowChainRecord } from './types'

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

import type { StateEvent } from '../../shared/state'
import {
  deriveChainStatus,
  type WorkflowChain,
  type WorkflowChainItem,
  type WorkflowRun,
  type WorkflowRunStatus
} from '../../shared/state/workflows'
import { chainItemBranchName } from '../../shared/workflow-branch'
import type { StartRunRequest } from '../workflow-runner'
import {
  WORKFLOW_CHAIN_RECORD_VERSION,
  type ChainItemFailure,
  type ChainSchedulerDeps,
  type StartChainRequest,
  type WorkflowChainItemRecord,
  type WorkflowChainRecord
} from './types'

type ChildRun = Pick<WorkflowRun, 'status'>

const IN_FLIGHT_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set(['queued', 'running'])
const TERMINAL_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set(['done', 'failed', 'cancelled'])

function sliceItem({ id, title, branch, failed }: WorkflowChainItemRecord): WorkflowChainItem {
  return { id, title, ...(branch === undefined ? {} : { branch }), ...(failed === undefined ? {} : { failed: true }) }
}

function sliceChain(record: WorkflowChainRecord): WorkflowChain {
  const childRunIds: Record<string, string> = {}
  for (const item of record.items) if (item.runId !== undefined) childRunIds[item.id] = item.runId
  return {
    chainId: record.chainId,
    defId: record.defId,
    repoRoot: record.repoRoot,
    mode: record.mode,
    items: record.items.map(sliceItem),
    draftPrs: record.draftPrs,
    childRunIds,
    startedAt: record.startedAt,
    ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt })
  }
}

export class ChainScheduler {
  private readonly chains = new Map<string, WorkflowChainRecord>()
  private readonly launching = new Set<string>()
  private readonly runOwners = new Map<string, string>()
  private readonly childRuns = new Map<string, ChildRun>()
  private readonly unsubscribe: () => void
  private pumpQueued = false
  private disposed = false

  constructor(private readonly deps: ChainSchedulerDeps) {
    this.unsubscribe = deps.store.subscribe((event) => this.onEvent(event))
  }

  start(request: StartChainRequest): string {
    const { store, now, newId } = this.deps
    const chainId = newId()
    const record: WorkflowChainRecord = {
      version: WORKFLOW_CHAIN_RECORD_VERSION,
      chainId,
      defId: request.defId,
      definitionName: request.definitionName,
      repoRoot: request.repoRoot,
      mode: request.mode,
      draftPrs: request.draftPrs,
      inputs: { ...request.inputs },
      ...(request.overrides === undefined ? {} : { overrides: request.overrides }),
      ...(request.autopilot === true ? { autopilot: true } : {}),
      ...(request.allowFull === true ? { allowFull: true } : {}),
      items: request.items.map(({ title, value, origin }) => ({
        id: newId(),
        title,
        value,
        ...(origin === undefined ? {} : { origin })
      })),
      startedAt: now()
    }
    this.chains.set(chainId, record)
    store.dispatch({ type: 'workflows/chainStarted', payload: { chain: sliceChain(record) } })
    this.deps.persist(record)
    this.deps.log('workflow', 'chain started', { chainId })
    this.pump()
    return chainId
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe()
  }

  private onEvent(event: StateEvent): void {
    if (this.disposed) return
    switch (event.type) {
      case 'workflows/runStarted': {
        const { runId, run } = event.payload
        if (run.chainId === undefined || !this.chains.has(run.chainId)) return
        this.runOwners.set(runId, run.chainId)
        this.childRuns.set(runId, { status: run.status })
        this.schedulePump()
        return
      }
      case 'workflows/runPaused':
      case 'workflows/runResumed':
      case 'workflows/runCancelled':
      case 'workflows/runFinished':
        this.refreshChild(event.payload.runId)
        return
      case 'settings/workflowSettingsChanged':
      case 'settings/labsChanged':
        if (this.chains.size > 0) this.schedulePump()
        return
      default:
        return
    }
  }

  private refreshChild(runId: string): void {
    if (!this.runOwners.has(runId)) return
    const { runs } = this.deps.store.getSnapshot().state.workflows
    if (Object.hasOwn(runs, runId)) this.childRuns.set(runId, { status: runs[runId].status })
    this.schedulePump()
  }

  private schedulePump(): void {
    if (this.pumpQueued || this.disposed) return
    this.pumpQueued = true
    queueMicrotask(() => {
      this.pumpQueued = false
      this.pump()
    })
  }

  private inFlight(): number {
    let count = this.launching.size
    for (const record of this.chains.values()) {
      for (const item of record.items) {
        const status = item.runId === undefined ? undefined : this.childRuns.get(item.runId)?.status
        if (status !== undefined && IN_FLIGHT_STATUSES.has(status)) count++
      }
    }
    return count
  }

  private pump(): void {
    if (this.disposed) return
    const { settings } = this.deps.store.getSnapshot().state
    if (settings.labs.workflows) {
      let free = settings.workflows.maxConcurrentAgents - this.inFlight()
      for (const record of this.chains.values()) {
        for (const item of record.items) {
          if (free <= 0) break
          if (item.runId !== undefined || item.failed !== undefined || this.launching.has(item.id)) continue
          free--
          void this.launch(record, item)
        }
      }
    }
    for (const record of [...this.chains.values()]) this.finishIfSettled(record)
  }

  private async launch(record: WorkflowChainRecord, item: WorkflowChainItemRecord): Promise<void> {
    this.launching.add(item.id)
    let failure: { reason: ChainItemFailure; refusal?: string } | null
    try {
      failure = await this.launchItem(record, item)
    } catch {
      failure = { reason: 'start-threw' }
    } finally {
      this.launching.delete(item.id)
    }
    if (failure && !this.disposed) this.failItem(record, item, failure.reason, failure.refusal)
    this.schedulePump()
  }

  private async launchItem(
    record: WorkflowChainRecord,
    item: WorkflowChainItemRecord
  ): Promise<{ reason: ChainItemFailure; refusal?: string } | null> {
    const { chainId } = record
    let branch: string
    try {
      branch = chainItemBranchName(record.definitionName, item.title, this.deps.newShortId())
    } catch {
      return { reason: 'branch-invalid' }
    }
    item.branch = branch
    item.baseBranch = ''
    this.deps.store.dispatch({ type: 'workflows/chainItemsChanged', payload: { chainId, items: [{ id: item.id, branch }] } })
    this.deps.persist(record)
    this.deps.log('workflow', 'chain item started', { chainId, itemId: item.id })
    let worktree: Awaited<ReturnType<ChainSchedulerDeps['createWorktree']>>
    try {
      worktree = await this.deps.createWorktree({ repoRoot: record.repoRoot, branchName: branch })
    } catch {
      return { reason: 'worktree-failed' }
    }
    if (this.disposed) return null
    if (!worktree.ok) return { reason: worktree.reason }
    item.worktreePath = worktree.worktreePath
    this.deps.persist(record)
    const result = await this.deps.startRun(this.runRequest(record, item, branch, worktree.worktreePath))
    if (this.disposed) return null
    if (!result.ok) return { reason: 'start-refused', refusal: result.reason }
    this.link(record, item, result.runId)
    return null
  }

  private runRequest(
    record: WorkflowChainRecord,
    item: WorkflowChainItemRecord,
    branch: string,
    worktreePath: string
  ): StartRunRequest {
    return {
      defId: record.defId,
      worktreePath,
      inputs: { ...record.inputs },
      ...(record.overrides === undefined ? {} : { overrides: record.overrides }),
      ...(record.allowFull ? { allowFull: true } : {}),
      ...(record.autopilot ? { autopilot: true } : {}),
      chain: {
        chainId: record.chainId,
        item: { id: item.id, title: item.title, value: item.value, branch, baseBranch: '' },
        ...(item.origin === undefined ? {} : { origin: item.origin })
      }
    }
  }

  private link(record: WorkflowChainRecord, item: WorkflowChainItemRecord, runId: string): void {
    const { chainId } = record
    item.runId = runId
    this.runOwners.set(runId, chainId)
    const { runs } = this.deps.store.getSnapshot().state.workflows
    if (Object.hasOwn(runs, runId)) this.childRuns.set(runId, { status: runs[runId].status })
    this.deps.store.dispatch({ type: 'workflows/chainChildRunLinked', payload: { chainId, itemId: item.id, runId } })
    this.deps.persist(record)
    this.deps.log('workflow', 'chain item linked', { chainId, itemId: item.id, runId })
  }

  private failItem(
    record: WorkflowChainRecord,
    item: WorkflowChainItemRecord,
    reason: ChainItemFailure,
    refusal?: string
  ): void {
    const { chainId } = record
    item.failed = reason
    this.deps.store.dispatch({ type: 'workflows/chainItemsChanged', payload: { chainId, items: [{ id: item.id, failed: true }] } })
    this.deps.persist(record)
    this.deps.log('workflow', 'chain item failed', {
      chainId,
      itemId: item.id,
      reason,
      ...(refusal === undefined ? {} : { refusal })
    })
  }

  private finishIfSettled(record: WorkflowChainRecord): void {
    const runs: Record<string, ChildRun> = {}
    for (const item of record.items) {
      if (this.launching.has(item.id)) return
      if (item.runId === undefined) {
        if (item.failed === undefined) return
        continue
      }
      const child = this.childRuns.get(item.runId)
      if (!child || !TERMINAL_STATUSES.has(child.status)) return
      runs[item.runId] = child
    }
    const derived = deriveChainStatus(sliceChain(record), runs)
    if (derived.status !== 'done' && derived.status !== 'failed' && derived.status !== 'cancelled') return
    const { chainId } = record
    const finishedAt = this.deps.now()
    record.finishedAt = finishedAt
    record.status = derived.status
    this.chains.delete(chainId)
    for (const runId of Object.keys(runs)) {
      this.runOwners.delete(runId)
      this.childRuns.delete(runId)
    }
    this.deps.store.dispatch({ type: 'workflows/chainFinished', payload: { chainId, status: derived.status, finishedAt } })
    this.deps.persist(record)
    this.deps.log('workflow', `chain finished ${derived.status}`, { chainId })
  }
}

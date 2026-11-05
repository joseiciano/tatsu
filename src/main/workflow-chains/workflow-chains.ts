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
  type ChainItemActionRefusal,
  type ChainItemActionResult,
  type ChainItemFailure,
  type ChainSchedulerDeps,
  type ChainSkipChoice,
  type StartChainRequest,
  type WorkflowChainItemRecord,
  type WorkflowChainRecord
} from './types'

type ChildRun = Pick<WorkflowRun, 'status'>

interface StartableItem {
  item: WorkflowChainItemRecord
  prev?: WorkflowChainItemRecord
}

type FoundItem = { record: WorkflowChainRecord; item: WorkflowChainItemRecord } | { ok: false; reason: ChainItemActionRefusal }

const IN_FLIGHT_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set(['queued', 'running'])
const TERMINAL_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set(['done', 'failed', 'cancelled'])

function sliceItem({ id, title, branch, baseBranch, failed, skipped, prevItemId, prNumber }: WorkflowChainItemRecord): WorkflowChainItem {
  return {
    id,
    title,
    ...(branch === undefined ? {} : { branch }),
    ...(baseBranch ? { baseBranch } : {}),
    ...(prevItemId === undefined ? {} : { prevItemId }),
    ...(prNumber === undefined ? {} : { prNumber }),
    ...(failed === undefined ? {} : { failed: true }),
    ...(skipped === undefined ? {} : { skipped: true })
  }
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

  async retryItem(chainId: string, itemId: string): Promise<ChainItemActionResult> {
    const found = this.findItem(chainId, itemId)
    if ('reason' in found) return found
    const { record, item } = found
    if (!this.deps.store.getSnapshot().state.settings.labs.workflows) return { ok: false, reason: 'labs-off' }
    if (this.launching.has(item.id)) return { ok: false, reason: 'item-starting' }
    const { runId, worktreePath, branch } = item
    const status = runId === undefined ? undefined : this.childRuns.get(runId)?.status
    if (item.skipped || worktreePath === undefined || branch === undefined || (status !== 'failed' && status !== 'cancelled')) {
      return { ok: false, reason: 'not-retryable' }
    }
    this.launching.add(item.id)
    let result: Awaited<ReturnType<ChainSchedulerDeps['startRun']>>
    try {
      result = await this.deps.startRun(this.runRequest(record, item, branch, worktreePath))
    } finally {
      this.launching.delete(item.id)
      this.schedulePump()
    }
    if (!result.ok) {
      this.deps.log('workflow', 'chain item retry refused', { chainId, itemId, refusal: result.reason })
      return { ok: false, reason: 'start-refused', refusal: result.reason }
    }
    if (runId !== undefined) {
      this.runOwners.delete(runId)
      this.childRuns.delete(runId)
    }
    this.link(record, item, result.runId)
    this.deps.log('workflow', 'chain item retried', { chainId, itemId, runId: result.runId })
    return { ok: true }
  }

  skipItem(chainId: string, itemId: string, choice: ChainSkipChoice): ChainItemActionResult {
    const found = this.findItem(chainId, itemId)
    if ('reason' in found) return found
    const { record, item } = found
    if (!this.deps.store.getSnapshot().state.settings.labs.workflows) return { ok: false, reason: 'labs-off' }
    if (record.mode !== 'stacked') return { ok: false, reason: 'not-stacked' }
    if (this.blockingItem(record)?.item !== item) return { ok: false, reason: 'not-blocking' }
    if (this.launching.has(item.id)) return { ok: false, reason: 'item-starting' }
    const status = item.runId === undefined ? undefined : this.childRuns.get(item.runId)?.status
    if (item.runId !== undefined && status !== undefined && !TERMINAL_STATUSES.has(status)) {
      if (!this.deps.cancelRun(item.runId).ok) return { ok: false, reason: 'busy' }
    }
    const index = record.items.indexOf(item)
    const skipped = choice === 'cancel-rest' ? record.items.slice(index).filter((candidate) => !candidate.skipped) : [item]
    for (const candidate of skipped) candidate.skipped = true
    this.deps.store.dispatch({
      type: 'workflows/chainItemsChanged',
      payload: { chainId, items: skipped.map(({ id }) => ({ id, skipped: true })) }
    })
    this.deps.persist(record)
    this.deps.log('workflow', 'chain item skipped', { chainId, itemId, choice })
    this.schedulePump()
    return { ok: true }
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
      case 'workflows/prRecorded':
        this.recordPr(event.payload.runId, event.payload.pr.number)
        return
      case 'settings/workflowSettingsChanged':
      case 'settings/labsChanged':
        if (this.chains.size > 0) this.schedulePump()
        return
      default:
        return
    }
  }

  private recordPr(runId: string, prNumber: number): void {
    const chainId = this.runOwners.get(runId)
    const record = chainId === undefined ? undefined : this.chains.get(chainId)
    const item = record?.items.find((candidate) => candidate.runId === runId)
    if (!record || !item || item.prNumber === prNumber) return
    item.prNumber = prNumber
    this.deps.store.dispatch({
      type: 'workflows/chainItemsChanged',
      payload: { chainId: record.chainId, items: [{ id: item.id, prNumber }] }
    })
    this.deps.persist(record)
  }

  private findItem(chainId: string, itemId: string): FoundItem {
    const record = this.chains.get(chainId)
    if (!record) return { ok: false, reason: 'unknown-chain' }
    const item = record.items.find(({ id }) => id === itemId)
    return item ? { record, item } : { ok: false, reason: 'unknown-item' }
  }

  private childStatus(item: WorkflowChainItemRecord): WorkflowRunStatus | undefined {
    return item.runId === undefined ? undefined : this.childRuns.get(item.runId)?.status
  }

  private blockingItem(record: WorkflowChainRecord): StartableItem | null {
    let prev: WorkflowChainItemRecord | undefined
    for (const item of record.items) {
      if (item.skipped) continue
      if (this.childStatus(item) === 'done') {
        prev = item
        continue
      }
      return prev === undefined ? { item } : { item, prev }
    }
    return null
  }

  private nextStartable(record: WorkflowChainRecord): StartableItem[] {
    const startable = (item: WorkflowChainItemRecord): boolean =>
      item.runId === undefined && item.failed === undefined && item.skipped === undefined && !this.launching.has(item.id)
    if (record.mode === 'independent') return record.items.filter(startable).map((item) => ({ item }))
    const blocking = this.blockingItem(record)
    return blocking && startable(blocking.item) ? [blocking] : []
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
        for (const { item, prev } of this.nextStartable(record)) {
          if (free <= 0) break
          free--
          void this.launch(record, item, prev)
        }
      }
    }
    for (const record of [...this.chains.values()]) this.finishIfSettled(record)
  }

  private async launch(
    record: WorkflowChainRecord,
    item: WorkflowChainItemRecord,
    prev: WorkflowChainItemRecord | undefined
  ): Promise<void> {
    this.launching.add(item.id)
    let failure: { reason: ChainItemFailure; refusal?: string } | null
    try {
      failure = await this.launchItem(record, item, prev)
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
    item: WorkflowChainItemRecord,
    prev: WorkflowChainItemRecord | undefined
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
    const base = prev?.branch
    if (prev !== undefined) {
      item.prevItemId = prev.id
      if (prev.prNumber !== undefined) item.stackedOn = prev.prNumber
    }
    this.deps.store.dispatch({
      type: 'workflows/chainItemsChanged',
      payload: { chainId, items: [{ id: item.id, branch, ...(prev === undefined ? {} : { prevItemId: prev.id }) }] }
    })
    this.deps.persist(record)
    this.deps.log('workflow', 'chain item started', { chainId, itemId: item.id })
    let worktree: Awaited<ReturnType<ChainSchedulerDeps['createWorktree']>>
    try {
      worktree = await this.deps.createWorktree({
        repoRoot: record.repoRoot,
        branchName: branch,
        ...(base === undefined ? {} : { baseBranch: base })
      })
    } catch {
      return { reason: 'worktree-failed' }
    }
    if (this.disposed) return null
    if (!worktree.ok) return { reason: worktree.reason }
    item.worktreePath = worktree.worktreePath
    item.baseBranch = worktree.baseBranch
    if (worktree.baseBranch) {
      this.deps.store.dispatch({
        type: 'workflows/chainItemsChanged',
        payload: { chainId, items: [{ id: item.id, baseBranch: worktree.baseBranch }] }
      })
    } else {
      this.deps.log('workflow', 'chain item base unresolved', { chainId, itemId: item.id })
    }
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
        item: { id: item.id, title: item.title, value: item.value, branch, baseBranch: item.baseBranch ?? '' },
        ...(item.origin === undefined ? {} : { origin: item.origin }),
        ...(item.stackedOn === undefined ? {} : { stackedOn: item.stackedOn })
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
      if (item.skipped) {
        const status = this.childStatus(item)
        if (status !== undefined && !TERMINAL_STATUSES.has(status)) return
        continue
      }
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
    for (const { runId } of record.items) {
      if (runId === undefined) continue
      this.runOwners.delete(runId)
      this.childRuns.delete(runId)
    }
    this.deps.store.dispatch({ type: 'workflows/chainFinished', payload: { chainId, status: derived.status, finishedAt } })
    this.deps.persist(record)
    this.deps.log('workflow', `chain finished ${derived.status}`, { chainId })
  }
}

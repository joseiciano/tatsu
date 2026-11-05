import { mkdtemp, readdir, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../store'
import { initialState, type StateEvent } from '../../shared/state'
import { deriveChainStatus, type WorkflowRun } from '../../shared/state/workflows'
import type { StartRunRequest, StartRunResult } from '../workflow-runner'
import {
  ChainScheduler,
  createWorkflowChainRecords,
  readWorkflowChainDraftPrs,
  type ChainSchedulerDeps,
  type ChainWorktreeResult,
  type StartChainRequest,
  type WorkflowChainRecord
} from '.'

const TITLE_SECRET = 'TITLE-SECRET-lynx'
const VALUE_SECRET = 'VALUE-SECRET-heron'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

interface SetupOptions {
  cap?: number
  labs?: boolean
  createWorktree?: ChainSchedulerDeps['createWorktree']
  startRun?: (request: StartRunRequest, started: (request: StartRunRequest) => StartRunResult) => Promise<StartRunResult>
}

function setup({ cap = 2, labs = true, createWorktree, startRun }: SetupOptions = {}) {
  const store = new Store({
    ...initialState,
    settings: {
      ...initialState.settings,
      labs: { ...initialState.settings.labs, workflows: labs },
      workflows: { ...initialState.settings.workflows, maxConcurrentAgents: cap }
    }
  })
  const events: StateEvent[] = []
  store.subscribe((event) => {
    if (event.type.startsWith('workflows/chain')) events.push(event)
  })
  const persisted: WorkflowChainRecord[] = []
  const logs: Array<{ message: string; data?: Record<string, string> }> = []
  const worktreeRequests: Array<{ repoRoot: string; branchName: string }> = []
  const startRequests: StartRunRequest[] = []
  const runIds: string[] = []
  const cancelRequests: string[] = []
  let cancelRefusal: 'busy' | undefined
  let maxLive = 0
  let nextId = 0
  let nextShort = 0

  const liveChildren = (): number =>
    runIds.filter((runId) => {
      const status = store.getSnapshot().state.workflows.runs[runId]?.status
      return status === 'running' || status === 'queued'
    }).length

  const started = (request: StartRunRequest): StartRunResult => {
    const runId = `run-${runIds.length + 1}`
    const run: WorkflowRun = {
      defId: request.defId,
      defHash: 'h',
      worktreePath: request.worktreePath,
      status: 'running',
      startedAt: 1,
      steps: {},
      ...(request.chain ? { chainId: request.chain.chainId, itemId: request.chain.item.id } : {})
    }
    store.dispatch({ type: 'workflows/runStarted', payload: { runId, run } })
    runIds.push(runId)
    maxLive = Math.max(maxLive, liveChildren())
    return { ok: true, runId }
  }

  const scheduler = new ChainScheduler({
    store,
    createWorktree: async (request) => {
      worktreeRequests.push(request)
      return createWorktree
        ? createWorktree(request)
        : { ok: true, worktreePath: `/repo/.worktrees/${request.branchName}`, baseBranch: request.baseBranch ?? 'main' }
    },
    startRun: async (request) => {
      startRequests.push(request)
      return startRun ? startRun(request, started) : started(request)
    },
    cancelRun: (runId) => {
      cancelRequests.push(runId)
      if (cancelRefusal) return { ok: false, reason: cancelRefusal }
      store.dispatch({ type: 'workflows/runCancelled', payload: { runId, finishedAt: 9 } })
      return { ok: true }
    },
    persist: (record) => persisted.push(structuredClone(record)),
    now: () => 5000,
    newId: () => `id-${++nextId}`,
    newShortId: () => (++nextShort).toString(16).padStart(8, '0'),
    log: (_category, message, data) => logs.push({ message, data })
  })

  const finish = (runId: string, status: 'done' | 'failed' = 'done'): void =>
    store.dispatch({ type: 'workflows/runFinished', payload: { runId, status, finishedAt: 9 } })
  const pause = (runId: string): void =>
    store.dispatch({ type: 'workflows/runPaused', payload: { runId, reason: 'step-failed' } })
  const cancel = (runId: string): void =>
    store.dispatch({ type: 'workflows/runCancelled', payload: { runId, finishedAt: 9 } })
  const recordPr = (runId: string, number: number): void =>
    store.dispatch({
      type: 'workflows/prRecorded',
      payload: { runId, pr: { number, url: `https://github.com/acme/widgets/pull/${number}`, draft: false } }
    })
  const refuseCancel = (): void => {
    cancelRefusal = 'busy'
  }
  const chainOf = (chainId: string) => store.getSnapshot().state.workflows.chains[chainId]
  const finishedEvents = () => events.filter((event) => event.type === 'workflows/chainFinished')

  return {
    store,
    scheduler,
    events,
    persisted,
    logs,
    worktreeRequests,
    startRequests,
    runIds,
    maxLive: () => maxLive,
    liveChildren,
    finish,
    pause,
    cancel,
    recordPr,
    refuseCancel,
    cancelRequests,
    chainOf,
    finishedEvents
  }
}

function request(count: number, overrides: Partial<StartChainRequest> = {}): StartChainRequest {
  return {
    defId: 'personal:fix',
    definitionName: 'Fix Bug',
    repoRoot: '/repo',
    mode: 'independent',
    items: Array.from({ length: count }, (_, i) => ({ title: `Item ${i + 1}`, value: `value ${i + 1}` })),
    inputs: { notes: 'n' },
    draftPrs: true,
    ...overrides
  }
}

describe('ChainScheduler start', () => {
  it('publishes the chain with titles only and persists values, mode and draftPrs', async () => {
    const t = setup()
    const chainId = t.scheduler.start(
      request(1, { items: [{ title: TITLE_SECRET, value: VALUE_SECRET, origin: { kind: 'issue', number: 12 } }] })
    )
    const started = t.events[0]
    expect(started.type).toBe('workflows/chainStarted')
    expect(JSON.stringify(started)).not.toContain(VALUE_SECRET)
    expect(t.chainOf(chainId)).toMatchObject({ chainId, defId: 'personal:fix', mode: 'independent', draftPrs: true })
    expect(t.persisted[0]).toMatchObject({
      chainId,
      mode: 'independent',
      draftPrs: true,
      inputs: { notes: 'n' },
      items: [{ title: TITLE_SECRET, value: VALUE_SECRET, origin: { kind: 'issue', number: 12 } }]
    })
    await settle()
    expect(t.persisted.at(-1)?.items[0]).toMatchObject({ runId: 'run-1', worktreePath: expect.stringContaining('/repo/') })
  })

  it('creates each item worktree on a chain branch and starts its child run with the item and its resolved base', async () => {
    const t = setup()
    const chainId = t.scheduler.start(request(1, { items: [{ title: 'Add Login!', value: 'v', origin: { kind: 'pr', number: 3 } }] }))
    await settle()
    expect(t.worktreeRequests).toEqual([{ repoRoot: '/repo', branchName: 'wf/fix-bug/add-login-00000001' }])
    const [startRequest] = t.startRequests
    expect(startRequest).toEqual({
      defId: 'personal:fix',
      worktreePath: '/repo/.worktrees/wf/fix-bug/add-login-00000001',
      inputs: { notes: 'n' },
      chain: {
        chainId,
        item: { id: 'id-2', title: 'Add Login!', value: 'v', branch: 'wf/fix-bug/add-login-00000001', baseBranch: 'main' },
        origin: { kind: 'pr', number: 3 }
      }
    })
    expect(t.chainOf(chainId).items[0]).toMatchObject({ branch: 'wf/fix-bug/add-login-00000001', baseBranch: 'main' })
    expect(t.persisted.at(-1)?.items[0].baseBranch).toBe('main')
    expect(t.chainOf(chainId).childRunIds).toEqual({ 'id-2': 'run-1' })
  })

  it('keeps an empty base when none resolves so publish can refuse it', async () => {
    const t = setup({
      createWorktree: async ({ branchName }) => ({ ok: true, worktreePath: `/repo/.worktrees/${branchName}`, baseBranch: '' })
    })
    const chainId = t.scheduler.start(request(1))
    await settle()
    expect(t.startRequests[0].chain?.item.baseBranch).toBe('')
    expect(t.chainOf(chainId).items[0]).not.toHaveProperty('baseBranch')
    expect(t.logs).toContainEqual({ message: 'chain item base unresolved', data: { chainId, itemId: 'id-2' } })
  })

  it('passes overrides, allowFull and autopilot through to every child run', async () => {
    const t = setup()
    t.scheduler.start(request(2, { overrides: { a: { model: 'opus' } }, allowFull: true, autopilot: true }))
    await settle()
    expect(t.startRequests).toHaveLength(2)
    for (const startRequest of t.startRequests) {
      expect(startRequest).toMatchObject({ overrides: { a: { model: 'opus' } }, allowFull: true, autopilot: true })
    }
  })
})

describe('ChainScheduler slots', () => {
  it('keeps at most cap children in flight and finishes all items', async () => {
    const t = setup({ cap: 2 })
    const chainId = t.scheduler.start(request(4))
    await settle()
    expect(t.worktreeRequests).toHaveLength(2)
    expect(t.runIds).toEqual(['run-1', 'run-2'])
    t.finish('run-1')
    await settle()
    expect(t.runIds).toHaveLength(3)
    expect(t.liveChildren()).toBe(2)
    t.finish('run-2')
    t.finish('run-3')
    await settle()
    expect(t.runIds).toHaveLength(4)
    expect(t.finishedEvents()).toHaveLength(0)
    t.finish('run-4')
    await settle()
    expect(t.maxLive()).toBeLessThanOrEqual(2)
    expect(t.finishedEvents()).toEqual([
      { type: 'workflows/chainFinished', payload: { chainId, status: 'done', finishedAt: 5000 } }
    ])
    expect(t.chainOf(chainId).finishedAt).toBe(5000)
  })

  it('counts items still creating a worktree against the cap', async () => {
    const gate = deferred<ChainWorktreeResult>()
    const t = setup({ cap: 1, createWorktree: () => gate.promise })
    t.scheduler.start(request(3))
    await settle()
    expect(t.worktreeRequests).toHaveLength(1)
    gate.resolve({ ok: true, worktreePath: '/repo/.worktrees/one', baseBranch: 'main' })
    await settle()
    expect(t.runIds).toEqual(['run-1'])
    expect(t.worktreeRequests).toHaveLength(1)
  })

  it('counts items still inside startRun against the cap', async () => {
    const gate = deferred<void>()
    const t = setup({
      cap: 1,
      startRun: async (startRequest, started) => {
        const result = started(startRequest)
        await gate.promise
        return result
      }
    })
    t.scheduler.start(request(2))
    await settle()
    t.finish('run-1')
    await settle()
    expect(t.worktreeRequests).toHaveLength(1)
    gate.resolve()
    await settle()
    expect(t.worktreeRequests).toHaveLength(2)
  })

  it('shares the cap across chains', async () => {
    const t = setup({ cap: 2 })
    t.scheduler.start(request(2))
    t.scheduler.start(request(2))
    await settle()
    expect(t.runIds).toHaveLength(2)
    t.finish('run-1')
    await settle()
    expect(t.runIds).toHaveLength(3)
  })

  it('starts more items when the cap is raised', async () => {
    const t = setup({ cap: 1 })
    t.scheduler.start(request(3))
    await settle()
    expect(t.runIds).toHaveLength(1)
    t.store.dispatch({ type: 'settings/workflowSettingsChanged', payload: { maxConcurrentAgents: 3 } })
    await settle()
    expect(t.runIds).toHaveLength(3)
  })

  it('starts nothing while Labs workflows is off and resumes when it is turned on', async () => {
    const t = setup({ labs: false })
    const chainId = t.scheduler.start(request(2))
    await settle()
    expect(t.worktreeRequests).toHaveLength(0)
    expect(t.chainOf(chainId).finishedAt).toBeUndefined()
    t.store.dispatch({ type: 'settings/labsChanged', payload: { workflows: true } })
    await settle()
    expect(t.runIds).toHaveLength(2)
  })

  it('ignores run events for runs it does not own', async () => {
    const t = setup({ cap: 1 })
    const foreign: WorkflowRun = { defId: 'd', defHash: 'h', worktreePath: '/other', status: 'running', startedAt: 1, steps: {} }
    t.store.dispatch({ type: 'workflows/runStarted', payload: { runId: 'foreign', run: foreign } })
    t.store.dispatch({
      type: 'workflows/runStarted',
      payload: { runId: 'other-chain', run: { ...foreign, chainId: 'not-mine', itemId: 'x' } }
    })
    t.scheduler.start(request(2))
    await settle()
    expect(t.runIds).toEqual(['run-1'])
    const before = t.events.length
    t.store.dispatch({ type: 'workflows/runFinished', payload: { runId: 'foreign', status: 'done', finishedAt: 2 } })
    t.store.dispatch({ type: 'workflows/runFinished', payload: { runId: 'other-chain', status: 'done', finishedAt: 2 } })
    await settle()
    expect(t.runIds).toEqual(['run-1'])
    expect(t.events.length).toBe(before)
  })
})

describe('ChainScheduler failure isolation', () => {
  it('lets the other children run when one pauses on step-failed and does not finish while it is paused', async () => {
    const t = setup({ cap: 2 })
    const chainId = t.scheduler.start(request(3))
    await settle()
    t.store.dispatch({ type: 'workflows/runPaused', payload: { runId: 'run-1', reason: 'step-failed' } })
    await settle()
    expect(t.runIds).toEqual(['run-1', 'run-2', 'run-3'])
    t.finish('run-2')
    t.finish('run-3')
    await settle()
    expect(t.finishedEvents()).toHaveLength(0)
    expect(deriveChainStatus(t.chainOf(chainId), t.store.getSnapshot().state.workflows.runs)).toEqual({
      status: 'paused',
      runId: 'run-1'
    })
    t.store.dispatch({ type: 'workflows/runCancelled', payload: { runId: 'run-1', finishedAt: 7 } })
    await settle()
    expect(t.finishedEvents()).toEqual([
      { type: 'workflows/chainFinished', payload: { chainId, status: 'cancelled', finishedAt: 5000 } }
    ])
  })

  it('finishes failed when a child fails and the others are done', async () => {
    const t = setup({ cap: 3 })
    const chainId = t.scheduler.start(request(3))
    await settle()
    t.finish('run-1')
    t.finish('run-2', 'failed')
    t.finish('run-3')
    await settle()
    expect(t.finishedEvents()).toEqual([{ type: 'workflows/chainFinished', payload: { chainId, status: 'failed', finishedAt: 5000 } }])
  })

  it('fails only the item whose worktree creation fails', async () => {
    const t = setup({
      cap: 2,
      createWorktree: async ({ branchName }) =>
        branchName.includes('item-2-')
          ? { ok: false, reason: 'worktree-failed' }
          : { ok: true, worktreePath: `/repo/.worktrees/${branchName}`, baseBranch: 'main' }
    })
    const chainId = t.scheduler.start(request(3))
    await settle()
    expect(t.runIds).toEqual(['run-1', 'run-2'])
    const items = t.chainOf(chainId).items
    expect(items[1].failed).toBe(true)
    expect(items[0].failed).toBeUndefined()
    expect(t.persisted.at(-1)?.items[1].failed).toBe('worktree-failed')
    t.finish('run-1')
    t.finish('run-2')
    await settle()
    expect(t.finishedEvents()).toEqual([{ type: 'workflows/chainFinished', payload: { chainId, status: 'failed', finishedAt: 5000 } }])
  })

  it('fails an item whose worktree setup script fails or whose creation throws', async () => {
    let call = 0
    const t = setup({
      cap: 3,
      createWorktree: async () => {
        call++
        if (call === 1) return { ok: false, reason: 'setup-failed' }
        if (call === 2) throw new Error('git exploded on wf/secret-branch')
        return { ok: true, worktreePath: '/repo/.worktrees/three', baseBranch: 'main' }
      }
    })
    const chainId = t.scheduler.start(request(3))
    await settle()
    expect(t.persisted.at(-1)?.items.map((item) => item.failed)).toEqual(['setup-failed', 'worktree-failed', undefined])
    t.finish('run-1')
    await settle()
    expect(t.finishedEvents()).toHaveLength(1)
    expect(t.chainOf(chainId).finishedAt).toBe(5000)
  })

  it('fails an item the runner refuses and keeps going', async () => {
    const t = setup({
      cap: 1,
      startRun: async (startRequest, started) =>
        startRequest.chain?.item.title === 'Item 1' ? { ok: false, reason: 'hooks-consent' } : started(startRequest)
    })
    const chainId = t.scheduler.start(request(2))
    await settle()
    expect(t.chainOf(chainId).items[0].failed).toBe(true)
    expect(t.runIds).toEqual(['run-1'])
    expect(t.logs).toContainEqual({
      message: 'chain item failed',
      data: { chainId, itemId: 'id-2', reason: 'start-refused', refusal: 'hooks-consent' }
    })
    t.finish('run-1')
    await settle()
    expect(t.finishedEvents()).toEqual([{ type: 'workflows/chainFinished', payload: { chainId, status: 'failed', finishedAt: 5000 } }])
  })

  it('fails an item whose startRun throws', async () => {
    const t = setup({
      startRun: async () => {
        throw new Error('boom')
      }
    })
    const chainId = t.scheduler.start(request(1))
    await settle()
    expect(t.persisted.at(-1)?.items[0].failed).toBe('start-threw')
    expect(t.finishedEvents()).toEqual([{ type: 'workflows/chainFinished', payload: { chainId, status: 'failed', finishedAt: 5000 } }])
  })

  it('finishes failed exactly once when every item fails', async () => {
    const t = setup({ cap: 2, createWorktree: async () => ({ ok: false, reason: 'worktree-failed' }) })
    const chainId = t.scheduler.start(request(4))
    await settle()
    expect(t.worktreeRequests).toHaveLength(4)
    expect(t.finishedEvents()).toEqual([{ type: 'workflows/chainFinished', payload: { chainId, status: 'failed', finishedAt: 5000 } }])
    t.store.dispatch({ type: 'settings/workflowSettingsChanged', payload: { maxConcurrentAgents: 3 } })
    await settle()
    expect(t.finishedEvents()).toHaveLength(1)
    expect(t.persisted.at(-1)).toMatchObject({ finishedAt: 5000, status: 'failed' })
  })

  it('finishes done even after the child runs are evicted from the slice', async () => {
    const t = setup({ cap: 2 })
    const chainId = t.scheduler.start(request(2))
    await settle()
    t.finish('run-1')
    t.store.dispatch({ type: 'workflows/runsEvicted', payload: { runIds: ['run-1'] } })
    t.finish('run-2')
    await settle()
    expect(t.finishedEvents()).toEqual([{ type: 'workflows/chainFinished', payload: { chainId, status: 'done', finishedAt: 5000 } }])
  })
})

const B1 = 'wf/fix-bug/item-1-00000001'
const B2 = 'wf/fix-bug/item-2-00000002'
const B3 = 'wf/fix-bug/item-3-00000003'

describe('ChainScheduler stacked mode', () => {
  it('runs items one at a time, each branching from the previous item with its PR number', async () => {
    const t = setup({ cap: 3 })
    const chainId = t.scheduler.start(request(3, { mode: 'stacked' }))
    await settle()
    expect(t.worktreeRequests).toEqual([{ repoRoot: '/repo', branchName: B1 }])
    expect(t.runIds).toEqual(['run-1'])
    expect(t.startRequests[0].chain).not.toHaveProperty('stackedOn')
    t.recordPr('run-1', 41)
    t.finish('run-1')
    await settle()
    expect(t.worktreeRequests[1]).toEqual({ repoRoot: '/repo', branchName: B2, baseBranch: B1 })
    expect(t.startRequests[1].chain).toMatchObject({ item: { id: 'id-3', branch: B2, baseBranch: B1 }, stackedOn: 41 })
    expect(t.chainOf(chainId).items[0]).toMatchObject({ prNumber: 41 })
    expect(t.chainOf(chainId).items[1]).toMatchObject({ prevItemId: 'id-2', baseBranch: B1 })
    expect(t.persisted.at(-1)?.items[0]).toMatchObject({ prNumber: 41 })
    expect(t.persisted.at(-1)?.items[1]).toMatchObject({ prevItemId: 'id-2', stackedOn: 41, baseBranch: B1 })
    t.recordPr('run-2', 42)
    t.finish('run-2')
    await settle()
    expect(t.worktreeRequests[2]).toEqual({ repoRoot: '/repo', branchName: B3, baseBranch: B2 })
    expect(t.startRequests[2].chain).toMatchObject({ item: { baseBranch: B2 }, stackedOn: 42 })
    t.finish('run-3')
    await settle()
    expect(t.maxLive()).toBe(1)
    expect(t.finishedEvents()).toEqual([
      { type: 'workflows/chainFinished', payload: { chainId, status: 'done', finishedAt: 5000 } }
    ])
  })

  it.each([
    ['paused', 'paused'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled']
  ] as const)('keeps later items queued and the chain open while item 1 is %s', async (outcome, derived) => {
    const t = setup({ cap: 3 })
    const chainId = t.scheduler.start(request(3, { mode: 'stacked' }))
    await settle()
    if (outcome === 'paused') t.pause('run-1')
    else if (outcome === 'failed') t.finish('run-1', 'failed')
    else t.cancel('run-1')
    await settle()
    expect(t.worktreeRequests).toHaveLength(1)
    expect(t.finishedEvents()).toHaveLength(0)
    const chain = t.chainOf(chainId)
    expect(chain.finishedAt).toBeUndefined()
    expect(deriveChainStatus(chain, t.store.getSnapshot().state.workflows.runs).status).toBe(derived)
  })

  it('retries a cancelled item in its existing worktree and then unblocks the next item', async () => {
    const t = setup({ cap: 3 })
    const chainId = t.scheduler.start(request(2, { mode: 'stacked' }))
    await settle()
    expect(await t.scheduler.retryItem(chainId, 'id-2')).toEqual({ ok: false, reason: 'not-retryable' })
    t.cancel('run-1')
    await settle()
    expect(await t.scheduler.retryItem(chainId, 'id-2')).toEqual({ ok: true })
    expect(t.worktreeRequests).toHaveLength(1)
    expect(t.startRequests[1].worktreePath).toBe(t.startRequests[0].worktreePath)
    expect(t.startRequests[1].chain).toEqual(t.startRequests[0].chain)
    expect(t.chainOf(chainId).childRunIds).toEqual({ 'id-2': 'run-2' })
    expect(t.persisted.at(-1)?.items[0].runId).toBe('run-2')
    t.finish('run-2')
    await settle()
    expect(t.worktreeRequests[1]).toEqual({ repoRoot: '/repo', branchName: B2, baseBranch: B1 })
    t.finish('run-3')
    await settle()
    expect(t.finishedEvents()[0]?.payload).toMatchObject({ chainId, status: 'done' })
  })

  it('ignores the replaced run after a retry', async () => {
    const t = setup({ cap: 3 })
    const chainId = t.scheduler.start(request(2, { mode: 'stacked' }))
    await settle()
    t.finish('run-1', 'failed')
    await settle()
    await t.scheduler.retryItem(chainId, 'id-2')
    t.pause('run-2')
    await settle()
    expect(t.worktreeRequests).toHaveLength(1)
    expect(t.finishedEvents()).toHaveLength(0)
  })

  it('reports a runner refusal on retry without failing the item', async () => {
    let refuse = false
    const t = setup({
      startRun: async (startRequest, started) => (refuse ? { ok: false, reason: 'worktree-busy' } : started(startRequest))
    })
    const chainId = t.scheduler.start(request(2, { mode: 'stacked' }))
    await settle()
    t.cancel('run-1')
    await settle()
    refuse = true
    expect(await t.scheduler.retryItem(chainId, 'id-2')).toEqual({ ok: false, reason: 'start-refused', refusal: 'worktree-busy' })
    expect(t.chainOf(chainId).items[0]).not.toHaveProperty('failed')
    refuse = false
    expect(await t.scheduler.retryItem(chainId, 'id-2')).toEqual({ ok: true })
  })

  it('skips onto the previous item: item 3 branches from item 1 with its PR number', async () => {
    const t = setup({ cap: 3 })
    const chainId = t.scheduler.start(request(3, { mode: 'stacked' }))
    await settle()
    t.recordPr('run-1', 41)
    t.finish('run-1')
    await settle()
    t.finish('run-2', 'failed')
    await settle()
    expect(t.scheduler.skipItem(chainId, 'id-3', 'onto-previous')).toEqual({ ok: true })
    await settle()
    expect(t.chainOf(chainId).items[1]).toMatchObject({ skipped: true })
    expect(t.worktreeRequests[2]).toEqual({ repoRoot: '/repo', branchName: B3, baseBranch: B1 })
    expect(t.startRequests[2].chain).toMatchObject({ item: { baseBranch: B1 }, stackedOn: 41 })
    expect(t.chainOf(chainId).items[2]).toMatchObject({ prevItemId: 'id-2' })
    t.finish('run-3')
    await settle()
    expect(t.finishedEvents()[0]?.payload).toMatchObject({ chainId, status: 'done' })
  })

  it('keeps the previous PR number for the stack after the previous run leaves the slice', async () => {
    const t = setup({ cap: 3 })
    const chainId = t.scheduler.start(request(3, { mode: 'stacked' }))
    await settle()
    t.recordPr('run-1', 41)
    t.finish('run-1')
    await settle()
    t.store.dispatch({ type: 'workflows/runsEvicted', payload: { runIds: ['run-1'] } })
    t.cancel('run-2')
    await settle()
    expect(t.scheduler.skipItem(chainId, 'id-3', 'onto-previous')).toEqual({ ok: true })
    await settle()
    expect(t.startRequests[2].chain).toMatchObject({ item: { baseBranch: B1 }, stackedOn: 41 })
  })

  it('skips a paused item by cancelling its child first, and starts the next item from the repo base', async () => {
    const t = setup({ cap: 3 })
    const chainId = t.scheduler.start(request(2, { mode: 'stacked' }))
    await settle()
    t.pause('run-1')
    await settle()
    expect(t.scheduler.skipItem(chainId, 'id-2', 'onto-previous')).toEqual({ ok: true })
    await settle()
    expect(t.cancelRequests).toEqual(['run-1'])
    expect(t.worktreeRequests[1]).toEqual({ repoRoot: '/repo', branchName: B2 })
    expect(t.chainOf(chainId).items[1]).not.toHaveProperty('prevItemId')
    expect(t.maxLive()).toBe(1)
  })

  it('skips an item that failed before it had a run, which cannot be retried', async () => {
    let calls = 0
    const t = setup({
      createWorktree: async ({ branchName, baseBranch }) =>
        ++calls === 1
          ? { ok: false, reason: 'worktree-failed' }
          : { ok: true, worktreePath: `/repo/.worktrees/${branchName}`, baseBranch: baseBranch ?? 'main' }
    })
    const chainId = t.scheduler.start(request(2, { mode: 'stacked' }))
    await settle()
    expect(t.chainOf(chainId).items[0]).toMatchObject({ failed: true })
    expect(t.finishedEvents()).toHaveLength(0)
    expect(await t.scheduler.retryItem(chainId, 'id-2')).toEqual({ ok: false, reason: 'not-retryable' })
    expect(t.scheduler.skipItem(chainId, 'id-2', 'onto-previous')).toEqual({ ok: true })
    await settle()
    expect(t.runIds).toEqual(['run-1'])
    expect(t.startRequests[0].chain?.item.id).toBe('id-3')
  })

  it('cancel-rest cancels the live child, skips this and every later item, and finishes the chain', async () => {
    const t = setup({ cap: 3 })
    const chainId = t.scheduler.start(request(3, { mode: 'stacked' }))
    await settle()
    t.finish('run-1')
    await settle()
    expect(t.scheduler.skipItem(chainId, 'id-3', 'cancel-rest')).toEqual({ ok: true })
    await settle()
    expect(t.cancelRequests).toEqual(['run-2'])
    expect(t.chainOf(chainId).items.map((item) => item.skipped)).toEqual([undefined, true, true])
    expect(t.worktreeRequests).toHaveLength(2)
    expect(t.finishedEvents()).toHaveLength(1)
    expect(t.persisted.at(-1)).toMatchObject({ finishedAt: 5000, status: 'done' })
  })

  it('refuses to skip anything but the blocking item of a live stacked chain', async () => {
    const t = setup({ cap: 3 })
    const chainId = t.scheduler.start(request(3, { mode: 'stacked' }))
    await settle()
    t.finish('run-1')
    await settle()
    expect(t.scheduler.skipItem(chainId, 'id-2', 'onto-previous')).toEqual({ ok: false, reason: 'not-blocking' })
    expect(t.scheduler.skipItem(chainId, 'id-4', 'cancel-rest')).toEqual({ ok: false, reason: 'not-blocking' })
    expect(t.scheduler.skipItem(chainId, 'nope', 'cancel-rest')).toEqual({ ok: false, reason: 'unknown-item' })
    expect(t.scheduler.skipItem('nope', 'id-3', 'cancel-rest')).toEqual({ ok: false, reason: 'unknown-chain' })
    t.refuseCancel()
    expect(t.scheduler.skipItem(chainId, 'id-3', 'cancel-rest')).toEqual({ ok: false, reason: 'busy' })
    expect(t.chainOf(chainId).items.some((item) => item.skipped)).toBe(false)
  })

  it('refuses retry and skip while Labs workflows is off', async () => {
    const t = setup()
    const chainId = t.scheduler.start(request(2, { mode: 'stacked' }))
    await settle()
    t.cancel('run-1')
    await settle()
    t.store.dispatch({ type: 'settings/labsChanged', payload: { ...t.store.getSnapshot().state.settings.labs, workflows: false } })
    expect(await t.scheduler.retryItem(chainId, 'id-2')).toEqual({ ok: false, reason: 'labs-off' })
    expect(t.scheduler.skipItem(chainId, 'id-2', 'cancel-rest')).toEqual({ ok: false, reason: 'labs-off' })
  })
})

describe('ChainScheduler independent retry', () => {
  it('retries a failed item while a sibling still runs and refuses skip', async () => {
    const t = setup({ cap: 2 })
    const chainId = t.scheduler.start(request(2))
    await settle()
    t.finish('run-1', 'failed')
    await settle()
    expect(t.scheduler.skipItem(chainId, 'id-2', 'onto-previous')).toEqual({ ok: false, reason: 'not-stacked' })
    expect(await t.scheduler.retryItem(chainId, 'id-2')).toEqual({ ok: true })
    expect(t.startRequests[2].worktreePath).toBe(t.startRequests[0].worktreePath)
    t.finish('run-2')
    t.finish('run-3')
    await settle()
    expect(t.finishedEvents()[0]?.payload).toMatchObject({ chainId, status: 'done' })
    expect(await t.scheduler.retryItem(chainId, 'id-2')).toEqual({ ok: false, reason: 'unknown-chain' })
  })
})

describe('ChainScheduler logging and disposal', () => {
  it('logs chain ids, item ids, run ids and reason codes only', async () => {
    const t = setup({
      cap: 2,
      createWorktree: async ({ branchName }) =>
        t.worktreeRequests.length === 1
          ? { ok: true, worktreePath: `/repo/.worktrees/${branchName}`, baseBranch: 'main' }
          : { ok: false, reason: 'worktree-failed' }
    })
    t.scheduler.start(
      request(2, {
        items: [
          { title: TITLE_SECRET, value: VALUE_SECRET },
          { title: `${TITLE_SECRET} two`, value: VALUE_SECRET }
        ]
      })
    )
    await settle()
    t.finish('run-1')
    await settle()
    const text = JSON.stringify(t.logs)
    expect(text).not.toContain('TITLE-SECRET')
    expect(text).not.toContain('title-secret')
    expect(text).not.toContain(VALUE_SECRET)
    expect(text).not.toContain('wf/')
    expect(t.logs.map((entry) => entry.message).sort()).toEqual([
      'chain finished failed',
      'chain item failed',
      'chain item linked',
      'chain item started',
      'chain item started',
      'chain started'
    ])
    for (const { data } of t.logs) {
      expect(Object.keys(data ?? {}).every((key) => ['chainId', 'itemId', 'runId', 'reason', 'refusal'].includes(key))).toBe(true)
    }
  })

  it('stops reacting after dispose', async () => {
    const gate = deferred<ChainWorktreeResult>()
    const t = setup({ cap: 1, createWorktree: () => gate.promise })
    t.scheduler.start(request(2))
    await settle()
    const before = t.events.length
    t.scheduler.dispose()
    gate.resolve({ ok: true, worktreePath: '/repo/.worktrees/one', baseBranch: 'main' })
    await settle()
    expect(t.startRequests).toHaveLength(0)
    expect(t.events.length).toBe(before)
  })
})

describe('createWorkflowChainRecords', () => {
  let dir = ''
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  function record(chainId: string, finishedAt?: number): WorkflowChainRecord {
    return {
      version: 1,
      chainId,
      defId: 'personal:fix',
      definitionName: 'Fix',
      repoRoot: '/repo',
      mode: 'independent',
      draftPrs: false,
      inputs: {},
      items: [{ id: 'i1', title: 't', value: 'v', runId: 'r1' }],
      startedAt: 1,
      ...(finishedAt === undefined ? {} : { finishedAt })
    }
  }

  it('writes the latest record per chain to <chainId>.json and leaves no temp files', async () => {
    dir = await mkdtemp(join(tmpdir(), 'chain-records-'))
    const records = createWorkflowChainRecords({ dir, log: () => {} })
    records.persist(record('chain-1'))
    records.persist(record('chain-1', 9))
    await records.flush()
    expect(await readdir(dir)).toEqual(['chain-1.json'])
    expect(JSON.parse(await readFile(join(dir, 'chain-1.json'), 'utf8'))).toEqual(record('chain-1', 9))
  })

  it('reads the draft flag back from a persisted record and nothing for a missing or unsafe id', async () => {
    dir = await mkdtemp(join(tmpdir(), 'chain-records-'))
    const records = createWorkflowChainRecords({ dir, log: () => {} })
    records.persist({ ...record('chain-2'), draftPrs: true })
    await records.flush()
    expect(readWorkflowChainDraftPrs(dir, 'chain-2')).toBe(true)
    expect(readWorkflowChainDraftPrs(dir, 'chain-3')).toBeUndefined()
    expect(readWorkflowChainDraftPrs(dir, '../chain-2')).toBeUndefined()
  })

  it('refuses a chain id that is not a safe file name', async () => {
    dir = await mkdtemp(join(tmpdir(), 'chain-records-'))
    const messages: string[] = []
    const records = createWorkflowChainRecords({ dir, log: (_c, message) => messages.push(message) })
    records.persist(record('../escape'))
    await records.flush()
    expect(await readdir(dir)).toEqual([])
    expect(messages).toEqual(['chain record refused invalid id'])
  })
})

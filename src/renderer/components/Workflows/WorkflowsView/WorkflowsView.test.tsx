// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowsView } from './WorkflowsView'
import { initialState, type AppState } from '../../../../shared/state'
import type { WorkflowAttempt, WorkflowDefinitionSummary, WorkflowRun } from '../../../../shared/state/workflows'

const { storeState } = vi.hoisted(() => ({ storeState: { current: null as AppState | null } }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { backendApi } = vi.hoisted(() => ({
  backendApi: { getWorkflowRun: vi.fn(), getWorkflowAttemptResult: vi.fn() }
}))

vi.mock('../../../backend', () => ({ useBackend: () => backendApi }))
vi.mock('../../MonacoDiffEditor', () => ({ MonacoDiffEditor: () => null }))
vi.mock('../../../store', async () => {
  const selectors = await import('../../../workflow-selectors')
  const selectPaused = selectors.createPausedRunIdsSelector()
  const selectAttempts = selectors.createRunAttemptsSelector()
  const useAppState = <T,>(selector: (s: AppState) => T): T => {
    if (!storeState.current) throw new Error('store not set')
    return selector(storeState.current)
  }
  return {
    useAppState,
    usePausedWorkflowRunIds: () => useAppState((s) => selectPaused(s.workflows)),
    useWorkflowRun: (id: string | null) => useAppState((s) => (id ? s.workflows.runs[id] ?? null : null)),
    useWorkflowAttempt: (id: string | null) => useAppState((s) => (id ? s.workflows.attempts[id] ?? null : null)),
    useWorkflowDefinition: (id: string | null) => useAppState((s) => (id ? s.workflows.definitions[id] ?? null : null)),
    useWorkflowRunAttempts: (id: string) => useAppState((s) => selectAttempts(s.workflows, id)),
    useWorkflowRunRecordKey: (id: string) => useAppState((s) => selectors.workflowRunRecordKey(s.workflows, id)),
    useWorktreeRepoRoot: (path: string | null) =>
      useAppState((s) => (path ? s.worktrees.list.find((w) => w.path === path)?.repoRoot ?? null : null)),
    useWorkflowStepTabLeaf: () => null
  }
})

const NOW = 1_000_000

const SUMMARY: WorkflowDefinitionSummary = {
  id: 'personal:ship',
  name: 'Ship it',
  scope: 'personal',
  path: '/d/ship.yaml',
  hash: 'h',
  stepIds: ['plan', 'build'],
  issues: []
}

function run(overrides: Partial<WorkflowRun>): WorkflowRun {
  return {
    defId: SUMMARY.id,
    defHash: 'h',
    worktreePath: '/repos/app/feature',
    status: 'running',
    startedAt: NOW - 65_000,
    cursorStepId: 'build',
    steps: {
      plan: { status: 'done', attemptIds: ['a-plan'], kind: 'shell' },
      build: { status: 'running', attemptIds: ['a-build'], kind: 'agent', agent: 'claude' }
    },
    ...overrides
  }
}

function attempt(stepId: string, costUsd?: number): WorkflowAttempt {
  return {
    runId: 'r',
    stepId,
    n: 1,
    status: 'done',
    summaryPreview: '',
    startedAt: NOW - 60_000,
    ...(costUsd === undefined ? {} : { costUsd })
  }
}

function setState(runs: Record<string, WorkflowRun>, attempts: Record<string, WorkflowAttempt> = {}): void {
  storeState.current = {
    ...initialState,
    settings: { ...initialState.settings, labs: { ...initialState.settings.labs, workflows: true } },
    worktrees: {
      ...initialState.worktrees,
      list: [{ path: '/repos/app/feature', branch: 'feature', head: 'abc', isBare: false, isMain: false, createdAt: 0, repoRoot: '/repos/app' }]
    },
    workflows: { definitions: { [SUMMARY.id]: SUMMARY }, runs, attempts, trust: {} }
  }
}

let container: HTMLDivElement
let root: Root
const onClose = vi.fn()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(NOW)
  onClose.mockReset()
  backendApi.getWorkflowRun.mockReset().mockResolvedValue(null)
  backendApi.getWorkflowAttemptResult.mockReset().mockResolvedValue(null)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

async function render(): Promise<void> {
  await act(async () => {
    root.render(<WorkflowsView onClose={onClose} />)
  })
}

const region = (name: string): HTMLElement => {
  const found = [...container.querySelectorAll<HTMLElement>('section')].find(
    (s) => s.getAttribute('aria-label') === name || s.querySelector('h2')?.textContent?.startsWith(name)
  )
  if (!found) throw new Error(`no section ${name}`)
  return found
}
const cards = (section: HTMLElement): string[] =>
  [...section.querySelectorAll('article')].map((a) => a.getAttribute('aria-label') ?? '')

describe('WorkflowsView', () => {
  it('pins Needs you above the Active and Recent runs', async () => {
    setState(
      {
        live: run({}),
        held: run({ status: 'paused', pausedReason: 'needs-input', startedAt: NOW - 1_000, worktreePath: '/repos/app/held' }),
        old: run({ status: 'done', startedAt: NOW - 500_000, finishedAt: NOW - 400_000, worktreePath: '/repos/app/old' }),
        newer: run({ status: 'cancelled', startedAt: NOW - 300_000, finishedAt: NOW - 200_000, worktreePath: '/repos/app/newer' })
      },
      { 'a-plan': attempt('plan'), 'a-build': attempt('build', 0.42) }
    )
    await render()

    const sections = [...container.querySelectorAll('[role="tabpanel"] section')]
    expect(sections.map((s) => s.getAttribute('aria-label') ?? s.querySelector('h2')?.textContent)).toEqual([
      'NEEDS YOU1',
      'Active runs',
      'Recent runs'
    ])
    expect(region('NEEDS YOU').textContent).toContain('Ship it')
    expect(cards(region('Active runs'))).toEqual(['Ship it on held', 'Ship it on feature'])
    expect(cards(region('Recent runs'))).toEqual(['Ship it on newer', 'Ship it on old'])
  })

  it('shows the run card facts: location, step strip, current agent, status, elapsed and cost', async () => {
    setState({ live: run({}) }, { 'a-plan': attempt('plan'), 'a-build': attempt('build', 0.42) })
    await render()

    const card = region('Active runs').querySelector('article')
    expect(card?.textContent).toContain('app / feature')
    expect(card?.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Workflow steps: plan done, build running')
    const facts = Object.fromEntries(
      [...(card?.querySelectorAll('dt') ?? [])].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent])
    )
    expect(facts).toEqual({ Step: 'build · Claude Code', Elapsed: '1m 05s', Cost: '$0.42' })
    expect(card?.textContent).toContain('Running')
  })

  it('ticks the elapsed time of active runs every second', async () => {
    setState({ live: run({}) })
    await render()
    const elapsed = () => region('Active runs').querySelectorAll('dd')[1]?.textContent
    expect(elapsed()).toBe('1m 05s')
    await act(async () => {
      vi.advanceTimersByTime(2_000)
    })
    expect(elapsed()).toBe('1m 07s')
  })

  it('shows a dash when no step reports a cost and empty states without runs', async () => {
    setState({ live: run({}) }, { 'a-plan': attempt('plan'), 'a-build': attempt('build') })
    await render()
    expect(region('Active runs').querySelectorAll('dd')[2]?.textContent).toBe('—')
    expect(region('Recent runs').textContent).toContain('No finished runs yet.')

    setState({})
    await render()
    expect(region('Active runs').textContent).toContain('No active runs.')
    expect(container.textContent).not.toContain('NEEDS YOU')
  })

  it('opens the launch sheet with no preset from the Run workflow… button', async () => {
    setState({})
    const onRunWorkflow = vi.fn()
    await act(async () => {
      root.render(<WorkflowsView onClose={onClose} onRunWorkflow={onRunWorkflow} />)
    })
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Run workflow…')
    await act(async () => button?.click())
    expect(onRunWorkflow).toHaveBeenCalledOnce()
    expect(onRunWorkflow).toHaveBeenCalledWith()
  })

  it('closes from the Back button', async () => {
    setState({})
    await render()
    const back = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Back')
    await act(async () => back?.click())
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('opens a run detail from its card and returns to the list', async () => {
    setState(
      { old: run({ status: 'done', startedAt: NOW - 500_000, finishedAt: NOW - 400_000, worktreePath: '/repos/app/old' }) },
      { 'a-plan': attempt('plan'), 'a-build': attempt('build') }
    )
    await render()
    const open = container.querySelector<HTMLButtonElement>('button[aria-label="Open run: Ship it on old"]')
    await act(async () => open?.click())
    expect(backendApi.getWorkflowRun).toHaveBeenCalledWith('old')
    expect(container.querySelector('h2')?.textContent).toBe('Ship it')
    expect(document.activeElement).toBe(container.querySelector('h2'))
    expect(container.textContent).not.toContain('No active runs.')

    const allRuns = [...container.querySelectorAll('button')].find((b) => b.textContent === 'All runs')
    await act(async () => allRuns?.click())
    expect(region('Recent runs').querySelector('article')?.getAttribute('aria-label')).toBe('Ship it on old')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Open run: Ship it on old')
  })

  it('restores focus to the returned-from card once and never steals it later', async () => {
    setState({ live: run({}) }, { 'a-plan': attempt('plan'), 'a-build': attempt('build') })
    await render()
    const open = container.querySelector<HTMLButtonElement>('button[aria-label="Open run: Ship it on feature"]')
    await act(async () => open?.click())
    const allRuns = [...container.querySelectorAll('button')].find((b) => b.textContent === 'All runs')
    await act(async () => allRuns?.click())
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Open run: Ship it on feature')

    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    setState(
      { live: run({ status: 'done', finishedAt: NOW - 1_000 }) },
      { 'a-plan': attempt('plan'), 'a-build': attempt('build') }
    )
    await render()
    expect(region('Recent runs').querySelector('article')?.getAttribute('aria-label')).toBe('Ship it on feature')
    expect(document.activeElement).toBe(input)
    input.remove()
  })
})


// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewWorktreeScreen } from './NewWorktreeScreen'
import { useWorktreeHandlers } from '../../hooks/useWorktreeHandlers'
import { initialState, type AppState } from '../../../shared/state'
import type { WorkflowDefinitionSummary } from '../../../shared/state/workflows'

type Outcome =
  | { id: string; outcome: 'success'; createdPath: string }
  | { id: string; outcome: 'setup-failed'; createdPath: string }
  | { id: string; outcome: 'error'; error: string }

const { calls, runPending, storeState } = vi.hoisted(() => ({
  calls: [] as { method: string; args: unknown[] }[],
  runPending: { outcome: null as ((id: string) => unknown) | null },
  storeState: {
    settings: null as AppState['settings'] | null,
    definitions: {} as Record<string, WorkflowDefinitionSummary>
  }
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../backend', () => {
  const backend = new Proxy(
    {},
    {
      get: (_target, method: string) =>
        (...args: unknown[]) => {
          if (method.startsWith('on')) return () => {}
          calls.push({ method, args })
          if (method === 'runPendingWorktree') {
            const { id } = args[0] as { id: string }
            return Promise.resolve(runPending.outcome?.(id))
          }
          return Promise.resolve(undefined)
        }
    }
  )
  return { useBackend: () => backend }
})
vi.mock('../../components/XTerminal', () => ({ markTerminalClosing: vi.fn() }))
vi.mock('../../store', () => ({
  useSettings: () => storeState.settings,
  useActiveBackend: () => ({ kind: 'local' }),
  useWorkflowDefinitions: () => storeState.definitions
}))

const REPO_DEF = 'repo:abc:ship'

function summary(id: string, scope: 'personal' | 'repo', repoRoot?: string, issues: string[] = []): WorkflowDefinitionSummary {
  const name = id.split(':').pop() ?? id
  return { id, name, scope, repoRoot, path: `/defs/${name}.yaml`, hash: `h-${name}`, stepIds: [], issues }
}

const openWorkflowLaunch = vi.fn<(target: { worktreePath: string; defId: string }) => void>()
const setActiveWorktreeId = vi.fn()
let container: HTMLDivElement
let root: Root

function Harness(): JSX.Element {
  const { handleSubmitNewWorktree, handleSubmitNewPRWorktree } = useWorktreeHandlers({
    worktrees: [],
    pendingWorktrees: [],
    repoRoots: ['/repo', '/other'],
    worktreeRepoByPath: {},
    terminalTabs: {},
    prStatuses: {},
    activeWorktreeId: null,
    setActiveWorktreeId,
    setActivePaneId: vi.fn(),
    setShowNewWorktree: vi.fn(),
    openWorkflowLaunch
  })
  return (
    <NewWorktreeScreen
      onSubmit={handleSubmitNewWorktree}
      onPRSubmit={handleSubmitNewPRWorktree}
      onCancel={vi.fn()}
      repoRoots={['/repo', '/other']}
      defaultRepoRoot="/repo"
    />
  )
}

function setLabs(workflows: boolean): void {
  storeState.settings = { ...initialState.settings, labs: { ...initialState.settings.labs, workflows } }
}

async function render(): Promise<void> {
  await act(async () => root.render(<Harness />))
}

function workflowSelect(): HTMLSelectElement | null {
  return container.querySelector<HTMLSelectElement>('select#new-worktree-workflow')
}

async function typeBranch(value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[placeholder="fix-the-thing"]')
  if (!input) throw new Error('branch input missing')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function create(): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Create worktree'))
  if (!button) throw new Error('create button missing')
  await act(async () => button.click())
}

const methods = (): string[] => calls.map((c) => c.method)

beforeEach(() => {
  calls.length = 0
  runPending.outcome = (id) => ({ id, outcome: 'success', createdPath: '/wts/feat' }) satisfies Outcome
  openWorkflowLaunch.mockReset()
  setActiveWorktreeId.mockReset()
  storeState.definitions = {
    'personal:plan': summary('personal:plan', 'personal'),
    'personal:broken': summary('personal:broken', 'personal', undefined, ['steps[0].prompt is required']),
    [REPO_DEF]: summary(REPO_DEF, 'repo', '/repo'),
    'repo:def:elsewhere': summary('repo:def:elsewhere', 'repo', '/other')
  }
  setLabs(true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('NewWorktreeScreen Workflow select', () => {
  it('is hidden with Labs workflows off', async () => {
    setLabs(false)
    await render()
    expect(workflowSelect()).toBeNull()
  })

  it('defaults to none and lists personal plus that repo’s definitions with broken ones disabled', async () => {
    await render()
    const select = workflowSelect()
    expect(select?.value).toBe('')
    const options = [...(select?.options ?? [])].map((o) => [o.value, o.disabled])
    expect(options).toEqual([
      ['', false],
      ['personal:broken', true],
      ['personal:plan', false],
      [REPO_DEF, false]
    ])
  })

  it('creates the worktree for the workflow, opens the launch sheet on it and sends no agent tab request', async () => {
    await render()
    await typeBranch('feat')
    await choose(workflowSelect()!, REPO_DEF)
    await create()

    expect(methods()).toEqual(['runPendingWorktree'])
    const [params] = calls[0].args as [Record<string, unknown>]
    expect(params).toEqual({ id: expect.stringMatching(/^pending:/), repoRoot: '/repo', branchName: 'feat', workflow: true })
    expect(openWorkflowLaunch).toHaveBeenCalledWith({ worktreePath: '/wts/feat', defId: REPO_DEF })
  })

  it('opens the launch sheet on a setup-failed worktree and dismisses its pending entry', async () => {
    runPending.outcome = (id) => ({ id, outcome: 'setup-failed', createdPath: '/wts/feat' }) satisfies Outcome
    await render()
    await typeBranch('feat')
    await choose(workflowSelect()!, 'personal:plan')
    await create()

    expect(methods()).toEqual(['runPendingWorktree', 'dismissPendingWorktree'])
    expect(setActiveWorktreeId).toHaveBeenLastCalledWith('/wts/feat')
    expect(openWorkflowLaunch).toHaveBeenCalledWith({ worktreePath: '/wts/feat', defId: 'personal:plan' })
  })

  it('does not open the launch sheet when creation fails', async () => {
    runPending.outcome = (id) => ({ id, outcome: 'error', error: 'git said no' }) satisfies Outcome
    await render()
    await typeBranch('feat')
    await choose(workflowSelect()!, 'personal:plan')
    await create()

    expect(methods()).toEqual(['runPendingWorktree'])
    expect(openWorkflowLaunch).not.toHaveBeenCalled()
  })

  it('creates an ordinary worktree with the agent settings when no workflow is selected', async () => {
    await render()
    await typeBranch('feat')
    await create()

    const [params] = calls[0].args as [Record<string, unknown>]
    expect(params).not.toHaveProperty('workflow')
    expect(params).toMatchObject({ repoRoot: '/repo', branchName: 'feat', agentKind: 'claude' })
    expect(openWorkflowLaunch).not.toHaveBeenCalled()
  })
})

// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LaunchSheet } from './LaunchSheet'
import { validateWorkflowDefinition } from '../../../../shared/workflow-def'
import type { HooksConsent } from '../../../../shared/state/hooks'
import type {
  WorkflowDefinitionDetail,
  WorkflowDefinitionSummary,
  WorkflowRun
} from '../../../../shared/state/workflows'
import type { Worktree } from '../../../../shared/state/worktrees'
import { STEP_HARNESS_AGENTS } from '../../../../shared/state/workflows'

const { backendApi, storeState } = vi.hoisted(() => {
  const backendApi = {
    getWorkflowDefinition: vi.fn(),
    startWorkflowRun: vi.fn(),
    acceptHooks: vi.fn(),
    trustWorkflowDefinition: vi.fn(),
    runPendingWorktree: vi.fn(),
    dismissPendingWorktree: vi.fn(),
    listRepoIssues: vi.fn(),
    listRepoPRs: vi.fn(),
    listAllFiles: vi.fn()
  }
  const storeState: {
    definitions: Record<string, WorkflowDefinitionSummary>
    consent: HooksConsent
    trust: Record<string, string>
    repoRoots: string[]
    worktrees: Worktree[]
    runs: Record<string, WorkflowRun>
  } = { definitions: {}, consent: 'accepted', trust: {}, repoRoots: [], worktrees: [], runs: {} }
  return { backendApi, storeState }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../backend', () => ({ useBackend: () => backendApi }))
vi.mock('../../../store', () => ({
  useWorkflowDefinitions: () => storeState.definitions,
  useHooks: () => ({ consent: storeState.consent, codexTrust: null }),
  useWorkflowTrust: (id: string | null) => (id === null ? undefined : storeState.trust[id]),
  useWorktreeRepoRoot: (path: string | null) => storeState.worktrees.find((w) => w.path === path)?.repoRoot ?? null,
  useAppState: <T,>(selector: (s: unknown) => T): T =>
    selector({
      worktrees: { repoRoots: storeState.repoRoots, list: storeState.worktrees },
      workflows: { runs: storeState.runs }
    })
}))

const SOURCES: Record<string, string> = {
  'personal:plan': `name: plan
inputs:
  task: { type: text }
  issue: { type: issue }
steps:
  - id: plan
    agent: claude
    prompt: "{{inputs.task}} {{inputs.issue}}"
`,
  'personal:full': `name: full
steps:
  - id: fix
    agent: claude
    permissions: full
    prompt: go
`,
  'personal:shell': `name: shell
steps:
  - id: test
    kind: shell
    run: "true"
`,
  'repo:abcdefabcdef:ship': `name: ship
defaults:
  permissions: full
steps:
  - id: review
    agent: opencode
    permissions: read-only
    prompt: review
  - id: fix
    agent: claude
    prompt: fix
  - id: test
    kind: shell
    run: pnpm test
`
}

SOURCES['personal:pick'] = `name: pick
inputs:
  target: { type: file }
steps:
  - id: check
    kind: shell
    run: test -f {{inputs.target}}
`

const REPO_ID = 'repo:abcdefabcdef:ship'
const DISK_HASH = 'd'.repeat(64)

function summary(id: string, issues: string[] = []): WorkflowDefinitionSummary {
  if (id === REPO_ID) {
    return {
      id,
      name: 'ship',
      scope: 'repo',
      repoRoot: '/repo',
      path: '/repo/.harness/workflows/ship.yaml',
      hash: 'slice-hash',
      stepIds: [],
      issues
    }
  }
  const name = id.replace('personal:', '')
  return { id, name, scope: 'personal', path: `/defs/${name}.yaml`, hash: `h-${name}`, stepIds: [], issues }
}

function detail(id: string): WorkflowDefinitionDetail | null {
  const source = SOURCES[id]
  if (source === undefined) return null
  const base = summary(id)
  return {
    ...validateWorkflowDefinition(source),
    source,
    summary: id === REPO_ID ? { ...base, hash: DISK_HASH } : base
  }
}

function worktree(path: string, repoRoot: string, branch: string, isMain = false): Worktree {
  return { path, branch, head: 'abc', isBare: false, isMain, createdAt: 0, repoRoot }
}

let container: HTMLDivElement
let root: Root
let onClose: ReturnType<typeof vi.fn<() => void>>
let onStarted: ReturnType<typeof vi.fn<(path: string) => void>>

beforeEach(() => {
  storeState.definitions = {
    'personal:plan': summary('personal:plan'),
    'personal:full': summary('personal:full'),
    'personal:broken': summary('personal:broken', ['steps[0].prompt is required']),
    [REPO_ID]: summary(REPO_ID)
  }
  storeState.consent = 'accepted'
  storeState.trust = {}
  storeState.repoRoots = ['/repo', '/other']
  storeState.worktrees = [
    worktree('/repo', '/repo', 'main', true),
    worktree('/wt/feature', '/repo', 'feature'),
    worktree('/wt/busy', '/repo', 'busy'),
    worktree('/other', '/other', 'main', true)
  ]
  storeState.runs = {
    live: { defId: 'personal:plan', defHash: 'h', worktreePath: '/wt/busy', status: 'running', startedAt: 1, steps: {} }
  }
  backendApi.runPendingWorktree
    .mockReset()
    .mockImplementation(async ({ id }: { id: string }) => ({ id, outcome: 'success', createdPath: '/wts/new' }))
  backendApi.dismissPendingWorktree.mockReset().mockResolvedValue(true)
  backendApi.trustWorkflowDefinition.mockReset().mockResolvedValue({ ok: true })
  backendApi.getWorkflowDefinition.mockReset().mockImplementation(async (id: string) => detail(id))
  backendApi.startWorkflowRun.mockReset().mockResolvedValue({ runId: 'run-1' })
  backendApi.acceptHooks.mockReset().mockResolvedValue(true)
  backendApi.listRepoIssues.mockReset().mockResolvedValue({ status: 'no-token' })
  backendApi.listRepoPRs.mockReset().mockResolvedValue(null)
  backendApi.listAllFiles.mockReset().mockResolvedValue([])
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  onClose = vi.fn<() => void>()
  onStarted = vi.fn<(path: string) => void>()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function mount(): Promise<void> {
  await act(async () => {
    root.render(<LaunchSheet worktreePath="/wt/feature" onClose={onClose} onStarted={onStarted} />)
  })
}

async function mountUnset(): Promise<void> {
  await act(async () => {
    root.render(<LaunchSheet onClose={onClose} onStarted={onStarted} />)
  })
}

function q<T extends Element>(selector: string): T {
  const el = container.querySelector<T>(selector)
  if (!el) throw new Error(`missing ${selector}`)
  return el
}

const startButton = () => q<HTMLButtonElement>('button[type="submit"]')

function buttonByText(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!button) throw new Error(`missing button ${text}`)
  return button
}

async function select(id: string): Promise<void> {
  const el = q<HTMLSelectElement>('select')
  await act(async () => {
    el.value = id
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click()
  })
}

function byLabel<T extends HTMLElement>(text: string): T {
  const label = [...container.querySelectorAll('label[for]')].find((l) => l.textContent?.trim() === text)
  const el = label ? document.getElementById((label as HTMLLabelElement).htmlFor) : null
  if (!el) throw new Error(`missing control labelled ${text}`)
  return el as T
}

async function choose(el: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    el.value = value
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function optionValues(el: HTMLSelectElement): string[] {
  return [...el.options].map((o) => o.value)
}

function radio(label: string): HTMLInputElement {
  const wrapper = [...container.querySelectorAll('label')].find((l) => l.textContent?.trim() === label)
  const input = wrapper?.querySelector<HTMLInputElement>('input[type="radio"]')
  if (!input) throw new Error(`missing radio ${label}`)
  return input
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function fillPlan(): Promise<void> {
  await type(q<HTMLTextAreaElement>('textarea'), 'ship it')
  await type(q<HTMLInputElement>('input[type="text"]'), '#12')
}

describe('LaunchSheet', () => {
  it('renders an accessible dialog with the broken definition disabled with its first issue', async () => {
    await mount()
    const dialog = q<HTMLElement>('[role="dialog"]')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Run workflow')
    const broken = q<HTMLOptionElement>('option[value="personal:broken"]')
    expect(broken.disabled).toBe(true)
    expect(broken.textContent).toContain('steps[0].prompt is required')
    expect(document.activeElement).toBe(q('select'))
    expect(q<HTMLLabelElement>('label[for]').htmlFor).toBe(q('select').id)
  })

  it('keeps Start disabled while a declared input is blank, then sends the inputs', async () => {
    await mount()
    await select('personal:plan')
    expect(container.querySelector('textarea')).not.toBeNull()
    expect(startButton().disabled).toBe(true)
    expect(container.textContent).toContain('Fill in task')
    await type(q<HTMLTextAreaElement>('textarea'), '   ')
    expect(startButton().disabled).toBe(true)
    await fillPlan()
    expect(startButton().disabled).toBe(false)
    await click(startButton())
    expect(backendApi.startWorkflowRun).toHaveBeenCalledWith({
      defId: 'personal:plan',
      worktreePath: '/wt/feature',
      inputs: { task: 'ship it', issue: '12' }
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps Start disabled while hooks consent is pending and installs hooks from the sheet', async () => {
    storeState.consent = 'pending'
    await mount()
    await select('personal:plan')
    await fillPlan()
    expect(startButton().disabled).toBe(true)
    expect(container.textContent).toContain('Install hooks to start a workflow')
    await click(buttonByText('Install hooks'))
    expect(backendApi.acceptHooks).toHaveBeenCalledTimes(1)
    expect(backendApi.startWorkflowRun).not.toHaveBeenCalled()
  })

  it('requires the allow-full checkbox for a full step and sends allowFull: true', async () => {
    await mount()
    await select('personal:full')
    expect(startButton().disabled).toBe(true)
    expect(container.textContent).toContain('Confirm full access to start')
    await click(q<HTMLInputElement>('input[type="checkbox"]'))
    expect(startButton().disabled).toBe(false)
    await click(startButton())
    expect(backendApi.startWorkflowRun).toHaveBeenCalledWith({
      defId: 'personal:full',
      worktreePath: '/wt/feature',
      inputs: {},
      allowFull: true
    })
  })

  it('clears the allow-full confirmation when the selected definition changes', async () => {
    await mount()
    await select('personal:full')
    await click(q<HTMLInputElement>('input[type="checkbox"]'))
    await select('personal:plan')
    await select('personal:full')
    expect(q<HTMLInputElement>('input[type="checkbox"]').checked).toBe(false)
    expect(startButton().disabled).toBe(true)
  })

  it('drops the allow-full confirmation when the definition file changes', async () => {
    await mount()
    await select('personal:full')
    await click(q<HTMLInputElement>('input[type="checkbox"]'))
    expect(startButton().disabled).toBe(false)
    storeState.definitions = { ...storeState.definitions, 'personal:full': { ...summary('personal:full'), hash: 'h-full-2' } }
    await mount()
    expect(q<HTMLInputElement>('input[type="checkbox"]').checked).toBe(false)
    expect(startButton().disabled).toBe(true)
  })

  it('shows the start error inline and stays open', async () => {
    backendApi.startWorkflowRun.mockResolvedValue({ error: 'A workflow is already running in this worktree' })
    await mount()
    await select('personal:full')
    await click(q<HTMLInputElement>('input[type="checkbox"]'))
    await click(startButton())
    expect(q('[role="alert"]').textContent).toBe('A workflow is already running in this worktree')
    expect(onClose).not.toHaveBeenCalled()
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('shows no trust panel for a personal definition', async () => {
    await mount()
    await select('personal:full')
    expect(container.querySelector('section')).toBeNull()
  })

  it('shows the repo source and resolved step permissions and keeps Start disabled until trusted', async () => {
    await mount()
    await select(REPO_ID)
    const region = q<HTMLElement>('section[aria-labelledby]')
    expect(document.getElementById(region.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(
      'Trust this repo workflow?'
    )
    expect(q<HTMLPreElement>('pre').textContent).toBe(SOURCES[REPO_ID])
    const rows = [...region.querySelectorAll('tbody tr')].map((row) =>
      [...row.querySelectorAll('td')].map((cell) => cell.textContent)
    )
    expect(rows).toEqual([
      ['review', 'opencode', 'read-only'],
      ['fix', 'claude', 'full'],
      ['test', 'shell', 'shell']
    ])
    expect(startButton().disabled).toBe(true)
    expect(container.textContent).toContain('Trust this definition to start it')
  })

  it('trusts the hash of the source it displayed, not the slice summary hash, then enables Start', async () => {
    await mount()
    await select(REPO_ID)
    await click(buttonByText('Trust this definition'))
    expect(backendApi.trustWorkflowDefinition).toHaveBeenCalledWith(REPO_ID, DISK_HASH)
    expect(backendApi.startWorkflowRun).not.toHaveBeenCalled()

    storeState.trust = { [REPO_ID]: DISK_HASH }
    await mount()
    expect(container.querySelector('section')).toBeNull()
    expect(container.textContent).toContain('Confirm full access to start')
    await click(q<HTMLInputElement>('input[type="checkbox"]'))
    expect(startButton().disabled).toBe(false)
  })

  it('asks again when the trusted hash differs from the displayed source', async () => {
    storeState.trust = { [REPO_ID]: 'e'.repeat(64) }
    await mount()
    await select(REPO_ID)
    expect(container.querySelector('section')).not.toBeNull()
    expect(startButton().disabled).toBe(true)
  })

  it('shows a trust refusal inline', async () => {
    backendApi.trustWorkflowDefinition.mockResolvedValue({
      error: 'The workflow definition changed on disk; review it again before trusting it'
    })
    await mount()
    await select(REPO_ID)
    await click(buttonByText('Trust this definition'))
    expect(q('[role="alert"]').textContent).toBe(
      'The workflow definition changed on disk; review it again before trusting it'
    )
    expect(startButton().disabled).toBe(true)
  })

  it('closes on Escape', async () => {
    await mount()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onStarted with the preset worktree after a successful start', async () => {
    await mount()
    await select('personal:full')
    await click(q<HTMLInputElement>('input[type="checkbox"]'))
    await click(startButton())
    expect(onStarted).toHaveBeenCalledWith('/wt/feature')
    expect(backendApi.runPendingWorktree).not.toHaveBeenCalled()
  })
})

describe('LaunchSheet target', () => {
  const uuid = vi.spyOn(crypto, 'randomUUID')

  beforeEach(() => {
    uuid.mockReset().mockReturnValue('12345678-aaaa-bbbb-cccc-dddddddddddd')
  })

  it('shows a preset target read-only and lists personal plus that repo’s definitions', async () => {
    await mount()
    expect(container.querySelector('fieldset')).toBeNull()
    expect(container.textContent).toContain('in feature')
    expect(optionValues(q<HTMLSelectElement>('select'))).toContain(REPO_ID)

    storeState.worktrees = [...storeState.worktrees, worktree('/wt/other-feature', '/other', 'other-feature')]
    await act(async () => {
      root.render(<LaunchSheet worktreePath="/wt/other-feature" onClose={onClose} />)
    })
    expect(optionValues(q<HTMLSelectElement>('select'))).not.toContain(REPO_ID)
  })

  it('opens without a preset on the repository select with a New worktree default branch name', async () => {
    await mountUnset()
    const repo = byLabel<HTMLSelectElement>('Repository')
    expect(document.activeElement).toBe(repo)
    expect(optionValues(repo)).toEqual(['/repo', '/other'])
    expect(radio('New worktree').checked).toBe(true)
    await choose(byLabel<HTMLSelectElement>('Workflow'), 'personal:plan')
    expect(byLabel<HTMLInputElement>('Branch name').value).toBe('wf/plan/12345678')
  })

  it('filters definitions by the chosen repository', async () => {
    await mountUnset()
    expect(optionValues(byLabel<HTMLSelectElement>('Workflow'))).toContain(REPO_ID)
    await choose(byLabel<HTMLSelectElement>('Repository'), '/other')
    expect(optionValues(byLabel<HTMLSelectElement>('Workflow'))).not.toContain(REPO_ID)
  })

  it('creates the worktree, then starts the run on the created path and reports it', async () => {
    await mountUnset()
    await choose(byLabel<HTMLSelectElement>('Workflow'), 'personal:full')
    await click(q<HTMLInputElement>('input[type="checkbox"]'))
    await click(startButton())
    expect(backendApi.runPendingWorktree).toHaveBeenCalledWith({
      id: 'pending:12345678-aaaa-bbbb-cccc-dddddddddddd',
      repoRoot: '/repo',
      branchName: 'wf/full/12345678'
    })
    expect(backendApi.startWorkflowRun).toHaveBeenCalledWith({
      defId: 'personal:full',
      worktreePath: '/wts/new',
      inputs: {},
      allowFull: true
    })
    expect(backendApi.runPendingWorktree.mock.invocationCallOrder[0]).toBeLessThan(
      backendApi.startWorkflowRun.mock.invocationCallOrder[0]
    )
    expect(backendApi.dismissPendingWorktree).not.toHaveBeenCalled()
    expect(onStarted).toHaveBeenCalledWith('/wts/new')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('uses the edited branch name and blocks Start on an invalid one', async () => {
    await mountUnset()
    await choose(byLabel<HTMLSelectElement>('Workflow'), 'personal:full')
    await click(q<HTMLInputElement>('input[type="checkbox"]'))
    const branch = byLabel<HTMLInputElement>('Branch name')
    await type(branch, 'my work')
    expect(branch.value).toBe('my-work')
    await type(branch, 'wip.lock')
    expect(startButton().disabled).toBe(true)
    expect(branch.getAttribute('aria-invalid')).toBe('true')
    await type(branch, '')
    expect(container.textContent).toContain('Enter a branch name')
    await type(branch, 'my-work')
    await click(startButton())
    expect(backendApi.runPendingWorktree).toHaveBeenCalledWith(expect.objectContaining({ branchName: 'my-work' }))
  })

  it('starts on a setup-failed worktree and dismisses its pending entry', async () => {
    backendApi.runPendingWorktree.mockImplementation(async ({ id }: { id: string }) => ({
      id,
      outcome: 'setup-failed',
      createdPath: '/wts/new'
    }))
    await mountUnset()
    await choose(byLabel<HTMLSelectElement>('Workflow'), 'personal:full')
    await click(q<HTMLInputElement>('input[type="checkbox"]'))
    await click(startButton())
    expect(backendApi.dismissPendingWorktree).toHaveBeenCalledWith('pending:12345678-aaaa-bbbb-cccc-dddddddddddd')
    expect(backendApi.startWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: '/wts/new' }))
    expect(onStarted).toHaveBeenCalledWith('/wts/new')
  })

  it('shows a creation error inline, dismisses the pending entry and does not start', async () => {
    backendApi.runPendingWorktree.mockImplementation(async ({ id }: { id: string }) => ({
      id,
      outcome: 'error',
      error: 'fatal: a branch named wf/full/12345678 already exists'
    }))
    await mountUnset()
    await choose(byLabel<HTMLSelectElement>('Workflow'), 'personal:full')
    await click(q<HTMLInputElement>('input[type="checkbox"]'))
    await click(startButton())
    expect(q('[role="alert"]').textContent).toBe('fatal: a branch named wf/full/12345678 already exists')
    expect(backendApi.dismissPendingWorktree).toHaveBeenCalledWith('pending:12345678-aaaa-bbbb-cccc-dddddddddddd')
    expect(backendApi.startWorkflowRun).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(startButton().disabled).toBe(false)
  })

  it('keeps the sheet open on a start refusal and retries on the created worktree', async () => {
    backendApi.runPendingWorktree.mockImplementation(async ({ id }: { id: string }) => {
      storeState.worktrees = [...storeState.worktrees, worktree('/wts/new', '/repo', 'wf/full/12345678')]
      return { id, outcome: 'success', createdPath: '/wts/new' }
    })
    backendApi.startWorkflowRun.mockResolvedValueOnce({ error: 'Install hooks to start a workflow' })
    await mountUnset()
    await choose(byLabel<HTMLSelectElement>('Workflow'), 'personal:full')
    await click(q<HTMLInputElement>('input[type="checkbox"]'))
    await click(startButton())
    expect(q('[role="alert"]').textContent).toBe('Install hooks to start a workflow')
    expect(onClose).not.toHaveBeenCalled()
    expect(radio('Existing worktree').checked).toBe(true)
    expect(byLabel<HTMLSelectElement>('Worktree').value).toBe('/wts/new')

    await click(startButton())
    expect(backendApi.runPendingWorktree).toHaveBeenCalledTimes(1)
    expect(backendApi.startWorkflowRun).toHaveBeenLastCalledWith(expect.objectContaining({ worktreePath: '/wts/new' }))
    expect(onStarted).toHaveBeenCalledWith('/wts/new')
  })

  it('lists only the repo’s worktrees without a live run and starts on the chosen one', async () => {
    await mountUnset()
    await click(radio('Existing worktree'))
    const existing = byLabel<HTMLSelectElement>('Worktree')
    expect(optionValues(existing)).toEqual(['/repo', '/wt/feature'])
    await choose(existing, '/wt/feature')
    await choose(byLabel<HTMLSelectElement>('Workflow'), 'personal:full')
    await click(q<HTMLInputElement>('input[type="checkbox"]'))
    await click(startButton())
    expect(backendApi.runPendingWorktree).not.toHaveBeenCalled()
    expect(backendApi.startWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: '/wt/feature' }))
    expect(onStarted).toHaveBeenCalledWith('/wt/feature')
  })

  it('stays submitting across creation and start, and does nothing after closing mid-creation', async () => {
    const creation = deferred<{ id: string; outcome: 'success'; createdPath: string }>()
    backendApi.runPendingWorktree.mockReturnValue(creation.promise)
    await mountUnset()
    await choose(byLabel<HTMLSelectElement>('Workflow'), 'personal:full')
    await click(q<HTMLInputElement>('input[type="checkbox"]'))
    await click(startButton())
    expect(startButton().disabled).toBe(true)
    expect(container.textContent).toContain('Starting…')
    await act(async () => {
      root.render(<></>)
    })
    await act(async () => {
      creation.resolve({ id: 'pending:12345678-aaaa-bbbb-cccc-dddddddddddd', outcome: 'success', createdPath: '/wts/new' })
    })
    expect(backendApi.startWorkflowRun).not.toHaveBeenCalled()
    expect(onStarted).not.toHaveBeenCalled()
  })
})

describe('LaunchSheet overrides', () => {
  const toggle = (): HTMLButtonElement => q<HTMLButtonElement>('button[aria-controls]')

  async function openOverrides(): Promise<void> {
    await click(toggle())
  }

  function startPayload(): Record<string, unknown> {
    const call = backendApi.startWorkflowRun.mock.calls.at(-1)
    if (!call) throw new Error('startWorkflowRun was not called')
    return call[0] as Record<string, unknown>
  }

  it('is collapsed by default and expands to one labelled row per agent step', async () => {
    await mount()
    await select(REPO_ID)
    await click(buttonByText('Trust this definition'))
    expect(toggle().textContent?.trim()).toBe('Overrides')
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    const body = (): HTMLElement | null => document.getElementById(toggle().getAttribute('aria-controls') ?? '')
    expect(body()?.hidden).toBe(true)
    await openOverrides()
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(body()?.hidden).toBe(false)
    expect(optionValues(byLabel<HTMLSelectElement>('Agent for review'))).toStrictEqual([...STEP_HARNESS_AGENTS])
    expect(byLabel<HTMLSelectElement>('Agent for review').value).toBe('opencode')
    expect(byLabel<HTMLSelectElement>('Agent for fix').value).toBe('claude')
    expect(container.textContent).not.toContain('Agent for test')
  })

  it('hides the section for a definition without agent steps', async () => {
    storeState.definitions = { ...storeState.definitions, 'personal:shell': summary('personal:shell') }
    await mount()
    await select('personal:shell')
    expect(container.querySelector('button[aria-controls]')).toBeNull()
  })

  it('sends no overrides key when nothing was changed', async () => {
    await mount()
    await select('personal:plan')
    await openOverrides()
    await fillPlan()
    await click(startButton())
    expect(Object.hasOwn(startPayload(), 'overrides')).toBe(false)
  })

  it('sends only the changed values, counts them, and clears the model on an agent change', async () => {
    await mount()
    await select('personal:plan')
    await openOverrides()
    await type(byLabel<HTMLInputElement>('Model for plan'), 'opus')
    await choose(byLabel<HTMLSelectElement>('Agent for plan'), 'opencode')
    expect(byLabel<HTMLInputElement>('Model for plan').value).toBe('')
    expect(toggle().textContent?.trim()).toBe('Overrides (1 changed)')
    await fillPlan()
    await click(startButton())
    const { overrides } = startPayload() as { overrides: Record<string, Record<string, unknown>> }
    expect(overrides).toStrictEqual({ plan: { agent: 'opencode' } })
  })

  it('blocks Start with the Codex hooks reason when a step is overridden to Codex', async () => {
    await mount()
    await select('personal:plan')
    await fillPlan()
    expect(startButton().disabled).toBe(false)
    await openOverrides()
    await choose(byLabel<HTMLSelectElement>('Agent for plan'), 'codex')
    expect(startButton().disabled).toBe(true)
    expect(container.textContent).toContain('Open a Codex tab and run /hooks')
    await choose(byLabel<HTMLSelectElement>('Agent for plan'), 'claude')
    expect(startButton().disabled).toBe(false)
  })

  it('blocks Start on an over-long model and marks the field invalid', async () => {
    await mount()
    await select('personal:plan')
    await fillPlan()
    await openOverrides()
    await type(byLabel<HTMLInputElement>('Model for plan'), 'm'.repeat(201))
    expect(startButton().disabled).toBe(true)
    expect(container.textContent).toContain('Model for plan is too long')
    expect(byLabel<HTMLInputElement>('Model for plan').getAttribute('aria-invalid')).toBe('true')
  })

  it('resets the drafts when the selected definition changes', async () => {
    await mount()
    await select('personal:plan')
    await openOverrides()
    await choose(byLabel<HTMLSelectElement>('Agent for plan'), 'opencode')
    await select('personal:full')
    await select('personal:plan')
    expect(byLabel<HTMLSelectElement>('Agent for plan').value).toBe('claude')
    expect(toggle().textContent?.trim()).toBe('Overrides')
  })

  it('keeps the drafts when a start refusal switches the target to the created worktree', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-aaaa-bbbb-cccc-dddddddddddd')
    backendApi.runPendingWorktree.mockImplementation(async ({ id }: { id: string }) => {
      storeState.worktrees = [...storeState.worktrees, worktree('/wts/new', '/repo', 'wf/full/12345678')]
      return { id, outcome: 'success', createdPath: '/wts/new' }
    })
    backendApi.startWorkflowRun.mockResolvedValueOnce({ error: 'Install hooks to start a workflow' })
    await mountUnset()
    await choose(byLabel<HTMLSelectElement>('Workflow'), 'personal:full')
    await click(q<HTMLInputElement>('input[type="checkbox"]'))
    await openOverrides()
    await choose(byLabel<HTMLSelectElement>('Agent for fix'), 'opencode')
    await click(startButton())
    expect(radio('Existing worktree').checked).toBe(true)
    expect(byLabel<HTMLSelectElement>('Agent for fix').value).toBe('opencode')
    await click(startButton())
    expect(startPayload()).toMatchObject({ worktreePath: '/wts/new', overrides: { fix: { agent: 'opencode' } } })
  })
})

describe('LaunchSheet input pickers', () => {
  beforeEach(() => {
    storeState.definitions = { ...storeState.definitions, 'personal:pick': summary('personal:pick') }
    backendApi.listAllFiles.mockImplementation(async (root: string) =>
      root === '/repo' ? ['README.md', 'docs/primary.md'] : ['README.md', 'docs/feature.md']
    )
  })

  function picker(): HTMLInputElement {
    return byLabel<HTMLInputElement>('targetfile')
  }

  async function key(el: HTMLElement, name: string): Promise<KeyboardEvent> {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
    await act(async () => {
      el.dispatchEvent(event)
    })
    return event
  }

  it('picks a file with the keyboard without submitting, Escape closes only the list, and Start sends the path', async () => {
    await mount()
    await choose(byLabel<HTMLSelectElement>('Workflow'), 'personal:pick')
    const el = picker()
    expect(el.getAttribute('role')).toBe('combobox')
    expect(backendApi.listAllFiles).toHaveBeenCalledWith('/wt/feature')
    await act(async () => el.focus())
    await type(el, 'feat')
    await key(el, 'Escape')
    expect(onClose).not.toHaveBeenCalled()
    expect(el.getAttribute('aria-expanded')).toBe('false')
    await key(el, 'ArrowDown')
    await key(el, 'Enter')
    expect(backendApi.startWorkflowRun).not.toHaveBeenCalled()
    expect(el.value).toBe('docs/feature.md')
    expect(startButton().disabled).toBe(false)
    await click(startButton())
    expect(backendApi.startWorkflowRun).toHaveBeenCalledWith({
      defId: 'personal:pick',
      worktreePath: '/wt/feature',
      inputs: { target: 'docs/feature.md' }
    })
  })

  it('keeps an Escape that closes the open list from reaching window listeners', async () => {
    const behind = vi.fn()
    window.addEventListener('keydown', behind)
    try {
      await mount()
      await choose(byLabel<HTMLSelectElement>('Workflow'), 'personal:pick')
      const el = picker()
      await act(async () => el.focus())
      await key(el, 'ArrowDown')
      await key(el, 'Escape')
      expect(el.getAttribute('aria-expanded')).toBe('false')
      expect(onClose).not.toHaveBeenCalled()
      expect(behind).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape' }))
      await key(el, 'Escape')
      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', behind)
    }
  })

  it('blocks Start while the typed text is not a listed file', async () => {
    await mount()
    await choose(byLabel<HTMLSelectElement>('Workflow'), 'personal:pick')
    await type(picker(), '/etc/passwd')
    expect(startButton().disabled).toBe(true)
    expect(container.textContent).toContain('Fill in target')
  })

  it('lists the primary checkout for a new worktree target and the chosen worktree for an existing one', async () => {
    await mountUnset()
    await choose(byLabel<HTMLSelectElement>('Workflow'), 'personal:pick')
    expect(backendApi.listAllFiles).toHaveBeenLastCalledWith('/repo')
    await act(async () => picker().focus())
    await key(picker(), 'ArrowDown')
    expect([...container.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual([
      'README.md',
      'docs/primary.md'
    ])
    await key(picker(), 'ArrowDown')
    await key(picker(), 'Enter')
    expect(picker().value).toBe('docs/primary.md')

    await click(radio('Existing worktree'))
    await choose(byLabel<HTMLSelectElement>('Worktree'), '/wt/feature')
    expect(backendApi.listAllFiles).toHaveBeenLastCalledWith('/wt/feature')
    expect(picker().value).toBe('')
    expect(startButton().disabled).toBe(true)
  })
})

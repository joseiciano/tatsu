// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LaunchSheet } from './LaunchSheet'
import { validateWorkflowDefinition } from '../../../../shared/workflow-def'
import type { HooksConsent } from '../../../../shared/state/hooks'
import type { WorkflowDefinitionDetail, WorkflowDefinitionSummary } from '../../../../shared/state/workflows'

const { backendApi, storeState } = vi.hoisted(() => {
  const backendApi = {
    getWorkflowDefinition: vi.fn(),
    startWorkflowRun: vi.fn(),
    acceptHooks: vi.fn(),
    trustWorkflowDefinition: vi.fn()
  }
  const storeState: {
    definitions: Record<string, WorkflowDefinitionSummary>
    consent: HooksConsent
    trust: Record<string, string>
  } = { definitions: {}, consent: 'accepted', trust: {} }
  return { backendApi, storeState }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../backend', () => ({ useBackend: () => backendApi }))
vi.mock('../../../store', () => ({
  useWorkflowDefinitions: () => storeState.definitions,
  useHooks: () => ({ consent: storeState.consent, codexTrust: null }),
  useWorkflowTrust: (id: string | null) => (id === null ? undefined : storeState.trust[id])
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

let container: HTMLDivElement
let root: Root
let onClose: ReturnType<typeof vi.fn<() => void>>

beforeEach(() => {
  storeState.definitions = {
    'personal:plan': summary('personal:plan'),
    'personal:full': summary('personal:full'),
    'personal:broken': summary('personal:broken', ['steps[0].prompt is required']),
    [REPO_ID]: summary(REPO_ID)
  }
  storeState.consent = 'accepted'
  storeState.trust = {}
  backendApi.trustWorkflowDefinition.mockReset().mockResolvedValue({ ok: true })
  backendApi.getWorkflowDefinition.mockReset().mockImplementation(async (id: string) => detail(id))
  backendApi.startWorkflowRun.mockReset().mockResolvedValue({ runId: 'run-1' })
  backendApi.acceptHooks.mockReset().mockResolvedValue(true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  onClose = vi.fn<() => void>()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function mount(): Promise<void> {
  await act(async () => {
    root.render(<LaunchSheet worktreePath="/wt/feature" onClose={onClose} />)
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
      inputs: { task: 'ship it', issue: '#12' }
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
})

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
    acceptHooks: vi.fn()
  }
  const storeState: {
    definitions: Record<string, WorkflowDefinitionSummary>
    consent: HooksConsent
  } = { definitions: {}, consent: 'accepted' }
  return { backendApi, storeState }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../backend', () => ({ useBackend: () => backendApi }))
vi.mock('../../../store', () => ({
  useWorkflowDefinitions: () => storeState.definitions,
  useHooks: () => ({ consent: storeState.consent, codexTrust: null })
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
`
}

function summary(id: string, issues: string[] = []): WorkflowDefinitionSummary {
  const name = id.replace('personal:', '')
  return { id, name, scope: 'personal', path: `/defs/${name}.yaml`, hash: `h-${name}`, stepIds: [], issues }
}

function detail(id: string): WorkflowDefinitionDetail | null {
  const source = SOURCES[id]
  if (source === undefined) return null
  return { ...validateWorkflowDefinition(source), source, summary: summary(id) }
}

let container: HTMLDivElement
let root: Root
let onClose: ReturnType<typeof vi.fn<() => void>>

beforeEach(() => {
  storeState.definitions = {
    'personal:plan': summary('personal:plan'),
    'personal:full': summary('personal:full'),
    'personal:broken': summary('personal:broken', ['steps[0].prompt is required'])
  }
  storeState.consent = 'accepted'
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

  it('closes on Escape', async () => {
    await mount()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

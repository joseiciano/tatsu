// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DefinitionEditor, NEW_WORKFLOW_TEMPLATE, type DefinitionEditorTarget } from '.'
import type { EditorMarker } from '../../MonacoEditor/types'
import { WORKFLOW_NO_REPO_DIR_ERROR, type WorkflowDefinitionDetail, type WorkflowDefinitionSummary } from '../../../../shared/state/workflows'
import { validateWorkflowDefinition } from '../../../../shared/workflow-def'

const { backendApi, editorProbe, storeState } = vi.hoisted(() => ({
  backendApi: { getWorkflowDefinition: vi.fn(), saveWorkflowDefinition: vi.fn() },
  editorProbe: { markers: undefined as readonly EditorMarker[] | undefined, onSave: undefined as (() => void) | undefined, mounts: 0 },
  storeState: { definitions: {} as Record<string, WorkflowDefinitionSummary> }
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../backend', () => ({ useBackend: () => backendApi }))
vi.mock('../../../store', () => ({
  useWorkflowDefinition: (id: string | null) => (id ? storeState.definitions[id] ?? null : null)
}))
vi.mock('../../MonacoEditor', async () => {
  const { useEffect } = await import('react')
  return {
    MonacoEditor: (props: {
      value: string
      ariaLabel?: string
      markers?: readonly EditorMarker[]
      onChange?: (value: string) => void
      onSave?: () => void
    }) => {
      editorProbe.markers = props.markers
      editorProbe.onSave = props.onSave
      useEffect(() => {
        editorProbe.mounts += 1
      }, [])
      return <textarea aria-label={props.ariaLabel} defaultValue={props.value} onChange={(e) => props.onChange?.(e.target.value)} />
    }
  }
})

const VALID = 'name: ship\nsteps:\n  - id: build\n    kind: shell\n    run: echo build\n'
const BAD_REF = 'name: ship\nsteps:\n  - id: build\n    kind: shell\n    run: echo {{steps.bogus.summary}}\n'
const BROKEN = 'steps:\n  - id: "build\n'
const REPO = '/repos/app'

function summary(overrides: Partial<WorkflowDefinitionSummary>): WorkflowDefinitionSummary {
  return { id: 'personal:ship', name: 'ship', scope: 'personal', path: '/data/workflows/ship.yaml', hash: 'h', stepIds: ['build'], issues: [], ...overrides }
}

function detail(s: WorkflowDefinitionSummary, source = VALID): WorkflowDefinitionDetail {
  return { summary: s, source, ...validateWorkflowDefinition(source) }
}

let container: HTMLDivElement
let root: Root
const onBack = vi.fn()
const onDirtyChange = vi.fn()

beforeEach(() => {
  backendApi.getWorkflowDefinition.mockReset()
  backendApi.saveWorkflowDefinition.mockReset().mockResolvedValue({ defId: 'personal:ship' })
  editorProbe.markers = undefined
  editorProbe.onSave = undefined
  editorProbe.mounts = 0
  storeState.definitions = {}
  onBack.mockReset()
  onDirtyChange.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

async function render(target: DefinitionEditorTarget, activeRepoRoot: string | null = REPO): Promise<void> {
  await act(async () => {
    root.render(<DefinitionEditor target={target} activeRepoRoot={activeRepoRoot} onBack={onBack} onDirtyChange={onDirtyChange} />)
  })
}

function textarea(): HTMLTextAreaElement {
  const el = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Workflow definition YAML"]')
  if (!el) throw new Error('no editor')
  return el
}

function type(text: string): void {
  const el = textarea()
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function button(name: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name)
  if (!found) throw new Error(`no button ${name}`)
  return found
}

function queryButton(name: string, scope: ParentNode = document): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name)
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click()
  })
}

function dialog(): HTMLElement | null {
  return document.querySelector('[role="alertdialog"]')
}

describe('DefinitionEditor', () => {
  it('starts New from a template that validates without problems', async () => {
    expect(validateWorkflowDefinition(NEW_WORKFLOW_TEMPLATE).diagnostics).toEqual([])
    await render({ kind: 'new' })
    expect(textarea().value).toBe(NEW_WORKFLOW_TEMPLATE)
    expect(editorProbe.markers).toEqual([])
    expect(container.textContent).toContain('No problems')
  })

  it('validates the draft after a debounce and passes markers to the editor', async () => {
    vi.useFakeTimers()
    await render({ kind: 'new' })
    type(BAD_REF)
    expect(editorProbe.markers).toEqual([])
    act(() => vi.advanceTimersByTime(249))
    expect(editorProbe.markers).toEqual([])
    act(() => vi.advanceTimersByTime(1))
    expect(editorProbe.markers).toEqual([
      expect.objectContaining({ severity: 'error', code: 'unknown-ref', startLineNumber: 5, startColumn: 15, endColumn: 38 })
    ])
    expect(container.textContent).toContain('1 problem · cannot be run')
    type(VALID)
    act(() => vi.advanceTimersByTime(250))
    expect(editorProbe.markers).toEqual([])
    expect(editorProbe.mounts).toBe(1)
  })

  it('saves a New workflow to personal under its YAML name, then overwrites it by id', async () => {
    await render({ kind: 'new' })
    type(VALID)
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    await click(button('Save'))
    expect(backendApi.saveWorkflowDefinition).toHaveBeenCalledWith({ scope: 'personal', name: 'ship', source: VALID })
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
    expect(container.textContent).toContain('Saved to your personal workflows')
    const edited = VALID.replace('echo build', 'echo again')
    type(edited)
    await act(async () => editorProbe.onSave?.())
    expect(backendApi.saveWorkflowDefinition).toHaveBeenLastCalledWith({ scope: 'personal', defId: 'personal:ship', name: 'ship', source: edited })
    expect(editorProbe.mounts).toBe(1)
  })

  it('asks before saving a definition with errors and saves only on confirm', async () => {
    await render({ kind: 'new' })
    type(BAD_REF)
    await click(button('Save'))
    expect(backendApi.saveWorkflowDefinition).not.toHaveBeenCalled()
    expect(dialog()?.textContent).toContain('This definition has 1 problem and cannot be run.')
    await click(button('Keep editing', dialog()!))
    expect(dialog()).toBeNull()
    expect(backendApi.saveWorkflowDefinition).not.toHaveBeenCalled()
    await click(button('Save'))
    await click(button('Save anyway', dialog()!))
    expect(backendApi.saveWorkflowDefinition).toHaveBeenCalledWith({ scope: 'personal', name: 'ship', source: BAD_REF })
    expect(dialog()).toBeNull()
  })

  it('needs a file name when the draft does not parse, and uses it', async () => {
    await render({ kind: 'new' })
    type(BROKEN)
    await click(button('Save'))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Enter a file name')
    expect(backendApi.saveWorkflowDefinition).not.toHaveBeenCalled()
    const input = container.querySelector<HTMLInputElement>('input')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'rescue')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(button('Save'))
    await click(button('Save anyway', dialog()!))
    expect(backendApi.saveWorkflowDefinition).toHaveBeenCalledWith({ scope: 'personal', name: 'rescue', source: BROKEN })
  })

  it('loads an existing personal definition and saves it back by id under its file name', async () => {
    const s = summary({ name: 'Ship it' })
    storeState.definitions = { [s.id]: s }
    backendApi.getWorkflowDefinition.mockResolvedValue(detail(s))
    await render({ kind: 'edit', defId: s.id })
    expect(backendApi.getWorkflowDefinition).toHaveBeenCalledWith('personal:ship')
    expect(container.textContent).toContain('Edit Ship it')
    expect(textarea().value).toBe(VALID)
    type(VALID + '# note\n')
    await click(button('Save'))
    expect(backendApi.saveWorkflowDefinition).toHaveBeenCalledWith({ scope: 'personal', defId: 'personal:ship', name: 'ship', source: VALID + '# note\n' })
  })

  it('saves a personal definition to the active repo as a new file after the trust warning', async () => {
    const s = summary({})
    backendApi.getWorkflowDefinition.mockResolvedValue(detail(s))
    backendApi.saveWorkflowDefinition.mockResolvedValue({ defId: 'repo:abc:ship' })
    await render({ kind: 'edit', defId: s.id })
    await click(button('Save to repo'))
    expect(backendApi.saveWorkflowDefinition).not.toHaveBeenCalled()
    expect(dialog()?.textContent).toContain('will need to trust this new version before running it')
    await click(button('Save to repo', dialog()!))
    expect(backendApi.saveWorkflowDefinition).toHaveBeenCalledWith({ scope: 'repo', repoRoot: REPO, name: 'ship', source: VALID })
    expect(container.textContent).toContain('Saved to app')
  })

  it('writes a repo definition back to its own repo with its id, never as personal', async () => {
    const s = summary({ id: 'repo:abc:lint', scope: 'repo', repoRoot: '/repos/other', path: '/repos/other/.harness/workflows/lint.yaml' })
    backendApi.getWorkflowDefinition.mockResolvedValue(detail(s, BAD_REF))
    backendApi.saveWorkflowDefinition.mockResolvedValue({ defId: s.id })
    await render({ kind: 'edit', defId: s.id })
    expect(queryButton('Save')).toBeUndefined()
    await click(button('Save to repo'))
    const text = dialog()?.textContent ?? ''
    expect(text).toContain('This definition has 1 problem and cannot be run.')
    expect(text).toContain('Teammates, and you, will need to trust this new version')
    await click(button('Save to repo', dialog()!))
    expect(backendApi.saveWorkflowDefinition).toHaveBeenCalledWith({ scope: 'repo', repoRoot: '/repos/other', defId: s.id, name: 'lint', source: BAD_REF })
  })

  it('keeps the draft and explains a repo without a workflows folder', async () => {
    backendApi.saveWorkflowDefinition.mockResolvedValue({ error: WORKFLOW_NO_REPO_DIR_ERROR })
    await render({ kind: 'new' })
    type(VALID)
    await click(button('Save to repo'))
    await click(button('Save to repo', dialog()!))
    expect(backendApi.saveWorkflowDefinition).toHaveBeenCalledWith({ scope: 'repo', repoRoot: REPO, name: 'ship', source: VALID })
    const alert = container.querySelector('[role="alert"]')?.textContent ?? ''
    expect(alert).toContain(WORKFLOW_NO_REPO_DIR_ERROR)
    expect(alert).toContain('Create and commit a .harness/workflows folder in app, or save to your personal workflows instead')
    expect(textarea().value).toBe(VALID)
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    expect(container.textContent).toContain('New workflow')
  })

  it('disables Save to repo with a reason when no repository is active', async () => {
    await render({ kind: 'new' }, null)
    const repo = button('Save to repo')
    expect(repo.getAttribute('aria-disabled')).toBe('true')
    const reason = document.getElementById(repo.getAttribute('aria-describedby') ?? '')
    expect(reason?.textContent).toContain('Select a worktree')
    await click(repo)
    expect(dialog()).toBeNull()
    expect(backendApi.saveWorkflowDefinition).not.toHaveBeenCalled()
  })

  it('shows an error when the definition is gone', async () => {
    backendApi.getWorkflowDefinition.mockResolvedValue(null)
    await render({ kind: 'edit', defId: 'personal:gone' })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('no longer exists')
    await click(button('Back to Library'))
    expect(onBack).toHaveBeenCalled()
  })
})

// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Library } from './Library'
import type { WorkflowDefinitionSummary } from '../../../../shared/state/workflows'

const { backendApi, storeState } = vi.hoisted(() => ({
  backendApi: { duplicateWorkflowDefinition: vi.fn(), deleteWorkflowDefinition: vi.fn() },
  storeState: {
    definitions: {} as Record<string, WorkflowDefinitionSummary>,
    repoRoots: [] as string[],
    trust: {} as Record<string, string>
  }
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../backend', () => ({ useBackend: () => backendApi }))
vi.mock('../../../store', () => ({
  useWorkflowDefinitions: () => storeState.definitions,
  useAppState: <T,>(selector: (s: unknown) => T): T =>
    selector({ worktrees: { repoRoots: storeState.repoRoots }, workflows: { trust: storeState.trust } })
}))

function personal(slug: string, name = slug): WorkflowDefinitionSummary {
  return { id: `personal:${slug}`, name, scope: 'personal', path: `/u/workflows/${slug}.yaml`, hash: `h-${slug}`, stepIds: ['plan'], issues: [] }
}

function repoDef(key: string, root: string, slug: string, hash = `h-${slug}`): WorkflowDefinitionSummary {
  return {
    id: `repo:${key}:${slug}`,
    name: slug,
    scope: 'repo',
    repoRoot: root,
    path: `${root}/.harness/workflows/${slug}.yaml`,
    hash,
    stepIds: ['build', 'test'],
    issues: []
  }
}

const ALPHA = '/repos/alpha'
const ZULU = '/repos/zulu'
const ACTIVE = '/repos/middle'

let container: HTMLDivElement
let root: Root
const onRun = vi.fn()

beforeEach(() => {
  backendApi.duplicateWorkflowDefinition.mockReset().mockResolvedValue({ defId: 'personal:copy' })
  backendApi.deleteWorkflowDefinition.mockReset().mockResolvedValue({ ok: true })
  onRun.mockReset()
  storeState.repoRoots = [ZULU, ACTIVE, ALPHA]
  storeState.definitions = {
    'personal:b': personal('b', 'Beta'),
    'personal:a': { ...personal('a', 'Alpha flow'), issues: ['Line 3: steps must be a list'] },
    [repoDef('cccccccccccc', ACTIVE, 'ship').id]: repoDef('cccccccccccc', ACTIVE, 'ship'),
    [repoDef('cccccccccccc', ACTIVE, 'risky').id]: repoDef('cccccccccccc', ACTIVE, 'risky'),
    [repoDef('aaaaaaaaaaaa', ALPHA, 'lint').id]: repoDef('aaaaaaaaaaaa', ALPHA, 'lint')
  }
  storeState.trust = {
    'repo:cccccccccccc:ship': 'h-ship',
    'repo:cccccccccccc:risky': 'stale-hash'
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

async function render(activeRepoRoot: string | null = ACTIVE): Promise<void> {
  await act(async () => {
    root.render(<Library activeRepoRoot={activeRepoRoot} onRun={onRun} />)
  })
}

const headings = (): string[] =>
  [...container.querySelectorAll('section > h2')].map((h) => h.firstChild?.textContent ?? '')

function section(label: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('section')].find((s) => s.querySelector('h2')?.firstChild?.textContent === label)
  if (!found) throw new Error(`no section ${label}`)
  return found
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent) === name)
  if (!found) throw new Error(`no button ${name}`)
  return found
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click()
  })
}

describe('Library', () => {
  it('lists the active repo first, then Personal, then other repos by name', async () => {
    await render()
    expect(headings()).toEqual(['This repo (middle)', 'Personal', 'alpha', 'zulu'])
    expect([...section('Personal').querySelectorAll('li > div > div > span:first-child')].map((s) => s.textContent)).toEqual([
      'Alpha flow',
      'Beta'
    ])
    expect(section('zulu').textContent).toContain('No workflows in this repository')

    await render(null)
    expect(headings()).toEqual(['Personal', 'alpha', 'middle', 'zulu'])
  })

  it('shows steps and problems, and a trust badge only on repo definitions', async () => {
    await render()
    const personalRows = section('Personal')
    expect(personalRows.textContent).toContain('1 step: plan')
    expect(personalRows.querySelector('[aria-label="Problems in Alpha flow"]')?.textContent).toBe('Line 3: steps must be a list')
    expect(personalRows.textContent).not.toMatch(/Trusted|Untrusted/)

    const active = section('This repo (middle)')
    const rows = [...active.querySelectorAll(':scope > ul > li')].map((li) => li.textContent ?? '')
    expect(rows[0]).toContain('risky')
    expect(rows[0]).toContain('Untrusted')
    expect(rows[1]).toContain('ship')
    expect(rows[1]).toContain('Trusted')
    expect(rows[1]).not.toContain('Untrusted')
    expect(section('alpha').textContent).toContain('Untrusted')
  })

  it('blocks Duplicate of an untrusted repo definition and duplicates a trusted one', async () => {
    await render()
    const blocked = button('Duplicate risky')
    expect(blocked.getAttribute('aria-disabled')).toBe('true')
    expect(document.getElementById(blocked.getAttribute('aria-describedby') ?? '')?.textContent).toContain('Trust it')
    await click(blocked)
    expect(backendApi.duplicateWorkflowDefinition).not.toHaveBeenCalled()

    await click(button('Duplicate ship'))
    expect(backendApi.duplicateWorkflowDefinition).toHaveBeenCalledWith('repo:cccccccccccc:ship')
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Duplicated ship')
    await click(button('Duplicate Beta'))
    expect(backendApi.duplicateWorkflowDefinition).toHaveBeenLastCalledWith('personal:b')
  })

  it('shows a duplicate refusal as an alert', async () => {
    backendApi.duplicateWorkflowDefinition.mockResolvedValue({ error: 'A workflow file with that name already exists' })
    await render()
    await click(button('Duplicate Beta'))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Could not duplicate Beta: A workflow file with that name already exists')
  })

  it('runs a definition by id', async () => {
    await render()
    await click(button('Run ship'))
    expect(onRun).toHaveBeenCalledWith('repo:cccccccccccc:ship')
  })

  it('confirms a repo delete in a modal naming the committed file, then deletes it', async () => {
    await render()
    await click(button('Delete ship'))
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(dialog?.textContent).toContain(`${ACTIVE}/.harness/workflows/ship.yaml`)
    expect(dialog?.textContent).toContain('committed file in the primary checkout')
    expect(document.activeElement?.textContent).toBe('Cancel')
    expect(backendApi.deleteWorkflowDefinition).not.toHaveBeenCalled()

    await click(button('Delete file'))
    expect(backendApi.deleteWorkflowDefinition).toHaveBeenCalledWith('repo:cccccccccccc:ship')
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Deleted ship')
  })

  it('keeps the dialog open with the error when delete is refused, and Cancel closes it', async () => {
    backendApi.deleteWorkflowDefinition.mockResolvedValue({ error: 'Unknown workflow definition' })
    await render()
    await click(button('Delete Beta'))
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('/u/workflows/b.yaml')
    expect(document.querySelector('[role="alertdialog"]')?.textContent).not.toContain('committed file')
    await click(button('Delete file'))
    expect(document.querySelector('[role="alertdialog"] [role="alert"]')?.textContent).toBe('Unknown workflow definition')

    await click(button('Cancel'))
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  })
})

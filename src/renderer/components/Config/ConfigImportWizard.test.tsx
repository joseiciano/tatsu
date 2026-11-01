// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigImportWizard } from './ConfigImportWizard'
import { importCutoverScopes, importFoldersProblem, importFoldersRequest } from './template-import-model'
import type {
  HarnessConfigFileRef,
  HarnessConfigState,
  HarnessTemplateImportItem,
  HarnessTemplateImportPreview
} from '../../../shared/state/harness-config'

vi.mock('../MonacoDiffEditor', () => ({
  MonacoDiffEditor: ({ original, modified }: { original: string; modified: string }) => (
    <pre data-testid="import-diff">{`${original}=>${modified}`}</pre>
  )
}))

const { backendApi, storeState } = vi.hoisted(() => {
  const backendApi = {
    previewHarnessTemplateImport: vi.fn(),
    applyHarnessTemplateImport: vi.fn(),
    pickDirectory: vi.fn(),
    scanHarnessConfig: vi.fn(async () => ({ ok: true, value: { resources: [], scannedAt: 1 } }))
  }
  const storeState: { harnessConfig: Pick<HarnessConfigState, 'comparisons' | 'resources'> } = {
    harnessConfig: { comparisons: {}, resources: { agents: [], skills: [], commands: [] } }
  }
  return { backendApi, storeState }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../backend', () => ({ useBackend: () => backendApi }))
vi.mock('../../store', () => ({
  useActiveBackend: () => ({ id: 'local', kind: 'local' }),
  useHarnessConfig: () => storeState.harnessConfig
}))

function item(overrides: Partial<HarnessTemplateImportItem> = {}): HarnessTemplateImportItem {
  return {
    key: 'agent/reviewer',
    type: 'template',
    kind: 'agent',
    name: 'reviewer',
    sourcePath: '/dots/agents/reviewer.md',
    targets: ['claude', 'opencode'],
    fragments: ['house-style'],
    references: [],
    droppedBlocks: ['omp: Tatsu does not manage this harness'],
    unsupportedSettings: [{ harness: 'opencode', key: 'model', value: '"anthropic/opus"' }],
    notes: [],
    conflict: false,
    action: 'create',
    error: null,
    ...overrides
  }
}

function preview(overrides: Partial<HarnessTemplateImportPreview> = {}): HarnessTemplateImportPreview {
  return {
    fingerprint: 'sha256:1',
    items: [item()],
    duplicates: [],
    coveredCommands: [{ name: 'deploy', skill: 'deploy', sourcePath: '/dots/commands/deploy.md' }],
    unknownFiles: [],
    renderErrors: [],
    shadows: [],
    files: [
      {
        templateRef: 'agent/reviewer',
        agentKind: 'claude',
        resourceType: 'agents',
        relativePath: 'reviewer.md',
        rendered: 'new',
        current: 'old'
      }
    ],
    blockingReasons: [],
    ...overrides
  }
}

let container: HTMLDivElement
let root: Root
let confirmSpy: ReturnType<typeof vi.spyOn>
const onClose = vi.fn()
const onReviewScope = vi.fn()
const onDirtyChange = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  storeState.harnessConfig = { comparisons: {}, resources: { agents: [], skills: [], commands: [] } }
  container = document.createElement('div')
  document.body.appendChild(container)
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  confirmSpy.mockRestore()
})

async function render(): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(
      <ConfigImportWizard onClose={onClose} onReviewScope={onReviewScope} onDirtyChange={onDirtyChange} />
    )
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error('element not found')
  act(() => (el as HTMLElement).click())
  await flush()
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === text)
  if (!button) throw new Error(`button not found: ${text}`)
  return button
}

function typeInto(el: HTMLInputElement | null, value: string): void {
  if (!el) throw new Error('field not found')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('ConfigImportWizard', () => {
  it('previews before writing, lists dropped settings and covered commands, and imports on confirmation', async () => {
    backendApi.previewHarnessTemplateImport.mockResolvedValue({ ok: true, value: preview() })
    backendApi.applyHarnessTemplateImport.mockResolvedValue({
      ok: true,
      value: { written: ['agent/reviewer'], skipped: [], scopes: [{ agentKind: 'claude', resourceType: 'agents' }] }
    })
    await render()
    expect(buttonByText('Preview import').disabled).toBe(true)
    typeInto(container.querySelector('#import-folder-agents'), '/dots/agents')
    await click(buttonByText('Preview import'))

    expect(backendApi.previewHarnessTemplateImport).toHaveBeenCalledWith({
      folders: { agents: '/dots/agents', agentFragments: null, skills: [], references: null, commands: null },
      choices: { harnesses: ['claude'], duplicateChoices: {}, conflictChoices: {} }
    })
    expect(backendApi.applyHarnessTemplateImport).not.toHaveBeenCalled()
    const text = container.textContent ?? ''
    expect(text).toContain('Dropped omp: Tatsu does not manage this harness')
    expect(text).toContain('opencode.model: "anthropic/opus"')
    expect(text).toContain('Commands covered by a skill')
    expect(container.querySelector('[data-testid="import-diff"]')?.textContent).toBe('old=>new')

    await click(buttonByText('Import'))
    expect(confirmSpy).toHaveBeenCalled()
    expect(backendApi.applyHarnessTemplateImport).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint: 'sha256:1', confirmed: true })
    )
    expect(container.textContent).toContain('Cutting over from the old build')
    expect(backendApi.scanHarnessConfig).toHaveBeenCalledWith({ scope: { agentKind: 'claude', resourceType: 'agents' } })
  })

  it('re-runs the preview when a conflict choice changes and keeps Import disabled while blocked', async () => {
    const blocked = preview({
      items: [item({ conflict: true, action: 'undecided' })],
      blockingReasons: ['agent/reviewer already exists; choose skip or replace']
    })
    backendApi.previewHarnessTemplateImport
      .mockResolvedValueOnce({ ok: true, value: blocked })
      .mockResolvedValueOnce({
        ok: true,
        value: preview({ fingerprint: 'sha256:2', items: [item({ conflict: true, action: 'replace' })] })
      })
    await render()
    typeInto(container.querySelector('#import-folder-agents'), '/dots/agents')
    await click(buttonByText('Preview import'))
    expect(buttonByText('Import').disabled).toBe(true)

    const replace = Array.from(container.querySelectorAll('label')).find((label) =>
      label.textContent?.includes('Replace (with backup)')
    )
    await click(replace?.querySelector('input') ?? null)
    expect(backendApi.previewHarnessTemplateImport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        choices: expect.objectContaining({ conflictChoices: { 'agent/reviewer': 'replace' } })
      })
    )
    expect(buttonByText('Import').disabled).toBe(false)
  })

  it('does not import when the confirmation is declined', async () => {
    backendApi.previewHarnessTemplateImport.mockResolvedValue({ ok: true, value: preview() })
    await render()
    typeInto(container.querySelector('#import-folder-agents'), '/dots/agents')
    await click(buttonByText('Preview import'))
    confirmSpy.mockReturnValue(false)
    await click(buttonByText('Import'))
    expect(backendApi.applyHarnessTemplateImport).not.toHaveBeenCalled()
  })
})

describe('template import model', () => {
  it('requires at least one full path', () => {
    const empty = importFoldersRequest({ agents: ' ', agentFragments: '', skills: [''], references: '', commands: '' })
    expect(importFoldersProblem(empty)).toMatch(/at least one/)
    const relative = importFoldersRequest({ agents: 'agents', agentFragments: '', skills: [], references: '', commands: '' })
    expect(importFoldersProblem(relative)).toMatch(/full path/)
  })

  it('lists linked harness files in each touched scope for the cut-over (REQ-008)', () => {
    const linked = { id: 'l1', agentKind: 'claude', existsOnDisk: true, linkedFrom: '/dots/build/a.md' } as HarnessConfigFileRef
    const other = { id: 'l2', agentKind: 'opencode', existsOnDisk: true, linkedFrom: '/x' } as HarnessConfigFileRef
    const scopes = importCutoverScopes(
      [{ agentKind: 'claude', resourceType: 'agents' }],
      {
        'claude:agents': {
          scope: { agentKind: 'claude', resourceType: 'agents' },
          status: 'conflict',
          configOnly: [],
          changed: [],
          comparedAt: 1
        }
      },
      { agents: [linked, other], skills: [], commands: [] }
    )
    expect(scopes).toEqual([
      expect.objectContaining({ key: 'claude:agents', status: 'conflict', linked: [linked], label: 'Claude Code · Agents' })
    ])
  })
})

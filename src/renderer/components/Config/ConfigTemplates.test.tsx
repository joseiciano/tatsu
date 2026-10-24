// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigTemplates } from './ConfigTemplates'
import type {
  HarnessFragment,
  HarnessTemplate,
  HarnessTemplateKind,
  HarnessTemplateSourceState
} from '../../../shared/state/harness-config'

vi.mock('../MonacoEditor', () => ({
  MonacoEditor: ({
    value,
    filePath,
    onChange
  }: {
    value: string
    filePath?: string
    onChange?: (value: string) => void
  }) => <textarea data-path={filePath} value={value} onChange={(e) => onChange?.(e.target.value)} />
}))

const { backendApi, storeState } = vi.hoisted(() => {
  const backendApi = {
    saveHarnessTemplate: vi.fn(),
    deleteHarnessTemplate: vi.fn(),
    saveHarnessFragment: vi.fn(),
    deleteHarnessFragment: vi.fn(),
    harnessFragmentUsage: vi.fn(async () => ({ ok: true, value: { files: [] } }))
  }
  const storeState: { source: HarnessTemplateSourceState | null } = { source: null }
  return { backendApi, storeState }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../backend', () => ({ useBackend: () => backendApi }))
vi.mock('../../store', () => ({
  useHarnessTemplateSource: () => storeState.source,
  useHarnessTemplate: (kind: HarnessTemplateKind | null, name: string | null) =>
    storeState.source?.templates.find((t) => t.kind === kind && t.name === name) ?? null,
  useHarnessFragment: (name: string | null) => storeState.source?.fragments.find((f) => f.name === name) ?? null
}))

function template(overrides: Partial<HarnessTemplate> = {}): HarnessTemplate {
  return {
    kind: 'skill',
    name: 'deploy',
    description: 'Ship it',
    fragments: [],
    body: 'Deploy steps.',
    harnesses: { claude: { frontmatter: {} } },
    references: [],
    relativePath: 'skills/deploy/TEMPLATE.md',
    hash: 'h1',
    ...overrides
  }
}

function fragment(name: string, content: string, hash = `hash-${name}`): HarnessFragment {
  return { name, content, relativePath: `fragments/${name}.md`, hash }
}

function setSource(templates: HarnessTemplate[], fragments: HarnessFragment[] = []): void {
  storeState.source = { templates, fragments, errors: [], loadedAt: 1 }
}

let container: HTMLDivElement
let root: Root
let confirmSpy: ReturnType<typeof vi.spyOn>
const onDirtyChange = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  confirmSpy.mockRestore()
})

function element(initialTemplateRef: string | null = null): JSX.Element {
  return (
    <ConfigTemplates
      initialTemplateRef={initialTemplateRef}
      searchQuery=""
      onDirtyChange={onDirtyChange}
      onImport={() => undefined}
    />
  )
}

async function render(initialTemplateRef: string | null = null): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(element(initialTemplateRef))
  })
}

async function rerender(): Promise<void> {
  await act(async () => {
    root.render(element())
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function click(el: Element | null): void {
  if (!el) throw new Error('element not found')
  act(() => (el as HTMLElement).click())
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === text)
  if (!button) throw new Error(`button not found: ${text}`)
  return button
}

function typeInto(el: HTMLInputElement | HTMLTextAreaElement | null, value: string): void {
  if (!el) throw new Error('field not found')
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  act(() => {
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function previewText(): string {
  return container.querySelector('[data-testid="template-preview"]')?.textContent ?? ''
}

describe('ConfigTemplates', () => {
  it('lists templates by kind and fragments', async () => {
    setSource([template(), template({ kind: 'agent', name: 'reviewer', relativePath: 'agents/reviewer.md' })], [
      fragment('shared', 'Shared text')
    ])
    await render()
    expect(container.querySelector('[data-testid="config-templates-skill"]')?.textContent).toContain('deploy')
    expect(container.querySelector('[data-testid="config-templates-agent"]')?.textContent).toContain('reviewer')
    expect(container.querySelector('[data-testid="config-fragments"]')?.textContent).toContain('shared')
  })

  it('changes preview targets with the harness toggles and keeps invalid targets off', async () => {
    setSource([template({ kind: 'agent', name: 'reviewer', relativePath: 'agents/reviewer.md' })])
    await render('agent/reviewer')

    const codex = container.querySelector<HTMLInputElement>('#template-harness-codex')
    expect(codex?.disabled).toBe(true)
    expect(container.querySelector('[data-testid="template-harness-codex"]')?.textContent).toContain('AGENTS.md')

    expect(previewText()).toContain('Claude Code')
    expect(previewText()).not.toContain('Opencode')
    click(container.querySelector('#template-harness-opencode'))
    const opencodeTab = Array.from(container.querySelectorAll('[data-testid="template-preview"] button')).find(
      (b) => b.textContent !== 'Claude Code'
    )
    expect(opencodeTab).toBeTruthy()
    click(opencodeTab!)
    await flush()
    expect(previewText()).toContain('<!-- tatsu-template: agent/reviewer -->')
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
  })

  it('shows a render error in the preview without disabling save', async () => {
    setSource([template({ fragments: ['gone'] })])
    await render('skill/deploy')
    await flush()
    expect(previewText()).toContain('Unknown fragment: gone')
    expect(container.querySelector('[data-testid="template-fragment-picker"]')?.textContent).toContain('gone (missing)')

    typeInto(container.querySelector<HTMLInputElement>('#template-description'), 'Changed')
    await flush()
    expect(buttonByText('Save').disabled).toBe(false)
    expect(previewText()).toContain('Unknown fragment: gone')
  })

  it('lists every dependent template before saving a shared fragment', async () => {
    setSource(
      [
        template({ name: 'a', fragments: ['shared'], relativePath: 'skills/a/TEMPLATE.md' }),
        template({ name: 'b', fragments: ['shared'], relativePath: 'skills/b/TEMPLATE.md' })
      ],
      [fragment('shared', 'Old')]
    )
    await render()
    click(container.querySelector('[data-testid="config-fragments"] button:not([aria-label])'))
    expect(container.querySelector('[data-testid="fragment-usage"]')?.textContent).toContain('skill/a, skill/b')
    typeInto(container.querySelector<HTMLTextAreaElement>('textarea[data-path="fragment.md"]'), 'New')

    confirmSpy.mockReturnValue(false)
    click(buttonByText('Save'))
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    const message = String(confirmSpy.mock.calls[0][0])
    expect(message).toContain('used in 2 places')
    expect(message).toContain('- skill/a')
    expect(message).toContain('- skill/b')
    expect(backendApi.saveHarnessFragment).not.toHaveBeenCalled()

    confirmSpy.mockReturnValue(true)
    backendApi.saveHarnessFragment.mockResolvedValue({ ok: true, value: fragment('shared', 'New', 'hash-new') })
    click(buttonByText('Save'))
    await flush()
    expect(backendApi.saveHarnessFragment).toHaveBeenCalledWith({ name: 'shared', content: 'New', confirmed: true })
  })

  it('asks before overwriting a template changed outside Tatsu', async () => {
    setSource([template()])
    await render('skill/deploy')
    typeInto(container.querySelector<HTMLInputElement>('#template-description'), 'Mine')

    setSource([template({ description: 'Theirs', hash: 'h2' })])
    await rerender()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('changed in the source folder')
    expect(container.querySelector<HTMLInputElement>('#template-description')?.value).toBe('Mine')

    confirmSpy.mockReturnValue(false)
    click(buttonByText('Save'))
    expect(String(confirmSpy.mock.calls[0][0])).toContain('changed in the source folder since you opened it')
    expect(backendApi.saveHarnessTemplate).not.toHaveBeenCalled()
  })

  it('reloads a clean draft when the file changes outside Tatsu', async () => {
    setSource([template()])
    await render('skill/deploy')
    setSource([template({ description: 'Theirs', hash: 'h2' })])
    await rerender()
    await flush()
    expect(container.querySelector<HTMLInputElement>('#template-description')?.value).toBe('Theirs')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('confirms and retries when a template would shadow stored config', async () => {
    setSource([template()])
    await render('skill/deploy')
    typeInto(container.querySelector<HTMLInputElement>('#template-description'), 'Mine')
    backendApi.saveHarnessTemplate
      .mockResolvedValueOnce({ ok: false, error: { code: 'template-shadows', message: 'Replaces stored config' } })
      .mockResolvedValueOnce({ ok: true, value: template({ description: 'Mine', hash: 'h3' }) })
    click(buttonByText('Save'))
    await flush()
    expect(backendApi.saveHarnessTemplate).toHaveBeenCalledTimes(2)
    expect(backendApi.saveHarnessTemplate.mock.calls[0][0]).not.toHaveProperty('allowShadowing')
    expect(backendApi.saveHarnessTemplate.mock.calls[1][0]).toMatchObject({ allowShadowing: true, confirmed: true })
    expect(container.textContent).toContain('Saved skills/deploy/TEMPLATE.md')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})

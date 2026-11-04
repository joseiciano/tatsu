// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InputPicker, ISSUE_SEARCH_DEBOUNCE_MS, type PickerKind } from '.'
import type { PRSummary } from '../../../../shared/github-types'

const { backendApi } = vi.hoisted(() => ({
  backendApi: {
    listRepoIssues: vi.fn(),
    listRepoPRs: vi.fn(),
    listAllFiles: vi.fn()
  }
}))

vi.mock('../../../backend', () => ({ useBackend: () => backendApi }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function pr(number: number, title: string, headBranch: string): PRSummary {
  return {
    number,
    title,
    author: null,
    baseBranch: 'main',
    headBranch,
    headSha: 'abc',
    headRepoFullName: 'acme/widgets',
    isFork: false,
    updatedAt: '',
    url: '',
    draft: false
  }
}

let container: HTMLDivElement
let root: Root
let values: string[]

function Harness({ kind, filesRoot = '/wt' }: { kind: PickerKind; filesRoot?: string | null }): JSX.Element {
  const [value, setValue] = useState('')
  return (
    <form onSubmit={(e) => e.preventDefault()}>
      <label htmlFor="pick">target</label>
      <InputPicker
        id="pick"
        label="target"
        kind={kind}
        value={value}
        disabled={false}
        repoRoot="/repo"
        filesRoot={filesRoot}
        className=""
        onChange={(next) => {
          values.push(next)
          setValue(next)
        }}
      />
    </form>
  )
}

beforeEach(() => {
  values = []
  backendApi.listRepoIssues.mockReset().mockResolvedValue({ status: 'ok', issues: [] })
  backendApi.listRepoPRs.mockReset().mockResolvedValue([])
  backendApi.listAllFiles.mockReset().mockResolvedValue([])
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

async function mount(kind: PickerKind, filesRoot?: string | null): Promise<void> {
  await act(async () => {
    root.render(<Harness kind={kind} filesRoot={filesRoot} />)
  })
}

function input(): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>('#pick')
  if (!el) throw new Error('missing picker input')
  return el
}

async function type(value: string): Promise<void> {
  const el = input()
  await act(async () => {
    el.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function press(key: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  await act(async () => {
    input().dispatchEvent(event)
  })
  return event
}

function optionLabels(): string[] {
  return [...container.querySelectorAll('[role="option"]')].map((o) => o.querySelector('span')?.textContent ?? '')
}

function activeOption(): Element | null {
  const id = input().getAttribute('aria-activedescendant')
  return id ? document.getElementById(id) : null
}

describe('InputPicker combobox', () => {
  it('exposes the ARIA combobox pattern and opens with ArrowDown', async () => {
    backendApi.listAllFiles.mockResolvedValue(['README.md', 'src/app.ts'])
    await mount('file')
    const el = input()
    expect(el.getAttribute('role')).toBe('combobox')
    expect(el.getAttribute('aria-expanded')).toBe('false')
    const listbox = document.getElementById(el.getAttribute('aria-controls') ?? '')
    expect(listbox?.getAttribute('role')).toBe('listbox')
    expect(listbox?.getAttribute('aria-label')).toBe('target options')
    await press('ArrowDown')
    expect(el.getAttribute('aria-expanded')).toBe('true')
    expect(activeOption()?.textContent).toBe('README.md')
    expect(activeOption()?.getAttribute('aria-selected')).toBe('true')
    await press('ArrowDown')
    expect(activeOption()?.textContent).toBe('src/app.ts')
    await press('ArrowUp')
    expect(activeOption()?.textContent).toBe('README.md')
  })

  it('closes on Escape without selecting and leaves Enter to the form when closed', async () => {
    backendApi.listAllFiles.mockResolvedValue(['README.md'])
    await mount('file')
    await press('ArrowDown')
    const escape = await press('Escape')
    expect(escape.defaultPrevented).toBe(true)
    expect(input().getAttribute('aria-expanded')).toBe('false')
    expect(values).toEqual([])
    const enter = await press('Enter')
    expect(enter.defaultPrevented).toBe(false)
  })
})

describe('InputPicker files', () => {
  it('lists the files root, fuzzy-filters, and writes the chosen repo-relative path with the keyboard', async () => {
    backendApi.listAllFiles.mockResolvedValue(['README.md', 'docs/guide.md', 'src/picker.ts', 'src/main.ts'])
    await mount('file')
    expect(backendApi.listAllFiles).toHaveBeenCalledWith('/wt')
    await type('pick')
    expect(optionLabels()).toEqual(['src/picker.ts'])
    const enter = await press('Enter')
    expect(enter.defaultPrevented).toBe(true)
    expect(values).toEqual(['src/picker.ts'])
    expect(input().value).toBe('src/picker.ts')
    expect(input().getAttribute('aria-expanded')).toBe('false')
  })

  it('never offers absolute or parent-relative paths from the listing', async () => {
    backendApi.listAllFiles.mockResolvedValue(['/etc/passwd', '../secret', 'a/../b', 'ok.txt'])
    await mount('file')
    await press('ArrowDown')
    expect(optionLabels()).toEqual(['ok.txt'])
  })

  it('clears the value when the text is edited after a selection', async () => {
    backendApi.listAllFiles.mockResolvedValue(['ok.txt'])
    await mount('file')
    await press('ArrowDown')
    await press('Enter')
    await type('ok.tx')
    expect(values).toEqual(['ok.txt', ''])
  })

  it('shows an empty state when nothing matches', async () => {
    backendApi.listAllFiles.mockResolvedValue(['ok.txt'])
    await mount('file')
    await type('zzz')
    expect(container.querySelector('[role="status"]')?.textContent).toBe('No matching files')
    await press('Enter')
    expect(values).toEqual([])
  })
})

describe('InputPicker pull requests', () => {
  it('filters open PRs by number, title or branch and writes the number', async () => {
    backendApi.listRepoPRs.mockResolvedValue([pr(7, 'Fix login', 'fix-login'), pr(9, 'Add dark mode', 'theme')])
    await mount('pr')
    expect(backendApi.listRepoPRs).toHaveBeenCalledWith('/repo', { requireToken: true })
    await type('dark')
    expect(optionLabels()).toEqual(['#9 Add dark mode'])
    await press('Enter')
    expect(values).toEqual(['9'])
  })

  it('offers a typed number that is not in the list', async () => {
    backendApi.listRepoPRs.mockResolvedValue([pr(7, 'Fix login', 'fix-login')])
    await mount('pr')
    await type('#42')
    expect(optionLabels()).toEqual(['#42'])
    await press('Enter')
    expect(values).toEqual(['42'])
  })

  it('falls back to a number field when the PR list is unavailable', async () => {
    backendApi.listRepoPRs.mockResolvedValue(null)
    await mount('pr')
    const el = input()
    expect(el.getAttribute('role')).toBeNull()
    expect(el.inputMode).toBe('numeric')
    await type('#3x1')
    expect(values).toEqual(['31'])
  })
})

describe('InputPicker issues', () => {
  it('loads open issues, debounces the search, and writes the chosen number', async () => {
    backendApi.listRepoIssues.mockImplementation(async (_root: string, query: string) => ({
      status: 'ok',
      issues:
        query === 'crash'
          ? [{ number: 12, title: 'Crash on start', author: 'octo', updatedAt: '' }]
          : [{ number: 1, title: 'First', author: null, updatedAt: '' }]
    }))
    await mount('issue')
    expect(backendApi.listRepoIssues).toHaveBeenCalledTimes(1)
    expect(backendApi.listRepoIssues).toHaveBeenLastCalledWith('/repo', '')
    vi.useFakeTimers()
    await type('cr')
    await type('crash')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ISSUE_SEARCH_DEBOUNCE_MS - 1)
    })
    expect(backendApi.listRepoIssues).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(backendApi.listRepoIssues).toHaveBeenCalledTimes(2)
    expect(backendApi.listRepoIssues).toHaveBeenLastCalledWith('/repo', 'crash')
    expect(optionLabels()).toEqual(['#12 Crash on start'])
    await press('ArrowDown')
    await press('Enter')
    expect(values.at(-1)).toBe('12')
  })

  it('renders issue titles as text, never as markup', async () => {
    backendApi.listRepoIssues.mockResolvedValue({
      status: 'ok',
      issues: [{ number: 5, title: '<img src=x onerror=alert(1)>', author: null, updatedAt: '' }]
    })
    await mount('issue')
    await press('ArrowDown')
    expect(container.querySelector('img')).toBeNull()
    expect(optionLabels()).toEqual(['#5 <img src=x onerror=alert(1)>'])
  })

  it.each(['no-token', 'no-repo', 'error'] as const)('falls back to a number field when the first load is %s', async (status) => {
    backendApi.listRepoIssues.mockResolvedValue({ status })
    await mount('issue')
    const el = input()
    expect(el.getAttribute('role')).toBeNull()
    expect(container.textContent).toContain('Enter the issue number')
    await type('12')
    expect(values).toEqual(['12'])
    expect(backendApi.listRepoIssues).toHaveBeenCalledTimes(1)
  })

  it('keeps the combobox and shows a search error when a later search fails', async () => {
    backendApi.listRepoIssues
      .mockResolvedValueOnce({ status: 'ok', issues: [{ number: 1, title: 'First', author: null, updatedAt: '' }] })
      .mockResolvedValue({ status: 'error' })
    await mount('issue')
    vi.useFakeTimers()
    await type('boom')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ISSUE_SEARCH_DEBOUNCE_MS)
    })
    expect(input().getAttribute('role')).toBe('combobox')
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Couldn't search issues")
  })
})

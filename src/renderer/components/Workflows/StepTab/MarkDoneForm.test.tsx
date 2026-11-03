// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkDoneForm } from './MarkDoneForm'
import type { WorkflowActionResponse, WorkflowMarkDonePayload } from '../../../../shared/state/workflows'
import type { ResolvedAgentStep } from '../../../../shared/workflow-def'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const STEP: ResolvedAgentStep = {
  id: 'fix',
  kind: 'agent',
  agent: 'claude',
  prompt: 'go',
  permissions: 'edit',
  allow: [],
  needs: [],
  output: {
    fields: {
      count: { type: 'number' },
      ok: { type: 'boolean' },
      level: { enum: ['low', 'high'] },
      tags: { type: 'array', items: { type: 'string' } }
    },
    required: ['count']
  }
}

let container: HTMLDivElement
let root: Root
let onSubmit: ReturnType<typeof vi.fn<(payload: WorkflowMarkDonePayload) => Promise<WorkflowActionResponse>>>

beforeEach(() => {
  onSubmit = vi.fn<(payload: WorkflowMarkDonePayload) => Promise<WorkflowActionResponse>>().mockResolvedValue({ ok: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<MarkDoneForm step={STEP} onSubmit={onSubmit} />))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function byLabel<T extends HTMLElement>(text: string): T {
  const label = [...container.querySelectorAll('label')].find((l) => l.textContent?.startsWith(text))
  const el = label ? document.getElementById(label.htmlFor) : null
  if (!el) throw new Error(`missing field ${text}`)
  return el as T
}

async function type(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): Promise<void> {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

async function submit(): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>('button[type="submit"]')
  await act(async () => {
    button?.click()
  })
}

describe('MarkDoneForm', () => {
  it('renders a labelled input for the summary and each output field', () => {
    expect(container.querySelector('form')?.getAttribute('aria-label')).toBe('Mark step done')
    expect(byLabel('Summary').tagName).toBe('TEXTAREA')
    expect(byLabel<HTMLInputElement>('count').getAttribute('inputmode')).toBe('decimal')
    expect(byLabel<HTMLInputElement>('ok').type).toBe('checkbox')
    expect([...byLabel<HTMLSelectElement>('level').options].map((o) => o.textContent)).toEqual(['—', 'low', 'high'])
    expect(byLabel('tags').tagName).toBe('TEXTAREA')
  })

  it('submits the serialised payload', async () => {
    await type(byLabel('Summary'), 'Fixed by hand')
    await type(byLabel('count'), '2')
    await act(async () => {
      byLabel<HTMLInputElement>('ok').click()
    })
    await type(byLabel('level'), '1')
    await type(byLabel('tags'), 'a\nb')
    await submit()
    expect(onSubmit).toHaveBeenCalledWith({
      summary: 'Fixed by hand',
      fields: { count: 2, ok: true, level: 'high', tags: ['a', 'b'] }
    })
  })

  it('shows client validation errors inline and focuses the first invalid field', async () => {
    await type(byLabel('count'), 'two')
    await submit()
    expect(onSubmit).not.toHaveBeenCalled()
    const summary = byLabel('Summary')
    expect(summary.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById(summary.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Required')
    const count = byLabel('count')
    expect(document.getElementById(count.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Expected a number')
    expect(document.activeElement).toBe(summary)
  })

  it('shows a server refusal inline', async () => {
    onSubmit.mockResolvedValue({ error: 'This step cannot be marked done now' })
    await type(byLabel('Summary'), 'done')
    await type(byLabel('count'), '1')
    await submit()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('This step cannot be marked done now')
  })
})

// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkflowGraph, type WorkflowGraphProps } from './WorkflowGraph'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function render(props: WorkflowGraphProps): void {
  act(() => root.render(<WorkflowGraph {...props} />))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const steps = [{ id: 'plan' }, { id: 'build' }, { id: 'test', needs: ['plan'] }]

describe('WorkflowGraph', () => {
  it('labels each node with its status', () => {
    render({ steps, statusByStep: { plan: 'done', build: 'running', test: 'awaiting-gate' } })
    const labels = [...container.querySelectorAll('[role="listitem"]')].map((n) => n.getAttribute('aria-label'))
    expect(labels).toEqual(['plan: done', 'build: running', 'test: waiting at gate'])
  })

  it('labels nodes with just the id when no status is given', () => {
    render({ steps })
    const labels = [...container.querySelectorAll('[role="listitem"]')].map((n) => n.getAttribute('aria-label'))
    expect(labels).toEqual(['plan', 'build', 'test'])
  })

  it('shows the step glyph and hides edges from assistive tech', () => {
    render({ steps, statusByStep: { plan: 'done' } })
    expect(container.querySelector('[aria-label="plan: done"]')?.textContent).toContain('✓')
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelectorAll('path')).toHaveLength(2)
  })

  it('wraps a wide graph in a focusable scroll container', () => {
    render({ steps })
    const scroll = container.querySelector<HTMLElement>('[aria-label="Workflow graph"]')
    expect(scroll?.tabIndex).toBe(0)
    expect(scroll?.className).toContain('overflow-x-auto')
  })

  it('renders nothing for an empty step list', () => {
    render({ steps: [] })
    expect(container.innerHTML).toBe('')
  })

  it('renders a flat row without edges for a broken draft', () => {
    render({ steps: [{ id: 'a', needs: ['b'] }, { id: 'b', needs: ['a'] }] })
    expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(2)
    expect(container.querySelectorAll('path')).toHaveLength(0)
  })
})

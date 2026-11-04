// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MARKER_OWNER, MonacoEditor, type EditorMarker } from '.'

const { monacoApi } = vi.hoisted(() => {
  const model = { id: 'model', dispose: vi.fn() }
  const editor = {
    getModel: () => model,
    getValue: () => '',
    setValue: vi.fn(),
    updateOptions: vi.fn(),
    dispose: vi.fn(),
    addCommand: vi.fn(),
    onDidChangeModelContent: () => ({ dispose: vi.fn() }),
    onMouseMove: () => ({ dispose: vi.fn() }),
    onMouseLeave: () => ({ dispose: vi.fn() }),
    onMouseDown: () => ({ dispose: vi.fn() }),
    createDecorationsCollection: () => ({ set: vi.fn(), clear: vi.fn() })
  }
  return {
    monacoApi: {
      model,
      editor,
      create: vi.fn(() => editor),
      setModelMarkers: vi.fn()
    }
  }
})

vi.mock('monaco-editor', () => ({
  editor: {
    create: monacoApi.create,
    setModelMarkers: monacoApi.setModelMarkers,
    setModelLanguage: vi.fn(),
    MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 }
  },
  MarkerSeverity: { Error: 8, Warning: 4 },
  KeyMod: { CtrlCmd: 2048 },
  KeyCode: { KeyS: 49 },
  Range: class {}
}))
vi.mock('../../monaco-setup', () => ({ detectMonacoLanguage: (path?: string) => (path?.endsWith('.yaml') ? 'yaml' : 'plaintext') }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ERROR: EditorMarker = { severity: 'error', message: 'unknown step', code: 'unknown-ref', startLineNumber: 5, startColumn: 15, endLineNumber: 5, endColumn: 38 }
const WARNING: EditorMarker = { severity: 'warning', message: 'odd', startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 5 }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  monacoApi.create.mockClear()
  monacoApi.setModelMarkers.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  container.remove()
})

function render(markers?: readonly EditorMarker[]): void {
  act(() => root.render(<MonacoEditor value="name: x" filePath="draft.yaml" markers={markers} ariaLabel="Workflow YAML" />))
}

describe('MonacoEditor markers', () => {
  it('sets markers on the model with Monaco severities and replaces them on change', () => {
    render([ERROR, WARNING])
    expect(monacoApi.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ language: 'yaml', ariaLabel: 'Workflow YAML' }))
    expect(monacoApi.setModelMarkers).toHaveBeenLastCalledWith(monacoApi.model, MARKER_OWNER, [
      { ...ERROR, severity: 8 },
      { ...WARNING, severity: 4 }
    ])
    render([])
    expect(monacoApi.setModelMarkers).toHaveBeenLastCalledWith(monacoApi.model, MARKER_OWNER, [])
    expect(monacoApi.create).toHaveBeenCalledTimes(1)
    act(() => root.unmount())
  })

  it('clears its markers before the model is disposed on unmount', () => {
    render([ERROR])
    monacoApi.setModelMarkers.mockClear()
    act(() => root.unmount())
    expect(monacoApi.setModelMarkers).toHaveBeenCalledWith(monacoApi.model, MARKER_OWNER, [])
    expect(monacoApi.setModelMarkers.mock.invocationCallOrder[0]).toBeLessThan(monacoApi.model.dispose.mock.invocationCallOrder.at(-1) ?? 0)
  })
})

import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import { detectMonacoLanguage } from '../../monaco-setup'
import type { EditorCompletionProvider, EditorMarker } from './types'

export const MARKER_OWNER = 'tatsu'

function toMonacoMarker(marker: EditorMarker): monaco.editor.IMarkerData {
  return {
    ...marker,
    severity: marker.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning
  }
}

interface MonacoEditorProps {
  value: string
  filePath?: string
  readOnly?: boolean
  fontFamily?: string
  fontSize?: number
  onChange?: (value: string) => void
  onSave?: () => void
  onReferenceLine?: (lineNumber: number) => void
  markers?: readonly EditorMarker[]
  ariaLabel?: string
  completionProvider?: EditorCompletionProvider
}

export function MonacoEditor({
  value,
  filePath,
  readOnly = false,
  fontFamily,
  fontSize,
  onChange,
  onSave,
  onReferenceLine,
  markers,
  ariaLabel,
  completionProvider
}: MonacoEditorProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const onRefRef = useRef(onReferenceLine)
  const completionRef = useRef(completionProvider)
  onChangeRef.current = onChange
  completionRef.current = completionProvider
  onSaveRef.current = onSave
  onRefRef.current = onReferenceLine

  // Construct the editor once and tear it down on unmount. Subsequent
  // prop updates are pushed imperatively so we don't recreate the model
  // (and lose undo history) on every render.
  useEffect(() => {
    if (!hostRef.current) return
    const editor = monaco.editor.create(hostRef.current, {
      value,
      language: detectMonacoLanguage(filePath),
      readOnly,
      ariaLabel,
      theme: 'harness',
      fontFamily: fontFamily || undefined,
      fontSize: fontSize || 13,
      automaticLayout: true,
      glyphMargin: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      tabSize: 2,
      fixedOverflowWidgets: true,
      scrollbar: {
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10,
        useShadows: false
      }
    })
    editorRef.current = editor

    const changeSub = editor.onDidChangeModelContent(() => {
      onChangeRef.current?.(editor.getValue())
    })

    // Cmd-S / Ctrl-S → onSave. Using addCommand lets Monaco own the
    // keybinding scope so it doesn't fire while focus is elsewhere.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current?.()
    })

    // Hover-tracked glyph-margin button for "reference line in Claude".
    const glyphCollection = editor.createDecorationsCollection()
    const setHoverLine = (lineNumber: number | null): void => {
      if (!onRefRef.current || lineNumber == null) {
        glyphCollection.clear()
        return
      }
      glyphCollection.set([
        {
          range: new monaco.Range(lineNumber, 1, lineNumber, 1),
          options: {
            glyphMarginClassName: 'ref-line-glyph',
            glyphMarginHoverMessage: { value: 'Reference this line in Claude' }
          }
        }
      ])
    }
    const moveSub = editor.onMouseMove((e) => {
      if (!onRefRef.current) return
      const ln = e.target.position?.lineNumber ?? null
      setHoverLine(ln)
    })
    const ownModel = editor.getModel()
    const completionSub =
      completionRef.current && ownModel
        ? monaco.languages.registerCompletionItemProvider(ownModel.getLanguageId(), {
            triggerCharacters: [...completionRef.current.triggerCharacters],
            provideCompletionItems: (model, position) => {
              const provider = completionRef.current
              if (model !== editor.getModel() || !provider) return { suggestions: [] }
              const lineBefore = model.getLineContent(position.lineNumber).slice(0, position.column - 1)
              const result = provider.provide(lineBefore)
              if (!result) return { suggestions: [] }
              const range = {
                startLineNumber: position.lineNumber,
                startColumn: result.start + 1,
                endLineNumber: position.lineNumber,
                endColumn: position.column
              }
              return {
                suggestions: result.items.map((item) => ({
                  label: item.label,
                  detail: item.detail,
                  kind: monaco.languages.CompletionItemKind.Reference,
                  insertText: item.label,
                  range
                }))
              }
            }
          })
        : null
    const leaveSub = editor.onMouseLeave(() => setHoverLine(null))
    const downSub = editor.onMouseDown((e) => {
      if (!onRefRef.current) return
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return
      const ln = e.target.position?.lineNumber
      if (ln != null) onRefRef.current(ln)
    })

    return () => {
      changeSub.dispose()
      moveSub.dispose()
      leaveSub.dispose()
      downSub.dispose()
      completionSub?.dispose()
      glyphCollection.clear()
      // Dispose the editor before its model — reversing this order fires
      // "TextModel got disposed before ..." from Monaco's listeners.
      const model = editor.getModel()
      if (model) monaco.editor.setModelMarkers(model, MARKER_OWNER, [])
      editor.dispose()
      model?.dispose()
      editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sync value when it changes externally (e.g. reload). Skip if the
  // editor already has the same content to avoid cursor resets.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    if (editor.getValue() !== value) {
      editor.setValue(value)
    }
  }, [value])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const model = editor.getModel()
    if (model) {
      monaco.editor.setModelLanguage(model, detectMonacoLanguage(filePath))
    }
  }, [filePath])

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly })
  }, [readOnly])

  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (!model) return
    monaco.editor.setModelMarkers(model, MARKER_OWNER, (markers ?? []).map(toMonacoMarker))
  }, [markers])

  useEffect(() => {
    editorRef.current?.updateOptions({
      fontFamily: fontFamily || undefined,
      fontSize: fontSize || 13
    })
  }, [fontFamily, fontSize])

  return <div ref={hostRef} className="h-full w-full" />
}

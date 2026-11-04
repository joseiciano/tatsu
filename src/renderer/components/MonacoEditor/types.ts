export interface EditorMarker {
  severity: 'error' | 'warning'
  message: string
  code?: string
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

export interface EditorCompletionItem {
  label: string
  detail?: string
}

export interface EditorCompletions {
  start: number
  items: readonly EditorCompletionItem[]
}

export interface EditorCompletionProvider {
  triggerCharacters: readonly string[]
  provide: (lineBefore: string) => EditorCompletions | null
}

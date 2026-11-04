export interface EditorMarker {
  severity: 'error' | 'warning'
  message: string
  code?: string
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

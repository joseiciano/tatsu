import type { WorkflowDiagnostic } from '../../../../shared/workflow-def'
import type { EditorMarker } from '../../MonacoEditor/types'

export function splitLines(source: string): string[] {
  return source.split(/\r\n|\r|\n/)
}

function isBlank(text: string): boolean {
  return text.trim() === ''
}

function nearestContentLine(lines: readonly string[], index: number): number {
  for (let i = index; i >= 0; i -= 1) if (!isBlank(lines[i])) return i
  for (let i = index + 1; i < lines.length; i += 1) if (!isBlank(lines[i])) return i
  return -1
}

function wholeLine(lineNumber: number, text: string): Pick<EditorMarker, 'startLineNumber' | 'startColumn' | 'endLineNumber' | 'endColumn'> {
  const start = text.length - text.trimStart().length + 1
  return { startLineNumber: lineNumber, startColumn: start, endLineNumber: lineNumber, endColumn: text.trimEnd().length + 1 }
}

function markerRange(diagnostic: WorkflowDiagnostic, lines: readonly string[]): ReturnType<typeof wholeLine> {
  const lastIndex = Math.max(lines.length - 1, 0)
  const index = Math.min(Math.max(diagnostic.line, 1) - 1, lastIndex)
  const text = lines[index] ?? ''
  if (isBlank(text)) {
    const content = nearestContentLine(lines, index)
    if (content < 0) return { startLineNumber: index + 1, startColumn: 1, endLineNumber: index + 1, endColumn: 2 }
    return wholeLine(content + 1, lines[content])
  }
  const col = Math.max(diagnostic.col, 1)
  if (col > text.trimEnd().length) return wholeLine(index + 1, text)
  let end = col - 1
  while (end < text.length && !/\s/.test(text[end])) end += 1
  return { startLineNumber: index + 1, startColumn: col, endLineNumber: index + 1, endColumn: Math.max(end + 1, col + 1) }
}

export function diagnosticsToMarkers(diagnostics: readonly WorkflowDiagnostic[], lines: readonly string[]): EditorMarker[] {
  return diagnostics.map((diagnostic) => ({
    severity: diagnostic.severity,
    message: diagnostic.message,
    code: diagnostic.code,
    ...markerRange(diagnostic, lines)
  }))
}

import { describe, expect, it } from 'vitest'
import { diagnosticsToMarkers, splitLines } from '.'
import { validateWorkflowDefinition, type WorkflowDiagnostic } from '../../../../shared/workflow-def'

function diag(line: number, col: number, overrides: Partial<WorkflowDiagnostic> = {}): WorkflowDiagnostic {
  return { severity: 'error', code: 'unknown-ref', message: 'bad', path: '', line, col, ...overrides }
}

function span(source: string, d: WorkflowDiagnostic): string {
  const [m] = diagnosticsToMarkers([d], splitLines(source))
  const lines = splitLines(source)
  expect(m.startLineNumber).toBe(m.endLineNumber)
  return lines[m.startLineNumber - 1].slice(m.startColumn - 1, m.endColumn - 1)
}

describe('diagnosticsToMarkers', () => {
  it('marks the template reference the validator points at', () => {
    const source = 'name: x\nsteps:\n  - id: hello\n    kind: shell\n    run: echo {{steps.bogus.summary}}\n'
    const { diagnostics } = validateWorkflowDefinition(source)
    expect(diagnostics.map((d) => d.code)).toEqual(['unknown-ref'])
    const [marker] = diagnosticsToMarkers(diagnostics, splitLines(source))
    expect(marker).toMatchObject({ severity: 'error', code: 'unknown-ref', startLineNumber: 5, startColumn: 15, endLineNumber: 5 })
    expect(span(source, diagnostics[0])).toBe('{{steps.bogus.summary}}')
  })

  it('stops at the end of the token, not the end of the line', () => {
    expect(span('steps: [alpha, beta]', diag(1, 9))).toBe('alpha,')
    expect(span('  - id: hello   ', diag(1, 9))).toBe('hello')
  })

  it('keeps the message and maps warning severity', () => {
    const [marker] = diagnosticsToMarkers([diag(1, 1, { severity: 'warning', message: 'careful', code: 'yaml-syntax' })], ['name: x'])
    expect(marker).toMatchObject({ severity: 'warning', message: 'careful', code: 'yaml-syntax' })
  })

  it('clamps a line past the end to the last non-blank line', () => {
    const source = 'name: x\nsteps:\n  - id: hello\n    run: "echo\n'
    expect(splitLines(source)).toHaveLength(5)
    const [marker] = diagnosticsToMarkers([diag(9, 1)], splitLines(source))
    expect(marker).toMatchObject({ startLineNumber: 4, startColumn: 5, endLineNumber: 4, endColumn: 15 })
  })

  it('moves a column past the end of the line onto the line content', () => {
    expect(span('  - id: hello', diag(1, 40))).toBe('- id: hello')
  })

  it('falls back to the nearest content when the line is blank', () => {
    expect(diagnosticsToMarkers([diag(2, 1)], ['name: x', '', ''])[0]).toMatchObject({ startLineNumber: 1, startColumn: 1, endColumn: 8 })
    expect(diagnosticsToMarkers([diag(1, 1)], ['', 'steps: []'])[0]).toMatchObject({ startLineNumber: 2, startColumn: 1, endColumn: 10 })
  })

  it('gives every marker a non-zero width, even for an empty document', () => {
    const [marker] = diagnosticsToMarkers([diag(1, 1)], splitLines(''))
    expect(marker).toMatchObject({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 })
  })

  it('treats coarse 0 positions as the first column of the first line', () => {
    const [marker] = diagnosticsToMarkers([diag(0, 0)], ['name: x'])
    expect(marker).toMatchObject({ startLineNumber: 1, startColumn: 1, endColumn: 6 })
  })

  it('splits lines the way Monaco counts them', () => {
    expect(splitLines('a\r\nb\rc\nd')).toEqual(['a', 'b', 'c', 'd'])
  })
})

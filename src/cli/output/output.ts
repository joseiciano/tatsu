import type { CliError } from '../errors'

export type Write = (text: string) => void

export interface ResultOptions {
  keepOnError?: boolean
}

export interface Output {
  result<T>(value: T, renderHuman: (value: T) => string, options?: ResultOptions): void
}

export interface BufferedOutput extends Output {
  flush(): void
  flushKept(): void
}

function withNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

export function createOutput({ json, stdout }: { json: boolean; stdout: Write }): BufferedOutput {
  let pending: string | undefined
  let keepOnError = false
  const flush = (): void => {
    if (pending !== undefined) stdout(withNewline(pending))
  }
  return {
    result(value, renderHuman, options) {
      if (pending !== undefined) throw new Error('output.result called more than once')
      pending = json ? JSON.stringify(value) : renderHuman(value)
      keepOnError = options?.keepOnError === true
    },
    flush,
    flushKept() {
      if (keepOnError) flush()
    }
  }
}

export function printError(err: CliError, { json, stderr }: { json: boolean; stderr: Write }): void {
  if (json) {
    const body = { error: { code: err.code, message: err.message, details: err.details ?? null } }
    stderr(`${JSON.stringify(body)}\n`)
    return
  }
  stderr(`tatsu: ${err.message}\n`)
}

export function formatTable(rows: readonly (readonly string[])[]): string {
  const columns = Math.max(0, ...rows.map((row) => row.length))
  const widths = Array.from({ length: columns }, (_, col) => Math.max(...rows.map((row) => (row[col] ?? '').length)))
  return rows
    .map((row) => row.map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col]))).join('  '))
    .join('\n')
}

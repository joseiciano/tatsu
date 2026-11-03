export type CliErrorCode =
  | 'request-failed'
  | 'command-failed'
  | 'usage'
  | 'not-running'
  | 'unreachable'
  | 'timeout'
  | 'unauthorized'

const EXIT_CODES: Record<CliErrorCode, number> = {
  'request-failed': 1,
  'command-failed': 1,
  usage: 2,
  'not-running': 3,
  unreachable: 3,
  timeout: 3,
  unauthorized: 4
}

export class CliError extends Error {
  readonly code: CliErrorCode
  readonly details?: unknown

  constructor(code: CliErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.details = details
  }
}

export function exitCodeFor(code: CliErrorCode): number {
  return EXIT_CODES[code]
}

export function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err
  const message = err instanceof Error ? err.message : String(err)
  return new CliError('command-failed', message)
}

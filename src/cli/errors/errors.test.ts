import { describe, it, expect } from 'vitest'
import { CliError, exitCodeFor, toCliError, type CliErrorCode } from '.'

describe('exitCodeFor', () => {
  const cases: Array<[CliErrorCode, number]> = [
    ['request-failed', 1],
    ['command-failed', 1],
    ['usage', 2],
    ['not-running', 3],
    ['unreachable', 3],
    ['timeout', 3],
    ['unauthorized', 4]
  ]

  it.each(cases)('maps %s to exit %i', (code, exit) => {
    expect(exitCodeFor(code)).toBe(exit)
  })
})

describe('toCliError', () => {
  it('passes a CliError through unchanged', () => {
    const err = new CliError('timeout', 'slow', { ms: 5 })
    expect(toCliError(err)).toBe(err)
  })

  it('wraps an unexpected error as command-failed with its message', () => {
    const err = toCliError(new Error('boom'))
    expect(err.code).toBe('command-failed')
    expect(err.message).toBe('boom')
  })

  it('wraps a thrown non-error value as command-failed', () => {
    expect(toCliError('nope')).toMatchObject({ code: 'command-failed', message: 'nope' })
  })
})

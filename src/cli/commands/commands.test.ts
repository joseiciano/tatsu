import { describe, it, expect } from 'vitest'
import { findCommand, type Command } from '.'

function command(name: string): Command {
  return { name, summary: name, usage: name, options: {}, run: () => {} }
}

describe('findCommand', () => {
  const registry = [command('sync'), command('sync plan'), command('status')]

  it('picks the longest space-named prefix of the positionals', () => {
    const match = findCommand(registry, ['sync', 'plan', 'extra'])
    expect(match?.command.name).toBe('sync plan')
    expect(match?.rest).toEqual(['extra'])
  })

  it('falls back to a shorter name when the longer one does not match', () => {
    const match = findCommand(registry, ['sync', 'apply'])
    expect(match?.command.name).toBe('sync')
    expect(match?.rest).toEqual(['apply'])
  })

  it('returns undefined for an unknown command', () => {
    expect(findCommand(registry, ['bogus'])).toBeUndefined()
  })

  it('returns undefined with no positionals', () => {
    expect(findCommand(registry, [])).toBeUndefined()
  })
})

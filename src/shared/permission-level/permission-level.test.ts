import { describe, it, expect } from 'vitest'
import { isPermissionLevel, normalizeAllowEntry, sanitizeBashAllow } from '.'

describe('isPermissionLevel', () => {
  it.each(['read-only', 'edit', 'full'])('accepts %s', (v) => {
    expect(isPermissionLevel(v)).toBe(true)
  })

  it.each([
    { name: 'wrong case', v: 'Full' },
    { name: 'empty string', v: '' },
    { name: 'undefined', v: undefined },
    { name: 'number', v: 1 }
  ])('rejects $name', ({ v }) => {
    expect(isPermissionLevel(v)).toBe(false)
  })
})

describe('sanitizeBashAllow', () => {
  it('trims, de-duplicates in input order and drops unsafe entries', () => {
    expect(
      sanitizeBashAllow([' npm test ', 'npm test', 'git diff', 'a,b', 'rm (x)', "it's", 'x*', '', 'ok\nno'])
    ).toEqual(['npm test', 'git diff'])
  })

  it('returns an empty list for undefined', () => {
    expect(sanitizeBashAllow(undefined)).toEqual([])
  })

  it('accepts the plan allow: list only after normalizeAllowEntry', () => {
    const allow = ['pnpm *', 'git status', 'git diff *']
    expect(sanitizeBashAllow(allow.map(normalizeAllowEntry))).toEqual(['pnpm', 'git status', 'git diff'])
    expect(sanitizeBashAllow(allow)).toEqual(['git status'])
  })
})

describe('normalizeAllowEntry', () => {
  it.each([
    { name: 'strips a trailing " *" from a one-word prefix', input: 'pnpm *', expected: 'pnpm' },
    { name: 'strips a trailing " *" from a multi-word prefix', input: 'git diff *', expected: 'git diff' },
    { name: 'leaves a plain prefix unchanged', input: 'git status', expected: 'git status' },
    { name: 'leaves a bare * unchanged', input: '*', expected: '*' },
    { name: 'leaves a mid-entry * unchanged', input: 'pnpm * x', expected: 'pnpm * x' }
  ])('$name', ({ input, expected }) => {
    expect(normalizeAllowEntry(input)).toBe(expected)
  })
})

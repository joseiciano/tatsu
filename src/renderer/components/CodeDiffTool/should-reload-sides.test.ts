import { describe, expect, it } from 'vitest'
import type { CodeDiffFile } from '../../../shared/code-diff'
import { shouldReloadSides } from './should-reload-sides'

const base: CodeDiffFile = {
  path: 'src/a.ts',
  status: 'modified',
  additions: 3,
  deletions: 1,
  mtimeMs: 1000,
}

describe('shouldReloadSides', () => {
  it('returns false for an equal entry in a new object', () => {
    expect(shouldReloadSides(base, { ...base })).toBe(false)
  })

  it('returns false for the same object', () => {
    expect(shouldReloadSides(base, base)).toBe(false)
  })

  it('returns true when mtimeMs changes', () => {
    expect(shouldReloadSides(base, { ...base, mtimeMs: 2000 })).toBe(true)
  })

  it('returns true when additions change', () => {
    expect(shouldReloadSides(base, { ...base, additions: 4 })).toBe(true)
  })

  it('returns true when deletions change', () => {
    expect(shouldReloadSides(base, { ...base, deletions: 0 })).toBe(true)
  })

  it('returns true when mtimeMs disappears', () => {
    expect(shouldReloadSides(base, { ...base, mtimeMs: undefined })).toBe(true)
  })

  it('returns false when the file is gone from the list', () => {
    expect(shouldReloadSides(base, undefined)).toBe(false)
  })

  it('returns false when there was no previous entry', () => {
    expect(shouldReloadSides(undefined, base)).toBe(false)
  })
})

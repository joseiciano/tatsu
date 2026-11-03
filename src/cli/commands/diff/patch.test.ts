import { describe, it, expect } from 'vitest'
import type { CodeDiffFile, CodeDiffSides } from '../../../shared/code-diff'
import { renderPatch } from '.'

function sides(overrides: Partial<CodeDiffSides> = {}): CodeDiffSides {
  return {
    original: '',
    modified: '',
    originalExists: true,
    modifiedExists: true,
    originalBinary: false,
    modifiedBinary: false,
    originalSize: 0,
    modifiedSize: 0,
    modifiedSymlink: false,
    ...overrides
  }
}

const modified: CodeDiffFile = { path: 'src/a.txt', status: 'modified' }

describe('renderPatch', () => {
  it('renders a modified file as a bare unified diff with a/ and b/ names', () => {
    expect(renderPatch(modified, sides({ original: 'one\ntwo\nthree\n', modified: 'one\nTWO\nthree\n' }))).toBe(
      ['--- a/src/a.txt', '+++ b/src/a.txt', '@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three', ''].join('\n')
    )
  })

  it('marks a missing trailing newline the way git does', () => {
    expect(renderPatch(modified, sides({ original: 'x', modified: 'y' }))).toBe(
      ['--- a/src/a.txt', '+++ b/src/a.txt', '@@ -1,1 +1,1 @@', '-x', '\\ No newline at end of file', '+y', '\\ No newline at end of file', ''].join('\n')
    )
  })

  it('uses /dev/null as the old name for an added file', () => {
    const file: CodeDiffFile = { path: 'new.ts', status: 'added' }
    expect(renderPatch(file, sides({ originalExists: false, modified: 'hi\n' }))).toBe(
      ['--- /dev/null', '+++ b/new.ts', '@@ -0,0 +1,1 @@', '+hi', ''].join('\n')
    )
  })

  it('uses /dev/null as the old name for an untracked file', () => {
    const file: CodeDiffFile = { path: 'scratch.txt', status: 'untracked' }
    expect(renderPatch(file, sides({ originalExists: false, modified: 'a\nb\n' }))).toBe(
      ['--- /dev/null', '+++ b/scratch.txt', '@@ -0,0 +1,2 @@', '+a', '+b', ''].join('\n')
    )
  })

  it('uses /dev/null as the new name for a deleted file', () => {
    const file: CodeDiffFile = { path: 'gone.txt', status: 'deleted' }
    expect(renderPatch(file, sides({ modifiedExists: false, original: 'bye\n' }))).toBe(
      ['--- a/gone.txt', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-bye', ''].join('\n')
    )
  })

  it('names the previous path on the old side of a rename', () => {
    const file: CodeDiffFile = { path: 'new.txt', previousPath: 'old.txt', status: 'renamed' }
    expect(renderPatch(file, sides({ original: 'a\n', modified: 'b\n' }))).toBe(
      ['--- a/old.txt', '+++ b/new.txt', '@@ -1,1 +1,1 @@', '-a', '+b', ''].join('\n')
    )
  })

  it('prints only the header for a rename with identical content', () => {
    const file: CodeDiffFile = { path: 'new.txt', previousPath: 'old.txt', status: 'renamed' }
    expect(renderPatch(file, sides({ original: 'same\n', modified: 'same\n' }))).toBe('--- a/old.txt\n+++ b/new.txt\n')
  })

  it('reports a binary file on one line', () => {
    const file: CodeDiffFile = { path: 'blob.bin', status: 'added' }
    expect(renderPatch(file, sides({ originalExists: false, modifiedBinary: true }))).toBe('Binary files /dev/null and b/blob.bin differ\n')
    expect(renderPatch({ ...file, status: 'modified' }, sides({ originalBinary: true }))).toBe(
      'Binary files a/blob.bin and b/blob.bin differ\n'
    )
  })

  it("writes its own header before a large file's server hunks", () => {
    const hunks = '@@ -1,2 +1,2 @@\n-a\n+b\n c\n'
    expect(renderPatch(modified, sides({ large: { patch: hunks } }))).toBe(`--- a/src/a.txt\n+++ b/src/a.txt\n${hunks}`)
  })

  it('says a large file is too large to diff when the server sent no hunks', () => {
    expect(renderPatch(modified, sides({ large: { patch: null } }))).toBe('src/a.txt: too large to diff\n')
  })

  it("diffs a symlink's link text", () => {
    const file: CodeDiffFile = { path: 'link', status: 'modified' }
    expect(renderPatch(file, sides({ original: 'old-target', modified: 'new-target', modifiedSymlink: true }))).toBe(
      ['--- a/link', '+++ b/link', '@@ -1,1 +1,1 @@', '-old-target', '\\ No newline at end of file', '+new-target', '\\ No newline at end of file', ''].join(
        '\n'
      )
    )
  })
})

import { describe, it, expect } from 'vitest'
import { countLines, isUnsafeRef, parseNameStatusZ, parseNumstatZ } from './code-diff-parse'

describe('parseNameStatusZ', () => {
  it.each([
    { name: 'empty input', input: '', expected: [] },
    {
      name: 'added / modified / deleted',
      input: 'A\0new.txt\0M\0changed.txt\0D\0gone.txt\0',
      expected: [
        { status: 'added', path: 'new.txt' },
        { status: 'modified', path: 'changed.txt' },
        { status: 'deleted', path: 'gone.txt' }
      ]
    },
    {
      name: 'type change maps to modified',
      input: 'T\0link-now-file\0',
      expected: [{ status: 'modified', path: 'link-now-file' }]
    },
    {
      name: 'rename carries old path as previousPath and new path as path',
      input: 'R087\0src/old.ts\0src/new.ts\0',
      expected: [{ status: 'renamed', path: 'src/new.ts', previousPath: 'src/old.ts' }]
    },
    {
      name: 'copy is a rename flagged copied',
      input: 'C100\0src/a.ts\0src/a-copy.ts\0',
      expected: [
        { status: 'renamed', path: 'src/a-copy.ts', previousPath: 'src/a.ts', copied: true }
      ]
    },
    {
      name: 'rename between other entries keeps token alignment',
      input: 'M\0one.txt\0R100\0two.txt\0three.txt\0A\0four.txt\0',
      expected: [
        { status: 'modified', path: 'one.txt' },
        { status: 'renamed', path: 'three.txt', previousPath: 'two.txt' },
        { status: 'added', path: 'four.txt' }
      ]
    },
    {
      name: 'paths with spaces, embedded newlines, and unicode are kept verbatim',
      input: 'M\0dir with space/file name.txt\0A\0line\nbreak.txt\0R050\0café/naïve.md\0日本/ファイル.md\0',
      expected: [
        { status: 'modified', path: 'dir with space/file name.txt' },
        { status: 'added', path: 'line\nbreak.txt' },
        { status: 'renamed', path: '日本/ファイル.md', previousPath: 'café/naïve.md' }
      ]
    },
    {
      name: 'missing trailing NUL still parses the last entry',
      input: 'M\0a.txt\0D\0b.txt',
      expected: [
        { status: 'modified', path: 'a.txt' },
        { status: 'deleted', path: 'b.txt' }
      ]
    }
  ])('$name', ({ input, expected }) => {
    expect(parseNameStatusZ(input)).toEqual(expected)
  })
})

describe('parseNumstatZ', () => {
  it('returns an empty map for empty input', () => {
    expect(parseNumstatZ('').size).toBe(0)
  })

  it('parses counts keyed by path', () => {
    const map = parseNumstatZ('3\t1\ta.txt\0' + '0\t7\tdir/b.txt\0')
    expect(map.get('a.txt')).toEqual({ additions: 3, deletions: 1 })
    expect(map.get('dir/b.txt')).toEqual({ additions: 0, deletions: 7 })
    expect(map.size).toBe(2)
  })

  it('keys renames and copies by the new path, not the old one', () => {
    const map = parseNumstatZ('2\t2\t\0old/name.ts\0new/name.ts\0' + '5\t0\tafter.txt\0')
    expect(map.get('new/name.ts')).toEqual({ additions: 2, deletions: 2 })
    expect(map.has('old/name.ts')).toBe(false)
    expect(map.get('after.txt')).toEqual({ additions: 5, deletions: 0 })
    expect(map.size).toBe(2)
  })

  it('maps binary entries (-\\t-) to null', () => {
    const map = parseNumstatZ('-\t-\timage.png\0' + '1\t0\ttext.txt\0')
    expect(map.has('image.png')).toBe(true)
    expect(map.get('image.png')).toBeNull()
    expect(map.get('text.txt')).toEqual({ additions: 1, deletions: 0 })
  })

  it('maps a binary rename to null under the new path', () => {
    const map = parseNumstatZ('-\t-\t\0a.bin\0b.bin\0')
    expect(map.has('b.bin')).toBe(true)
    expect(map.get('b.bin')).toBeNull()
    expect(map.has('a.bin')).toBe(false)
  })

  it('keeps paths with spaces, embedded newlines, and unicode verbatim', () => {
    const map = parseNumstatZ(
      '1\t1\tdir with space/f.txt\0' + '2\t0\tline\nbreak.txt\0' + '4\t4\t\0café.md\0日本.md\0'
    )
    expect(map.get('dir with space/f.txt')).toEqual({ additions: 1, deletions: 1 })
    expect(map.get('line\nbreak.txt')).toEqual({ additions: 2, deletions: 0 })
    expect(map.get('日本.md')).toEqual({ additions: 4, deletions: 4 })
    expect(map.size).toBe(3)
  })

  it('parses the last entry when the trailing NUL is missing', () => {
    const map = parseNumstatZ('1\t2\ta.txt\0' + '10\t20\tb.txt')
    expect(map.get('b.txt')).toEqual({ additions: 10, deletions: 20 })
    expect(map.size).toBe(2)
  })
})

describe('isUnsafeRef', () => {
  it.each([
    { name: 'empty string', ref: '' },
    { name: 'option injection', ref: '--output=/tmp/x' },
    { name: 'single leading dash', ref: '-n' },
    { name: 'range syntax', ref: 'a..b' },
    { name: 'symmetric range syntax', ref: 'a...b' },
    { name: 'space', ref: 'a b' },
    { name: 'tab', ref: 'a\tb' },
    { name: 'newline', ref: 'main\n' },
    { name: 'NUL', ref: 'ma\0in' },
    { name: 'escape control char', ref: 'ma\x1bin' },
    { name: 'DEL', ref: 'main\x7f' }
  ])('rejects $name', ({ ref }) => {
    expect(isUnsafeRef(ref)).toBe(true)
  })

  it.each([
    { name: 'local branch', ref: 'main' },
    { name: 'remote branch', ref: 'origin/main' },
    { name: 'full tag ref', ref: 'refs/tags/v1.0' },
    { name: 'relative revision', ref: 'HEAD~1' },
    { name: 'branch containing a dash after the start', ref: 'feature/my-branch' },
    { name: 'full sha', ref: '0123456789abcdef0123456789abcdef01234567' }
  ])('accepts $name', ({ ref }) => {
    expect(isUnsafeRef(ref)).toBe(false)
  })
})

describe('countLines', () => {
  it.each([
    { input: '', expected: 0 },
    { input: 'a', expected: 1 },
    { input: 'a\n', expected: 1 },
    { input: 'a\nb', expected: 2 },
    { input: 'a\nb\n', expected: 2 },
    { input: '\n', expected: 1 },
    { input: '\n\n', expected: 2 }
  ])('countLines($input) === $expected', ({ input, expected }) => {
    expect(countLines(input)).toBe(expected)
  })
})

import { execFileSync } from 'child_process'
import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRangeChangedFiles, readBlobAtCommit, resolveCommitRef } from '.'

vi.mock('../perf-log', () => ({
  perfLog: vi.fn(),
  getPerfLogFilePath: vi.fn(() => '/tmp/perf.log')
}))

const fixtureEnv = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: '0',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t'
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: fixtureEnv }).toString().trim()
}

function commitAll(cwd: string, message: string): string {
  git(cwd, ['add', '-A'])
  git(cwd, ['commit', '-q', '--allow-empty', '-m', message])
  return git(cwd, ['rev-parse', 'HEAD'])
}

let root: string
let repo: string

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'tatsu-worktree-range-'))
  repo = join(root, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: fixtureEnv })
  git(repo, ['config', 'commit.gpgsign', 'false'])
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('getRangeChangedFiles', () => {
  it('lists added, modified and deleted files with line counts, binary files without counts', async () => {
    writeFileSync(join(repo, 'keep.txt'), 'one\ntwo\n')
    writeFileSync(join(repo, 'gone.txt'), 'bye\n')
    writeFileSync(join(repo, 'HEAD'), 'a file named HEAD\n')
    const base = commitAll(repo, 'base')
    writeFileSync(join(repo, 'keep.txt'), 'one\nTWO\nthree\n')
    unlinkSync(join(repo, 'gone.txt'))
    writeFileSync(join(repo, 'with space "q".txt'), 'new\n')
    writeFileSync(join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255]))
    const head = commitAll(repo, 'head')

    const result = await getRangeChangedFiles({ worktreePath: repo, base, head, maxFiles: 50 })

    expect(result.truncated).toBe(false)
    expect(result.files).toEqual([
      { path: 'blob.bin', status: 'added', additions: null, deletions: null },
      { path: 'gone.txt', status: 'deleted', additions: 0, deletions: 1 },
      { path: 'keep.txt', status: 'modified', additions: 2, deletions: 1 },
      { path: 'with space "q".txt', status: 'added', additions: 1, deletions: 0 }
    ])
  })

  it('caps the list and reports truncation', async () => {
    const base = commitAll(repo, 'base')
    for (let i = 0; i < 5; i++) writeFileSync(join(repo, `f${i}.txt`), `${i}\n`)
    const head = commitAll(repo, 'head')

    const result = await getRangeChangedFiles({ worktreePath: repo, base, head, maxFiles: 3 })

    expect(result.truncated).toBe(true)
    expect(result.files.map((f) => f.path)).toEqual(['f0.txt', 'f1.txt', 'f2.txt'])
  })

  it('returns no files for identical commits', async () => {
    const base = commitAll(repo, 'base')
    expect(await getRangeChangedFiles({ worktreePath: repo, base, head: base, maxFiles: 10 })).toEqual({
      files: [],
      truncated: false
    })
  })

  it('rejects revisions that are not full object ids and fails on unknown objects', async () => {
    const base = commitAll(repo, 'base')
    await expect(getRangeChangedFiles({ worktreePath: repo, base: 'HEAD', head: base, maxFiles: 10 })).rejects.toThrow()
    await expect(
      getRangeChangedFiles({ worktreePath: repo, base, head: '0'.repeat(40), maxFiles: 10 })
    ).rejects.toThrow()
  })
})

describe('readBlobAtCommit', () => {
  it('reads a file, reports a missing path and refuses a file over the byte cap', async () => {
    writeFileSync(join(repo, 'small.txt'), 'hello\n')
    writeFileSync(join(repo, 'big.txt'), 'x'.repeat(2048))
    const commit = commitAll(repo, 'base')

    expect(await readBlobAtCommit({ worktreePath: repo, commit, path: 'small.txt', maxBytes: 1024 })).toEqual({
      kind: 'ok',
      text: 'hello\n'
    })
    expect(await readBlobAtCommit({ worktreePath: repo, commit, path: 'nope.txt', maxBytes: 1024 })).toEqual({
      kind: 'missing'
    })
    expect(await readBlobAtCommit({ worktreePath: repo, commit, path: 'big.txt', maxBytes: 1024 })).toEqual({
      kind: 'too-large'
    })
  })
})

describe('resolveCommitRef', () => {
  it('resolves an existing ref to its commit and returns null for a missing one', async () => {
    const commit = commitAll(repo, 'base')
    git(repo, ['update-ref', 'refs/harness/runs/r1/s1/0', commit])

    expect(await resolveCommitRef({ worktreePath: repo, ref: 'refs/harness/runs/r1/s1/0' })).toBe(commit)
    expect(await resolveCommitRef({ worktreePath: repo, ref: 'refs/harness/runs/r1/s1/9' })).toBeNull()
  })
})

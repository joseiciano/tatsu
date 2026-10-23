import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  fetchCompareRef,
  getCodeDiffFiles,
  getCodeDiffFileSides,
  listBranchesForCompare,
  resolveDefaultCompareRef,
  validateRef
} from '.'
import { CODE_DIFF_MAX_FILES, MAX_FILE_READ_BYTES } from './constants'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t'
    }
  }).toString()
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  git(dir, ['config', 'tag.gpgsign', 'false'])
}

function commitFile(repo: string, path: string, content: string | Buffer, message: string): void {
  writeFileSync(join(repo, path), content)
  git(repo, ['add', '--', path])
  git(repo, ['commit', '-q', '-m', message])
}

function sha(repo: string, rev: string): string {
  return git(repo, ['rev-parse', rev]).trim()
}

let root: string
let repo: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'harness-code-diff-'))
  repo = join(root, 'r')
  initRepo(repo)
  commitFile(repo, 'base.txt', 'base\n', 'base')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('validateRef', () => {
  it.each([
    { name: 'option injection', ref: '--output=PLACEHOLDER' },
    { name: 'range syntax', ref: 'main..HEAD' },
    { name: 'empty string', ref: '' }
  ])('rejects $name without touching git side effects', async ({ ref }) => {
    const sideEffect = join(root, 'injected-output')
    const input = ref.replace('PLACEHOLDER', sideEffect)

    const result = await validateRef(repo, input)

    expect(result.ok).toBe(false)
    expect(existsSync(sideEffect)).toBe(false)
  })

  it('rejects a ref that does not exist', async () => {
    const result = await validateRef(repo, 'does-not-exist')
    expect(result.ok).toBe(false)
  })

  it('resolves a local branch to its full ref name', async () => {
    const result = await validateRef(repo, 'main')
    expect(result).toEqual({
      ok: true,
      type: 'branch',
      ref: 'refs/heads/main',
      sha: sha(repo, 'main')
    })
  })

  it('resolves an annotated tag to the peeled commit sha, not the tag object', async () => {
    git(repo, ['tag', '-a', 'v1.0', '-m', 'release'])
    const tagObject = sha(repo, 'refs/tags/v1.0')
    const commit = sha(repo, 'refs/tags/v1.0^{commit}')
    expect(tagObject).not.toBe(commit)

    const result = await validateRef(repo, 'v1.0')

    expect(result).toEqual({ ok: true, type: 'tag', ref: 'refs/tags/v1.0', sha: commit })
  })

  it('prefers the tag when a name is both a branch and a tag', async () => {
    git(repo, ['branch', 'dup'])
    commitFile(repo, 'second.txt', 'second\n', 'second')
    git(repo, ['tag', 'dup'])
    const tagCommit = sha(repo, 'refs/tags/dup')
    expect(tagCommit).not.toBe(sha(repo, 'refs/heads/dup'))

    const result = await validateRef(repo, 'dup')

    expect(result).toEqual({ ok: true, type: 'tag', ref: 'refs/tags/dup', sha: tagCommit })
  })

  it('resolves a relative revision to a commit with the full sha as ref', async () => {
    commitFile(repo, 'second.txt', 'second\n', 'second')
    const parent = sha(repo, 'HEAD~1')

    const result = await validateRef(repo, 'HEAD~1')

    expect(result).toEqual({ ok: true, type: 'commit', ref: parent, sha: parent })
    expect(parent).toMatch(/^[0-9a-f]{40}$/)
  })

  it('resolves a remote-tracking branch as a branch with its full ref', async () => {
    const upstream = join(root, 'upstream')
    initRepo(upstream)
    commitFile(upstream, 'u.txt', 'u\n', 'upstream')
    git(repo, ['remote', 'add', 'origin', upstream])
    git(repo, ['fetch', '-q', 'origin'])

    const result = await validateRef(repo, 'origin/main')

    expect(result).toEqual({
      ok: true,
      type: 'branch',
      ref: 'refs/remotes/origin/main',
      sha: sha(upstream, 'main')
    })
  })
})

describe('listBranchesForCompare', () => {
  it('lists local branches, remote branches, and tags by short name with their source', async () => {
    git(repo, ['branch', 'feature'])
    git(repo, ['tag', '-a', 'v1.0', '-m', 'release'])
    const upstream = join(root, 'upstream')
    initRepo(upstream)
    commitFile(upstream, 'u.txt', 'u\n', 'upstream')
    git(repo, ['remote', 'add', 'origin', upstream])
    git(repo, ['fetch', '-q', 'origin'])
    git(repo, ['remote', 'set-head', 'origin', 'main'])

    const branches = await listBranchesForCompare(repo)

    expect(branches).toContainEqual({ name: 'main', source: 'local' })
    expect(branches).toContainEqual({ name: 'feature', source: 'local' })
    expect(branches).toContainEqual({ name: 'origin/main', source: 'remote' })
    expect(branches).toContainEqual({ name: 'v1.0', source: 'tag' })
    expect(branches).toHaveLength(4)
    expect(branches.map((b) => b.name)).not.toContain('origin/HEAD')
    expect(branches.map((b) => b.name)).not.toContain('origin')
  })
})

describe('resolveDefaultCompareRef', () => {
  it('uses origin/main as a fetchable full ref when it exists', async () => {
    const upstream = join(root, 'upstream')
    initRepo(upstream)
    commitFile(upstream, 'u.txt', 'u\n', 'upstream')
    git(repo, ['remote', 'add', 'origin', upstream])
    git(repo, ['fetch', '-q', 'origin'])

    const result = await resolveDefaultCompareRef(repo)

    expect(result).toEqual({ ref: 'refs/remotes/origin/main', fetchable: true })
  })

  it('falls back to origin/master and keeps it fetchable when origin has no main', async () => {
    const upstream = join(root, 'upstream')
    mkdirSync(upstream)
    git(upstream, ['init', '-q', '-b', 'master'])
    git(upstream, ['config', 'commit.gpgsign', 'false'])
    commitFile(upstream, 'u.txt', 'u\n', 'upstream')
    git(repo, ['remote', 'add', 'origin', upstream])
    git(repo, ['fetch', '-q', 'origin'])

    const result = await resolveDefaultCompareRef(repo)

    expect(result).toEqual({ ref: 'refs/remotes/origin/master', fetchable: true })
  })

  it('falls back to the local branch as a non-fetchable full ref when there is no remote', async () => {
    const result = await resolveDefaultCompareRef(repo)

    expect(result).toEqual({ ref: 'refs/heads/main', fetchable: false })
  })

  it('returns a ref that getCodeDiffFiles echoes back as baseRef when there is no remote and no main or master', async () => {
    git(repo, ['branch', '-m', 'main', 'trunk'])

    const resolved = await resolveDefaultCompareRef(repo)
    const list = await getCodeDiffFiles(repo, resolved.ref)

    expect(list.error).toBeUndefined()
    expect(list.baseRef).toBe(resolved.ref)
    expect(resolved).toEqual({ ref: sha(repo, 'HEAD'), fetchable: false })
  })
})

describe('getCodeDiffFiles', () => {
  it('omits a file whose committed change is reverted in the working tree', async () => {
    git(repo, ['checkout', '-q', '-b', 'feature'])
    commitFile(repo, 'base.txt', 'changed on branch\n', 'change')
    writeFileSync(join(repo, 'base.txt'), 'base\n')

    const result = await getCodeDiffFiles(repo, 'main')

    expect(result.error).toBeUndefined()
    expect(result.files.map((f) => f.path)).not.toContain('base.txt')
    expect(result.isWorktreeDirty).toBe(true)
  })

  it('folds committed, staged, unstaged, and untracked changes into one list', async () => {
    commitFile(repo, 'committed.txt', 'one\n', 'c')
    commitFile(repo, 'staged.txt', 'one\n', 's')
    commitFile(repo, 'unstaged.txt', 'one\n', 'u')
    commitFile(repo, 'doomed.txt', 'one\n', 'd')
    git(repo, ['checkout', '-q', '-b', 'feature'])
    commitFile(repo, 'committed.txt', 'one\ntwo\n', 'edit')
    commitFile(repo, 'added.txt', 'a\nb\n', 'add')
    git(repo, ['rm', '-q', 'doomed.txt'])
    git(repo, ['commit', '-q', '-m', 'delete'])
    writeFileSync(join(repo, 'staged.txt'), 'one\ntwo\nthree\n')
    git(repo, ['add', 'staged.txt'])
    writeFileSync(join(repo, 'staged-new.txt'), 'x\n')
    git(repo, ['add', 'staged-new.txt'])
    writeFileSync(join(repo, 'unstaged.txt'), 'changed\n')
    writeFileSync(join(repo, 'untracked.txt'), 'l1\nl2\nl3\n')

    const result = await getCodeDiffFiles(repo, 'main')
    const byPath = new Map(result.files.map((f) => [f.path, f]))

    expect(result.error).toBeUndefined()
    expect(byPath.get('committed.txt')).toMatchObject({ status: 'modified', additions: 1, deletions: 0 })
    expect(byPath.get('added.txt')).toMatchObject({ status: 'added', additions: 2, deletions: 0 })
    expect(byPath.get('doomed.txt')).toMatchObject({ status: 'deleted', additions: 0, deletions: 1 })
    expect(byPath.get('staged.txt')).toMatchObject({ status: 'modified', additions: 2, deletions: 0 })
    expect(byPath.get('staged-new.txt')).toMatchObject({ status: 'added', additions: 1 })
    expect(byPath.get('unstaged.txt')).toMatchObject({ status: 'modified', additions: 1, deletions: 1 })
    expect(byPath.get('untracked.txt')).toMatchObject({ status: 'untracked', additions: 3 })
    expect(result.files).toHaveLength(7)
    expect(result.totalFiles).toBe(7)
    expect(result.totalAdditions).toBe(1 + 2 + 0 + 2 + 1 + 1 + 3)
    expect(result.totalDeletions).toBe(0 + 0 + 1 + 0 + 0 + 1 + 0)
  })

  it('sets mtimeMs for files on disk and leaves it undefined for deleted files', async () => {
    commitFile(repo, 'doomed.txt', 'one\n', 'd')
    git(repo, ['checkout', '-q', '-b', 'feature'])
    commitFile(repo, 'base.txt', 'edited\n', 'edit')
    git(repo, ['rm', '-q', 'doomed.txt'])
    git(repo, ['commit', '-q', '-m', 'delete'])
    writeFileSync(join(repo, 'untracked.txt'), 'x\n')

    const result = await getCodeDiffFiles(repo, 'main')
    const byPath = new Map(result.files.map((f) => [f.path, f]))

    expect(byPath.get('base.txt')?.mtimeMs).toBeGreaterThan(0)
    expect(byPath.get('untracked.txt')?.mtimeMs).toBeGreaterThan(0)
    expect(byPath.get('doomed.txt')?.status).toBe('deleted')
    expect(byPath.get('doomed.txt')?.mtimeMs).toBeUndefined()
  })

  it('reports a rename with its previous path', async () => {
    commitFile(repo, 'old-name.txt', 'line 1\nline 2\nline 3\nline 4\n', 'add')
    git(repo, ['checkout', '-q', '-b', 'feature'])
    git(repo, ['mv', 'old-name.txt', 'new-name.txt'])
    git(repo, ['commit', '-q', '-m', 'rename'])

    const result = await getCodeDiffFiles(repo, 'main')

    expect(result.files).toEqual([
      expect.objectContaining({ path: 'new-name.txt', status: 'renamed', previousPath: 'old-name.txt' })
    ])
  })

  it('returns the resolved full base ref, merge-base, and head branch', async () => {
    git(repo, ['checkout', '-q', '-b', 'feature'])
    commitFile(repo, 'f.txt', 'f\n', 'f')

    const result = await getCodeDiffFiles(repo, 'main')

    expect(result.baseRef).toBe('refs/heads/main')
    expect(result.mergeBase).toBe(sha(repo, 'main'))
    expect(result.headRef).toBe('feature')
  })

  it('diffs against the merge-base, not the current tip of the base', async () => {
    git(repo, ['checkout', '-q', '-b', 'feature'])
    commitFile(repo, 'feature.txt', 'f\n', 'feature work')
    git(repo, ['checkout', '-q', 'main'])
    commitFile(repo, 'main-only.txt', 'm\n', 'main moves on')
    git(repo, ['checkout', '-q', 'feature'])

    const result = await getCodeDiffFiles(repo, 'main')

    expect(result.files.map((f) => f.path)).toEqual(['feature.txt'])
  })

  it('reports isWorktreeDirty false for committed-only changes and true once something is untracked', async () => {
    git(repo, ['checkout', '-q', '-b', 'feature'])
    commitFile(repo, 'f.txt', 'f\n', 'f')

    const clean = await getCodeDiffFiles(repo, 'main')
    writeFileSync(join(repo, 'scratch.txt'), 'x\n')
    const dirty = await getCodeDiffFiles(repo, 'main')

    expect(clean.isWorktreeDirty).toBe(false)
    expect(dirty.isWorktreeDirty).toBe(true)
  })

  it('returns no-merge-base when the base shares no history with HEAD', async () => {
    git(repo, ['checkout', '-q', '--orphan', 'unrelated'])
    git(repo, ['rm', '-rf', '-q', '.'])
    commitFile(repo, 'other.txt', 'other\n', 'unrelated root')
    git(repo, ['checkout', '-q', 'main'])

    const result = await getCodeDiffFiles(repo, 'unrelated')

    expect(result.error).toBe('no-merge-base')
    expect(result.files).toEqual([])
  })

  it('returns invalid-ref for a ref that does not resolve', async () => {
    const result = await getCodeDiffFiles(repo, 'does-not-exist')

    expect(result.error).toBe('invalid-ref')
    expect(result.files).toEqual([])
  })

  it('returns invalid-ref for an option-shaped ref', async () => {
    const result = await getCodeDiffFiles(repo, `--output=${join(root, 'x')}`)

    expect(result.error).toBe('invalid-ref')
    expect(existsSync(join(root, 'x'))).toBe(false)
  })

  it(
    'caps the file list but computes totals over every file',
    async () => {
      const count = CODE_DIFF_MAX_FILES + 5
      for (let i = 0; i < count; i++) {
        writeFileSync(join(repo, `file-${String(i).padStart(5, '0')}.txt`), `line ${i}\n`)
      }

      const result = await getCodeDiffFiles(repo, 'main')

      expect(result.files).toHaveLength(CODE_DIFF_MAX_FILES)
      expect(result.totalFiles).toBe(count)
      expect(result.totalAdditions).toBe(count)
    },
    30000
  )
})

describe('getCodeDiffFileSides', () => {
  it('returns base content as original and working-tree content as modified', async () => {
    commitFile(repo, 'f.txt', 'before\n', 'add')
    git(repo, ['checkout', '-q', '-b', 'feature'])
    commitFile(repo, 'f.txt', 'committed\n', 'edit')
    writeFileSync(join(repo, 'f.txt'), 'working tree\n')

    const sides = await getCodeDiffFileSides(repo, 'main', 'f.txt')

    expect(sides).toMatchObject({
      original: 'before\n',
      modified: 'working tree\n',
      originalExists: true,
      modifiedExists: true,
      originalBinary: false,
      modifiedBinary: false,
      originalTruncated: false,
      modifiedTruncated: false,
      modifiedSymlink: false
    })
    expect(sides.error).toBeUndefined()
  })

  it('refuses a path that escapes the worktree and does not read it', async () => {
    writeFileSync(join(root, 'outside.txt'), 'outside secret\n')

    const sides = await getCodeDiffFileSides(repo, 'main', '../outside.txt')

    expect(sides.error).toBeTruthy()
    expect(sides.modified).toBe('')
    expect(sides.original).toBe('')
  })

  it('shows a symlink as its link text and never reads the target', async () => {
    const secretPath = join(root, 'secret.txt')
    writeFileSync(secretPath, 'TOP SECRET CONTENT\n')
    symlinkSync(secretPath, join(repo, 'link'))

    const sides = await getCodeDiffFileSides(repo, 'main', 'link')

    expect(sides.modifiedSymlink).toBe(true)
    expect(sides.modifiedExists).toBe(true)
    expect(sides.modified).toBe(secretPath)
    expect(JSON.stringify(sides)).not.toContain('TOP SECRET')
  })

  it('truncates an original blob larger than the read cap', async () => {
    const bigSize = MAX_FILE_READ_BYTES + 1024 * 1024
    commitFile(repo, 'big.txt', 'a'.repeat(bigSize), 'big')
    git(repo, ['checkout', '-q', '-b', 'feature'])
    commitFile(repo, 'big.txt', 'small now\n', 'shrink')

    const sides = await getCodeDiffFileSides(repo, 'main', 'big.txt')

    expect(sides.originalExists).toBe(true)
    expect(sides.originalTruncated).toBe(true)
    expect(sides.original.length).toBe(MAX_FILE_READ_BYTES)
    expect(sides.originalSize).toBe(bigSize)
    expect(sides.modified).toBe('small now\n')
    expect(sides.modifiedTruncated).toBe(false)
  })

  it('flags binary content on both sides', async () => {
    commitFile(repo, 'blob.bin', Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]), 'bin')
    git(repo, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(repo, 'blob.bin'), Buffer.from([0x00, 0xff, 0x00, 0xfe]))

    const sides = await getCodeDiffFileSides(repo, 'main', 'blob.bin')

    expect(sides.originalBinary).toBe(true)
    expect(sides.modifiedBinary).toBe(true)
    expect(sides.originalExists).toBe(true)
    expect(sides.modifiedExists).toBe(true)
  })

  it('reports a deleted file as missing on the modified side', async () => {
    commitFile(repo, 'gone.txt', 'was here\n', 'add')
    git(repo, ['checkout', '-q', '-b', 'feature'])
    unlinkSync(join(repo, 'gone.txt'))

    const sides = await getCodeDiffFileSides(repo, 'main', 'gone.txt')

    expect(sides.originalExists).toBe(true)
    expect(sides.original).toBe('was here\n')
    expect(sides.modifiedExists).toBe(false)
    expect(sides.modified).toBe('')
  })

  it('reports an untracked file as missing on the original side', async () => {
    writeFileSync(join(repo, 'fresh.txt'), 'brand new\n')

    const sides = await getCodeDiffFileSides(repo, 'main', 'fresh.txt')

    expect(sides.originalExists).toBe(false)
    expect(sides.original).toBe('')
    expect(sides.modifiedExists).toBe(true)
    expect(sides.modified).toBe('brand new\n')
  })

  it('reads the original side from previousPath for a rename', async () => {
    commitFile(repo, 'old.txt', 'line 1\nline 2\nline 3\n', 'add')
    git(repo, ['checkout', '-q', '-b', 'feature'])
    git(repo, ['mv', 'old.txt', 'new.txt'])
    writeFileSync(join(repo, 'new.txt'), 'line 1\nline 2\nline 3 edited\n')

    const sides = await getCodeDiffFileSides(repo, 'main', 'new.txt', 'old.txt')

    expect(sides.originalExists).toBe(true)
    expect(sides.original).toBe('line 1\nline 2\nline 3\n')
    expect(sides.modified).toBe('line 1\nline 2\nline 3 edited\n')
  })
})

describe('fetchCompareRef', () => {
  let savedTrace: string | undefined

  beforeEach(() => {
    savedTrace = process.env.GIT_TRACE
  })

  afterEach(() => {
    if (savedTrace === undefined) delete process.env.GIT_TRACE
    else process.env.GIT_TRACE = savedTrace
  })

  function addFileOrigin(): string {
    const upstream = join(root, 'upstream')
    initRepo(upstream)
    commitFile(upstream, 'u.txt', 'u1\n', 'upstream 1')
    git(repo, ['remote', 'add', 'origin', `file://${upstream}`])
    git(repo, ['fetch', '-q', 'origin'])
    return upstream
  }

  it('returns ok false instead of throwing when there is no origin remote', async () => {
    const result = await fetchCompareRef(repo, 'refs/remotes/origin/main')

    expect(result.ok).toBe(false)
  })

  it('refuses refs that are not origin remote-tracking branches', async () => {
    const upstream = addFileOrigin()
    const before = sha(repo, 'refs/remotes/origin/main')
    commitFile(upstream, 'u.txt', 'u2\n', 'upstream 2')

    const result = await fetchCompareRef(repo, 'refs/heads/main')

    expect(result.ok).toBe(false)
    expect(sha(repo, 'refs/remotes/origin/main')).toBe(before)
  })

  it('updates the remote-tracking ref to the origin tip on success', async () => {
    const upstream = addFileOrigin()
    commitFile(upstream, 'u.txt', 'u2\n', 'upstream 2')
    const newTip = sha(upstream, 'main')
    expect(sha(repo, 'refs/remotes/origin/main')).not.toBe(newTip)

    const result = await fetchCompareRef(repo, 'refs/remotes/origin/main')

    expect(result).toMatchObject({ ok: true })
    expect(sha(repo, 'refs/remotes/origin/main')).toBe(newTip)
  })

  it('joins concurrent fetches of the same ref into a single git fetch', async () => {
    const upstream = addFileOrigin()
    commitFile(upstream, 'u.txt', 'u2\n', 'upstream 2')
    const tracePath = join(root, 'git-trace.log')
    process.env.GIT_TRACE = tracePath

    const [a, b] = await Promise.all([
      fetchCompareRef(repo, 'refs/remotes/origin/main'),
      fetchCompareRef(repo, 'refs/remotes/origin/main')
    ])

    delete process.env.GIT_TRACE
    const fetchLines = readFileSync(tracePath, 'utf8')
      .split('\n')
      .filter((line) => /built-in: git fetch/.test(line))
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(fetchLines).toHaveLength(1)
    expect(sha(repo, 'refs/remotes/origin/main')).toBe(sha(upstream, 'main'))
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  deleteRunRefs,
  ensureRunsExcluded,
  restoreSnapshot,
  snapshotRefName,
  takeSnapshot
} from '.'

const fixtureEnv = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: '0',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t'
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: fixtureEnv }).toString()
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.name', 't'])
  git(dir, ['config', 'user.email', 't@t'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(dir, '.gitignore'), 'ignored.log\n')
  writeFileSync(join(dir, 'tracked.txt'), 'base\n')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'keep.ts'), 'keep\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'base'])
}

function lsTree(cwd: string, rev: string): string[] {
  return git(cwd, ['ls-tree', '-r', '--name-only', rev]).trim().split('\n').filter(Boolean)
}

function refs(cwd: string): string[] {
  return git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/harness/'])
    .trim()
    .split('\n')
    .filter(Boolean)
}

function workingFiles(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (rel === '.git' || rel === '.harness/runs') continue
    if (entry.isDirectory()) out.push(...workingFiles(dir, rel))
    else out.push(rel)
  }
  return out.sort()
}

describe('workflow-snapshots', () => {
  let root: string
  let repo: string

  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), 'tatsu-snapshots-test-'))
    repo = join(root, 'repo')
    initRepo(repo)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  describe('snapshotRefName', () => {
    it('builds refs under refs/harness/runs', () => {
      expect(snapshotRefName({ runId: 'run-1', stepId: 'build_2', n: 3 })).toBe(
        'refs/harness/runs/run-1/build_2/3'
      )
    })

    it.each([
      ['', 'step', 0],
      ['..', 'step', 0],
      ['a/b', 'step', 0],
      ['run', 'a..b', 0],
      ['run', 'x.lock', 0],
      ['run', '-step', 0],
      ['run', 'step name', 0],
      ['run', 'step', -1],
      ['run', 'step', 1.5],
      ['run', 'step', Number.NaN]
    ])('rejects runId=%j stepId=%j n=%j', (runId, stepId, n) => {
      expect(() => snapshotRefName({ runId, stepId, n })).toThrow()
    })
  })

  describe('takeSnapshot', () => {
    it('records tracked edits and untracked files but not ignored files, without touching git state', async () => {
      writeFileSync(join(repo, 'tracked.txt'), 'edited\n')
      writeFileSync(join(repo, 'untracked.txt'), 'new\n')
      writeFileSync(join(repo, 'ignored.log'), 'noise\n')
      git(repo, ['status', '--porcelain'])

      const indexPath = join(repo, '.git', 'index')
      const headBefore = git(repo, ['rev-parse', 'HEAD'])
      const branchBefore = git(repo, ['symbolic-ref', 'HEAD'])
      const indexBefore = readFileSync(indexPath)
      const statusBefore = git(repo, ['status', '--porcelain'])

      const snap = await takeSnapshot({ worktree: repo, runId: 'r1', stepId: 'build', n: 0 })

      const indexAfter = readFileSync(indexPath)
      expect(indexAfter.equals(indexBefore)).toBe(true)
      expect(git(repo, ['status', '--porcelain'])).toBe(statusBefore)
      expect(git(repo, ['rev-parse', 'HEAD'])).toBe(headBefore)
      expect(git(repo, ['symbolic-ref', 'HEAD'])).toBe(branchBefore)
      expect(git(repo, ['stash', 'list'])).toBe('')

      expect(snap.ref).toBe('refs/harness/runs/r1/build/0')
      expect(git(repo, ['rev-parse', snap.ref]).trim()).toBe(snap.commit)
      expect(git(repo, ['rev-parse', `${snap.commit}^{tree}`]).trim()).toBe(snap.tree)
      expect(lsTree(repo, snap.commit)).toEqual([
        '.gitignore',
        'src/keep.ts',
        'tracked.txt',
        'untracked.txt'
      ])
      expect(git(repo, ['show', `${snap.commit}:tracked.txt`])).toBe('edited\n')
    })

    it('excludes .harness/runs and keeps tracked files that match an ignore rule', async () => {
      writeFileSync(join(repo, 'forced.log'), 'forced\n')
      git(repo, ['add', '-f', 'forced.log'])
      git(repo, ['commit', '-q', '-m', 'forced'])
      writeFileSync(join(repo, '.gitignore'), 'ignored.log\n*.log\n')
      mkdirSync(join(repo, '.harness', 'runs', 'r1'), { recursive: true })
      writeFileSync(join(repo, '.harness', 'runs', 'r1', 'out.txt'), 'artifact\n')

      const snap = await takeSnapshot({ worktree: repo, runId: 'r1', stepId: 's', n: 0 })

      const files = lsTree(repo, snap.commit)
      expect(files).toContain('forced.log')
      expect(files.some((f) => f.startsWith('.harness/runs'))).toBe(false)
    })

    it('chains to the previous snapshot and uses its own identity', async () => {
      const first = await takeSnapshot({ worktree: repo, runId: 'r1', stepId: 's', n: 0 })
      writeFileSync(join(repo, 'tracked.txt'), 'two\n')
      const second = await takeSnapshot({
        worktree: repo,
        runId: 'r1',
        stepId: 's',
        n: 1,
        parent: first.commit
      })
      expect(git(repo, ['rev-parse', `${second.commit}^`]).trim()).toBe(first.commit)
      expect(git(repo, ['log', '-1', '--format=%an <%ae>|%cn <%ce>', second.commit]).trim()).toBe(
        'Tatsu <tatsu@localhost>|Tatsu <tatsu@localhost>'
      )
    })

    it('works in a repo with no commits yet', async () => {
      const fresh = join(root, 'fresh')
      mkdirSync(fresh)
      git(fresh, ['init', '-q', '-b', 'main'])
      writeFileSync(join(fresh, 'a.txt'), 'a\n')
      const snap = await takeSnapshot({ worktree: fresh, runId: 'r1', stepId: 's', n: 0 })
      expect(lsTree(fresh, snap.commit)).toEqual(['a.txt'])
    })

    it('rejects a malformed parent and a path that is not the worktree root', async () => {
      await expect(
        takeSnapshot({ worktree: repo, runId: 'r1', stepId: 's', n: 0, parent: '--output=x' })
      ).rejects.toThrow()
      await expect(
        takeSnapshot({ worktree: join(repo, 'src'), runId: 'r1', stepId: 's', n: 0 })
      ).rejects.toThrow(/Not a worktree root/)
      expect(refs(repo)).toEqual([])
    })
  })

  describe('ensureRunsExcluded', () => {
    it('appends .harness/runs/ to info/exclude exactly once', async () => {
      const exclude = join(repo, '.git', 'info', 'exclude')
      writeFileSync(exclude, '# existing\nfoo')
      await ensureRunsExcluded(repo)
      await ensureRunsExcluded(repo)
      expect(readFileSync(exclude, 'utf8')).toBe('# existing\nfoo\n.harness/runs/\n')
      expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('ignored.log\n')

      mkdirSync(join(repo, '.harness', 'runs'), { recursive: true })
      writeFileSync(join(repo, '.harness', 'runs', 'x'), 'x\n')
      expect(git(repo, ['status', '--porcelain'])).toBe('')
    })

    it('creates info/exclude when it is missing', async () => {
      rmSync(join(repo, '.git', 'info'), { recursive: true, force: true })
      await ensureRunsExcluded(repo)
      expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toBe('.harness/runs/\n')
    })

    it('does not double-append under concurrent calls', async () => {
      await Promise.all([ensureRunsExcluded(repo), ensureRunsExcluded(repo)])
      const content = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')
      expect(content.split('\n').filter((l) => l === '.harness/runs/')).toHaveLength(1)
    })
  })

  describe('linked worktree', () => {
    let linked: string

    beforeEach(() => {
      linked = join(root, 'linked')
      git(repo, ['worktree', 'add', '-q', '-b', 'feature', linked])
    })

    it('writes the exclude into the common dir once across two calls', async () => {
      expect(readFileSync(join(linked, '.git'), 'utf8')).toMatch(/^gitdir:/)
      const exclude = join(repo, '.git', 'info', 'exclude')
      const before = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
      await ensureRunsExcluded(linked)
      await ensureRunsExcluded(linked)
      await ensureRunsExcluded(repo)
      const after = readFileSync(exclude, 'utf8')
      expect(after.slice(0, before.length)).toBe(before)
      expect(after.split('\n').filter((l) => l === '.harness/runs/')).toHaveLength(1)
      expect(existsSync(join(linked, '.gitignore'))).toBe(true)
      expect(readFileSync(join(linked, '.gitignore'), 'utf8')).toBe('ignored.log\n')

      mkdirSync(join(linked, '.harness', 'runs'), { recursive: true })
      writeFileSync(join(linked, '.harness', 'runs', 'x'), 'x\n')
      expect(git(linked, ['status', '--porcelain'])).toBe('')
    })

    it('snapshots, restores and deletes refs the same way', async () => {
      const head = git(linked, ['rev-parse', 'HEAD'])
      writeFileSync(join(linked, 'linked.txt'), 'linked\n')
      const snap = await takeSnapshot({ worktree: linked, runId: 'r1', stepId: 's', n: 0 })
      expect(lsTree(linked, snap.commit)).toContain('linked.txt')
      expect(git(repo, ['rev-parse', snap.ref]).trim()).toBe(snap.commit)

      writeFileSync(join(linked, 'extra.txt'), 'extra\n')
      unlinkSync(join(linked, 'linked.txt'))
      await restoreSnapshot(linked, snap.commit)
      expect(existsSync(join(linked, 'extra.txt'))).toBe(false)
      expect(readFileSync(join(linked, 'linked.txt'), 'utf8')).toBe('linked\n')
      expect(git(linked, ['rev-parse', 'HEAD'])).toBe(head)
      expect(git(linked, ['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/feature')

      expect(await deleteRunRefs(linked, 'r1')).toBe(1)
      expect(refs(repo)).toEqual([])
    })
  })

  describe('restoreSnapshot', () => {
    it('returns the working tree to the snapshot without touching HEAD, branch or index', async () => {
      writeFileSync(join(repo, 'tracked.txt'), 'snapshot\n')
      writeFileSync(join(repo, 'untracked.txt'), 'untracked\n')
      mkdirSync(join(repo, 'src', 'deep'), { recursive: true })
      writeFileSync(join(repo, 'src', 'deep', 'nested.ts'), 'nested\n')
      writeFileSync(join(repo, 'ignored.log'), 'ignored\n')
      const snap = await takeSnapshot({ worktree: repo, runId: 'r1', stepId: 's', n: 0 })
      const expectedFiles = workingFiles(repo)

      writeFileSync(join(repo, 'tracked.txt'), 'later edit\n')
      unlinkSync(join(repo, 'untracked.txt'))
      unlinkSync(join(repo, 'src', 'deep', 'nested.ts'))
      writeFileSync(join(repo, 'src', 'keep.ts'), 'changed\n')
      writeFileSync(join(repo, 'brand-new.txt'), 'new\n')
      mkdirSync(join(repo, 'made', 'deeper'), { recursive: true })
      writeFileSync(join(repo, 'made', 'deeper', 'file.txt'), 'deep\n')
      mkdirSync(join(repo, '.harness', 'runs'), { recursive: true })
      writeFileSync(join(repo, '.harness', 'runs', 'x'), 'artifact\n')

      git(repo, ['status', '--porcelain'])
      const indexPath = join(repo, '.git', 'index')
      const indexBefore = readFileSync(indexPath)
      const headBefore = git(repo, ['rev-parse', 'HEAD'])

      await restoreSnapshot(repo, snap.commit)

      expect(readFileSync(indexPath).equals(indexBefore)).toBe(true)
      expect(git(repo, ['rev-parse', 'HEAD'])).toBe(headBefore)
      expect(git(repo, ['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/main')
      expect(workingFiles(repo)).toEqual(expectedFiles)
      expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('snapshot\n')
      expect(readFileSync(join(repo, 'src', 'keep.ts'), 'utf8')).toBe('keep\n')
      expect(readFileSync(join(repo, 'src', 'deep', 'nested.ts'), 'utf8')).toBe('nested\n')
      expect(existsSync(join(repo, 'made'))).toBe(false)
      expect(readFileSync(join(repo, 'ignored.log'), 'utf8')).toBe('ignored\n')
      expect(readFileSync(join(repo, '.harness', 'runs', 'x'), 'utf8')).toBe('artifact\n')

      const again = await takeSnapshot({ worktree: repo, runId: 'r1', stepId: 's', n: 1 })
      expect(again.tree).toBe(snap.tree)
    })

    it('handles file and directory swaps in both directions', async () => {
      writeFileSync(join(repo, 'swap'), 'file\n')
      mkdirSync(join(repo, 'dirswap'))
      writeFileSync(join(repo, 'dirswap', 'inner.txt'), 'inner\n')
      const snap = await takeSnapshot({ worktree: repo, runId: 'r1', stepId: 's', n: 0 })

      unlinkSync(join(repo, 'swap'))
      mkdirSync(join(repo, 'swap'))
      writeFileSync(join(repo, 'swap', 'child.txt'), 'child\n')
      rmSync(join(repo, 'dirswap'), { recursive: true })
      writeFileSync(join(repo, 'dirswap'), 'now a file\n')

      await restoreSnapshot(repo, snap.commit)

      expect(readFileSync(join(repo, 'swap'), 'utf8')).toBe('file\n')
      expect(readFileSync(join(repo, 'dirswap', 'inner.txt'), 'utf8')).toBe('inner\n')
      const again = await takeSnapshot({ worktree: repo, runId: 'r1', stepId: 's', n: 1 })
      expect(again.tree).toBe(snap.tree)
    })

    it('never deletes files outside the worktree', async () => {
      const outside = join(root, 'outside')
      mkdirSync(outside)
      writeFileSync(join(outside, 'precious.txt'), 'precious\n')
      const snap = await takeSnapshot({ worktree: repo, runId: 'r1', stepId: 's', n: 0 })

      execFileSync('ln', ['-s', outside, join(repo, 'escape')])
      await restoreSnapshot(repo, snap.commit)

      expect(existsSync(join(repo, 'escape'))).toBe(false)
      expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('precious\n')
    })

    it('rejects a malformed sha before running git', async () => {
      await expect(restoreSnapshot(repo, 'HEAD')).rejects.toThrow(/Invalid snapshot sha/)
      await expect(restoreSnapshot(repo, '--output=/tmp/x')).rejects.toThrow(/Invalid snapshot sha/)
    })
  })

  describe('deleteRunRefs', () => {
    it("removes only that run's refs", async () => {
      await takeSnapshot({ worktree: repo, runId: 'run1', stepId: 'a', n: 0 })
      await takeSnapshot({ worktree: repo, runId: 'run1', stepId: 'b', n: 1 })
      await takeSnapshot({ worktree: repo, runId: 'run10', stepId: 'a', n: 0 })
      await takeSnapshot({ worktree: repo, runId: 'run2', stepId: 'a', n: 0 })

      expect(await deleteRunRefs(repo, 'run1')).toBe(2)
      expect(refs(repo)).toEqual(['refs/harness/runs/run10/a/0', 'refs/harness/runs/run2/a/0'])
      expect(await deleteRunRefs(repo, 'run1')).toBe(0)
    })

    it('rejects a malformed runId', async () => {
      await expect(deleteRunRefs(repo, '../heads')).rejects.toThrow()
      await expect(deleteRunRefs(repo, '')).rejects.toThrow()
    })
  })
})

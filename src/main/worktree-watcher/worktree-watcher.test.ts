import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

import { WorktreeWatcher, resolveGitDir } from '.'

type FsCallback = (eventType: string, filename: string | null) => void

interface FakeWatcher {
  path: string
  listener: FsCallback
  close: ReturnType<typeof vi.fn>
}

let fakeWatchers: FakeWatcher[] = []

function fireFsEvent(path: string, filename: string): void {
  for (const w of fakeWatchers) {
    if (w.path === path) w.listener('change', filename)
  }
}

function activeWatchers(path: string): FakeWatcher[] {
  return fakeWatchers.filter((w) => !w.close.mock.calls.length && w.path === path)
}

beforeEach(() => {
  fakeWatchers = []
  vi.useFakeTimers()
  vi.spyOn(fs, 'watch').mockImplementation(((
    path: fs.PathLike,
    optionsOrListener?: unknown,
    maybeListener?: unknown
  ) => {
    const listener = (typeof optionsOrListener === 'function'
      ? optionsOrListener
      : maybeListener) as FsCallback
    const w: FakeWatcher = {
      path: String(path),
      listener,
      close: vi.fn()
    }
    fakeWatchers.push(w)
    return {
      close: w.close,
      // The full FSWatcher interface has a few EventEmitter methods we
      // don't exercise in these tests; cast at the call site.
    } as unknown as fs.FSWatcher
  }) as unknown as typeof fs.watch)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('WorktreeWatcher', () => {
  it('notifies a single subscriber after debounce window elapses', () => {
    const watcher = new WorktreeWatcher()
    const listener = vi.fn()
    watcher.subscribe('/wt/a', listener)

    fireFsEvent(join('/wt/a', '.git'), 'index')
    expect(listener).not.toHaveBeenCalled()

    vi.advanceTimersByTime(199)
    expect(listener).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('coalesces multiple events within the debounce window into one notification', () => {
    const watcher = new WorktreeWatcher()
    const listener = vi.fn()
    watcher.subscribe('/wt/a', listener)

    const gitDir = join('/wt/a', '.git')
    fireFsEvent(gitDir, 'index')
    fireFsEvent(gitDir, 'HEAD')
    fireFsEvent(gitDir, 'index')
    fireFsEvent(gitDir, 'MERGE_HEAD')
    fireFsEvent(gitDir, 'HEAD')

    vi.advanceTimersByTime(200)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('ignores fs events for unrelated filenames', () => {
    const watcher = new WorktreeWatcher()
    const listener = vi.fn()
    watcher.subscribe('/wt/a', listener)

    const gitDir = join('/wt/a', '.git')
    fireFsEvent(gitDir, 'objects')
    fireFsEvent(gitDir, 'config')
    fireFsEvent(gitDir, 'logs')

    vi.advanceTimersByTime(500)
    expect(listener).not.toHaveBeenCalled()
  })

  it('notifies every subscriber on the same path', () => {
    const watcher = new WorktreeWatcher()
    const a = vi.fn()
    const b = vi.fn()
    watcher.subscribe('/wt/a', a)
    watcher.subscribe('/wt/a', b)

    fireFsEvent(join('/wt/a', '.git'), 'index')
    vi.advanceTimersByTime(200)

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('reuses the underlying fs.watch handle across subscribers', () => {
    const watcher = new WorktreeWatcher()
    watcher.subscribe('/wt/a', vi.fn())
    watcher.subscribe('/wt/a', vi.fn())

    expect(activeWatchers(join('/wt/a', '.git'))).toHaveLength(1)
  })

  it('reference-counts: unsubscribing one keeps the watcher alive for the rest', () => {
    const watcher = new WorktreeWatcher()
    const a = vi.fn()
    const b = vi.fn()
    const offA = watcher.subscribe('/wt/a', a)
    watcher.subscribe('/wt/a', b)

    offA()

    fireFsEvent(join('/wt/a', '.git'), 'index')
    vi.advanceTimersByTime(200)

    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
    expect(activeWatchers(join('/wt/a', '.git'))).toHaveLength(1)
  })

  it('closes the underlying fs.watch handle when the last subscriber leaves', () => {
    const watcher = new WorktreeWatcher()
    const offA = watcher.subscribe('/wt/a', vi.fn())
    const offB = watcher.subscribe('/wt/a', vi.fn())

    const created = fakeWatchers.filter((w) => w.path === join('/wt/a', '.git'))
    expect(created).toHaveLength(1)
    expect(created[0].close).not.toHaveBeenCalled()

    offA()
    expect(created[0].close).not.toHaveBeenCalled()

    offB()
    expect(created[0].close).toHaveBeenCalledTimes(1)
  })

  it('keeps subscriptions on different paths independent', () => {
    const watcher = new WorktreeWatcher()
    const a = vi.fn()
    const b = vi.fn()
    watcher.subscribe('/wt/a', a)
    watcher.subscribe('/wt/b', b)

    fireFsEvent(join('/wt/a', '.git'), 'index')
    vi.advanceTimersByTime(200)

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
  })

  it('shutdown closes every open watcher and clears entries', () => {
    const watcher = new WorktreeWatcher()
    watcher.subscribe('/wt/a', vi.fn())
    watcher.subscribe('/wt/b', vi.fn())

    const aWatcher = fakeWatchers.find((w) => w.path === join('/wt/a', '.git'))!
    const bWatcher = fakeWatchers.find((w) => w.path === join('/wt/b', '.git'))!

    watcher.shutdown()

    expect(aWatcher.close).toHaveBeenCalledTimes(1)
    expect(bWatcher.close).toHaveBeenCalledTimes(1)
  })

  it('survives fs.watch throwing (e.g. .git/ missing) and produces no notifications', () => {
    ;(fs.watch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('ENOENT')
    })

    const watcher = new WorktreeWatcher()
    const listener = vi.fn()
    expect(() => watcher.subscribe('/wt/missing', listener)).not.toThrow()

    vi.advanceTimersByTime(500)
    expect(listener).not.toHaveBeenCalled()
  })
})

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

describe('resolveGitDir', () => {
  let root: string
  let repo: string

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'harness-gitdir-'))
    repo = join(root, 'repo')
    fs.mkdirSync(repo)
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'commit.gpgsign', 'false'])
    fs.writeFileSync(join(repo, 'f.txt'), 'base\n')
    git(repo, ['add', 'f.txt'])
    git(repo, ['commit', '-q', '-m', 'base'])
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('returns <repo>/.git for a normal repository', () => {
    expect(resolveGitDir(repo)).toBe(join(repo, '.git'))
  })

  it('follows the .git file of a linked worktree to its per-worktree gitdir', () => {
    const wt = join(root, 'linked')
    git(repo, ['worktree', 'add', '-q', '-b', 'feature', wt])

    const result = resolveGitDir(wt)

    expect(result).not.toBeNull()
    expect(fs.realpathSync(result!)).toBe(
      fs.realpathSync(join(repo, '.git', 'worktrees', 'linked'))
    )
  })

  it('resolves a relative gitdir against the worktree path, not the cwd', () => {
    const wt = join(root, 'handmade')
    fs.mkdirSync(wt)
    fs.writeFileSync(join(wt, '.git'), 'gitdir: ../repo/.git/worktrees/x\n')

    expect(resolveGitDir(wt)).toBe(resolve(wt, '../repo/.git/worktrees/x'))
  })

  it('returns null when .git is missing', () => {
    const bare = join(root, 'plain-dir')
    fs.mkdirSync(bare)

    expect(resolveGitDir(bare)).toBeNull()
  })

  it('returns null when .git is a file without a gitdir line', () => {
    const wt = join(root, 'garbage')
    fs.mkdirSync(wt)
    fs.writeFileSync(join(wt, '.git'), 'not a pointer\n')

    expect(resolveGitDir(wt)).toBeNull()
  })
})

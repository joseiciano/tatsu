import { afterEach, describe, it, expect, vi } from 'vitest'
import type { CodeDiffFile, CodeDiffFileList, CodeDiffSides } from '../../../shared/code-diff'
import { initialState, type AppState } from '../../../shared/state'
import type { Worktree } from '../../../shared/state/worktrees'
import type { TatsuClient } from '../../client'
import { CliError } from '../../errors'
import { createOutput } from '../../output'
import type { CommandContext } from '..'
import { main } from '../../main'
import { diffCommand, renderFileList, type DiffResult } from '.'

const MAIN: Worktree = { path: '/remote/repo', repoRoot: '/remote/repo', branch: 'main', head: 'a', isBare: false, isMain: true, createdAt: 0 }
const FEAT: Worktree = { path: '/remote/wt/feat', repoRoot: '/remote/repo', branch: 'feat', head: 'b', isBare: false, isMain: false, createdAt: 0 }
const STATE: AppState = { ...initialState, worktrees: { ...initialState.worktrees, repoRoots: ['/remote/repo'], list: [MAIN, FEAT] } }

const FILES: CodeDiffFile[] = [
  { path: 'a.ts', status: 'added', additions: 3, deletions: 0 },
  { path: 'blob.bin', status: 'added' },
  { path: 'new.txt', previousPath: 'old.txt', status: 'renamed', additions: 1, deletions: 1 },
  { path: 'scratch.txt', status: 'untracked', additions: 2, deletions: 0 }
]

function list(overrides: Partial<CodeDiffFileList> = {}): CodeDiffFileList {
  return {
    files: FILES,
    totalFiles: 4,
    totalAdditions: 6,
    totalDeletions: 1,
    baseRef: 'refs/heads/main',
    mergeBase: '0123456789abcdef',
    headRef: 'feat',
    isWorktreeDirty: true,
    ...overrides
  }
}

function fakeClient(replies: Record<string, unknown>): { client: TatsuClient; requests: { name: string; args: unknown[] }[] } {
  const requests: { name: string; args: unknown[] }[] = []
  const client: TatsuClient = {
    endpoint: { url: 'ws://127.0.0.1:1', source: 'flag' },
    snapshot: async () => STATE,
    request: async <T,>(name: string, ...args: unknown[]) => {
      requests.push({ name, args })
      const reply = replies[name]
      return (typeof reply === 'function' ? reply(...args) : reply) as T
    },
    close: () => {}
  }
  return { client, requests }
}

async function runDiff(client: TatsuClient, opts: { positionals?: string[]; values?: CommandContext['values']; json?: boolean } = {}) {
  let stdout = ''
  const output = createOutput({ json: opts.json ?? false, stdout: (t) => (stdout += t) })
  await diffCommand.run({
    values: opts.values ?? {},
    positionals: opts.positionals ?? [],
    globals: { json: opts.json ?? false },
    env: {},
    client: async () => client,
    output
  })
  output.flush()
  return stdout
}

async function rejection(promise: Promise<unknown>): Promise<CliError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  if (!(err instanceof CliError)) throw new Error(`expected a CliError, got ${String(err)}`)
  return err
}

afterEach(() => vi.restoreAllMocks())

describe('renderFileList', () => {
  const result: DiffResult = {
    worktree: FEAT.path,
    baseRef: 'refs/heads/main',
    mergeBase: '0123456789abcdef',
    headRef: 'feat',
    dirty: true,
    totals: { files: 4, additions: 6, deletions: 1 },
    files: FILES
  }

  it('prints the header, one row per file and the totals', () => {
    expect(renderFileList(result, FEAT)).toBe(
      [
        'feat vs refs/heads/main (merge base 0123456) · uncommitted changes',
        '',
        'A  +3 -0  a.ts',
        'A  -      blob.bin',
        'R  +1 -1  old.txt → new.txt',
        '?  +2 -0  scratch.txt',
        '',
        '4 files changed, +6 -1'
      ].join('\n')
    )
  })

  it('omits the uncommitted note when the worktree is clean', () => {
    expect(renderFileList({ ...result, dirty: false }, FEAT).split('\n')[0]).toBe('feat vs refs/heads/main (merge base 0123456)')
  })

  it('says how many files are shown when the server capped the list', () => {
    expect(renderFileList({ ...result, totals: { ...result.totals, files: 9 } }, FEAT)).toContain('9 files changed (showing 4), +6 -1')
  })

  it('prints a single line when nothing changed', () => {
    const empty = { ...result, files: [], totals: { files: 0, additions: 0, deletions: 0 } }
    expect(renderFileList(empty, FEAT)).toBe('No changes against refs/heads/main.')
  })
})

describe('diffCommand', () => {
  it('resolves the default base and sends the stored worktree path', async () => {
    const { client, requests } = fakeClient({
      'worktree:defaultCompareRef': { ref: 'refs/remotes/origin/main', fetchable: true },
      'worktree:codeDiffFiles': list()
    })
    await runDiff(client, { positionals: ['feat'] })
    expect(requests).toEqual([
      { name: 'worktree:defaultCompareRef', args: [FEAT.path] },
      { name: 'worktree:codeDiffFiles', args: [FEAT.path, 'refs/remotes/origin/main'] }
    ])
  })

  it('uses --base verbatim without asking for the default', async () => {
    const { client, requests } = fakeClient({ 'worktree:codeDiffFiles': list() })
    await runDiff(client, { positionals: ['/remote/wt/feat/src'], values: { base: 'v1' } })
    expect(requests).toEqual([{ name: 'worktree:codeDiffFiles', args: [FEAT.path, 'v1'] }])
  })

  it('defaults the worktree to the current directory', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/remote/wt/feat/pkg')
    const { client, requests } = fakeClient({ 'worktree:codeDiffFiles': list() })
    await runDiff(client, { values: { base: 'main' } })
    expect(requests[0].args[0]).toBe(FEAT.path)
  })

  it('says the current directory is outside every worktree when the cwd default matches nothing', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/elsewhere')
    const { client, requests } = fakeClient({})
    const err = await rejection(runDiff(client))
    expect(err.code).toBe('usage')
    expect(err.message).toBe('current directory is not inside a known worktree; pass <worktree>')
    expect(err.details).toEqual({ worktrees: [{ path: MAIN.path, branch: 'main' }, { path: FEAT.path, branch: 'feat' }] })
    expect(requests).toEqual([])
  })

  it('prints the documented JSON shape', async () => {
    const { client } = fakeClient({ 'worktree:codeDiffFiles': list() })
    const out = await runDiff(client, { positionals: ['feat'], values: { base: 'main' }, json: true })
    expect(JSON.parse(out)).toEqual({
      worktree: FEAT.path,
      baseRef: 'refs/heads/main',
      mergeBase: '0123456789abcdef',
      headRef: 'feat',
      dirty: true,
      totals: { files: 4, additions: 6, deletions: 1 },
      files: FILES
    })
  })

  it('maps invalid-ref to command-failed naming the ref sent', async () => {
    const { client } = fakeClient({ 'worktree:codeDiffFiles': list({ files: [], error: 'invalid-ref', baseRef: 'nope' }) })
    const err = await rejection(runDiff(client, { positionals: ['feat'], values: { base: 'nope' } }))
    expect(err.code).toBe('command-failed')
    expect(err.message).toBe("invalid base ref 'nope'")
  })

  it('maps no-merge-base to command-failed naming the branch and resolved ref', async () => {
    const { client } = fakeClient({
      'worktree:codeDiffFiles': list({ files: [], error: 'no-merge-base', headRef: '', baseRef: 'refs/heads/unrelated' })
    })
    const err = await rejection(runDiff(client, { positionals: ['feat'], values: { base: 'unrelated' } }))
    expect(err.code).toBe('command-failed')
    expect(err.message).toBe('no merge base between feat and refs/heads/unrelated')
  })

  it('maps unknown-worktree to usage', async () => {
    const { client } = fakeClient({ 'worktree:codeDiffFiles': list({ files: [], error: 'unknown-worktree' }) })
    expect((await rejection(runDiff(client, { positionals: ['feat'], values: { base: 'main' } }))).code).toBe('usage')
  })

  it('gives a usage error with the worktree list for an unknown worktree, before any request', async () => {
    const { client, requests } = fakeClient({})
    const err = await rejection(runDiff(client, { positionals: ['nope'] }))
    expect(err.code).toBe('usage')
    expect(err.details).toEqual({ worktrees: [{ path: MAIN.path, branch: 'main' }, { path: FEAT.path, branch: 'feat' }] })
    expect(requests).toEqual([])
  })

  it('rejects a malformed codeDiffFiles reply', async () => {
    const { client } = fakeClient({ 'worktree:codeDiffFiles': { nope: true } })
    expect((await rejection(runDiff(client, { positionals: ['feat'], values: { base: 'main' } }))).code).toBe('request-failed')
  })

  it('rejects a second positional and an empty --base', async () => {
    const { client } = fakeClient({})
    expect((await rejection(runDiff(client, { positionals: ['feat', 'extra'] }))).code).toBe('usage')
    expect((await rejection(runDiff(client, { positionals: ['feat'], values: { base: '' } }))).code).toBe('usage')
  })
})

function textSides(original: string, modified: string, overrides: Partial<CodeDiffSides> = {}): CodeDiffSides {
  return {
    original,
    modified,
    originalExists: original !== '',
    modifiedExists: true,
    originalBinary: false,
    modifiedBinary: false,
    originalSize: original.length,
    modifiedSize: modified.length,
    modifiedSymlink: false,
    ...overrides
  }
}

const SIDES: Record<string, CodeDiffSides> = {
  'a.ts': textSides('', 'x\n'),
  'blob.bin': textSides('', '', { modifiedBinary: true }),
  'new.txt': textSides('o\n', 'n\n'),
  'scratch.txt': textSides('', 's\n')
}

const PATCHES: Record<string, string> = {
  'a.ts': '--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1,1 @@\n+x\n',
  'blob.bin': 'Binary files /dev/null and b/blob.bin differ\n',
  'new.txt': '--- a/old.txt\n+++ b/new.txt\n@@ -1,1 +1,1 @@\n-o\n+n\n',
  'scratch.txt': '--- /dev/null\n+++ b/scratch.txt\n@@ -0,0 +1,1 @@\n+s\n'
}

function patchClient(sides: Record<string, CodeDiffSides | unknown> = SIDES) {
  return fakeClient({
    'worktree:codeDiffFiles': list(),
    'worktree:codeDiffFileSides': (_path: string, _base: string, filePath: string) => sides[filePath]
  })
}

describe('diffCommand patches', () => {
  it('--patch fetches sides one file at a time in list order and prints only the patches', async () => {
    const { client, requests } = patchClient()
    const out = await runDiff(client, { positionals: ['feat'], values: { base: 'main', patch: true } })
    expect(requests.slice(1)).toEqual([
      { name: 'worktree:codeDiffFileSides', args: [FEAT.path, 'refs/heads/main', 'a.ts', undefined] },
      { name: 'worktree:codeDiffFileSides', args: [FEAT.path, 'refs/heads/main', 'blob.bin', undefined] },
      { name: 'worktree:codeDiffFileSides', args: [FEAT.path, 'refs/heads/main', 'new.txt', 'old.txt'] },
      { name: 'worktree:codeDiffFileSides', args: [FEAT.path, 'refs/heads/main', 'scratch.txt', undefined] }
    ])
    expect(out).toBe(FILES.map((f) => PATCHES[f.path]).join(''))
  })

  it('--file prints one file, matched by its path or its previous path', async () => {
    const byPath = patchClient()
    expect(await runDiff(byPath.client, { positionals: ['feat'], values: { base: 'main', file: 'a.ts' } })).toBe(PATCHES['a.ts'])
    expect(byPath.requests.filter((r) => r.name === 'worktree:codeDiffFileSides')).toHaveLength(1)

    const byPrevious = patchClient()
    expect(await runDiff(byPrevious.client, { positionals: ['feat'], values: { base: 'main', file: 'old.txt' } })).toBe(PATCHES['new.txt'])
  })

  it('--file for a path not in the list is a usage error', async () => {
    const { client, requests } = patchClient()
    const err = await rejection(runDiff(client, { positionals: ['feat'], values: { base: 'main', file: 'nope.txt' } }))
    expect(err.code).toBe('usage')
    expect(err.message).toContain("'nope.txt'")
    expect(requests.map((r) => r.name)).toEqual(['worktree:codeDiffFiles'])
  })

  it('rejects --file with --patch and an empty --file before any request', async () => {
    const { client, requests } = patchClient()
    expect((await rejection(runDiff(client, { positionals: ['feat'], values: { file: 'a.ts', patch: true } }))).code).toBe('usage')
    expect((await rejection(runDiff(client, { positionals: ['feat'], values: { file: '' } }))).code).toBe('usage')
    expect(requests).toEqual([])
  })

  it('--patch --json adds a patch to every file', async () => {
    const { client } = patchClient()
    const out = await runDiff(client, { positionals: ['feat'], values: { base: 'main', patch: true }, json: true })
    const parsed = JSON.parse(out) as DiffResult
    expect(parsed.totals).toEqual({ files: 4, additions: 6, deletions: 1 })
    expect(parsed.files).toEqual(FILES.map((f) => ({ ...f, patch: PATCHES[f.path] })))
  })

  it('--file --json narrows files to the matched file', async () => {
    const { client } = patchClient()
    const out = await runDiff(client, { positionals: ['feat'], values: { base: 'main', file: 'a.ts' }, json: true })
    expect((JSON.parse(out) as DiffResult).files).toEqual([{ ...FILES[0], patch: PATCHES['a.ts'] }])
  })

  it('prints the patches that succeeded, then fails with every sides error', async () => {
    const { client } = patchClient({ ...SIDES, 'blob.bin': textSides('', '', { error: 'disk on fire' }) })
    let stdout = ''
    const output = createOutput({ json: false, stdout: (t) => (stdout += t) })
    const err = await rejection(
      Promise.resolve(
        diffCommand.run({
          values: { base: 'main', patch: true },
          positionals: ['feat'],
          globals: { json: false },
          env: {},
          client: async () => client,
          output
        })
      )
    )
    output.flushKept()
    expect(err.code).toBe('command-failed')
    expect(err.message).toBe('blob.bin: disk on fire')
    expect(err.details).toEqual({ failed: [{ path: 'blob.bin', error: 'disk on fire' }] })
    expect(stdout).toBe(['a.ts', 'new.txt', 'scratch.txt'].map((p) => PATCHES[p]).join(''))
  })

  it('in json mode a failed file gets patch null and patchError, still in one document', async () => {
    const { client } = patchClient({ ...SIDES, 'a.ts': textSides('', '', { error: 'boom' }), 'new.txt': textSides('', '', { error: 'bang' }) })
    let stdout = ''
    const output = createOutput({ json: true, stdout: (t) => (stdout += t) })
    const err = await rejection(
      Promise.resolve(
        diffCommand.run({
          values: { base: 'main', patch: true },
          positionals: ['feat'],
          globals: { json: true },
          env: {},
          client: async () => client,
          output
        })
      )
    )
    output.flushKept()
    expect(err.message).toBe('2 files failed to diff:\na.ts: boom\nnew.txt: bang')
    expect(err.details).toEqual({ failed: [{ path: 'a.ts', error: 'boom' }, { path: 'new.txt', error: 'bang' }] })
    const parsed = JSON.parse(stdout) as DiffResult
    expect(parsed.files[0]).toEqual({ ...FILES[0], patch: null, patchError: 'boom' })
    expect(parsed.files[1]).toEqual({ ...FILES[1], patch: PATCHES['blob.bin'] })
    expect(parsed.files[2]).toEqual({ ...FILES[2], patch: null, patchError: 'bang' })
  })

  it('rejects a malformed codeDiffFileSides reply', async () => {
    const { client } = patchClient({ ...SIDES, 'a.ts': { nope: true } })
    expect((await rejection(runDiff(client, { positionals: ['feat'], values: { base: 'main', file: 'a.ts' } }))).code).toBe('request-failed')
  })

  it('prints nothing for --patch when nothing changed', async () => {
    const { client } = fakeClient({ 'worktree:codeDiffFiles': list({ files: [], totalFiles: 0, totalAdditions: 0, totalDeletions: 0 }) })
    expect(await runDiff(client, { positionals: ['feat'], values: { base: 'main', patch: true } })).toBe('')
  })

  it('through main: prints the other patches, then exits 1 with the failure on stderr', async () => {
    const { client } = patchClient({ ...SIDES, 'blob.bin': textSides('', '', { error: 'disk on fire' }) })
    let stdout = ''
    let stderr = ''
    const code = await main(
      ['diff', 'feat', '--base', 'main', '--patch', '--url', 'ws://127.0.0.1:1', '--token', 't'],
      {
        stdout: (t) => (stdout += t),
        stderr: (t) => (stderr += t),
        env: {},
        files: {
          readFile: async () => {
            throw new Error('unused')
          },
          homedir: () => '/nonexistent',
          platform: 'linux',
          isPidAlive: () => false
        },
        connect: async () => client
      },
      [diffCommand]
    )
    expect(code).toBe(1)
    expect(stderr).toBe('tatsu: blob.bin: disk on fire\n')
    expect(stdout).toBe(['a.ts', 'new.txt', 'scratch.txt'].map((p) => PATCHES[p]).join(''))
  })
})

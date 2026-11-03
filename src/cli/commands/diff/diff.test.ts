import { afterEach, describe, it, expect, vi } from 'vitest'
import type { CodeDiffFile, CodeDiffFileList } from '../../../shared/code-diff'
import { initialState, type AppState } from '../../../shared/state'
import type { Worktree } from '../../../shared/state/worktrees'
import type { TatsuClient } from '../../client'
import { CliError } from '../../errors'
import { createOutput } from '../../output'
import type { CommandContext } from '..'
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
      return replies[name] as T
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

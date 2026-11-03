import type { CodeDiffFile, CodeDiffFileList, CodeDiffSides, CodeDiffStatus } from '../../../shared/code-diff'
import type { AppState } from '../../../shared/state'
import type { Worktree } from '../../../shared/state/worktrees'
import type { TatsuClient } from '../../client'
import { CliError } from '../../errors'
import { formatTable } from '../../output'
import { findWorktree } from '../../repo-match'
import type { Command, CommandContext } from '..'
import { renderPatch } from './patch'

const HELP_HINT = "Run 'tatsu diff --help' for usage."

export interface DiffResult {
  worktree: string
  baseRef: string
  mergeBase: string
  headRef: string
  dirty: boolean
  totals: { files: number; additions: number; deletions: number }
  files: CodeDiffFile[]
}

export type PatchedFile = CodeDiffFile & { patch: string | null; patchError?: string }

export type PatchedDiffResult = Omit<DiffResult, 'files'> & { files: PatchedFile[] }

const STATUS_LETTERS = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: '?'
} satisfies Record<CodeDiffStatus, string>

function isDefaultCompareRef(value: unknown): value is { ref: string } {
  return typeof value === 'object' && value !== null && 'ref' in value && typeof value.ref === 'string'
}

function isCodeDiffFileList(value: unknown): value is CodeDiffFileList {
  return (
    typeof value === 'object' &&
    value !== null &&
    'files' in value &&
    Array.isArray(value.files) &&
    'baseRef' in value &&
    typeof value.baseRef === 'string'
  )
}

function isCodeDiffSides(value: unknown): value is CodeDiffSides {
  return (
    typeof value === 'object' &&
    value !== null &&
    'original' in value &&
    typeof value.original === 'string' &&
    'modified' in value &&
    typeof value.modified === 'string' &&
    'originalBinary' in value &&
    typeof value.originalBinary === 'boolean' &&
    'modifiedBinary' in value &&
    typeof value.modifiedBinary === 'boolean'
  )
}

async function resolveBase(client: TatsuClient, path: string, base: string | undefined): Promise<string> {
  if (base !== undefined) return base
  const reply = await client.request('worktree:defaultCompareRef', path)
  if (!isDefaultCompareRef(reply)) {
    throw new CliError('request-failed', "backend sent a malformed reply to 'worktree:defaultCompareRef'")
  }
  return reply.ref
}

function checkList(list: CodeDiffFileList, worktree: Worktree, baseRef: string): void {
  switch (list.error) {
    case undefined:
      return
    case 'invalid-ref':
      throw new CliError('command-failed', `invalid base ref '${baseRef}'`)
    case 'no-merge-base':
      throw new CliError('command-failed', `no merge base between ${worktree.branch || 'HEAD'} and ${list.baseRef || baseRef}`)
    case 'unknown-worktree':
      throw new CliError('usage', `the backend does not know the worktree ${worktree.path}`)
    default: {
      const _exhaustive: never = list.error
      throw new CliError('request-failed', `backend reported an unknown code diff error '${String(_exhaustive)}'`)
    }
  }
}

export async function fetchFileList(client: TatsuClient, worktree: Worktree, base: string | undefined): Promise<DiffResult> {
  const baseRef = await resolveBase(client, worktree.path, base)
  const reply = await client.request('worktree:codeDiffFiles', worktree.path, baseRef)
  if (!isCodeDiffFileList(reply)) {
    throw new CliError('request-failed', "backend sent a malformed reply to 'worktree:codeDiffFiles'")
  }
  checkList(reply, worktree, baseRef)
  return {
    worktree: worktree.path,
    baseRef: reply.baseRef,
    mergeBase: reply.mergeBase,
    headRef: reply.headRef,
    dirty: reply.isWorktreeDirty,
    totals: { files: reply.totalFiles, additions: reply.totalAdditions, deletions: reply.totalDeletions },
    files: reply.files
  }
}

export async function fetchPatches(client: TatsuClient, worktree: Worktree, baseRef: string, files: CodeDiffFile[]): Promise<PatchedFile[]> {
  const patched: PatchedFile[] = []
  for (const file of files) {
    const reply = await client.request('worktree:codeDiffFileSides', worktree.path, baseRef, file.path, file.previousPath)
    if (!isCodeDiffSides(reply)) {
      throw new CliError('request-failed', "backend sent a malformed reply to 'worktree:codeDiffFileSides'")
    }
    patched.push(reply.error !== undefined ? { ...file, patch: null, patchError: reply.error } : { ...file, patch: renderPatch(file, reply) })
  }
  return patched
}

function selectFiles(files: CodeDiffFile[], selector: string | undefined): CodeDiffFile[] {
  if (selector === undefined) return files
  const match = files.find((file) => file.path === selector || file.previousPath === selector)
  if (!match) throw new CliError('usage', `'${selector}' is not in the changed files. ${HELP_HINT}`)
  return [match]
}

function failure(files: PatchedFile[]): CliError | undefined {
  const failed = files.flatMap((file) => (file.patchError !== undefined ? [{ path: file.path, error: file.patchError }] : []))
  if (failed.length === 0) return undefined
  const lines = failed.map(({ path, error }) => `${path}: ${error}`)
  const message = failed.length === 1 ? lines[0] : [`${failed.length} files failed to diff:`, ...lines].join('\n')
  return new CliError('command-failed', message, { failed })
}

function counts(file: CodeDiffFile): string {
  if (file.additions === undefined && file.deletions === undefined) return '-'
  return `+${file.additions ?? 0} -${file.deletions ?? 0}`
}

function displayPath(file: CodeDiffFile): string {
  return file.previousPath !== undefined ? `${file.previousPath} → ${file.path}` : file.path
}

export function renderFileList(result: DiffResult, worktree: Worktree): string {
  if (result.totals.files === 0) return `No changes against ${result.baseRef}.`
  const branch = worktree.branch || result.headRef || 'HEAD'
  const header = `${branch} vs ${result.baseRef} (merge base ${result.mergeBase.slice(0, 7)})${result.dirty ? ' · uncommitted changes' : ''}`
  const rows = formatTable(result.files.map((file) => [STATUS_LETTERS[file.status], counts(file), displayPath(file)]))
  const { files, additions, deletions } = result.totals
  const shown = result.files.length < files ? ` (showing ${result.files.length})` : ''
  const totals = `${files} ${files === 1 ? 'file' : 'files'} changed${shown}, +${additions} -${deletions}`
  return [header, '', rows, '', totals].join('\n')
}

function findCwdWorktree(state: AppState): Worktree {
  try {
    return findWorktree(state, process.cwd())
  } catch (err) {
    if (err instanceof CliError && err.code === 'usage') {
      throw new CliError('usage', 'current directory is not inside a known worktree; pass <worktree>', err.details)
    }
    throw err
  }
}

interface DiffArgs {
  target?: string
  base?: string
  file?: string
  patch: boolean
}

function parseArgs(ctx: CommandContext): DiffArgs {
  if (ctx.positionals.length > 1) {
    throw new CliError('usage', `unexpected argument '${ctx.positionals[1]}'. ${HELP_HINT}`)
  }
  const { base, file } = ctx.values
  const patch = ctx.values.patch === true
  if (base === '') throw new CliError('usage', `--base needs a ref. ${HELP_HINT}`)
  if (file === '') throw new CliError('usage', `--file needs a path. ${HELP_HINT}`)
  if (typeof file === 'string' && patch) throw new CliError('usage', `--file and --patch cannot be used together. ${HELP_HINT}`)
  return {
    ...(ctx.positionals[0] !== undefined ? { target: ctx.positionals[0] } : {}),
    ...(typeof base === 'string' ? { base } : {}),
    ...(typeof file === 'string' ? { file } : {}),
    patch
  }
}

export const diffCommand: Command = {
  name: 'diff',
  summary: 'Show what a worktree changed against a base ref',
  usage: 'diff [<worktree>] [--base <ref>] [--file <path> | --patch]',
  options: {
    base: { type: 'string', valueName: 'ref', description: "Ref to compare against (default: the backend's default base)" },
    file: { type: 'string', valueName: 'path', description: "Print one changed file's unified diff" },
    patch: { type: 'boolean', description: "Print every changed file's unified diff" }
  },
  async run(ctx) {
    const args = parseArgs(ctx)
    const client = await ctx.client()
    const state = await client.snapshot()
    const worktree = args.target !== undefined ? findWorktree(state, args.target) : findCwdWorktree(state)
    const result = await fetchFileList(client, worktree, args.base)
    if (args.file === undefined && !args.patch) {
      ctx.output.result(result, (value) => renderFileList(value, worktree))
      return
    }
    const files = await fetchPatches(client, worktree, result.baseRef, selectFiles(result.files, args.file))
    const patched: PatchedDiffResult = { ...result, files }
    const text = files.map((file) => file.patch ?? '').join('')
    if (ctx.globals.json || text !== '') ctx.output.result(patched, () => text, { keepOnError: true })
    const err = failure(files)
    if (err) throw err
  }
}

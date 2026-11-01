import { execFile } from 'child_process'
import { promisify } from 'util'
import { appendFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, rmdir, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'

const execFileAsync = promisify(execFile)

const MAX_BUFFER = 64 * 1024 * 1024
const RUNS_DIR = '.harness/runs'
const RUNS_EXCLUDE_LINE = '.harness/runs/'
const REF_ROOT = 'refs/harness/runs'
const REF_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const GITLINK_MODE = '160000'
const IDENTITY_CONFIG = [
  '-c',
  'user.name=Tatsu',
  '-c',
  'user.email=tatsu@localhost',
  '-c',
  'commit.gpgsign=false'
]
const IDENTITY_ENV = {
  GIT_AUTHOR_NAME: 'Tatsu',
  GIT_AUTHOR_EMAIL: 'tatsu@localhost',
  GIT_COMMITTER_NAME: 'Tatsu',
  GIT_COMMITTER_EMAIL: 'tatsu@localhost'
}

export interface SnapshotRef {
  runId: string
  stepId: string
  n: number
}

export interface TakeSnapshotArgs extends SnapshotRef {
  worktree: string
  parent?: string
}

export interface Snapshot {
  commit: string
  tree: string
  ref: string
}

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...extra }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  if (!('GIT_INDEX_FILE' in extra)) delete env.GIT_INDEX_FILE
  return env
}

async function git(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {}
): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: baseEnv(extraEnv),
    maxBuffer: MAX_BUFFER,
    encoding: 'utf8'
  })
  return stdout
}

function assertRefComponent(name: string, value: string): void {
  if (!REF_COMPONENT.test(value)) {
    throw new Error(`Invalid ${name} for snapshot ref: ${JSON.stringify(value)}`)
  }
}

function assertObjectId(name: string, value: string): void {
  if (!OBJECT_ID.test(value)) {
    throw new Error(`Invalid ${name}: expected a full object id, got ${JSON.stringify(value)}`)
  }
}

export function snapshotRefName({ runId, stepId, n }: SnapshotRef): string {
  assertRefComponent('runId', runId)
  assertRefComponent('stepId', stepId)
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`Invalid snapshot number: ${String(n)}`)
  }
  return `${REF_ROOT}/${runId}/${stepId}/${n}`
}

async function resolveWorktreeRoot(worktree: string): Promise<string> {
  const requested = await realpath(worktree)
  const top = (await git(requested, ['rev-parse', '--show-toplevel'])).trim()
  const root = await realpath(top)
  if (root !== requested) {
    throw new Error(`Not a worktree root: ${worktree} (top level is ${root})`)
  }
  return root
}

async function withTempIndex<T>(fn: (indexFile: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'tatsu-snap-'))
  try {
    return await fn(join(dir, 'index'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function hasHead(root: string): Promise<boolean> {
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
    return true
  } catch {
    return false
  }
}

async function writeWorkingTree(root: string): Promise<string> {
  return withTempIndex(async (indexFile) => {
    const env = { GIT_INDEX_FILE: indexFile }
    if (await hasHead(root)) {
      await git(root, ['read-tree', 'HEAD'], env)
    }
    await git(root, ['add', '-A', '--', '.'], env)
    await git(root, ['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', RUNS_DIR], env)
    return (await git(root, ['write-tree'], env)).trim()
  })
}

export async function takeSnapshot(args: TakeSnapshotArgs): Promise<Snapshot> {
  const ref = snapshotRefName(args)
  if (args.parent !== undefined) assertObjectId('parent', args.parent)
  const root = await resolveWorktreeRoot(args.worktree)
  const tree = await writeWorkingTree(root)
  const parentArgs = args.parent !== undefined ? ['-p', args.parent] : []
  const commit = (
    await git(
      root,
      [
        ...IDENTITY_CONFIG,
        'commit-tree',
        '--no-gpg-sign',
        tree,
        ...parentArgs,
        '-m',
        `tatsu snapshot ${args.runId}/${args.stepId}/${args.n}`
      ],
      IDENTITY_ENV
    )
  ).trim()
  await git(root, ['update-ref', ref, commit])
  return { commit, tree, ref }
}

const excludeQueues = new Map<string, Promise<void>>()

async function appendRunsExclude(excludeFile: string): Promise<void> {
  await mkdir(dirname(excludeFile), { recursive: true })
  let existing = ''
  try {
    existing = await readFile(excludeFile, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const lines = existing.split(/\r?\n/).map((line) => line.trim())
  if (lines.includes(RUNS_EXCLUDE_LINE) || lines.includes(`/${RUNS_EXCLUDE_LINE}`)) return
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
  await appendFile(excludeFile, `${prefix}${RUNS_EXCLUDE_LINE}\n`)
}

export async function ensureRunsExcluded(worktree: string): Promise<void> {
  const cwd = await realpath(worktree)
  const commonDir = resolve(cwd, (await git(cwd, ['rev-parse', '--git-common-dir'])).trim())
  const excludeFile = join(commonDir, 'info', 'exclude')
  const previous = excludeQueues.get(excludeFile) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(() => appendRunsExclude(excludeFile))
  excludeQueues.set(excludeFile, next)
  try {
    await next
  } finally {
    if (excludeQueues.get(excludeFile) === next) excludeQueues.delete(excludeFile)
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function isUnderRuns(root: string, target: string): boolean {
  const runs = join(root, RUNS_DIR)
  return target === runs || target.startsWith(runs + sep)
}

function parseAddedPaths(raw: string): string[] {
  const fields = raw.split('\0')
  const paths: string[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i].replace(/^:/, '').split(' ')
    const path = fields[i + 1]
    if (meta[1] === GITLINK_MODE) continue
    paths.push(path)
  }
  return paths
}

async function safeDeletionTarget(root: string, path: string): Promise<string | null> {
  if (path === '' || isAbsolute(path) || path.split('/').includes('..')) return null
  const target = join(root, path)
  if (!isInside(root, target) || isUnderRuns(root, target)) return null
  let parent: string
  try {
    parent = await realpath(dirname(target))
  } catch {
    return null
  }
  if (parent !== root && !isInside(root, parent)) return null
  const resolved = join(parent, basename(target))
  if (isUnderRuns(root, resolved)) return null
  return resolved
}

async function removeExtra(root: string, path: string): Promise<void> {
  const target = await safeDeletionTarget(root, path)
  if (target === null) return
  try {
    const stat = await lstat(target)
    if (stat.isDirectory()) return
    await unlink(target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    return
  }
  await pruneEmptyParents(root, dirname(target))
}

async function pruneEmptyParents(root: string, start: string): Promise<void> {
  let dir = start
  while (isInside(root, dir) && !isUnderRuns(root, dir)) {
    try {
      await rmdir(dir)
    } catch {
      return
    }
    dir = dirname(dir)
  }
}

export async function restoreSnapshot(worktree: string, sha: string): Promise<void> {
  assertObjectId('snapshot sha', sha)
  const root = await resolveWorktreeRoot(worktree)
  const target = (await git(root, ['rev-parse', '--verify', '--quiet', `${sha}^{tree}`])).trim()
  const current = await writeWorkingTree(root)
  if (target !== current) {
    const raw = await git(root, [
      'diff-tree',
      '-r',
      '-z',
      '--raw',
      '--no-renames',
      '--diff-filter=A',
      target,
      current
    ])
    for (const path of parseAddedPaths(raw)) {
      await removeExtra(root, path)
    }
  }
  await withTempIndex(async (indexFile) => {
    const env = { GIT_INDEX_FILE: indexFile }
    await git(root, ['read-tree', target], env)
    await git(root, ['checkout-index', '-a', '-f'], env)
  })
}

export async function deleteRunRefs(worktree: string, runId: string): Promise<number> {
  assertRefComponent('runId', runId)
  const cwd = await realpath(worktree)
  const prefix = `${REF_ROOT}/${runId}/`
  const out = await git(cwd, ['for-each-ref', '--format=%(refname)', prefix])
  const refs = out
    .split('\n')
    .map((line) => line.trim())
    .filter((ref) => ref.startsWith(prefix))
  for (const ref of refs) {
    await git(cwd, ['update-ref', '-d', ref])
  }
  return refs.length
}

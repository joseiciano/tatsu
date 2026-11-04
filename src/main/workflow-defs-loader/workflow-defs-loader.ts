import { createHash, randomBytes } from 'crypto'
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  watch as fsWatch,
  writeSync,
  type Dirent,
  type Stats
} from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { log as defaultLog } from '../debug'
import { userDataDir } from '../paths'
import type {
  WorkflowDefinitionDetail,
  WorkflowDefinitionSummary,
  WorkflowSaveDefinitionPayload,
  WorkflowsEvent
} from '../../shared/state/workflows'
import { validateWorkflowDefinition, type WorkflowDiagnostic } from '../../shared/workflow-def'
import { copyNameCandidates, renameDefinitionSource } from './definition-copy'

export const MAX_WORKFLOW_FILE_BYTES = 256 * 1024
export const MAX_WORKFLOW_FILES = 200
export const WORKFLOW_WATCH_DEBOUNCE_MS = 250
const MAX_ISSUES = 5
const MAX_ISSUE_LENGTH = 200
const PERSONAL_KEY = 'personal'
const PERSONAL_ID_PATTERN = /^personal:[a-z0-9]+(?:-[a-z0-9]+)*$/
const REPO_ID_PATTERN = /^repo:([0-9a-f]{12}):[a-z0-9]+(?:-[a-z0-9]+)*$/
const YAML_EXTENSION = /\.ya?ml$/i
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
const TEMP_FLAGS = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0)
const MAX_SLUG_CHARS = 100
const UNSAFE_NAME = /[/\\\0]|^\.|\.\./

type SkipReason =
  | 'empty-id'
  | 'duplicate-id'
  | 'not-a-file'
  | 'symlink'
  | 'too-large'
  | 'unreadable'
  | 'too-many-files'

export interface WorkflowWatcher {
  close(): void
  on(event: 'error', listener: (err: unknown) => void): unknown
}

export type WorkflowWatchFn = (
  path: string,
  listener: (eventType: string, filename: string | null) => void
) => WorkflowWatcher

export interface WorkflowDefsLoaderDeps {
  dir: string
  dispatch: (event: WorkflowsEvent) => void
  log?: (category: string, message: string, data?: unknown) => void
  repoRoots?: readonly string[]
  resolvePrimaryCheckout?: (root: string) => string | null
  watch?: WorkflowWatchFn
  setTimer?: (fn: () => void, ms: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
}

type TimerHandle = ReturnType<typeof setTimeout>

export type SaveDefinitionRequest = WorkflowSaveDefinitionPayload

export type DefinitionWriteRefusal =
  | 'invalid-name'
  | 'unsafe-name'
  | 'too-large'
  | 'unknown-repo'
  | 'no-repo-dir'
  | 'unknown-definition'
  | 'scope-mismatch'
  | 'exists'
  | 'too-many-files'
  | 'not-a-file'
  | 'not-allowed'
  | 'write-failed'

export type SaveDefinitionResult =
  | { ok: true; summary: WorkflowDefinitionSummary }
  | { ok: false; reason: DefinitionWriteRefusal }

export type DeleteDefinitionResult =
  | { ok: true }
  | { ok: false; reason: 'unknown-definition' | 'not-a-file' | 'write-failed' }

export interface WorkflowDefsLoader {
  reload(): number
  getDefinition(id: unknown): WorkflowDefinitionDetail | null
  saveDefinition(request: SaveDefinitionRequest): SaveDefinitionResult
  duplicateDefinition(id: unknown, allow: (detail: WorkflowDefinitionDetail) => boolean): SaveDefinitionResult
  deleteDefinition(id: unknown): DeleteDefinitionResult
  setRepoRoots(roots: readonly string[]): void
  dispose(): void
}

interface WatchTarget {
  path: string
  names: ReadonlySet<string> | null
}

interface Group {
  key: string
  repoRoot: string | null
  checkout: string | null
  files: Map<string, string>
  summaries: WorkflowDefinitionSummary[]
  watcher: WorkflowWatcher | null
  watchPath: string | null
  timer: TimerHandle | null
  closed: boolean
}

interface YamlEntry {
  dirent: Dirent
  path: string
}

interface GroupLocation {
  dir: string | null
  watch: WatchTarget | null
}

export function workflowsDir(): string {
  return join(userDataDir(), 'workflows')
}

export function repoKeyOf(repoRoot: string): string {
  return createHash('sha256').update(repoRoot).digest('hex').slice(0, 12)
}

function errorCode(err: unknown): string {
  return err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : 'unknown'
}

export function resolvePrimaryCheckout(root: string): string | null {
  try {
    const top = realpathSync(root)
    const entry = join(top, '.git')
    const stats = lstatSync(entry)
    if (stats.isDirectory()) return top
    if (!stats.isFile() || stats.size > 4096) return null
    const first = readFileSync(entry, 'utf8').split('\n')[0]?.trim() ?? ''
    if (!first.startsWith('gitdir:')) return null
    const gitDir = resolve(top, first.slice('gitdir:'.length).trim())
    let commonDir = gitDir
    try {
      commonDir = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim())
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') return null
    }
    const realCommon = realpathSync(commonDir)
    return basename(realCommon) === '.git' ? dirname(realCommon) : null
  } catch {
    return null
  }
}

const defaultWatch: WorkflowWatchFn = (path, listener) =>
  fsWatch(path, { persistent: false }, (eventType, filename) =>
    listener(eventType, filename == null ? null : String(filename))
  )

function stemOf(filename: string): string {
  return filename.replace(YAML_EXTENSION, '')
}

function slugOf(stem: string): string {
  return stem
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export function definitionSlug(name: string): string {
  return slugOf(slugOf(name).slice(0, MAX_SLUG_CHARS))
}

function repoIdPrefix(key: string): string {
  return `repo:${key}:`
}

export function repoDefinitionId(repoRoot: string, path: string): string | null {
  const slug = slugOf(stemOf(basename(path)))
  return slug ? `${repoIdPrefix(repoKeyOf(repoRoot))}${slug}` : null
}

function truncate(text: string): string {
  return text.length <= MAX_ISSUE_LENGTH ? text : `${text.slice(0, MAX_ISSUE_LENGTH - 1)}…`
}

export function capIssues(diagnostics: readonly WorkflowDiagnostic[]): string[] {
  const ordered = [
    ...diagnostics.filter((d) => d.severity === 'error'),
    ...diagnostics.filter((d) => d.severity !== 'error')
  ]
  return ordered.slice(0, MAX_ISSUES).map((d) => truncate(`Line ${d.line}: ${d.message}`))
}

function readBounded(path: string): Buffer | SkipReason {
  let fd: number
  try {
    fd = openSync(path, OPEN_FLAGS)
  } catch (err) {
    return errorCode(err) === 'ELOOP' ? 'symlink' : 'unreadable'
  }
  try {
    const stats = fstatSync(fd)
    if (!stats.isFile()) return 'not-a-file'
    if (stats.size > MAX_WORKFLOW_FILE_BYTES) return 'too-large'
    const buffer = Buffer.alloc(MAX_WORKFLOW_FILE_BYTES + 1)
    let total = 0
    while (total < buffer.length) {
      const read = readSync(fd, buffer, total, buffer.length - total, null)
      if (read === 0) break
      total += read
    }
    return total > MAX_WORKFLOW_FILE_BYTES ? 'too-large' : Buffer.from(buffer.subarray(0, total))
  } catch {
    return 'unreadable'
  } finally {
    closeSync(fd)
  }
}

function lstatOrNull(path: string): Stats | null | 'error' {
  try {
    return lstatSync(path)
  } catch (err) {
    const code = errorCode(err)
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : 'error'
  }
}

function realDirectory(stats: Stats | null | 'error'): boolean {
  return stats !== null && stats !== 'error' && !stats.isSymbolicLink() && stats.isDirectory()
}

function regularFile(stats: Stats | null | 'error'): boolean {
  return stats !== null && stats !== 'error' && !stats.isSymbolicLink() && stats.isFile()
}

function writeAll(fd: number, bytes: Buffer): void {
  let written = 0
  while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written)
}

function writeAtomically(target: string, bytes: Buffer, replace: boolean): void {
  const temp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
  const fd = openSync(temp, TEMP_FLAGS, 0o644)
  let placed = false
  try {
    try {
      writeAll(fd, bytes)
    } finally {
      closeSync(fd)
    }
    if (replace) {
      renameSync(temp, target)
      placed = true
    } else {
      linkSync(temp, target)
    }
  } finally {
    if (!placed) {
      try {
        unlinkSync(temp)
      } catch (err) {
        if (errorCode(err) !== 'ENOENT') throw err
      }
    }
  }
}

export function createWorkflowDefsLoader(deps: WorkflowDefsLoaderDeps): WorkflowDefsLoader {
  const { dir, dispatch } = deps
  const log = deps.log ?? defaultLog
  const resolveCheckout = deps.resolvePrimaryCheckout ?? resolvePrimaryCheckout
  const watch = deps.watch ?? defaultWatch
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle: TimerHandle) => clearTimeout(handle))
  let disposed = false

  function newGroup(key: string, repoRoot: string | null, checkout: string | null): Group {
    return {
      key,
      repoRoot,
      checkout,
      files: new Map(),
      summaries: [],
      watcher: null,
      watchPath: null,
      timer: null,
      closed: false
    }
  }

  const personal = newGroup(PERSONAL_KEY, null, null)
  const repoGroups = new Map<string, Group>()
  for (const root of deps.repoRoots ?? []) {
    repoGroups.set(repoKeyOf(root), newGroup(repoKeyOf(root), root, resolveCheckout(root)))
  }

  function skip(file: string, reason: SkipReason, extra?: Record<string, unknown>): void {
    log('workflow', 'definition skipped', { file, reason, ...extra })
  }

  function idPrefix(group: Group): string {
    return group.repoRoot === null ? 'personal:' : repoIdPrefix(group.key)
  }

  function locate(group: Group): GroupLocation {
    if (group.repoRoot === null) {
      mkdirSync(dir, { recursive: true })
      return { dir, watch: { path: dir, names: null } }
    }
    const checkout = group.checkout
    if (checkout === null) return { dir: null, watch: null }
    const harness = join(checkout, '.harness')
    const harnessStats = lstatOrNull(harness)
    if (harnessStats === null) return { dir: null, watch: { path: checkout, names: new Set(['.harness']) } }
    if (!realDirectory(harnessStats)) {
      log('workflow', 'repo definitions refused', { repoRoot: group.repoRoot, reason: 'harness-not-directory' })
      return { dir: null, watch: { path: checkout, names: new Set(['.harness']) } }
    }
    const workflows = join(harness, 'workflows')
    const workflowsStats = lstatOrNull(workflows)
    if (workflowsStats === null) return { dir: null, watch: { path: harness, names: new Set(['workflows']) } }
    if (!realDirectory(workflowsStats)) {
      log('workflow', 'repo definitions refused', { repoRoot: group.repoRoot, reason: 'workflows-not-directory' })
      return { dir: null, watch: { path: harness, names: new Set(['workflows']) } }
    }
    return { dir: workflows, watch: { path: workflows, names: null } }
  }

  function listYamlEntries(target: string): YamlEntry[] {
    try {
      return readdirSync(target, { withFileTypes: true })
        .filter((dirent) => YAML_EXTENSION.test(dirent.name))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((dirent) => ({ dirent, path: join(target, dirent.name) }))
    } catch (err) {
      log('workflow', 'definitions directory unreadable', { code: errorCode(err) })
      return []
    }
  }

  function buildDetail(group: Group, path: string, id: string, bytes: Buffer): WorkflowDefinitionDetail {
    const source = bytes.toString('utf-8')
    const result = validateWorkflowDefinition(source)
    const summary: WorkflowDefinitionSummary = {
      id,
      name: result.parsed?.name ?? stemOf(basename(path)),
      scope: group.repoRoot === null ? 'personal' : 'repo',
      ...(group.repoRoot === null ? {} : { repoRoot: group.repoRoot }),
      path,
      hash: createHash('sha256').update(bytes).digest('hex'),
      stepIds: result.parsed?.steps.map((step) => step.id) ?? [],
      issues: capIssues(result.diagnostics)
    }
    return { ...result, summary, source }
  }

  function dispatchGroup(group: Group, definitions: WorkflowDefinitionSummary[]): void {
    dispatch({
      type: 'workflows/definitionsLoaded',
      payload:
        group.repoRoot === null
          ? { scope: 'personal', definitions }
          : { scope: 'repo', repoRoot: group.repoRoot, definitions }
    })
  }

  function closeWatcher(group: Group): void {
    group.watcher?.close()
    group.watcher = null
    group.watchPath = null
  }

  function schedule(group: Group): void {
    if (group.timer !== null) clearTimer(group.timer)
    group.timer = setTimer(() => {
      group.timer = null
      if (!group.closed && !disposed) scanGroup(group)
    }, WORKFLOW_WATCH_DEBOUNCE_MS)
  }

  function ensureWatch(group: Group, target: WatchTarget | null): void {
    closeWatcher(group)
    if (target === null) return
    const self = basename(target.path)
    const relevant = (filename: string | null): boolean =>
      filename === null ||
      filename === self ||
      (target.names === null ? YAML_EXTENSION.test(filename) : target.names.has(filename))
    try {
      const watcher = watch(target.path, (_eventType, filename) => {
        if (!group.closed && !disposed && relevant(filename)) schedule(group)
      })
      watcher.on('error', (err) => {
        log('workflow', 'definitions watcher failed', { group: group.key, code: errorCode(err) })
        if (group.watcher === watcher) closeWatcher(group)
        else watcher.close()
      })
      group.watcher = watcher
      group.watchPath = target.path
    } catch (err) {
      log('workflow', 'definitions watcher unavailable', { group: group.key, code: errorCode(err) })
    }
  }

  function scanGroup(group: Group): number {
    if (disposed || group.closed) return 0
    let location: GroupLocation
    try {
      location = locate(group)
    } catch (err) {
      log('workflow', 'definitions directory unreadable', { code: errorCode(err) })
      location = { dir: null, watch: null }
    }
    ensureWatch(group, location.watch)
    const entries = location.dir === null ? [] : listYamlEntries(location.dir)
    const prefix = idPrefix(group)
    const claimed = new Set<string>()
    const nextFiles = new Map<string, string>()
    const definitions: WorkflowDefinitionSummary[] = []
    let skipped = 0
    if (entries.length > MAX_WORKFLOW_FILES) {
      skip(location.dir ?? '', 'too-many-files', { ignored: entries.length - MAX_WORKFLOW_FILES })
      skipped += entries.length - MAX_WORKFLOW_FILES
    }
    for (const { dirent, path } of entries.slice(0, MAX_WORKFLOW_FILES)) {
      const file = dirent.name
      const slug = slugOf(stemOf(file))
      if (!slug) {
        skip(file, 'empty-id')
        skipped += 1
        continue
      }
      const id = `${prefix}${slug}`
      if (claimed.has(id)) {
        skip(file, 'duplicate-id', { id })
        skipped += 1
        continue
      }
      claimed.add(id)
      const bytes = dirent.isSymbolicLink() ? 'symlink' : !dirent.isFile() ? 'not-a-file' : readBounded(path)
      if (typeof bytes === 'string') {
        skip(file, bytes, { id })
        skipped += 1
        continue
      }
      const detail = buildDetail(group, path, id, bytes)
      const errors = detail.diagnostics.filter((d) => d.severity === 'error').length
      log('workflow', 'definition loaded', {
        file,
        id,
        errors,
        warnings: detail.diagnostics.length - errors,
        unsupported: detail.diagnostics.filter((d) => d.code === 'unsupported-feature').length
      })
      nextFiles.set(id, path)
      definitions.push(detail.summary)
    }
    group.files = nextFiles
    group.summaries = definitions
    dispatchGroup(group, definitions)
    log('workflow', 'definitions scanned', { group: group.key, loaded: definitions.length, skipped })
    return definitions.length
  }

  function closeGroup(group: Group): void {
    group.closed = true
    if (group.timer !== null) clearTimer(group.timer)
    group.timer = null
    closeWatcher(group)
  }

  function reload(): number {
    let total = scanGroup(personal)
    for (const group of repoGroups.values()) total += scanGroup(group)
    return total
  }

  function setRepoRoots(roots: readonly string[]): void {
    if (disposed) return
    const wanted = new Map(roots.map((root) => [repoKeyOf(root), root]))
    for (const [key, group] of repoGroups) {
      if (wanted.get(key) === group.repoRoot) continue
      closeGroup(group)
      repoGroups.delete(key)
      dispatchGroup(group, [])
    }
    for (const [key, root] of wanted) {
      const checkout = resolveCheckout(root)
      const existing = repoGroups.get(key)
      if (existing && existing.checkout === checkout) continue
      if (existing) {
        existing.checkout = checkout
        scanGroup(existing)
        continue
      }
      const group = newGroup(key, root, checkout)
      repoGroups.set(key, group)
      scanGroup(group)
    }
  }

  function groupForId(id: string): Group | null {
    if (PERSONAL_ID_PATTERN.test(id)) return personal
    const match = REPO_ID_PATTERN.exec(id)
    return match ? (repoGroups.get(match[1]) ?? null) : null
  }

  function getDefinition(id: unknown): WorkflowDefinitionDetail | null {
    if (typeof id !== 'string' || disposed) return null
    const group = groupForId(id)
    const path = group?.files.get(id)
    if (!group || !path) return null
    const bytes = readBounded(path)
    if (typeof bytes === 'string') {
      skip(basename(path), bytes, { id })
      scanGroup(group)
      return null
    }
    const detail = buildDetail(group, path, id, bytes)
    const cached = group.summaries.find((summary) => summary.id === id)
    if (cached?.hash !== detail.summary.hash) scanGroup(group)
    return detail
  }

  function groupForRequest(request: SaveDefinitionRequest): Group | null {
    if (request.scope === 'personal') return personal
    const group = repoGroups.get(repoKeyOf(request.repoRoot))
    return group && group.repoRoot === request.repoRoot ? group : null
  }

  function currentDir(group: Group): string | null {
    try {
      return locate(group).dir
    } catch (err) {
      log('workflow', 'definitions directory unreadable', { code: errorCode(err) })
      return null
    }
  }

  function storeSummary(group: Group, id: string, path: string, summary: WorkflowDefinitionSummary): void {
    group.files.set(id, path)
    const index = group.summaries.findIndex((entry) => entry.id === id)
    group.summaries =
      index === -1
        ? [...group.summaries, summary]
        : [...group.summaries.slice(0, index), summary, ...group.summaries.slice(index + 1)]
  }

  function writeDefinition(
    group: Group,
    existingId: string | undefined,
    name: string,
    source: string
  ): SaveDefinitionResult {
    const bytes = Buffer.from(source, 'utf8')
    if (bytes.length > MAX_WORKFLOW_FILE_BYTES) return { ok: false, reason: 'too-large' }
    const target = currentDir(group)
    if (target === null) return { ok: false, reason: group.repoRoot === null ? 'write-failed' : 'no-repo-dir' }
    let id: string
    let path: string
    if (existingId !== undefined) {
      if (groupForId(existingId) !== group) return { ok: false, reason: 'scope-mismatch' }
      const known = group.files.get(existingId)
      if (known === undefined) return { ok: false, reason: 'unknown-definition' }
      if (dirname(known) !== target || !regularFile(lstatOrNull(known))) return { ok: false, reason: 'not-a-file' }
      id = existingId
      path = known
    } else {
      const slug = definitionSlug(name)
      if (!slug) return { ok: false, reason: 'invalid-name' }
      const entries = listYamlEntries(target)
      if (entries.some(({ dirent }) => slugOf(stemOf(dirent.name)) === slug)) return { ok: false, reason: 'exists' }
      if (entries.length >= MAX_WORKFLOW_FILES) return { ok: false, reason: 'too-many-files' }
      id = `${idPrefix(group)}${slug}`
      path = join(target, `${slug}.yaml`)
    }
    try {
      writeAtomically(path, bytes, existingId !== undefined)
    } catch (err) {
      const code = errorCode(err)
      log('workflow', 'definition save failed', { id, code })
      return { ok: false, reason: code === 'EEXIST' ? 'exists' : 'write-failed' }
    }
    const { summary } = buildDetail(group, path, id, bytes)
    storeSummary(group, id, path, summary)
    dispatch({ type: 'workflows/definitionSaved', payload: summary })
    log('workflow', 'definition saved', { id, scope: summary.scope })
    return { ok: true, summary }
  }

  function saveDefinition(request: SaveDefinitionRequest): SaveDefinitionResult {
    if (disposed) return { ok: false, reason: 'write-failed' }
    const group = groupForRequest(request)
    if (!group) return { ok: false, reason: 'unknown-repo' }
    if (UNSAFE_NAME.test(request.name)) return { ok: false, reason: 'unsafe-name' }
    if (group.repoRoot !== null && group.checkout === null) return { ok: false, reason: 'no-repo-dir' }
    return writeDefinition(group, request.defId, request.name, request.source)
  }

  function takenNames(): Set<string> {
    const names = new Set(personal.summaries.map((summary) => summary.name))
    for (const group of repoGroups.values()) for (const summary of group.summaries) names.add(summary.name)
    return names
  }

  function duplicateDefinition(
    id: unknown,
    allow: (detail: WorkflowDefinitionDetail) => boolean
  ): SaveDefinitionResult {
    const detail = getDefinition(id)
    if (!detail) return { ok: false, reason: 'unknown-definition' }
    if (!allow(detail)) return { ok: false, reason: 'not-allowed' }
    const target = currentDir(personal)
    if (target === null) return { ok: false, reason: 'write-failed' }
    const slugs = new Set(listYamlEntries(target).map(({ dirent }) => slugOf(stemOf(dirent.name))))
    const names = takenNames()
    const name = copyNameCandidates(detail.summary.name).find(
      (candidate) => !names.has(candidate) && !slugs.has(definitionSlug(candidate))
    )
    if (name === undefined) return { ok: false, reason: 'exists' }
    return writeDefinition(personal, undefined, name, renameDefinitionSource(detail.source, name))
  }

  function deleteDefinition(id: unknown): DeleteDefinitionResult {
    if (typeof id !== 'string' || disposed) return { ok: false, reason: 'unknown-definition' }
    const group = groupForId(id)
    const path = group?.files.get(id)
    if (!group || path === undefined) return { ok: false, reason: 'unknown-definition' }
    if (dirname(path) !== currentDir(group) || !regularFile(lstatOrNull(path))) {
      log('workflow', 'definition delete refused', { id })
      return { ok: false, reason: 'not-a-file' }
    }
    try {
      unlinkSync(path)
    } catch (err) {
      log('workflow', 'definition delete failed', { id, code: errorCode(err) })
      return { ok: false, reason: 'write-failed' }
    }
    group.files.delete(id)
    group.summaries = group.summaries.filter((summary) => summary.id !== id)
    dispatch({ type: 'workflows/definitionDeleted', payload: { defId: id } })
    log('workflow', 'definition deleted', { id })
    return { ok: true }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    closeGroup(personal)
    for (const group of repoGroups.values()) closeGroup(group)
  }

  return { reload, getDefinition, saveDefinition, duplicateDefinition, deleteDefinition, setRepoRoots, dispose }
}

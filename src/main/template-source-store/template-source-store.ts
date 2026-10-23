import { createHash } from 'crypto'
import * as nodeFs from 'fs'
import { dirname, isAbsolute, resolve, sep } from 'path'

import { formatErr as defaultFormatErr, log as defaultLog } from '../debug'
import { HarnessConfigError, type HarnessConfigFilesystem } from '../harness-config'
import {
  classifyTemplateSourcePath,
  fragmentRelativePath,
  parseTemplateSource,
  referenceFileNameError,
  referenceRelativePath,
  serializeTemplateSource,
  templateNameError,
  templateRelativePath,
  validateTemplateTargets,
  type HarnessTemplateDraft
} from '../../shared/harness-templates'
import {
  HARNESS_TEMPLATE_KINDS,
  isFragmentSourcePath,
  type HarnessConfigEvent,
  type HarnessFragment,
  type HarnessTemplate,
  type HarnessTemplateKind,
  type HarnessTemplateParseError,
  type HarnessTemplateReference
} from '../../shared/state/harness-config'

export const MAX_TEMPLATE_SOURCE_FILE_BYTES = 1024 * 1024

const LAYOUT_DIRS = ['agents', 'skills', 'commands', 'fragments'] as const
const DEFAULT_DEBOUNCE_MS = 150

export interface TemplateSourceWatcher {
  close(): void
}

export interface TemplateSourceStoreDeps {
  sourceDir: () => string
  store: { dispatch(event: HarnessConfigEvent): void }
  filesystem?: HarnessConfigFilesystem
  watch?: (dir: string, onChange: () => void) => TemplateSourceWatcher
  clock?: () => number
  debounceMs?: number
  log?: (category: string, message: string, data?: unknown) => void
  formatErr?: (error: unknown) => string
}

interface SourceSnapshot {
  templates: Map<string, HarnessTemplate>
  fragments: Map<string, HarnessFragment>
  errors: Map<string, string>
}

interface WriteOperation {
  relativePath: string
  content?: string
}

function templateKey(kind: HarnessTemplateKind, name: string): string {
  return `${kind}/${name}`
}

function sha256(parts: string[]): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    hash.update(String(part.length))
    hash.update(':')
    hash.update(part)
  }
  return `sha256:${hash.digest('hex')}`
}

function compactTimestamp(value: number): string {
  return new Date(value).toISOString().replace(/[-:.]/g, '')
}

function defaultWatch(dir: string, onChange: () => void): TemplateSourceWatcher {
  const watcher = nodeFs.watch(dir, { recursive: true }, () => onChange())
  watcher.on('error', () => watcher.close())
  return watcher
}

function emptySnapshot(): SourceSnapshot {
  return { templates: new Map(), fragments: new Map(), errors: new Map() }
}

function errorList(errors: Map<string, string>, fragments: boolean): HarnessTemplateParseError[] {
  const list: HarnessTemplateParseError[] = []
  for (const [relativePath, message] of errors) {
    if (isFragmentSourcePath(relativePath) === fragments) list.push({ relativePath, message })
  }
  return list
}

export class TemplateSourceStore {
  private readonly deps: TemplateSourceStoreDeps
  private readonly fs: HarnessConfigFilesystem
  private readonly clock: () => number
  private readonly log: (category: string, message: string, data?: unknown) => void
  private readonly formatErr: (error: unknown) => string
  private cache: SourceSnapshot = emptySnapshot()
  private watcher: TemplateSourceWatcher | null = null
  private watchedDir: string | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private tempSequence = 0

  constructor(deps: TemplateSourceStoreDeps) {
    this.deps = deps
    this.fs = deps.filesystem ?? (nodeFs as unknown as HarnessConfigFilesystem)
    this.clock = deps.clock ?? Date.now
    this.log = deps.log ?? defaultLog
    this.formatErr = deps.formatErr ?? defaultFormatErr
  }

  start(): void {
    this.load()
    this.ensureWatching()
  }

  stop(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    this.watcher?.close()
    this.watcher = null
    this.watchedDir = null
  }

  /** Re-points the store at the current source folder (Step 16 setting). */
  restart(): void {
    this.stop()
    this.start()
  }

  load(): void {
    const snapshot = this.readSnapshot()
    const loadedAt = this.clock()
    this.deps.store.dispatch({
      type: 'harnessConfig/templatesLoaded',
      payload: { templates: [...snapshot.templates.values()], errors: errorList(snapshot.errors, false), loadedAt }
    })
    this.deps.store.dispatch({
      type: 'harnessConfig/fragmentsLoaded',
      payload: { fragments: [...snapshot.fragments.values()], errors: errorList(snapshot.errors, true), loadedAt }
    })
    this.cache = snapshot
  }

  /** Rescans the folder and dispatches only what changed since the last
   *  scan, so watcher echoes of Tatsu's own writes dispatch nothing. */
  refresh(): void {
    const next = this.readSnapshot()
    const previous = this.cache
    const dispatch = this.deps.store.dispatch.bind(this.deps.store)
    const touched = new Set<string>()

    for (const [key, template] of next.templates) {
      const before = previous.templates.get(key)
      if (before && before.hash === template.hash && before.relativePath === template.relativePath) {
        next.templates.set(key, before)
        continue
      }
      dispatch({ type: 'harnessConfig/templateChanged', payload: template })
      touched.add(template.relativePath)
    }
    for (const [key, template] of previous.templates) {
      if (!next.templates.has(key)) {
        dispatch({ type: 'harnessConfig/templateRemoved', payload: { kind: template.kind, name: template.name } })
      }
    }
    for (const [name, fragment] of next.fragments) {
      const before = previous.fragments.get(name)
      if (before && before.hash === fragment.hash) {
        next.fragments.set(name, before)
        continue
      }
      dispatch({ type: 'harnessConfig/fragmentChanged', payload: fragment })
      touched.add(fragment.relativePath)
    }
    for (const [name] of previous.fragments) {
      if (!next.fragments.has(name)) dispatch({ type: 'harnessConfig/fragmentRemoved', payload: { name } })
    }
    for (const [relativePath, message] of next.errors) {
      if (previous.errors.get(relativePath) !== message) {
        dispatch({ type: 'harnessConfig/templateSourceErrorChanged', payload: { relativePath, message } })
      }
    }
    for (const relativePath of previous.errors.keys()) {
      if (!next.errors.has(relativePath) && !touched.has(relativePath)) {
        dispatch({ type: 'harnessConfig/templateSourceErrorChanged', payload: { relativePath, message: null } })
      }
    }
    this.cache = next
  }

  getTemplate(kind: HarnessTemplateKind, name: string): HarnessTemplate | undefined {
    return this.cache.templates.get(templateKey(kind, name))
  }

  getFragment(name: string): HarnessFragment | undefined {
    return this.cache.fragments.get(name)
  }

  saveTemplate(draft: HarnessTemplateDraft): HarnessTemplate {
    const nameError = templateNameError(draft.name)
    if (nameError) throw new HarnessConfigError('invalid-name', nameError)
    if (!HARNESS_TEMPLATE_KINDS.includes(draft.kind)) {
      throw new HarnessConfigError('invalid-template', 'The template kind is unknown')
    }
    const targetErrors = validateTemplateTargets(draft)
    if (targetErrors.length > 0) {
      throw new HarnessConfigError('invalid-target', targetErrors.map((error) => error.message).join(' '))
    }
    if (draft.kind !== 'skill' && draft.references.length > 0) {
      throw new HarnessConfigError('invalid-template', 'Only skill templates can have reference files')
    }
    const seen = new Set<string>()
    for (const reference of draft.references) {
      const error = referenceFileNameError(reference.fileName)
      if (error) throw new HarnessConfigError('invalid-name', error)
      if (seen.has(reference.fileName)) {
        throw new HarnessConfigError('collision', 'Two reference files have the same name')
      }
      seen.add(reference.fileName)
    }
    const source = serializeTemplateSource(draft)
    const reparsed = parseTemplateSource(draft.kind, draft.name, source, draft.references)
    if (!reparsed.ok) throw new HarnessConfigError('invalid-template', reparsed.message)

    const operations: WriteOperation[] = [{ relativePath: templateRelativePath(draft.kind, draft.name), content: source }]
    if (draft.kind === 'skill') {
      for (const reference of draft.references) {
        operations.push({ relativePath: referenceRelativePath(draft.name, reference.fileName), content: reference.content })
      }
      for (const fileName of this.existingReferenceNames(draft.name)) {
        if (!seen.has(fileName)) operations.push({ relativePath: referenceRelativePath(draft.name, fileName) })
      }
    }
    this.apply(operations)
    this.refresh()
    const saved = this.getTemplate(draft.kind, draft.name)
    if (!saved) throw new HarnessConfigError('read-failed', 'The saved template could not be read back')
    return saved
  }

  deleteTemplate(kind: HarnessTemplateKind, name: string): void {
    const nameError = templateNameError(name)
    if (nameError) throw new HarnessConfigError('invalid-name', nameError)
    const relativePath = templateRelativePath(kind, name)
    if (!this.fileExists(relativePath)) {
      throw new HarnessConfigError('unknown-resource', 'The template does not exist')
    }
    const operations: WriteOperation[] = [{ relativePath }]
    if (kind === 'skill') {
      for (const fileName of this.existingReferenceNames(name)) {
        operations.push({ relativePath: referenceRelativePath(name, fileName) })
      }
    }
    this.apply(operations)
    this.refresh()
  }

  saveFragment(name: string, content: string): HarnessFragment {
    const nameError = templateNameError(name)
    if (nameError) throw new HarnessConfigError('invalid-name', nameError)
    this.apply([{ relativePath: fragmentRelativePath(name), content }])
    this.refresh()
    const saved = this.getFragment(name)
    if (!saved) throw new HarnessConfigError('read-failed', 'The saved fragment could not be read back')
    return saved
  }

  deleteFragment(name: string): void {
    const nameError = templateNameError(name)
    if (nameError) throw new HarnessConfigError('invalid-name', nameError)
    const relativePath = fragmentRelativePath(name)
    if (!this.fileExists(relativePath)) {
      throw new HarnessConfigError('unknown-resource', 'The fragment does not exist')
    }
    this.apply([{ relativePath }])
    this.refresh()
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      try {
        this.refresh()
      } catch (error) {
        this.log('harness-config', 'template source refresh failed', this.formatErr(error))
      }
    }, this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS)
  }

  private ensureWatching(): void {
    const root = this.lexicalRoot()
    if (!root || (this.watcher && this.watchedDir === root)) return
    if (!this.isDirectory(root)) return
    try {
      this.watcher = (this.deps.watch ?? defaultWatch)(root, () => this.scheduleRefresh())
      this.watchedDir = root
    } catch (error) {
      this.log('harness-config', 'unable to watch the template source folder', this.formatErr(error))
    }
  }

  private lexicalRoot(): string | null {
    const value = this.deps.sourceDir()
    if (!value || !isAbsolute(value)) return null
    return resolve(value)
  }

  private isDirectory(path: string): boolean {
    try {
      return this.fs.statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  private readRoot(): string | null {
    const root = this.lexicalRoot()
    if (!root || !this.isDirectory(root)) return null
    try {
      return resolve(this.fs.realpathSync(root))
    } catch {
      return null
    }
  }

  private readSnapshot(): SourceSnapshot {
    const snapshot = emptySnapshot()
    const root = this.readRoot()
    if (!root) return snapshot

    const references = new Map<string, HarnessTemplateReference[]>()
    const templateFiles: { kind: HarnessTemplateKind; name: string; relativePath: string }[] = []

    for (const relativePath of this.listFiles(root, snapshot.errors)) {
      const entry = classifyTemplateSourcePath(relativePath)
      if (!entry) continue
      if (entry.type === 'template') {
        templateFiles.push({ kind: entry.kind, name: entry.name, relativePath })
        continue
      }
      const content = this.readText(root, relativePath, snapshot.errors)
      if (content === null) continue
      if (entry.type === 'fragment') {
        snapshot.fragments.set(entry.name, {
          name: entry.name,
          content,
          relativePath,
          hash: sha256([content])
        })
      } else {
        const list = references.get(entry.name) ?? []
        list.push({ fileName: entry.fileName, content })
        references.set(entry.name, list)
      }
    }

    for (const file of templateFiles) {
      const source = this.readText(root, file.relativePath, snapshot.errors)
      if (source === null) continue
      const refs = file.kind === 'skill' ? (references.get(file.name) ?? []) : []
      const parsed = parseTemplateSource(file.kind, file.name, source, refs)
      if (!parsed.ok) {
        snapshot.errors.set(file.relativePath, parsed.message)
        continue
      }
      const hashParts = [source]
      for (const reference of parsed.template.references) hashParts.push(reference.fileName, reference.content)
      snapshot.templates.set(templateKey(file.kind, file.name), {
        ...parsed.template,
        relativePath: file.relativePath,
        hash: sha256(hashParts)
      })
    }
    return snapshot
  }

  private listFiles(root: string, errors: Map<string, string>): string[] {
    const files: string[] = []
    const walk = (relativeDir: string, depth: number): void => {
      let entries: nodeFs.Dirent[]
      try {
        entries = this.fs.readdirSync(resolve(root, ...relativeDir.split('/')), { withFileTypes: true })
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ENOTDIR') errors.set(relativeDir, 'The folder could not be read')
        return
      }
      for (const entry of entries) {
        const relativePath = `${relativeDir}/${entry.name}`
        if (entry.isSymbolicLink()) {
          if (classifyTemplateSourcePath(relativePath) !== null || relativeDir === 'skills') {
            errors.set(relativePath, 'Symbolic links are not read from the template source folder')
          }
        } else if (entry.isDirectory()) {
          if (depth < 2 && !entry.name.startsWith('.')) walk(relativePath, depth + 1)
        } else if (entry.isFile()) {
          files.push(relativePath)
        }
      }
    }
    for (const dir of LAYOUT_DIRS) {
      try {
        if (this.fs.lstatSync(resolve(root, dir)).isSymbolicLink()) {
          errors.set(dir, 'Symbolic links are not read from the template source folder')
          continue
        }
      } catch {
        continue
      }
      walk(dir, 0)
    }
    return files.sort()
  }

  private readText(root: string, relativePath: string, errors: Map<string, string>): string | null {
    try {
      const absolutePath = resolve(root, ...relativePath.split('/'))
      if (this.fs.lstatSync(absolutePath).size > MAX_TEMPLATE_SOURCE_FILE_BYTES) {
        errors.set(relativePath, 'The file is larger than 1 MB')
        return null
      }
      return this.fs.readFileSync(absolutePath).toString('utf8')
    } catch {
      errors.set(relativePath, 'The file could not be read')
      return null
    }
  }

  private existingReferenceNames(name: string): string[] {
    const root = this.readRoot()
    if (!root) return []
    const dir = resolve(root, 'skills', name, 'references')
    try {
      if (this.fs.lstatSync(dir).isSymbolicLink()) return []
      return this.fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && referenceFileNameError(entry.name) === null)
        .map((entry) => entry.name)
        .sort()
    } catch {
      return []
    }
  }

  private fileExists(relativePath: string): boolean {
    const root = this.readRoot()
    if (!root) return false
    try {
      return this.fs.lstatSync(resolve(root, ...relativePath.split('/'))).isFile()
    } catch {
      return false
    }
  }

  private writeRoot(): string {
    const root = this.lexicalRoot()
    if (!root) throw new HarnessConfigError('unsupported-scope', 'The template source folder is not configured')
    try {
      this.fs.mkdirSync(root, { recursive: true })
      if (!this.fs.statSync(root).isDirectory()) throw new Error('not a directory')
      return resolve(this.fs.realpathSync(root))
    } catch (error) {
      throw new HarnessConfigError('write-failed', 'The template source folder is unavailable', { cause: error })
    }
  }

  private resolveWriteTarget(root: string, relativePath: string): string {
    const target = resolve(root, ...relativePath.split('/'))
    if (!target.startsWith(root + sep)) {
      throw new HarnessConfigError('unsafe-path', 'The template path escapes the source folder')
    }
    let cursor = target
    while (cursor !== root) {
      try {
        const info = this.fs.lstatSync(cursor)
        if (info.isSymbolicLink()) {
          throw new HarnessConfigError('unsafe-path', 'A symbolic link makes the template path unsafe')
        }
        if (cursor !== target && !info.isDirectory()) {
          throw new HarnessConfigError('unsafe-path', 'The template path crosses a non-directory')
        }
        if (cursor === target && !info.isFile()) {
          throw new HarnessConfigError('unsafe-path', 'The template path is not a regular file')
        }
      } catch (error) {
        if (error instanceof HarnessConfigError) throw error
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new HarnessConfigError('unsafe-path', 'Unable to verify the template path', { cause: error })
        }
      }
      cursor = dirname(cursor)
    }
    return target
  }

  /** Backs up every file the operations overwrite or delete before any
   *  write happens, so a failed backup leaves the folder untouched. */
  private apply(operations: WriteOperation[]): void {
    const root = this.writeRoot()
    const targets = operations.map((operation) => ({
      operation,
      absolutePath: this.resolveWriteTarget(root, operation.relativePath)
    }))
    const changing = targets.filter(({ operation, absolutePath }) => {
      if (!this.fs.existsSync(absolutePath)) return false
      if (operation.content === undefined) return true
      return this.fs.readFileSync(absolutePath).toString('utf8') !== operation.content
    })
    const backups: string[] = []
    try {
      for (const { absolutePath } of changing) backups.push(this.createBackup(absolutePath))
    } catch (error) {
      for (const backup of backups) {
        try {
          this.fs.unlinkSync(backup)
        } catch (cleanupError) {
          this.log('harness-config', 'template backup cleanup failed', this.formatErr(cleanupError))
        }
      }
      throw error
    }
    for (const { operation, absolutePath } of targets) {
      if (operation.content === undefined) {
        try {
          this.fs.unlinkSync(absolutePath)
        } catch (error) {
          throw new HarnessConfigError('delete-failed', 'Unable to delete the template file', { cause: error })
        }
        continue
      }
      const unchanged = this.fs.existsSync(absolutePath) && !changing.some((entry) => entry.absolutePath === absolutePath)
      if (!unchanged) this.atomicWrite(absolutePath, Buffer.from(operation.content, 'utf8'))
    }
    this.ensureWatching()
  }

  private createBackup(target: string): string {
    let bytes: Buffer
    try {
      bytes = this.fs.readFileSync(target)
    } catch (error) {
      throw new HarnessConfigError('backup-failed', 'Unable to read the template file for backup', { cause: error })
    }
    const base = `${target}.x-backup-${compactTimestamp(this.clock())}`
    for (let collision = 1; ; collision += 1) {
      const backup = collision === 1 ? base : `${base}-${collision}`
      if (this.fs.existsSync(backup)) continue
      try {
        this.fs.writeFileSync(backup, bytes, { flag: 'wx' })
        return backup
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        try {
          if (this.fs.existsSync(backup)) this.fs.unlinkSync(backup)
        } catch (cleanupError) {
          this.log('harness-config', 'template backup cleanup failed', this.formatErr(cleanupError))
        }
        throw new HarnessConfigError('backup-failed', 'Unable to create the template backup', { cause: error })
      }
    }
  }

  private atomicWrite(target: string, bytes: Buffer): void {
    const temporary = `${target}.harness-config-${this.clock()}-${++this.tempSequence}.tmp-${process.pid}`
    try {
      this.fs.mkdirSync(dirname(target), { recursive: true })
      this.fs.writeFileSync(temporary, bytes, { flag: 'wx' })
      this.fs.renameSync(temporary, target)
    } catch (error) {
      try {
        if (this.fs.existsSync(temporary)) this.fs.unlinkSync(temporary)
      } catch (cleanupError) {
        this.log('harness-config', 'template temporary-file cleanup failed', this.formatErr(cleanupError))
      }
      throw new HarnessConfigError('write-failed', 'Unable to write the template file', { cause: error })
    }
  }
}

export function createTemplateSourceStore(deps: TemplateSourceStoreDeps): TemplateSourceStore {
  return new TemplateSourceStore(deps)
}

import { join, relative, resolve, sep } from 'path'
import { CORE_SCHEMA, load } from 'js-yaml'

import {
  parseTemplateHarnessBlock,
  parseTemplateSource,
  referenceFileNameError,
  serializeTemplateSource,
  TEMPLATE_HARNESSES,
  templateNameError,
  templateTargets,
  validateTemplateTargets,
  type HarnessTemplateDraft
} from '../../shared/harness-templates'
import { TEMPLATE_MARKER_KEY } from '../../shared/harness-template-render'
import type {
  HarnessTemplateHarnessBlock,
  HarnessTemplateHarnesses,
  HarnessTemplateImportChoices,
  HarnessTemplateImportCoveredCommand,
  HarnessTemplateImportDuplicate,
  HarnessTemplateImportIssue,
  HarnessTemplateImportItem,
  HarnessTemplateImportSetting,
  HarnessTemplateKind,
  HarnessTemplateReference,
  ManagedHarnessKind
} from '../../shared/state/harness-config'

/** One picked folder as the main process read it. Only markdown files
 *  are read; symbolic links are recorded with their real target and
 *  never followed out of the folder. */
export interface ImportFolderListing {
  root: string
  realRoot?: string
  /** Relative POSIX path to file contents. */
  files: Record<string, string>
  /** Relative POSIX path of a symbolic link to its absolute real target. */
  links: Record<string, string>
  skipped: HarnessTemplateImportIssue[]
}

export interface TemplateImportListing {
  agents: ImportFolderListing | null
  agentFragments: ImportFolderListing | null
  skills: ImportFolderListing[]
  references: ImportFolderListing | null
  commands: ImportFolderListing | null
}

export interface TemplateImportOptions extends HarnessTemplateImportChoices {
  /** Keys already in the template source folder: `<kind>/<name>` and
   *  `fragment/<name>`. */
  existing: ReadonlySet<string>
  /** Per-harness frontmatter keys the old build wrote outside resource
   *  files. Defaults to `OUTSIDE_FILE_SETTINGS`. */
  outsideSettings?: Partial<Record<ManagedHarnessKind, readonly string[]>>
}

export interface ImportedTemplate {
  item: HarnessTemplateImportItem
  draft: HarnessTemplateDraft | null
}

export interface ImportedFragment {
  item: HarnessTemplateImportItem
  content: string
}

export interface TemplateImportResult {
  templates: ImportedTemplate[]
  fragments: ImportedFragment[]
  duplicates: HarnessTemplateImportDuplicate[]
  coveredCommands: HarnessTemplateImportCoveredCommand[]
  unknownFiles: HarnessTemplateImportIssue[]
  blockingReasons: string[]
}

/** Settings the reference build sent to `opencode.json` instead of the
 *  agent file (REQ-006). They have no place in a resource file. */
export const OUTSIDE_FILE_SETTINGS: Partial<Record<ManagedHarnessKind, readonly string[]>> = {
  opencode: ['model', 'fallback_models', 'variant', 'temperature', 'skills', 'mcps']
}

/** Harness block keys Tatsu recognizes but does not manage. */
export const UNMANAGED_HARNESS_KEYS: readonly string[] = ['omp', 'pi']

export const SKILL_SOURCE_FILE = 'SKILL.md'

const MARKDOWN_SUFFIX = '.md'
const FRAGMENT_LIST_KEYS = ['shared', 'fragments'] as const
const MARKDOWN_LINK = /\]\(\s*<?([^)\s>]+?\.md)(?:#[^)\s>]*)?>?(?:\s+"[^"]*")?\s*\)/g

interface ParsedSource {
  data: Record<string, unknown>
  body: string
}

interface ItemSeed {
  kind: HarnessTemplateKind
  stem: string
  sourcePath: string
  source: string
  references?: HarnessTemplateReference[]
  notes?: string[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function displayValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function splitSource(source: string): ParsedSource {
  const text = source.replace(/^﻿/, '')
  const lines = text.split('\n')
  if (lines[0]?.replace(/\r$/, '') !== '---') return { data: {}, body: text }
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].replace(/\r$/, '') !== '---') continue
    let data: unknown
    try {
      data = load(lines.slice(1, index).join('\n'), { schema: CORE_SCHEMA })
    } catch (error) {
      const reason = error instanceof Error ? error.message.split('\n')[0] : 'invalid YAML'
      throw new Error(`The frontmatter is not valid YAML: ${reason}`)
    }
    if (data === undefined || data === null) data = {}
    if (!isPlainObject(data)) throw new Error('The frontmatter must be a mapping')
    return { data, body: lines.slice(index + 1).join('\n') }
  }
  throw new Error('The frontmatter block is not closed')
}

function stripMarkdown(fileName: string): string | null {
  return fileName.endsWith(MARKDOWN_SUFFIX) ? fileName.slice(0, -MARKDOWN_SUFFIX.length) : null
}

function fragmentNames(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be a list of fragment names`)
  return value.map((entry) => {
    const name = typeof entry === 'string' ? (stripMarkdown(entry) ?? entry) : entry
    const error = templateNameError(name)
    if (error) throw new Error(`${field} has an invalid fragment name: ${error}`)
    return name as string
  })
}

function isMultiHarness(data: Record<string, unknown>): boolean {
  return Object.keys(data).some(
    (key) => TEMPLATE_HARNESSES.includes(key as ManagedHarnessKind) || UNMANAGED_HARNESS_KEYS.includes(key)
  )
}

function isInside(root: string | undefined, target: string): boolean {
  return !!root && (target === root || target.startsWith(root.endsWith(sep) ? root : root + sep))
}

function emptyItem(kind: HarnessTemplateKind | null, name: string, sourcePath: string): HarnessTemplateImportItem {
  return {
    key: kind ? `${kind}/${name}` : `fragment/${name}`,
    type: kind ? 'template' : 'fragment',
    kind,
    name,
    sourcePath,
    targets: [],
    fragments: [],
    references: [],
    droppedBlocks: [],
    unsupportedSettings: [],
    notes: [],
    conflict: false,
    action: 'create',
    error: null
  }
}

class Importer {
  readonly unknownFiles: HarnessTemplateImportIssue[] = []
  private readonly outside: Partial<Record<ManagedHarnessKind, readonly string[]>>

  constructor(
    private readonly listing: TemplateImportListing,
    private readonly options: TemplateImportOptions
  ) {
    this.outside = options.outsideSettings ?? OUTSIDE_FILE_SETTINGS
    for (const folder of [listing.agents, listing.agentFragments, listing.references, listing.commands, ...listing.skills]) {
      if (folder) this.unknownFiles.push(...folder.skipped)
    }
  }

  unknown(folder: ImportFolderListing, relativePath: string, message: string): void {
    this.unknownFiles.push({ sourcePath: join(folder.root, ...relativePath.split('/')), message })
  }

  /** Top-level markdown files of a flat folder; everything else is
   *  listed as unknown. */
  flatEntries(folder: ImportFolderListing, noun: string): { stem: string; relativePath: string; content: string }[] {
    const entries: { stem: string; relativePath: string; content: string }[] = []
    for (const [relativePath, content] of Object.entries(folder.files).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const stem = relativePath.includes('/') ? null : stripMarkdown(relativePath)
      if (stem === null) {
        this.unknown(folder, relativePath, `Not a top-level ${noun} file`)
        continue
      }
      entries.push({ stem, relativePath, content })
    }
    for (const relativePath of Object.keys(folder.links).sort()) {
      this.unknown(folder, relativePath, 'Symbolic link not followed')
    }
    return entries
  }

  referenceFor(target: string): { content: string } | null {
    const refs = this.listing.references
    if (!refs) return null
    for (const root of [refs.realRoot, refs.root]) {
      if (!isInside(root, target)) continue
      const rel = relative(root as string, target).split(sep).join('/')
      const content = refs.files[rel]
      if (content !== undefined) return { content }
    }
    return null
  }

  stripOutsideSettings(
    harness: ManagedHarnessKind,
    block: HarnessTemplateHarnessBlock,
    unsupported: HarnessTemplateImportSetting[]
  ): void {
    const keys = [...(this.outside[harness] ?? []), TEMPLATE_MARKER_KEY]
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(block.frontmatter, key)) continue
      unsupported.push({ harness, key, value: displayValue(block.frontmatter[key]) })
      delete block.frontmatter[key]
    }
  }

  buildTemplate(seed: ItemSeed): ImportedTemplate {
    let item = emptyItem(seed.kind, seed.stem, seed.sourcePath)
    try {
      const { data, body } = splitSource(seed.source)
      const fmName = data.name
      let name = seed.stem
      if (typeof fmName === 'string' && templateNameError(fmName) === null) {
        name = fmName
        if (fmName !== seed.stem) item.notes.push(`Imported as "${fmName}" from its frontmatter name`)
      }
      item = { ...emptyItem(seed.kind, name, seed.sourcePath), notes: [...item.notes, ...(seed.notes ?? [])] }
      const nameError = templateNameError(name)
      if (nameError) throw new Error(nameError)
      if (data.description !== undefined && typeof data.description !== 'string') {
        throw new Error('description must be text')
      }

      let fragments: string[] = []
      for (const key of FRAGMENT_LIST_KEYS) {
        if (data[key] !== undefined) fragments = [...fragments, ...fragmentNames(data[key], key)]
      }
      const harnesses: HarnessTemplateHarnesses = {}
      const multi = isMultiHarness(data)
      const lifted = new Set<string>(['name', 'description', ...FRAGMENT_LIST_KEYS])

      if (multi) {
        for (const [key, value] of Object.entries(data)) {
          if (lifted.has(key)) continue
          if (TEMPLATE_HARNESSES.includes(key as ManagedHarnessKind)) {
            const harness = key as ManagedHarnessKind
            const raw = isPlainObject(value) ? { ...value } : value
            let sharedOverride: string[] | undefined
            if (isPlainObject(raw) && raw.shared !== undefined) {
              sharedOverride = fragmentNames(raw.shared, `${harness}.shared`)
              delete raw.shared
            }
            const block = parseTemplateHarnessBlock(harness, raw)
            if (block !== false) {
              if (sharedOverride) block.fragments = [...(block.fragments ?? []), ...sharedOverride]
              this.stripOutsideSettings(harness, block, item.unsupportedSettings)
            }
            harnesses[harness] = block
          } else if (UNMANAGED_HARNESS_KEYS.includes(key) || isPlainObject(value) || value === false) {
            item.droppedBlocks.push(`${key}: Tatsu does not manage this harness`)
          } else {
            item.unsupportedSettings.push({ harness: 'top level', key, value: displayValue(value) })
          }
        }
      } else {
        const frontmatter: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(data)) {
          if (!lifted.has(key)) frontmatter[key] = value
        }
        for (const harness of this.options.harnesses) {
          const block: HarnessTemplateHarnessBlock = { frontmatter: structuredClone(frontmatter) }
          this.stripOutsideSettings(harness, block, item.unsupportedSettings)
          harnesses[harness] = block
        }
      }

      for (const error of validateTemplateTargets({ kind: seed.kind, harnesses })) {
        delete harnesses[error.agentKind]
        item.droppedBlocks.push(`${error.agentKind}: ${error.message}`)
      }

      const draft: HarnessTemplateDraft = {
        kind: seed.kind,
        name,
        description: (data.description as string | undefined) ?? '',
        fragments,
        body,
        harnesses,
        references: seed.references ?? []
      }
      const reparsed = parseTemplateSource(seed.kind, name, serializeTemplateSource(draft), draft.references)
      if (!reparsed.ok) throw new Error(reparsed.message)
      item.targets = templateTargets(draft)
      item.fragments = [...fragments]
      item.references = draft.references.map((reference) => reference.fileName)
      if (item.targets.length === 0) item.notes.push('No harness is targeted, so this template renders nothing')
      return { item, draft }
    } catch (error) {
      item.action = 'invalid'
      item.error = error instanceof Error ? error.message : 'The file could not be imported'
      return { item, draft: null }
    }
  }

  fragments(): ImportedFragment[] {
    const folder = this.listing.agentFragments
    if (!folder) return []
    return this.flatEntries(folder, 'fragment').map(({ stem, relativePath, content }) => {
      const item = emptyItem(null, stem, join(folder.root, relativePath))
      const error = templateNameError(stem)
      if (error) {
        item.action = 'invalid'
        item.error = error
      }
      return { item, content }
    })
  }

  flatTemplates(folder: ImportFolderListing | null, kind: HarnessTemplateKind, noun: string): { seed: ItemSeed }[] {
    if (!folder) return []
    return this.flatEntries(folder, noun).map(({ stem, relativePath, content }) => ({
      seed: { kind, stem, sourcePath: join(folder.root, relativePath), source: content }
    }))
  }

  skillSeeds(folder: ImportFolderListing): ItemSeed[] {
    const groups = new Map<string, { files: string[]; links: string[] }>()
    const group = (dir: string): { files: string[]; links: string[] } => {
      let entry = groups.get(dir)
      if (!entry) {
        entry = { files: [], links: [] }
        groups.set(dir, entry)
      }
      return entry
    }
    for (const relativePath of Object.keys(folder.files).sort()) {
      if (!relativePath.includes('/')) this.unknown(folder, relativePath, 'Not inside a skill folder')
      else group(relativePath.split('/')[0]).files.push(relativePath)
    }
    for (const relativePath of Object.keys(folder.links).sort()) {
      if (!relativePath.includes('/')) this.unknown(folder, relativePath, 'Symbolic link not followed')
      else group(relativePath.split('/')[0]).links.push(relativePath)
    }

    const seeds: ItemSeed[] = []
    for (const [dir, entry] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const skillFile = `${dir}/${SKILL_SOURCE_FILE}`
      if (!entry.files.includes(skillFile)) {
        for (const path of [...entry.files, ...entry.links]) this.unknown(folder, path, `No ${SKILL_SOURCE_FILE} in this folder`)
        continue
      }
      const references: HarnessTemplateReference[] = []
      const notes: string[] = []
      const addReference = (fileName: string, content: string, origin: string): void => {
        const error = referenceFileNameError(fileName)
        if (error) {
          this.unknown(folder, origin, error)
        } else if (references.some((reference) => reference.fileName === fileName)) {
          notes.push(`Reference ${fileName} appears more than once; the first one is kept`)
        } else {
          references.push({ fileName, content })
        }
      }

      for (const path of entry.files) {
        if (path === skillFile) continue
        const segments = path.split('/')
        if (segments.length === 3 && segments[1] === 'references') addReference(segments[2], folder.files[path], path)
        else this.unknown(folder, path, 'Not a skill reference file')
      }
      for (const path of entry.links) {
        const target = folder.links[path]
        const found = this.referenceFor(target)
        if (found) addReference(path.split('/').pop() as string, found.content, path)
        else this.unknown(folder, path, 'Link does not point into the shared references folder')
      }

      const source = folder.files[skillFile]
      const skillDir = resolve(folder.root, dir)
      const seenTargets = new Set<string>()
      for (const match of source.matchAll(MARKDOWN_LINK)) {
        const href = match[1]
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue
        const target = resolve(skillDir, href)
        if (seenTargets.has(target) || isInside(skillDir, target)) continue
        seenTargets.add(target)
        const found = this.referenceFor(target)
        if (found) addReference(href.split('/').pop() as string, found.content, skillFile)
        else notes.push(`Link to ${href} could not be resolved in the shared references folder`)
      }
      if (references.length > 0) {
        notes.push('Reference files are inlined into SKILL.md when rendered; links in the body stay as written')
      }
      seeds.push({
        kind: 'skill',
        stem: dir,
        sourcePath: join(folder.root, dir, SKILL_SOURCE_FILE),
        source,
        references: references.sort((a, b) => (a.fileName < b.fileName ? -1 : 1)),
        notes
      })
    }
    return seeds
  }
}

function applyConflict(item: HarnessTemplateImportItem, options: TemplateImportOptions): void {
  if (item.action === 'invalid' || !options.existing.has(item.key)) return
  item.conflict = true
  item.action = options.conflictChoices[item.key] ?? 'undecided'
}

/** Pure: turns a file listing into templates, fragments, and a report
 *  (REQ-009). Nothing here touches the filesystem. */
export function importTemplateSetup(listing: TemplateImportListing, options: TemplateImportOptions): TemplateImportResult {
  const importer = new Importer(listing, options)
  const blockingReasons: string[] = []

  const fragments = importer.fragments()

  const agents: ImportedTemplate[] = []
  const agentNames = new Set<string>()
  for (const { seed } of importer.flatTemplates(listing.agents, 'agent', 'agent')) {
    const built = importer.buildTemplate(seed)
    if (built.draft && agentNames.has(built.item.name)) {
      built.item.action = 'invalid'
      built.item.error = `Another agent file also imports as "${built.item.name}"`
      built.draft = null
    }
    if (built.draft) agentNames.add(built.item.name)
    agents.push(built)
  }

  const candidates = new Map<string, { root: string; built: ImportedTemplate }[]>()
  for (const folder of listing.skills) {
    for (const seed of importer.skillSeeds(folder)) {
      const built = importer.buildTemplate(seed)
      const list = candidates.get(built.item.name) ?? []
      list.push({ root: folder.root, built })
      candidates.set(built.item.name, list)
    }
  }
  const skills: ImportedTemplate[] = []
  const duplicates: HarnessTemplateImportDuplicate[] = []
  for (const [name, list] of [...candidates].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (list.length === 1) {
      skills.push(list[0].built)
      continue
    }
    const sources = list.map((entry) => entry.built.item.sourcePath)
    const raw = options.duplicateChoices[name]
    const chosen = list.find((entry) => entry.built.item.sourcePath === raw || entry.root === raw)
    if (raw === 'skip') {
      duplicates.push({ name, sources, choice: 'skip' })
    } else if (chosen) {
      duplicates.push({ name, sources, choice: chosen.built.item.sourcePath })
      skills.push(chosen.built)
    } else {
      duplicates.push({ name, sources, choice: null })
      blockingReasons.push(`Skill "${name}" is in ${list.length} source folders; choose which one to import`)
    }
  }

  // The skill/command alias exists only for Claude skills, so only an
  // imported skill that targets Claude covers a same-name command.
  const coveringSkills = new Set(
    skills.filter((entry) => entry.draft && entry.item.targets.includes('claude')).map((entry) => entry.item.name)
  )
  const coveredCommands: HarnessTemplateImportCoveredCommand[] = []
  const commands: ImportedTemplate[] = []
  const commandNames = new Set<string>()
  for (const { seed } of importer.flatTemplates(listing.commands, 'command', 'command')) {
    const built = importer.buildTemplate(seed)
    if (coveringSkills.has(built.item.name)) {
      coveredCommands.push({ name: built.item.name, skill: built.item.name, sourcePath: built.item.sourcePath })
      continue
    }
    if (candidates.has(built.item.name)) {
      built.item.notes.push('A skill has the same name but does not cover this command for Claude, so it is imported')
    }
    if (built.draft && commandNames.has(built.item.name)) {
      built.item.action = 'invalid'
      built.item.error = `Another command file also imports as "${built.item.name}"`
      built.draft = null
    }
    if (built.draft) commandNames.add(built.item.name)
    commands.push(built)
  }

  const templates = [...agents, ...skills, ...commands]
  for (const entry of [...fragments, ...templates]) applyConflict(entry.item, options)
  for (const entry of [...fragments, ...templates]) {
    if (entry.item.action === 'undecided') {
      blockingReasons.push(`${entry.item.key} already exists; choose skip or replace`)
    }
  }
  const importable = [...fragments, ...templates].filter(
    (entry) => entry.item.action === 'create' || entry.item.action === 'replace'
  )
  if (importable.length === 0 && blockingReasons.length === 0) blockingReasons.push('There is nothing to import')

  return {
    templates,
    fragments,
    duplicates,
    coveredCommands,
    unknownFiles: importer.unknownFiles,
    blockingReasons
  }
}

export function isImported(item: HarnessTemplateImportItem): boolean {
  return item.action === 'create' || item.action === 'replace'
}

import { CORE_SCHEMA, dump, load } from 'js-yaml'

import { getAgentInfo, type HarnessConfigResourceType } from '../agent-registry'
import {
  HARNESS_FRAGMENTS_DIR,
  type HarnessFragment,
  type HarnessTemplate,
  type HarnessTemplateHarnessBlock,
  type HarnessTemplateHarnesses,
  type HarnessTemplateKind,
  type HarnessTemplateReference,
  type HarnessTemplateTargetError,
  type ManagedHarnessKind
} from '../state/harness-config'

export const TEMPLATE_HARNESSES: readonly ManagedHarnessKind[] = ['claude', 'codex', 'opencode']

export const TEMPLATE_KIND_RESOURCE_TYPE: Record<HarnessTemplateKind, HarnessConfigResourceType> = {
  agent: 'agents',
  skill: 'skills',
  command: 'commands'
}

export const TEMPLATE_KIND_DIR: Record<HarnessTemplateKind, string> = {
  agent: 'agents',
  skill: 'skills',
  command: 'commands'
}

export const SKILL_TEMPLATE_FILE = 'TEMPLATE.md'
export const SKILL_REFERENCES_DIR = 'references'

const MARKDOWN_SUFFIX = '.md'
const RESERVED_TOP_LEVEL_KEYS = new Set(['name', 'description', 'fragments', ...TEMPLATE_HARNESSES])
const REFERENCE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/

export type HarnessTemplateDraft = Omit<HarnessTemplate, 'relativePath' | 'hash'>

export type HarnessTemplateParseResult =
  | { ok: true; template: HarnessTemplateDraft }
  | { ok: false; message: string }

export type HarnessTemplateSourcePath =
  | { type: 'template'; kind: HarnessTemplateKind; name: string }
  | { type: 'reference'; name: string; fileName: string }
  | { type: 'fragment'; name: string }

/** Logical-name rules shared with the harness service's
 *  `validateLogicalName`, narrowed to one path segment because every
 *  template and fragment maps to a single file or folder name. */
export function templateNameError(name: unknown): string | null {
  if (typeof name !== 'string' || name.length === 0) return 'A name is required'
  if (name.includes('\0') || name.includes('\\') || name.includes('/')) {
    return 'Names cannot contain slashes or control characters'
  }
  if (name === '.' || name === '..' || name.startsWith('.')) return 'Names cannot start with a dot'
  if (name.trim() !== name) return 'Names cannot start or end with whitespace'
  return null
}

export function isValidTemplateName(name: unknown): name is string {
  return templateNameError(name) === null
}

export function referenceFileNameError(fileName: unknown): string | null {
  if (typeof fileName !== 'string' || !REFERENCE_FILE_PATTERN.test(fileName)) {
    return 'Reference files must be markdown files named with letters, digits, dots, dashes, or underscores'
  }
  return null
}

export function templateRelativePath(kind: HarnessTemplateKind, name: string): string {
  if (kind === 'skill') return `${TEMPLATE_KIND_DIR.skill}/${name}/${SKILL_TEMPLATE_FILE}`
  return `${TEMPLATE_KIND_DIR[kind]}/${name}${MARKDOWN_SUFFIX}`
}

export function referenceRelativePath(name: string, fileName: string): string {
  return `${TEMPLATE_KIND_DIR.skill}/${name}/${SKILL_REFERENCES_DIR}/${fileName}`
}

export function fragmentRelativePath(name: string): string {
  return `${HARNESS_FRAGMENTS_DIR}/${name}${MARKDOWN_SUFFIX}`
}

function stripMarkdownSuffix(fileName: string): string | null {
  if (!fileName.endsWith(MARKDOWN_SUFFIX)) return null
  const name = fileName.slice(0, -MARKDOWN_SUFFIX.length)
  return isValidTemplateName(name) ? name : null
}

export function classifyTemplateSourcePath(relativePath: string): HarnessTemplateSourcePath | null {
  const segments = relativePath.split('/')
  const [top] = segments
  if (segments.length === 2) {
    const name = stripMarkdownSuffix(segments[1])
    if (name === null) return null
    if (top === HARNESS_FRAGMENTS_DIR) return { type: 'fragment', name }
    if (top === TEMPLATE_KIND_DIR.agent) return { type: 'template', kind: 'agent', name }
    if (top === TEMPLATE_KIND_DIR.command) return { type: 'template', kind: 'command', name }
    return null
  }
  if (top !== TEMPLATE_KIND_DIR.skill || !isValidTemplateName(segments[1])) return null
  if (segments.length === 3 && segments[2] === SKILL_TEMPLATE_FILE) {
    return { type: 'template', kind: 'skill', name: segments[1] }
  }
  if (segments.length === 4 && segments[2] === SKILL_REFERENCES_DIR && referenceFileNameError(segments[3]) === null) {
    return { type: 'reference', name: segments[1], fileName: segments[3] }
  }
  return null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function splitFrontmatter(source: string): { yaml: string; body: string } | null {
  const lines = source.split('\n')
  if (lines[0].replace(/\r$/, '') !== '---') return null
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].replace(/\r$/, '') === '---') {
      return {
        yaml: lines.slice(1, index).join('\n'),
        body: lines.slice(index + 1).join('\n')
      }
    }
  }
  return null
}

function parseNameList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be a list of fragment names`)
  return value.map((entry) => {
    const error = templateNameError(entry)
    if (error) throw new Error(`${field} has an invalid fragment name: ${error}`)
    return entry as string
  })
}

export function parseTemplateHarnessBlock(harness: ManagedHarnessKind, value: unknown): HarnessTemplateHarnessBlock | false {
  if (value === false) return false
  if (value === null) return { frontmatter: {} }
  if (!isPlainObject(value)) throw new Error(`${harness} must be a frontmatter mapping or false`)
  const block: HarnessTemplateHarnessBlock = { frontmatter: {} }
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'name') {
      const error = templateNameError(entry)
      if (error) throw new Error(`${harness}.name is invalid: ${error}`)
      block.name = entry as string
    } else if (key === 'fragments') {
      block.fragments = parseNameList(entry, `${harness}.fragments`)
    } else {
      block.frontmatter[key] = entry
    }
  }
  return block
}

export function parseTemplateSource(
  kind: HarnessTemplateKind,
  name: string,
  source: string,
  references: HarnessTemplateReference[] = []
): HarnessTemplateParseResult {
  try {
    const nameError = templateNameError(name)
    if (nameError) throw new Error(nameError)
    const parts = splitFrontmatter(source)
    if (!parts) throw new Error('The file must start with a --- frontmatter block')
    let data: unknown
    try {
      data = load(parts.yaml, { schema: CORE_SCHEMA })
    } catch (error) {
      const reason = error instanceof Error ? error.message.split('\n')[0] : 'invalid YAML'
      throw new Error(`The frontmatter is not valid YAML: ${reason}`)
    }
    if (data === undefined || data === null) data = {}
    if (!isPlainObject(data)) throw new Error('The frontmatter must be a mapping')

    for (const key of Object.keys(data)) {
      if (key === 'pi') throw new Error('Pi templates are not supported yet')
      if (!RESERVED_TOP_LEVEL_KEYS.has(key)) {
        throw new Error(`Unknown frontmatter key "${key}"; harness settings belong under claude, codex, or opencode`)
      }
    }
    if (data.name !== undefined && data.name !== name) {
      throw new Error(`The frontmatter name "${String(data.name)}" does not match the file name "${name}"`)
    }
    if (data.description !== undefined && typeof data.description !== 'string') {
      throw new Error('description must be text')
    }
    const harnesses: HarnessTemplateHarnesses = {}
    for (const harness of TEMPLATE_HARNESSES) {
      if (Object.prototype.hasOwnProperty.call(data, harness)) {
        harnesses[harness] = parseTemplateHarnessBlock(harness, data[harness])
      }
    }
    if (kind !== 'skill' && references.length > 0) throw new Error('Only skill templates can have reference files')
    for (const reference of references) {
      const error = referenceFileNameError(reference.fileName)
      if (error) throw new Error(error)
    }
    return {
      ok: true,
      template: {
        kind,
        name,
        description: (data.description as string | undefined) ?? '',
        fragments: data.fragments === undefined ? [] : parseNameList(data.fragments, 'fragments'),
        body: parts.body,
        harnesses,
        references: [...references].sort((left, right) => (left.fileName < right.fileName ? -1 : 1))
      }
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'The template could not be parsed' }
  }
}

function serializeHarnessBlock(block: HarnessTemplateHarnessBlock | false): unknown {
  if (block === false) return false
  const out: Record<string, unknown> = {}
  if (block.name !== undefined) out.name = block.name
  for (const [key, value] of Object.entries(block.frontmatter)) {
    if (key !== 'name' && key !== 'fragments') out[key] = value
  }
  if (block.fragments !== undefined) out.fragments = [...block.fragments]
  return out
}

export function serializeTemplateSource(template: HarnessTemplateDraft): string {
  const data: Record<string, unknown> = { name: template.name, description: template.description }
  if (template.fragments.length > 0) data.fragments = [...template.fragments]
  for (const harness of TEMPLATE_HARNESSES) {
    const block = template.harnesses[harness]
    if (block !== undefined) data[harness] = serializeHarnessBlock(block)
  }
  const yaml = dump(data, { schema: CORE_SCHEMA, noRefs: true, lineWidth: -1 })
  return `---\n${yaml}---\n${template.body}`
}

export function parseFragmentSource(name: string, content: string): Omit<HarnessFragment, 'hash'> | { error: string } {
  const error = templateNameError(name)
  if (error) return { error }
  return { name, content, relativePath: fragmentRelativePath(name) }
}

export function templateTargets(template: Pick<HarnessTemplate, 'harnesses'>): ManagedHarnessKind[] {
  return TEMPLATE_HARNESSES.filter((harness) => {
    const block = template.harnesses[harness]
    return block !== undefined && block !== false
  })
}

export function validateTemplateTargets(
  template: Pick<HarnessTemplate, 'kind' | 'harnesses'>
): HarnessTemplateTargetError[] {
  const resourceType = TEMPLATE_KIND_RESOURCE_TYPE[template.kind]
  const errors: HarnessTemplateTargetError[] = []
  for (const agentKind of templateTargets(template)) {
    const info = getAgentInfo(agentKind)
    const capability = info.configCapabilities.find((entry) => entry.resourceType === resourceType)
    if (!capability || capability.status !== 'supported') {
      const reason = capability?.notes ? ` ${capability.notes}` : ''
      errors.push({
        agentKind,
        message: `${info.displayName} does not support ${resourceType}, so a ${template.kind} template cannot target it.${reason}`
      })
    } else if (capability.layout === 'single-file') {
      const reason = capability.notes ? ` ${capability.notes}` : ''
      errors.push({
        agentKind,
        message: `A ${template.kind} template cannot target ${info.displayName} because it has no file per resource.${reason}`
      })
    }
  }
  return errors
}

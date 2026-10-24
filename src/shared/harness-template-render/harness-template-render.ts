import { CORE_SCHEMA, dump } from 'js-yaml'

import {
  resourcePathForName,
  templateOutputFor,
  type HarnessConfigResourceType
} from '../agent-registry'
import {
  TEMPLATE_KIND_RESOURCE_TYPE,
  templateTargets,
  validateTemplateTargets
} from '../harness-templates'
import { expandInlineFragments, inlineFragmentNames } from '../inline-fragments'
import { sha256Hex } from '../sha256'
import type {
  HarnessFragment,
  HarnessTemplate,
  HarnessTemplateKind,
  ManagedHarnessKind
} from '../state/harness-config'

export const RENDERER_VERSION = 3

/** Frontmatter key that files rendered before RENDERER_VERSION 3 carried. */
export const LEGACY_TEMPLATE_MARKER_KEY = 'tatsu-template'

export type RenderableTemplate = Pick<
  HarnessTemplate,
  'kind' | 'name' | 'description' | 'fragments' | 'body' | 'harnesses' | 'references'
>

export type RenderableFragment = Pick<HarnessFragment, 'name' | 'content'>

export interface RenderedResource {
  templateName: string
  templateKind: HarnessTemplateKind
  agentKind: ManagedHarnessKind
  resourceType: HarnessConfigResourceType
  relativePath: string
  content: string
  hash: string
}

export type TemplateRenderErrorCode =
  | 'unknown-fragment'
  | 'inline-fragment'
  | 'invalid-target'
  | 'duplicate-output'
  | 'invalid-frontmatter'

export interface TemplateRenderError {
  templateKind: HarnessTemplateKind
  templateName: string
  agentKind?: ManagedHarnessKind
  code: TemplateRenderErrorCode
  message: string
}

export interface TemplateRenderResult {
  rendererVersion: number
  resources: RenderedResource[]
  errors: TemplateRenderError[]
}

const BODY_ONLY = { frontmatter: false }

const KIND_ORDER: Record<HarnessTemplateKind, number> = { agent: 0, skill: 1, command: 2 }
const HARNESS_ORDER: Record<ManagedHarnessKind, number> = { claude: 0, codex: 1, opencode: 2 }
const LEGACY_MARKER_COMMENT = /^<!--\s*tatsu-template:\s*\S(?:.*\S)?\s*-->$/

function lexicalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n')
}

function section(value: string): string {
  return normalizeNewlines(value).replace(/^\n+/, '').replace(/\s+$/, '')
}

/** Every fragment a template uses: its list, each harness block's list,
 *  and the placeholders in its body. */
export function templateFragmentNames(
  template: Pick<RenderableTemplate, 'fragments' | 'harnesses' | 'body'>
): string[] {
  const names = new Set(template.fragments)
  for (const block of Object.values(template.harnesses)) {
    if (block) for (const name of block.fragments ?? []) names.add(name)
  }
  for (const name of inlineFragmentNames(template.body, BODY_ONLY)) names.add(name)
  return [...names].sort(lexicalCompare)
}

export function templateRefOf(kind: HarnessTemplateKind, name: string): string {
  return `${kind}/${name}`
}

/** Files rendered before RENDERER_VERSION 3 carried a provenance comment on
 *  the first body line; drop it when such a file is imported. */
export function stripLegacyTemplateMarker(body: string): string {
  const lines = normalizeNewlines(body).split('\n')
  const first = lines.findIndex((line) => line.trim().length > 0)
  if (first === -1 || !LEGACY_MARKER_COMMENT.test(lines[first].trim())) return body
  return [...lines.slice(0, first), ...lines.slice(first + 1)].join('\n')
}

function serializeFrontmatter(data: Record<string, unknown>): string {
  if (Object.keys(data).length === 0) return ''
  return dump(data, { schema: CORE_SCHEMA, noRefs: true, lineWidth: -1 })
}

type HarnessRender = { resource: RenderedResource } | { error: TemplateRenderError }

function renderForHarness(
  template: RenderableTemplate,
  agentKind: ManagedHarnessKind,
  fragments: ReadonlyMap<string, string>
): HarnessRender {
  const resourceType = TEMPLATE_KIND_RESOURCE_TYPE[template.kind]
  const block = template.harnesses[agentKind]
  const base = { templateKind: template.kind, templateName: template.name, agentKind }
  const output = templateOutputFor(agentKind, resourceType)
  if (!block || !output) {
    return { error: { ...base, code: 'invalid-target', message: `${agentKind} cannot render ${resourceType}` } }
  }
  const outputName = block.name ?? template.name
  const relativePath = resourcePathForName(agentKind, resourceType, outputName)
  if (relativePath === null) {
    return { error: { ...base, code: 'invalid-target', message: `${agentKind} has no file path for ${resourceType}` } }
  }

  const fragmentNames = block.fragments ?? template.fragments
  const missing = fragmentNames.filter((name) => !fragments.has(name))
  if (missing.length > 0) {
    return {
      error: {
        ...base,
        code: 'unknown-fragment',
        message: `Unknown fragment${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`
      }
    }
  }

  const frontmatter: Record<string, unknown> = {}
  if (output.frontmatterName) frontmatter.name = outputName
  if (template.description.length > 0 || 'description' in block.frontmatter) {
    frontmatter.description = template.description
  }
  for (const [key, value] of Object.entries(block.frontmatter)) frontmatter[key] = value

  let yaml: string
  try {
    yaml = serializeFrontmatter(frontmatter)
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : 'unsupported value'
    return { error: { ...base, code: 'invalid-frontmatter', message: `The frontmatter cannot be written: ${reason}` } }
  }

  const inline = expandInlineFragments(template.body, fragments, BODY_ONLY)
  if (inline.errors.length > 0) {
    const unknown = inline.errors.filter((error) => error.code === 'unknown-fragment')
    const code = unknown.length === inline.errors.length ? 'unknown-fragment' : 'inline-fragment'
    return { error: { ...base, code, message: inline.errors.map((error) => error.message).join('. ') } }
  }

  const sections = [section(inline.content), ...fragmentNames.map((name) => section(fragments.get(name)!))]
  if (template.kind === 'skill') {
    for (const reference of template.references) {
      sections.push(`## ${reference.fileName}\n\n${section(reference.content)}`)
    }
  }
  const body = sections.filter((part) => part.length > 0).join('\n\n')
  const content = `---\n${yaml}---\n${body}${body.length > 0 ? '\n' : ''}`
  return {
    resource: {
      templateName: template.name,
      templateKind: template.kind,
      agentKind,
      resourceType,
      relativePath,
      content,
      hash: sha256Hex(content)
    }
  }
}

function templateKey(template: Pick<RenderableTemplate, 'kind' | 'name'>): string {
  return `${template.kind}\0${template.name}`
}

/** Pure and deterministic: builds every harness file the templates
 *  target. Errors are reported per template; a template with any error
 *  produces no output, and other templates still render. */
export function renderTemplates(
  templates: readonly RenderableTemplate[],
  fragments: readonly RenderableFragment[]
): TemplateRenderResult {
  const fragmentMap = new Map(fragments.map((fragment) => [fragment.name, fragment.content]))
  const ordered = [...templates].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || lexicalCompare(a.name, b.name)
  )
  const errorsByTemplate = new Map<string, TemplateRenderError[]>()
  const outputsByTemplate = new Map<string, RenderedResource[]>()
  const addError = (error: TemplateRenderError): void => {
    const key = templateKey({ kind: error.templateKind, name: error.templateName })
    errorsByTemplate.set(key, [...(errorsByTemplate.get(key) ?? []), error])
  }

  for (const template of ordered) {
    for (const targetError of validateTemplateTargets(template)) {
      addError({
        templateKind: template.kind,
        templateName: template.name,
        agentKind: targetError.agentKind,
        code: 'invalid-target',
        message: targetError.message
      })
    }
    if (errorsByTemplate.has(templateKey(template))) continue
    const resources: RenderedResource[] = []
    for (const agentKind of templateTargets(template)) {
      const rendered = renderForHarness(template, agentKind, fragmentMap)
      if ('error' in rendered) addError(rendered.error)
      else resources.push(rendered.resource)
    }
    outputsByTemplate.set(templateKey(template), resources)
  }

  const claims = new Map<string, RenderedResource[]>()
  for (const [key, resources] of outputsByTemplate) {
    if (errorsByTemplate.has(key)) continue
    for (const resource of resources) {
      const pathKey = `${resource.agentKind}\0${resource.resourceType}\0${resource.relativePath.toLowerCase()}`
      claims.set(pathKey, [...(claims.get(pathKey) ?? []), resource])
    }
  }
  for (const claimants of claims.values()) {
    if (claimants.length < 2) continue
    for (const resource of claimants) {
      const others = claimants
        .filter((other) => other !== resource)
        .map((other) => templateRefOf(other.templateKind, other.templateName))
      addError({
        templateKind: resource.templateKind,
        templateName: resource.templateName,
        agentKind: resource.agentKind,
        code: 'duplicate-output',
        message: `${resource.agentKind} ${resource.resourceType} ${resource.relativePath} is also built by ${others.join(', ')}`
      })
    }
  }

  const resources: RenderedResource[] = []
  for (const [key, rendered] of outputsByTemplate) {
    if (!errorsByTemplate.has(key)) resources.push(...rendered)
  }
  resources.sort(
    (a, b) =>
      HARNESS_ORDER[a.agentKind] - HARNESS_ORDER[b.agentKind] ||
      lexicalCompare(a.resourceType, b.resourceType) ||
      lexicalCompare(a.relativePath, b.relativePath)
  )
  const errors = ordered.flatMap((template) => errorsByTemplate.get(templateKey(template)) ?? [])
  return { rendererVersion: RENDERER_VERSION, resources, errors }
}

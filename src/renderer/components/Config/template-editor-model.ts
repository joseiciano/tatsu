import { CORE_SCHEMA, dump, load } from 'js-yaml'
import { getAgentInfo } from '../../../shared/agent-registry'
import {
  TEMPLATE_HARNESSES,
  parseTemplateHarnessBlock,
  templateNameError,
  validateTemplateTargets
} from '../../../shared/harness-templates'
import {
  renderTemplates,
  templateFragmentNames,
  type RenderableTemplate
} from '../../../shared/harness-template-render'
import type {
  HarnessFragment,
  HarnessTemplate,
  HarnessTemplateHarnessBlock,
  HarnessTemplateHarnesses,
  HarnessTemplateKind,
  HarnessTemplateSaveRequest,
  ManagedHarnessKind
} from '../../../shared/state/harness-config'
import type {
  ConfigTemplateDraft,
  ConfigTemplateHarnessAvailability,
  ConfigTemplateHarnessDraft,
  ConfigTemplatePreview
} from './types'

export const TEMPLATE_KINDS: readonly HarnessTemplateKind[] = ['agent', 'skill', 'command']

export const TEMPLATE_KIND_LABEL: Record<HarnessTemplateKind, string> = {
  agent: 'Agents',
  skill: 'Skills',
  command: 'Commands'
}

export function templateRefOf(kind: HarnessTemplateKind, name: string): string {
  return `${kind}/${name}`
}

export function parseTemplateRef(ref: string): { kind: HarnessTemplateKind; name: string } | null {
  const slash = ref.indexOf('/')
  if (slash === -1) return null
  const kind = ref.slice(0, slash) as HarnessTemplateKind
  const name = ref.slice(slash + 1)
  if (!TEMPLATE_KINDS.includes(kind) || name.length === 0) return null
  return { kind, name }
}

function blockToText(block: HarnessTemplateHarnessBlock | false | undefined): string {
  if (!block) return ''
  const data: Record<string, unknown> = {}
  if (block.name !== undefined) data.name = block.name
  for (const [key, value] of Object.entries(block.frontmatter)) {
    if (key !== 'name' && key !== 'fragments') data[key] = value
  }
  if (block.fragments !== undefined) data.fragments = [...block.fragments]
  if (Object.keys(data).length === 0) return ''
  return dump(data, { schema: CORE_SCHEMA, noRefs: true, lineWidth: -1 })
}

function harnessDraft(block: HarnessTemplateHarnessBlock | false | undefined): ConfigTemplateHarnessDraft {
  return {
    enabled: block !== undefined && block !== false,
    excluded: block === false,
    frontmatterText: blockToText(block)
  }
}

export function emptyTemplateDraft(kind: HarnessTemplateKind): ConfigTemplateDraft {
  return {
    kind,
    name: '',
    description: '',
    fragments: [],
    body: '',
    harnesses: { claude: harnessDraft(undefined), codex: harnessDraft(undefined), opencode: harnessDraft(undefined) },
    references: []
  }
}

export function templateToDraft(template: HarnessTemplate): ConfigTemplateDraft {
  return {
    kind: template.kind,
    name: template.name,
    description: template.description,
    fragments: [...template.fragments],
    body: template.body,
    harnesses: {
      claude: harnessDraft(template.harnesses.claude),
      codex: harnessDraft(template.harnesses.codex),
      opencode: harnessDraft(template.harnesses.opencode)
    },
    references: template.references.map((reference) => ({ ...reference }))
  }
}

export function templateDraftsEqual(a: ConfigTemplateDraft, b: ConfigTemplateDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Parses one harness block's YAML text the same way the template file
 *  parser reads that block, so `name` and `fragments` stay overrides. */
export function parseHarnessBlockText(
  harness: ManagedHarnessKind,
  text: string
): { ok: true; block: HarnessTemplateHarnessBlock } | { ok: false; message: string } {
  let data: unknown
  try {
    data = load(text, { schema: CORE_SCHEMA })
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : 'invalid YAML'
    return { ok: false, message: `Not valid YAML: ${reason}` }
  }
  if (data === undefined || data === null) return { ok: true, block: { frontmatter: {} } }
  if (data === false) return { ok: false, message: 'Use the toggle to turn this harness off' }
  try {
    const block = parseTemplateHarnessBlock(harness, data)
    if (block === false) return { ok: false, message: 'Use the toggle to turn this harness off' }
    return { ok: true, block }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'The frontmatter is not valid' }
  }
}

/** Whether each harness may be a target for `kind`, with the capability
 *  metadata's reason when it may not. */
export function templateHarnessAvailability(
  kind: HarnessTemplateKind
): Record<ManagedHarnessKind, ConfigTemplateHarnessAvailability> {
  const result = {} as Record<ManagedHarnessKind, ConfigTemplateHarnessAvailability>
  for (const harness of TEMPLATE_HARNESSES) {
    const errors = validateTemplateTargets({ kind, harnesses: { [harness]: { frontmatter: {} } } })
    result[harness] = {
      displayName: getAgentInfo(harness).displayName,
      valid: errors.length === 0,
      reason: errors[0]?.message ?? null
    }
  }
  return result
}

export interface CompiledTemplateDraft {
  /** Draft with every block that parses; invalid blocks are left out so
   *  the other harnesses still preview. */
  renderable: RenderableTemplate
  blockErrors: Partial<Record<ManagedHarnessKind, string>>
  /** Save-blocking problems in display order. Empty means savable. */
  problems: string[]
  /** Request payload, or null while `problems` is non-empty. */
  saveTemplate: HarnessTemplateSaveRequest['template'] | null
}

export function compileTemplateDraft(draft: ConfigTemplateDraft): CompiledTemplateDraft {
  const blockErrors: Partial<Record<ManagedHarnessKind, string>> = {}
  const renderHarnesses: HarnessTemplateHarnesses = {}
  const saveHarnesses: HarnessTemplateHarnesses = {}
  for (const harness of TEMPLATE_HARNESSES) {
    const entry = draft.harnesses[harness]
    if (!entry.enabled) {
      if (entry.excluded) {
        renderHarnesses[harness] = false
        saveHarnesses[harness] = false
      }
      continue
    }
    const parsed = parseHarnessBlockText(harness, entry.frontmatterText)
    if (!parsed.ok) {
      blockErrors[harness] = parsed.message
      continue
    }
    renderHarnesses[harness] = parsed.block
    saveHarnesses[harness] = parsed.block
  }

  const problems: string[] = []
  const nameError = templateNameError(draft.name)
  if (nameError) problems.push(`Name: ${nameError}`)
  for (const harness of TEMPLATE_HARNESSES) {
    const error = blockErrors[harness]
    if (error) problems.push(`${getAgentInfo(harness).displayName} frontmatter: ${error}`)
  }
  for (const targetError of validateTemplateTargets({ kind: draft.kind, harnesses: saveHarnesses })) {
    problems.push(targetError.message)
  }

  const base = {
    kind: draft.kind,
    name: draft.name,
    description: draft.description,
    fragments: [...draft.fragments],
    body: draft.body,
    references: draft.kind === 'skill' ? draft.references.map((reference) => ({ ...reference })) : []
  }
  return {
    renderable: { ...base, harnesses: renderHarnesses },
    blockErrors,
    problems,
    saveTemplate: problems.length === 0 ? { ...base, harnesses: saveHarnesses } : null
  }
}

const PREVIEW_NAME = 'untitled'

/** Renders the draft for one harness with the shared renderer, alongside
 *  every other stored template so duplicate output paths show up too. */
export function renderTemplatePreview(
  compiled: CompiledTemplateDraft,
  harness: ManagedHarnessKind | null,
  storedTemplates: readonly HarnessTemplate[],
  fragments: readonly HarnessFragment[],
  original: { kind: HarnessTemplateKind; name: string } | null
): ConfigTemplatePreview {
  const draft = compiled.renderable
  const name = templateNameError(draft.name) === null ? draft.name : PREVIEW_NAME
  const renderable: RenderableTemplate = { ...draft, name }
  const others = storedTemplates.filter(
    (template) =>
      !(original && template.kind === original.kind && template.name === original.name) &&
      !(template.kind === renderable.kind && template.name === renderable.name)
  )
  const result = renderTemplates([...others, renderable], fragments)
  const mine = (entry: { templateKind: HarnessTemplateKind; templateName: string }): boolean =>
    entry.templateKind === renderable.kind && entry.templateName === renderable.name
  const errors = result.errors.filter(mine).map((error) => error.message)
  if (harness && compiled.blockErrors[harness]) {
    errors.unshift(`${getAgentInfo(harness).displayName} frontmatter: ${compiled.blockErrors[harness]}`)
  }
  const resource = harness
    ? (result.resources.find((entry) => mine(entry) && entry.agentKind === harness) ?? null)
    : null
  return { resource, errors }
}

/** Every stored template that pulls in `fragmentName`, at the top level,
 *  through a harness block override, or as a placeholder in its body. */
export function fragmentUsage(templates: readonly HarnessTemplate[], fragmentName: string): HarnessTemplate[] {
  return templates.filter((template) => templateFragmentNames(template).includes(fragmentName))
}

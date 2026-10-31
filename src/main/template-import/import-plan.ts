import { classifyTemplateSourcePath, type HarnessTemplateDraft } from '../../shared/harness-templates'
import { renderTemplates, templateRefOf } from '../../shared/harness-template-render'
import { sha256Hex } from '../../shared/sha256'
import type {
  HarnessConfigResourceType,
  HarnessFragment,
  HarnessTemplate,
  HarnessTemplateImportChoices,
  HarnessTemplateImportFile,
  HarnessTemplateImportIssue,
  HarnessTemplateImportPreview,
  ManagedHarnessKind
} from '../../shared/state/harness-config'
import { importTemplateSetup, isImported, type TemplateImportListing } from './template-import'

export interface TemplateImportPlanDeps {
  existingTemplates: readonly HarnessTemplate[]
  existingFragments: readonly HarnessFragment[]
  /** Source files that exist but failed to parse; their names still
   *  count as taken (REQ-007). */
  existingErrors?: readonly { relativePath: string }[]
  /** Existing files a template would write over, as display strings. */
  templateShadows(draft: HarnessTemplateDraft): string[]
  /** The file now in the harness folder at that path, if any. */
  currentContent(agentKind: ManagedHarnessKind, resourceType: HarnessConfigResourceType, relativePath: string): string | null
  outsideSettings?: Partial<Record<ManagedHarnessKind, readonly string[]>>
}

export interface TemplateImportPlan {
  preview: HarnessTemplateImportPreview
  fragments: { name: string; content: string }[]
  templates: HarnessTemplateDraft[]
  skipped: string[]
}

export function importFingerprint(listing: TemplateImportListing, choices: HarnessTemplateImportChoices): string {
  return `sha256:${sha256Hex(JSON.stringify({ listing, choices }))}`
}

/** Runs the importer against the current template source and renders
 *  the result, so the preview shows every file the import would build
 *  next to the file that is on disk now (RISK-002). */
export function planTemplateImport(
  listing: TemplateImportListing,
  choices: HarnessTemplateImportChoices,
  deps: TemplateImportPlanDeps
): TemplateImportPlan {
  const existing = new Set<string>([
    ...deps.existingTemplates.map((template) => `${template.kind}/${template.name}`),
    ...deps.existingFragments.map((fragment) => `fragment/${fragment.name}`)
  ])
  for (const { relativePath } of deps.existingErrors ?? []) {
    const entry = classifyTemplateSourcePath(relativePath)
    if (entry?.type === 'template') existing.add(`${entry.kind}/${entry.name}`)
    else if (entry?.type === 'reference') existing.add(`skill/${entry.name}`)
    else if (entry?.type === 'fragment') existing.add(`fragment/${entry.name}`)
  }
  const result = importTemplateSetup(listing, { ...choices, existing, outsideSettings: deps.outsideSettings })

  const fragments = result.fragments.filter((entry) => isImported(entry.item))
  const templates = result.templates.filter((entry) => isImported(entry.item) && entry.draft !== null)
  const skipped = [...result.fragments, ...result.templates]
    .filter((entry) => entry.item.action === 'skip')
    .map((entry) => entry.item.key)

  const importedKeys = new Set(templates.map((entry) => entry.item.key))
  const importedFragments = new Set(fragments.map((entry) => entry.item.name))
  const renderSet = [
    ...deps.existingTemplates.filter((template) => !importedKeys.has(`${template.kind}/${template.name}`)),
    ...templates.map((entry) => entry.draft as HarnessTemplateDraft)
  ]
  const fragmentSet = [
    ...deps.existingFragments.filter((fragment) => !importedFragments.has(fragment.name)),
    ...fragments.map((entry) => ({ name: entry.item.name, content: entry.content }))
  ]
  const rendered = renderTemplates(renderSet, fragmentSet)

  const renderErrors: HarnessTemplateImportIssue[] = rendered.errors
    .filter((error) => importedKeys.has(templateRefOf(error.templateKind, error.templateName)))
    .map((error) => ({
      sourcePath: templateRefOf(error.templateKind, error.templateName),
      message: error.agentKind ? `${error.agentKind}: ${error.message}` : error.message
    }))

  const files: HarnessTemplateImportFile[] = rendered.resources
    .filter((resource) => importedKeys.has(templateRefOf(resource.templateKind, resource.templateName)))
    .map((resource) => ({
      templateRef: templateRefOf(resource.templateKind, resource.templateName),
      agentKind: resource.agentKind,
      resourceType: resource.resourceType,
      relativePath: resource.relativePath,
      rendered: resource.content,
      current: deps.currentContent(resource.agentKind, resource.resourceType, resource.relativePath)
    }))

  const shadows = templates.flatMap((entry) => deps.templateShadows(entry.draft as HarnessTemplateDraft))

  const preview: HarnessTemplateImportPreview = {
    fingerprint: importFingerprint(listing, choices),
    items: [...result.fragments, ...result.templates].map((entry) => entry.item),
    duplicates: result.duplicates,
    coveredCommands: result.coveredCommands,
    unknownFiles: result.unknownFiles,
    renderErrors,
    shadows,
    files,
    blockingReasons: result.blockingReasons
  }
  return {
    preview,
    fragments: fragments.map((entry) => ({ name: entry.item.name, content: entry.content })),
    templates: templates.map((entry) => entry.draft as HarnessTemplateDraft),
    skipped
  }
}

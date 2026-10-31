import { getAgentInfo } from '../../../shared/agent-registry'
import {
  harnessConfigScopeKey,
  type HarnessConfigComparison,
  type HarnessConfigFileRef,
  type HarnessConfigResourceType,
  type HarnessConfigScope,
  type HarnessConfigScopeKey,
  type HarnessConfigSyncStatus,
  type HarnessTemplateImportChoices,
  type HarnessTemplateImportFolders,
  type HarnessTemplateImportItem,
  type HarnessTemplateImportPreview
} from '../../../shared/state/harness-config'

export interface ImportFolderDrafts {
  agents: string
  agentFragments: string
  skills: string[]
  references: string
  commands: string
}

export type ImportSingleFolderKey = 'agents' | 'agentFragments' | 'references' | 'commands'

export const IMPORT_FOLDER_ROWS: readonly { key: ImportSingleFolderKey | 'skills'; label: string; hint: string }[] = [
  { key: 'agents', label: 'Agents', hint: 'One file per agent, with a block per harness' },
  { key: 'agentFragments', label: 'Agent fragments', hint: 'Shared text that agents list under shared' },
  { key: 'skills', label: 'Skill folders', hint: 'Folders of <name>/SKILL.md; add one row per source folder' },
  { key: 'references', label: 'Shared references', hint: 'The folder skills link into for reference files' },
  { key: 'commands', label: 'Commands', hint: 'Hand-written and generated commands' }
]

export function emptyImportFolders(): ImportFolderDrafts {
  return { agents: '', agentFragments: '', skills: [''], references: '', commands: '' }
}

export function defaultImportChoices(): HarnessTemplateImportChoices {
  return { harnesses: ['claude'], duplicateChoices: {}, conflictChoices: {} }
}

function optionalPath(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function importFoldersRequest(drafts: ImportFolderDrafts): HarnessTemplateImportFolders {
  return {
    agents: optionalPath(drafts.agents),
    agentFragments: optionalPath(drafts.agentFragments),
    skills: drafts.skills.map((path) => path.trim()).filter((path) => path.length > 0),
    references: optionalPath(drafts.references),
    commands: optionalPath(drafts.commands)
  }
}

export function importFoldersProblem(folders: HarnessTemplateImportFolders): string | null {
  const paths = [folders.agents, folders.agentFragments, ...folders.skills, folders.references, folders.commands].filter(
    (path): path is string => path !== null
  )
  if (paths.length === 0) return 'Choose at least one folder to import from.'
  const relative = paths.find((path) => !path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path))
  if (relative) return `Use a full path: ${relative}`
  return null
}

export function importFoldersDirty(drafts: ImportFolderDrafts): boolean {
  const folders = importFoldersRequest(drafts)
  return [folders.agents, folders.agentFragments, folders.references, folders.commands].some(Boolean) || folders.skills.length > 0
}

export const IMPORT_ACTION_LABEL: Record<HarnessTemplateImportItem['action'], string> = {
  create: 'New',
  replace: 'Replace',
  skip: 'Skip',
  undecided: 'Choose',
  invalid: 'Not imported'
}

export interface ImportSummary {
  create: number
  replace: number
  skip: number
  invalid: number
  undecided: number
}

export function importSummary(items: readonly HarnessTemplateImportItem[]): ImportSummary {
  const summary: ImportSummary = { create: 0, replace: 0, skip: 0, invalid: 0, undecided: 0 }
  for (const item of items) summary[item.action] += 1
  return summary
}

export function importConfirmMessage(preview: HarnessTemplateImportPreview): string {
  const summary = importSummary(preview.items)
  const lines = [`Import ${summary.create + summary.replace} templates and fragments into the template source folder?`]
  if (summary.replace > 0) lines.push(`${summary.replace} existing will be replaced. Tatsu backs up each file first.`)
  if (summary.skip > 0) lines.push(`${summary.skip} will be skipped.`)
  const settings = preview.items.reduce((count, item) => count + item.unsupportedSettings.length, 0)
  if (settings > 0) lines.push(`${settings} settings that lived outside resource files will not be imported.`)
  lines.push('The source folders are not changed, and no harness file is written until you sync.')
  return lines.join('\n\n')
}

export interface ImportCutoverScope {
  key: HarnessConfigScopeKey
  scope: HarnessConfigScope
  label: string
  status: HarnessConfigSyncStatus | null
  linked: HarnessConfigFileRef[]
}

const RESOURCE_LABEL: Record<HarnessConfigResourceType, string> = {
  agents: 'Agents',
  skills: 'Skills',
  commands: 'Commands'
}

/** REQ-008: the scopes an import touched, with their sync status and
 *  the harness files that are still links into another build. */
export function importCutoverScopes(
  scopes: readonly HarnessConfigScope[],
  comparisons: Partial<Record<HarnessConfigScopeKey, HarnessConfigComparison>>,
  resources: Record<HarnessConfigResourceType, HarnessConfigFileRef[]>
): ImportCutoverScope[] {
  return scopes.map((scope) => {
    const key = harnessConfigScopeKey(scope)
    const linked = (resources[scope.resourceType] ?? []).filter(
      (ref) => ref.agentKind === scope.agentKind && ref.existsOnDisk && !!ref.linkedFrom
    )
    return {
      key,
      scope,
      label: `${getAgentInfo(scope.agentKind).displayName} · ${RESOURCE_LABEL[scope.resourceType]}`,
      status: comparisons[key]?.status ?? null,
      linked
    }
  })
}

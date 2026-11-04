import type { WorkflowDefinitionSummary } from '../../../../shared/state/workflows'

export interface LibraryGroup {
  key: string
  label: string
  repoRoot: string | null
  definitions: WorkflowDefinitionSummary[]
}

export interface LibraryGroupsInput {
  definitions: Record<string, WorkflowDefinitionSummary>
  repoRoots: readonly string[]
  activeRepoRoot: string | null
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

function byName(a: WorkflowDefinitionSummary, b: WorkflowDefinitionSummary): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
}

export function isDefinitionTrusted(summary: WorkflowDefinitionSummary, trust: Record<string, string>): boolean {
  return summary.scope === 'personal' || (Object.hasOwn(trust, summary.id) && trust[summary.id] === summary.hash)
}

export function libraryGroups({ definitions, repoRoots, activeRepoRoot }: LibraryGroupsInput): LibraryGroup[] {
  const personal: WorkflowDefinitionSummary[] = []
  const byRepo = new Map<string, WorkflowDefinitionSummary[]>(repoRoots.map((root) => [root, []]))
  for (const summary of Object.values(definitions)) {
    if (summary.scope === 'personal') personal.push(summary)
    else if (summary.repoRoot !== undefined) {
      const list = byRepo.get(summary.repoRoot)
      if (list) list.push(summary)
      else byRepo.set(summary.repoRoot, [summary])
    }
  }
  const repoGroups = [...byRepo].map(([root, list]): LibraryGroup => ({
    key: `repo:${root}`,
    label: root === activeRepoRoot ? `This repo (${basename(root)})` : basename(root),
    repoRoot: root,
    definitions: list.sort(byName)
  }))
  const active = repoGroups.filter((group) => group.repoRoot === activeRepoRoot)
  const others = repoGroups
    .filter((group) => group.repoRoot !== activeRepoRoot)
    .sort((a, b) => a.label.localeCompare(b.label) || (a.repoRoot ?? '').localeCompare(b.repoRoot ?? ''))
  return [
    ...active,
    { key: 'personal', label: 'Personal', repoRoot: null, definitions: personal.sort(byName) },
    ...others
  ]
}

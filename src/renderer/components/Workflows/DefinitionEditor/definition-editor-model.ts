import type { WorkflowSaveDefinitionPayload } from '../../../../shared/state/workflows'
import type { WorkflowDiagnostic } from '../../../../shared/workflow-def'

export const NEW_WORKFLOW_TEMPLATE = `name: new-workflow
steps:
  - id: hello
    kind: shell
    run: echo hello
`

export const VALIDATE_DEBOUNCE_MS = 250

export type DefinitionEditorTarget = { kind: 'new' } | { kind: 'edit'; defId: string }

export type EditedFile = { defId: string; name: string } & ({ scope: 'personal' } | { scope: 'repo'; repoRoot: string })

export type SaveDestination = 'own' | 'repo'

export function fileStem(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base.replace(/\.ya?ml$/i, '')
}

export function repoLabel(repoRoot: string): string {
  return repoRoot.split('/').filter(Boolean).pop() ?? repoRoot
}

export function errorCount(diagnostics: readonly WorkflowDiagnostic[]): number {
  return diagnostics.filter((d) => d.severity === 'error').length
}

export function problemsLabel(count: number): string {
  return count === 1 ? '1 problem' : `${count} problems`
}

export type SavePlan =
  | { kind: 'save'; payload: WorkflowSaveDefinitionPayload }
  | { kind: 'refuse'; reason: string }

export function planSave({
  destination,
  file,
  source,
  newName,
  activeRepoRoot
}: {
  destination: SaveDestination
  file: EditedFile | null
  source: string
  newName: string
  activeRepoRoot: string | null
}): SavePlan {
  if (destination === 'own' && file) {
    const base = { defId: file.defId, name: file.name, source }
    return { kind: 'save', payload: file.scope === 'repo' ? { scope: 'repo', repoRoot: file.repoRoot, ...base } : { scope: 'personal', ...base } }
  }
  const name = file?.name ?? newName.trim()
  if (!name) return { kind: 'refuse', reason: 'Enter a file name, or give the workflow a name: line' }
  if (destination === 'own') return { kind: 'save', payload: { scope: 'personal', name, source } }
  if (file?.scope === 'repo') return { kind: 'refuse', reason: 'This workflow is already in a repository' }
  if (!activeRepoRoot) return { kind: 'refuse', reason: 'Select a worktree to save to its repository' }
  return { kind: 'save', payload: { scope: 'repo', repoRoot: activeRepoRoot, name, source } }
}

export function saveWarnings(payload: WorkflowSaveDefinitionPayload, errors: number): string[] {
  const warnings: string[] = []
  if (errors > 0) warnings.push(`This definition has ${problemsLabel(errors)} and cannot be run.`)
  if (payload.scope === 'repo') {
    warnings.push(
      `This writes to the .harness/workflows folder of ${repoLabel(payload.repoRoot)}. Teammates, and you, will need to trust this new version before running it; commit the file to share it.`
    )
  }
  return warnings
}

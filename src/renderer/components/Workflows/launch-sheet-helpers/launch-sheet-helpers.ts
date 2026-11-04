import type { CodexHookTrustSummary, HooksConsent } from '../../../../shared/state/hooks'
import {
  WORKFLOW_STEP_MODEL_MAX_CHARS,
  applyOverrides,
  isWorkflowStepModel,
  type WorkflowDefinitionSummary,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowScope,
  type WorkflowStepOverride
} from '../../../../shared/state/workflows'
import type { Worktree } from '../../../../shared/state/worktrees'
import { branchNameProblem } from '../../../../shared/branch-name-rules'
import type { ResolvedDefinition, WorkflowAgent, WorkflowInputType } from '../../../../shared/workflow-def'

export type LaunchInputControl = 'textarea' | 'text'

export interface LaunchInputField {
  name: string
  type: WorkflowInputType
  control: LaunchInputControl
}

export interface CanStartArgs {
  consent: HooksConsent
  codexTrust: CodexHookTrustSummary | null
  inputs: Record<string, string>
  needsFull: boolean
  allowFull: boolean
  trustNeeded: boolean
  definition: ResolvedDefinition | null
}

export interface TrustNeededArgs {
  scope: WorkflowScope
  hash: string
  trustedHash: string | undefined
}

export interface TrustStepRow {
  id: string
  agent: string
  permission: string
}

export interface RunWorkflowItemArgs {
  labsWorkflows: boolean
  worktreePath: string
  runs: Record<string, WorkflowRun>
}

export type LaunchTarget =
  | { kind: 'preset'; worktreePath: string }
  | { kind: 'new'; repoRoot: string | null; branchName: string }
  | { kind: 'existing'; repoRoot: string | null; worktreePath: string | null }

export interface ExistingWorktreeOption {
  path: string
  label: string
}

export interface ExistingWorktreeOptionsArgs {
  worktrees: readonly Worktree[]
  repoRoot: string | null
  runs: Record<string, WorkflowRun>
}

export interface TargetBlockReasonArgs {
  target: LaunchTarget
  repoRoots: readonly string[]
  worktrees: readonly Worktree[]
  runs: Record<string, WorkflowRun>
}

export interface OverrideRow {
  id: string
  agent: WorkflowAgent
  model: string | undefined
}

export interface OverrideDraft {
  agent?: WorkflowAgent
  model?: string
}

export interface ResolvedOverrides {
  overrides: Record<string, WorkflowStepOverride> | undefined
  effective: ResolvedDefinition
  reason: string | null
  invalidStep: string | null
}

const BRANCH_DEFINITION_MAX_CHARS = 40

const BUSY_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set(['queued', 'running', 'paused'])

export function buildInputFields(definition: ResolvedDefinition | null): LaunchInputField[] {
  if (!definition) return []
  return Object.entries(definition.inputs).map(([name, { type }]) => ({
    name,
    type,
    control: type === 'text' ? 'textarea' : 'text'
  }))
}

export function needsFull(definition: ResolvedDefinition | null): boolean {
  return !!definition?.steps.some((step) => step.kind === 'agent' && step.permissions === 'full')
}

export function trustNeeded({ scope, hash, trustedHash }: TrustNeededArgs): boolean {
  return scope === 'repo' && trustedHash !== hash
}

export function trustStepRows(definition: ResolvedDefinition): TrustStepRow[] {
  return definition.steps.map((step) => {
    switch (step.kind) {
      case 'agent':
        return {
          id: step.id,
          agent: step.agent,
          permission: step.allow.length === 0 ? step.permissions : `${step.permissions} + ${step.allow.join(', ')}`
        }
      case 'shell':
        return { id: step.id, agent: 'shell', permission: 'shell' }
      default:
        return { id: step.id, agent: step.kind, permission: 'not supported' }
    }
  })
}

function isFilled(inputs: Record<string, string>, name: string): boolean {
  return Object.hasOwn(inputs, name) && inputs[name].trim() !== ''
}

function hasCodexStep(definition: ResolvedDefinition): boolean {
  return definition.steps.some((step) => step.kind === 'agent' && step.agent === 'codex')
}

export function startBlockReason({
  consent,
  codexTrust,
  inputs,
  needsFull,
  allowFull,
  trustNeeded,
  definition
}: CanStartArgs): string | null {
  if (!definition) return 'Pick a valid workflow'
  if (trustNeeded) return 'Trust this definition to start it'
  if (consent !== 'accepted') return 'Install hooks to start a workflow'
  if (hasCodexStep(definition) && codexTrust?.state !== 'ok') return 'Open a Codex tab and run /hooks'
  const missing = Object.keys(definition.inputs).find((name) => !isFilled(inputs, name))
  if (missing !== undefined) return `Fill in ${missing}`
  if (needsFull && !allowFull) return 'Confirm full access to start'
  return null
}

export function canStart(args: CanStartArgs): boolean {
  return startBlockReason(args) === null
}

export function isWorktreeBusy(runs: Record<string, WorkflowRun>, worktreePath: string): boolean {
  return Object.values(runs).some((run) => run.worktreePath === worktreePath && BUSY_STATUSES.has(run.status))
}

export function showRunWorkflowItem({ labsWorkflows, worktreePath, runs }: RunWorkflowItemArgs): boolean {
  return labsWorkflows && !isWorktreeBusy(runs, worktreePath)
}

export function definitionsForRepo(
  definitions: Record<string, WorkflowDefinitionSummary>,
  repoRoot: string | null
): WorkflowDefinitionSummary[] {
  return Object.values(definitions).filter(
    (summary) => summary.scope === 'personal' || (repoRoot !== null && summary.repoRoot === repoRoot)
  )
}

export function existingWorktreeOptions({ worktrees, repoRoot, runs }: ExistingWorktreeOptionsArgs): ExistingWorktreeOption[] {
  if (repoRoot === null) return []
  return worktrees
    .filter((wt) => wt.repoRoot === repoRoot && !wt.isBare && !isWorktreeBusy(runs, wt.path))
    .map((wt) => ({ path: wt.path, label: wt.branch || (wt.path.split('/').filter(Boolean).pop() ?? wt.path) }))
}

export function workflowBranchName(definitionName: string, suffix: string): string {
  const slug = definitionName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, BRANCH_DEFINITION_MAX_CHARS)
    .replace(/-+$/, '')
  return `wf/${slug || 'workflow'}/${suffix}`
}

export function targetBlockReason({ target, repoRoots, worktrees, runs }: TargetBlockReasonArgs): string | null {
  switch (target.kind) {
    case 'preset':
      return null
    case 'new':
      if (target.repoRoot === null || !repoRoots.includes(target.repoRoot)) return 'Choose a repository'
      return branchNameProblem(target.branchName)
    case 'existing': {
      if (target.repoRoot === null || !repoRoots.includes(target.repoRoot)) return 'Choose a repository'
      const allowed = existingWorktreeOptions({ worktrees, repoRoot: target.repoRoot, runs })
      return allowed.some((option) => option.path === target.worktreePath) ? null : 'Choose a worktree'
    }
    default: {
      const _exhaustive: never = target
      return _exhaustive
    }
  }
}

export function overrideRows(definition: ResolvedDefinition | null): OverrideRow[] {
  if (!definition) return []
  return definition.steps.flatMap((step) =>
    step.kind === 'agent' ? [{ id: step.id, agent: step.agent, model: step.model }] : []
  )
}

function changedOverride(row: OverrideRow, draft: OverrideDraft): WorkflowStepOverride | null {
  const agent = draft.agent ?? row.agent
  const agentChanged = agent !== row.agent
  const model = draft.model?.trim() ?? ''
  const modelChanged = model !== '' && (agentChanged || model !== row.model)
  if (!agentChanged && !modelChanged) return null
  return { ...(agentChanged ? { agent } : {}), ...(modelChanged ? { model } : {}) }
}

function modelProblem(id: string, model: string | undefined): string | null {
  if (model === undefined) return null
  if (model.length > WORKFLOW_STEP_MODEL_MAX_CHARS) return `Model for ${id} is too long`
  return isWorkflowStepModel(model) ? null : `Model for ${id} is invalid`
}

export function resolveOverrides(definition: ResolvedDefinition, drafts: Record<string, OverrideDraft>): ResolvedOverrides {
  const overrides: Record<string, WorkflowStepOverride> = {}
  let invalid: { stepId: string; reason: string } | null = null
  for (const row of overrideRows(definition)) {
    if (!Object.hasOwn(drafts, row.id)) continue
    const change = changedOverride(row, drafts[row.id])
    if (change === null) continue
    overrides[row.id] = change
    const problem = modelProblem(row.id, change.model)
    if (invalid === null && problem !== null) invalid = { stepId: row.id, reason: problem }
  }
  if (Object.keys(overrides).length === 0) return { overrides: undefined, effective: definition, reason: null, invalidStep: null }
  if (invalid !== null) return { overrides, effective: definition, reason: invalid.reason, invalidStep: invalid.stepId }
  const applied = applyOverrides(definition, overrides)
  return applied.ok
    ? { overrides, effective: applied.definition, reason: null, invalidStep: null }
    : { overrides, effective: definition, reason: 'Choose a supported agent', invalidStep: null }
}

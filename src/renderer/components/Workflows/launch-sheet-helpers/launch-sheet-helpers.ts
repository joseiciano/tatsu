import type { CodexHookTrustSummary, HooksConsent } from '../../../../shared/state/hooks'
import type { WorkflowRun, WorkflowRunStatus } from '../../../../shared/state/workflows'
import type { ResolvedDefinition, WorkflowInputType } from '../../../../shared/workflow-def'

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
  definition: ResolvedDefinition | null
}

export interface RunWorkflowItemArgs {
  labsWorkflows: boolean
  worktreePath: string
  runs: Record<string, WorkflowRun>
}

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
  definition
}: CanStartArgs): string | null {
  if (!definition) return 'Pick a valid workflow'
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

export function showRunWorkflowItem({ labsWorkflows, worktreePath, runs }: RunWorkflowItemArgs): boolean {
  if (!labsWorkflows) return false
  return !Object.values(runs).some((run) => run.worktreePath === worktreePath && BUSY_STATUSES.has(run.status))
}

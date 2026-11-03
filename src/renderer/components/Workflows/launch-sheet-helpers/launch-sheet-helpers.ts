import type { CodexHookTrustSummary, HooksConsent } from '../../../../shared/state/hooks'
import type { WorkflowRun, WorkflowRunStatus, WorkflowScope } from '../../../../shared/state/workflows'
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

export function showRunWorkflowItem({ labsWorkflows, worktreePath, runs }: RunWorkflowItemArgs): boolean {
  if (!labsWorkflows) return false
  return !Object.values(runs).some((run) => run.worktreePath === worktreePath && BUSY_STATUSES.has(run.status))
}

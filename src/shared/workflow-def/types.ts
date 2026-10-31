import type { PermissionLevel } from '../permission-level'

export type WorkflowDiagnosticSeverity = 'error' | 'warning'

export type WorkflowDiagnosticCode =
  | 'yaml-syntax'
  | 'yaml-tag'
  | 'alias-limit'
  | 'too-large'
  | 'unknown-key'
  | 'wrong-type'
  | 'missing-field'
  | 'bad-value'
  | 'bad-condition'
  | 'duplicate-id'
  | 'unknown-ref'
  | 'cycle'
  | 'bad-back-to'
  | 'kind-mismatch'
  | 'unsafe-allow'
  | 'internal'

export interface WorkflowDiagnostic {
  severity: WorkflowDiagnosticSeverity
  code: WorkflowDiagnosticCode
  message: string
  path: string
  line: number
  col: number
}

export type WorkflowInputType = 'text' | 'issue' | 'pr' | 'file'

export interface WorkflowInputDef {
  type: WorkflowInputType
}

export interface WorkflowDefaults {
  permissions?: PermissionLevel
  allow?: string[]
}

export type WorkflowScalar = string | number | boolean

export type WorkflowCondition =
  | { field: string; equals: WorkflowScalar }
  | { field: string; in: WorkflowScalar[] }
  | { field: string; not: WorkflowScalar }
  | { exit: number }

export type OutputScalarType = 'string' | 'number' | 'boolean'

export interface OutputItemSchema {
  type?: OutputScalarType
  enum?: WorkflowScalar[]
}

export interface OutputFieldSchema {
  type?: OutputScalarType | 'array'
  enum?: WorkflowScalar[]
  items?: OutputItemSchema
}

export interface WorkflowOutputSchema {
  fields: Record<string, OutputFieldSchema>
  required?: string[]
}

export interface WorkflowLoop {
  back_to: string
  until: WorkflowCondition
  max: number
  fresh?: boolean
}

export type WorkflowStepKind = 'agent' | 'shell' | 'foreach' | 'orchestrator'

export type WorkflowGate = 'approve'

export type ForeachMode = 'independent' | 'stacked'

export interface ParsedWorkflowStep {
  id: string
  kind?: WorkflowStepKind
  agent?: string
  model?: string
  permissions?: PermissionLevel
  allow?: string[]
  prompt?: string
  run?: string
  needs?: string[]
  gate?: WorkflowGate
  output?: WorkflowOutputSchema
  loop?: WorkflowLoop
  when?: WorkflowCondition
  on_loop?: string
  parallel_safe?: boolean
  timeout?: number
  over?: string
  mode?: ForeachMode
}

export interface ParsedWorkflowDefinition {
  name: string
  inputs: Record<string, WorkflowInputDef>
  item_input?: string
  defaults?: WorkflowDefaults
  steps: ParsedWorkflowStep[]
}

export type WorkflowAgent = 'claude' | 'codex' | 'opencode'

export interface ResolvedStepCommon extends Pick<ParsedWorkflowStep, 'id' | 'gate' | 'loop' | 'when' | 'on_loop' | 'parallel_safe' | 'timeout'> {
  needs: string[]
}

export interface ResolvedAgentStep extends ResolvedStepCommon, Pick<ParsedWorkflowStep, 'model' | 'output'> {
  kind: 'agent'
  agent: WorkflowAgent
  prompt: string
  permissions: PermissionLevel
  allow: string[]
}

export interface ResolvedShellStep extends ResolvedStepCommon {
  kind: 'shell'
  run: string
}

export interface ResolvedReservedStep extends Omit<ParsedWorkflowStep, 'kind' | 'needs'> {
  kind: 'foreach' | 'orchestrator'
  needs: string[]
}

export type ResolvedWorkflowStep = ResolvedAgentStep | ResolvedShellStep | ResolvedReservedStep

export interface ResolvedDefinition {
  name: string
  inputs: Record<string, WorkflowInputDef>
  item_input?: string
  steps: ResolvedWorkflowStep[]
}

export type ValidateWorkflowOptions = Record<never, never>

export interface WorkflowValidationResult {
  parsed?: ParsedWorkflowDefinition
  definition?: ResolvedDefinition
  diagnostics: WorkflowDiagnostic[]
}

export interface ConditionContext {
  status?: string
  data?: Record<string, unknown>
  exitCode?: number
}

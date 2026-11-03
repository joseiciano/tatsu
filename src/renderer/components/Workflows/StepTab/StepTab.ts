import type { TerminalTab } from '../../../../shared/state/terminals'
import type {
  WorkflowActionResponse,
  WorkflowAttempt,
  WorkflowAttemptRecord,
  WorkflowCompletedBy,
  WorkflowMarkDonePayload,
  WorkflowPausedReason,
  WorkflowRunRecord,
  WorkflowStepStatus
} from '../../../../shared/state/workflows'
import {
  STEP_OUTPUT_FORBIDDEN_KEYS,
  STEP_OUTPUT_RESERVED_KEYS,
  validateStepOutput,
  type OutputFieldSchema,
  type OutputScalarType,
  type ResolvedWorkflowStep,
  type WorkflowOutputSchema,
  type WorkflowScalar
} from '../../../../shared/workflow-def'

export type StepTabCloseDecision = 'confirm-cancel' | 'close'

export type StepTabOverlayMode = 'result' | 'result-with-mark-done' | 'default'

export type MarkDoneField =
  | { kind: 'text'; name: string; required: boolean }
  | { kind: 'number'; name: string; required: boolean }
  | { kind: 'boolean'; name: string; required: boolean }
  | { kind: 'enum'; name: string; required: boolean; options: WorkflowScalar[] }
  | { kind: 'list'; name: string; required: boolean; itemType?: OutputScalarType; itemEnum?: WorkflowScalar[] }

export type MarkDoneValues = Record<string, string | boolean>

export type MarkDoneErrors = Record<string, string>

export type MarkDonePayloadResult = { ok: true; payload: WorkflowMarkDonePayload } | { ok: false; errors: MarkDoneErrors }

export const COMPLETED_BY_LABELS: Record<WorkflowCompletedBy, string> = {
  tool: 'the agent (complete_step)',
  fallback: 'end of the agent turn',
  user: 'you (Mark done)',
  exit: 'process exit'
}

const MARK_DONE_REASONS: ReadonlySet<WorkflowPausedReason> = new Set(['needs-input', 'step-failed'])

const MARK_DONE_STEP_STATUSES: ReadonlySet<WorkflowStepStatus> = new Set([
  'failed',
  'cancelled',
  'interrupted',
  'running'
])

export function stepTabCloseDecision(
  tab: Pick<TerminalTab, 'workflow'>,
  attempt: Pick<WorkflowAttempt, 'status'> | null
): StepTabCloseDecision {
  if (!tab.workflow) return 'close'
  return attempt?.status === 'running' ? 'confirm-cancel' : 'close'
}

export function stepTabOverlayMode(
  tab: Pick<TerminalTab, 'workflow'>,
  attempt: Pick<WorkflowAttemptRecord, 'attemptId' | 'stepId'> | null,
  run: WorkflowRunRecord | null
): StepTabOverlayMode {
  const ref = tab.workflow
  if (!ref) return 'default'
  if (!run || run.status !== 'paused' || !run.pausedReason || !MARK_DONE_REASONS.has(run.pausedReason)) return 'result'
  const stepId = attempt?.stepId ?? ref.stepId
  const attemptId = attempt?.attemptId ?? ref.attemptId
  if (run.definition.steps[run.cursor]?.id !== stepId) return 'result'
  const status = Object.hasOwn(run.steps, stepId) ? run.steps[stepId] : undefined
  if (!status || !MARK_DONE_STEP_STATUSES.has(status)) return 'result'
  const latest = run.attempts.filter((a) => a.stepId === stepId).at(-1)
  return latest?.attemptId === attemptId ? 'result-with-mark-done' : 'result'
}

export function markedDoneAfter(
  run: WorkflowRunRecord | null,
  stepId: string,
  attemptId: string
): WorkflowAttemptRecord | null {
  const latest = run?.attempts.filter((a) => a.stepId === stepId).at(-1)
  if (!latest || latest.attemptId === attemptId || latest.result?.completedBy !== 'user') return null
  return latest
}

export function stepOutputSchema(step: ResolvedWorkflowStep | undefined): WorkflowOutputSchema | undefined {
  return step?.kind === 'agent' ? step.output : undefined
}

function fieldDescriptor(name: string, schema: OutputFieldSchema, required: boolean): MarkDoneField {
  if (schema.type === 'array') {
    return {
      kind: 'list',
      name,
      required,
      ...(schema.items?.type ? { itemType: schema.items.type } : {}),
      ...(schema.items?.enum ? { itemEnum: schema.items.enum } : {})
    }
  }
  if (schema.enum) return { kind: 'enum', name, required, options: schema.enum }
  if (schema.type === 'number') return { kind: 'number', name, required }
  if (schema.type === 'boolean') return { kind: 'boolean', name, required }
  return { kind: 'text', name, required }
}

export function buildMarkDoneFields(step: ResolvedWorkflowStep | undefined): MarkDoneField[] {
  const schema = stepOutputSchema(step)
  if (!schema) return []
  const required = new Set(schema.required ?? [])
  return Object.keys(schema.fields)
    .filter((name) => !STEP_OUTPUT_RESERVED_KEYS.has(name) && !STEP_OUTPUT_FORBIDDEN_KEYS.has(name))
    .map((name) => fieldDescriptor(name, schema.fields[name], required.has(name)))
}

export function initialMarkDoneValues(fields: readonly MarkDoneField[]): MarkDoneValues {
  const values: MarkDoneValues = {}
  for (const field of fields) values[field.name] = field.kind === 'boolean' ? false : ''
  return values
}

type Parsed = { kind: 'value'; value: unknown } | { kind: 'omit' } | { kind: 'error'; message: string }

function parseNumber(text: string): Parsed {
  const value = Number(text)
  return text !== '' && Number.isFinite(value) ? { kind: 'value', value } : { kind: 'error', message: 'Expected a number' }
}

function parseItem(text: string, itemType: OutputScalarType | undefined, itemEnum: WorkflowScalar[] | undefined): Parsed {
  if (itemEnum) {
    const match = itemEnum.find((option) => String(option) === text)
    return { kind: 'value', value: match ?? text }
  }
  if (itemType === 'number') return parseNumber(text)
  if (itemType === 'boolean') {
    if (text === 'true' || text === 'false') return { kind: 'value', value: text === 'true' }
    return { kind: 'error', message: 'Expected true or false' }
  }
  return { kind: 'value', value: text }
}

function parseField(field: MarkDoneField, raw: string | boolean | undefined): Parsed {
  if (field.kind === 'boolean') return { kind: 'value', value: raw === true }
  const text = typeof raw === 'string' ? raw : ''
  switch (field.kind) {
    case 'text':
      return text.trim() === '' ? { kind: 'omit' } : { kind: 'value', value: text }
    case 'number':
      return text.trim() === '' ? { kind: 'omit' } : parseNumber(text.trim())
    case 'enum': {
      if (text === '') return { kind: 'omit' }
      const index = Number(text)
      return Number.isInteger(index) && index >= 0 && index < field.options.length
        ? { kind: 'value', value: field.options[index] }
        : { kind: 'error', message: 'Pick one of the options' }
    }
    case 'list': {
      const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
      if (lines.length === 0) return { kind: 'omit' }
      const items: unknown[] = []
      for (const line of lines) {
        const item = parseItem(line, field.itemType, field.itemEnum)
        if (item.kind === 'error') return item
        if (item.kind === 'omit') continue
        items.push(item.value)
      }
      return { kind: 'value', value: items }
    }
    default: {
      const _exhaustive: never = field
      return _exhaustive
    }
  }
}

function errorKey(field: string): string {
  return field.replace(/\[\d+\]$/, '')
}

export function markDonePayload(
  step: ResolvedWorkflowStep | undefined,
  summary: string,
  values: MarkDoneValues
): MarkDonePayloadResult {
  const errors: MarkDoneErrors = {}
  const fields: Record<string, unknown> = {}
  for (const field of buildMarkDoneFields(step)) {
    const parsed = parseField(field, values[field.name])
    if (parsed.kind === 'error') errors[field.name] = parsed.message
    else if (parsed.kind === 'value') fields[field.name] = parsed.value
  }
  if (summary.trim() === '') errors.summary = 'Required'
  const validation = validateStepOutput(stepOutputSchema(step), { ...fields, summary })
  if (!validation.ok) {
    for (const { field, message } of validation.errors) {
      const key = errorKey(field)
      if (!Object.hasOwn(errors, key)) errors[key] = message
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return { ok: true, payload: { summary, fields } }
}

export async function cancelStepThenClose(
  cancel: () => Promise<WorkflowActionResponse>,
  close: () => void
): Promise<string | null> {
  let response: WorkflowActionResponse
  try {
    response = await cancel()
  } catch {
    return 'Could not cancel the step'
  }
  if ('error' in response) return response.error
  close()
  return null
}

import {
  STEP_OUTPUT_ARRAY_MAX_ITEMS,
  STEP_OUTPUT_FIELD_NAME_MAX_CHARS,
  STEP_OUTPUT_FORBIDDEN_KEYS,
  STEP_OUTPUT_MAX_ERRORS,
  STEP_OUTPUT_RESERVED_KEYS,
  STEP_OUTPUT_STATUSES,
  STEP_OUTPUT_STRING_MAX_CHARS,
  STEP_SUMMARY_MAX_CHARS
} from './constants'
import type {
  OutputFieldSchema,
  OutputItemSchema,
  StepInputProperty,
  StepInputSchema,
  StepOutputFieldError,
  StepOutputStatus,
  StepOutputValidation,
  WorkflowOutputSchema,
  WorkflowScalar
} from './types'

function isUnexpressible(name: string): boolean {
  return STEP_OUTPUT_RESERVED_KEYS.has(name) || STEP_OUTPUT_FORBIDDEN_KEYS.has(name)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStatus(value: unknown): value is StepOutputStatus {
  return STEP_OUTPUT_STATUSES.some((status) => status === value)
}

function displayName(name: string): string {
  return name.length > STEP_OUTPUT_FIELD_NAME_MAX_CHARS ? `${name.slice(0, STEP_OUTPUT_FIELD_NAME_MAX_CHARS)}…` : name
}

function formatEnum(values: readonly WorkflowScalar[]): string {
  return `Expected one of: ${values.map((value) => JSON.stringify(value)).join(', ')}`
}

function checkString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return 'Expected a string'
  return value.length > max ? `Expected at most ${max} characters` : null
}

function checkScalar(schema: OutputItemSchema, value: unknown): string | null {
  switch (schema.type) {
    case 'string': {
      const error = checkString(value, STEP_OUTPUT_STRING_MAX_CHARS)
      if (error) return error
      break
    }
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'Expected a number'
      break
    case 'boolean':
      if (typeof value !== 'boolean') return 'Expected a boolean'
      break
    case undefined:
      if (schema.enum === undefined && !['string', 'number', 'boolean'].includes(typeof value)) {
        return 'Expected a string, number or boolean'
      }
      break
    default: {
      const _exhaustive: never = schema.type
      void _exhaustive
    }
  }
  if (schema.enum && !schema.enum.some((option) => option === value)) return formatEnum(schema.enum)
  return null
}

function checkField(name: string, schema: OutputFieldSchema, value: unknown, errors: StepOutputFieldError[]): boolean {
  if (schema.type !== 'array') {
    const message = checkScalar({ type: schema.type, enum: schema.enum }, value)
    if (message) errors.push({ field: name, message })
    return message === null
  }
  if (!Array.isArray(value)) {
    errors.push({ field: name, message: 'Expected an array' })
    return false
  }
  if (value.length > STEP_OUTPUT_ARRAY_MAX_ITEMS) {
    errors.push({ field: name, message: `Expected at most ${STEP_OUTPUT_ARRAY_MAX_ITEMS} items` })
    return false
  }
  const before = errors.length
  value.forEach((item, i) => {
    const message = checkScalar(schema.items ?? {}, item)
    if (message) errors.push({ field: `${name}[${i}]`, message })
  })
  return errors.length === before
}

export function validateStepOutput(schema: WorkflowOutputSchema | undefined, value: unknown): StepOutputValidation {
  if (!isRecord(value)) return { ok: false, errors: [{ field: '', message: 'Expected an object' }] }
  const fields = schema?.fields ?? {}
  const errors: StepOutputFieldError[] = []
  for (const name of Object.keys(fields)) {
    if (isUnexpressible(name)) {
      errors.push({ field: name, message: 'Output field uses a reserved name; fix the workflow definition' })
    }
  }

  const status = Object.hasOwn(value, 'status') ? value.status : 'done'
  if (!isStatus(status)) errors.push({ field: 'status', message: formatEnum(STEP_OUTPUT_STATUSES) })

  let summary = ''
  if (!Object.hasOwn(value, 'summary')) {
    errors.push({ field: 'summary', message: 'Required' })
  } else {
    const message = checkString(value.summary, STEP_SUMMARY_MAX_CHARS)
    if (message) errors.push({ field: 'summary', message })
    else if (typeof value.summary === 'string') summary = value.summary
  }

  const data: Record<string, unknown> = {}
  let dataCount = 0
  for (const key of Object.keys(value)) {
    if (STEP_OUTPUT_RESERVED_KEYS.has(key)) continue
    if (STEP_OUTPUT_FORBIDDEN_KEYS.has(key)) {
      errors.push({ field: key, message: 'Reserved key' })
      continue
    }
    const field = Object.hasOwn(fields, key) ? fields[key] : undefined
    if (!field) {
      errors.push({ field: displayName(key), message: 'Unknown field' })
      continue
    }
    if (checkField(key, field, value[key], errors)) {
      data[key] = value[key]
      dataCount++
    }
  }

  for (const name of schema?.required ?? []) {
    if (STEP_OUTPUT_RESERVED_KEYS.has(name)) continue
    if (!Object.hasOwn(value, name)) errors.push({ field: name, message: 'Required' })
  }

  if (errors.length > 0 || !isStatus(status)) return { ok: false, errors: errors.slice(0, STEP_OUTPUT_MAX_ERRORS) }
  return { ok: true, value: { status, summary, ...(dataCount > 0 ? { data } : {}) } }
}

function scalarJsonSchema(schema: OutputItemSchema): StepInputProperty {
  return {
    ...(schema.type === undefined ? {} : { type: schema.type }),
    ...(schema.enum === undefined ? {} : { enum: [...schema.enum] }),
    ...(schema.type === 'string' ? { maxLength: STEP_OUTPUT_STRING_MAX_CHARS } : {})
  }
}

function fieldJsonSchema(schema: OutputFieldSchema): StepInputProperty {
  if (schema.type !== 'array') return scalarJsonSchema({ type: schema.type, enum: schema.enum })
  return { type: 'array', items: scalarJsonSchema(schema.items ?? {}), maxItems: STEP_OUTPUT_ARRAY_MAX_ITEMS }
}

export function outputJsonSchema(step: { output?: WorkflowOutputSchema }): StepInputSchema {
  const properties: Record<string, StepInputProperty> = {
    status: {
      type: 'string',
      enum: [...STEP_OUTPUT_STATUSES],
      default: 'done',
      description: '"done" when the step succeeded, "failed" when it cannot succeed, "needs-input" to ask the user a question.'
    },
    summary: {
      type: 'string',
      maxLength: STEP_SUMMARY_MAX_CHARS,
      description: 'What the step did, or the question to ask when status is "needs-input".'
    }
  }
  const fields = step.output?.fields ?? {}
  for (const name of Object.keys(fields)) {
    if (!isUnexpressible(name)) properties[name] = fieldJsonSchema(fields[name])
  }
  const required = (step.output?.required ?? []).filter(
    (name) => !isUnexpressible(name) && Object.hasOwn(fields, name)
  )
  return { type: 'object', properties, required: ['summary', ...required], additionalProperties: false }
}

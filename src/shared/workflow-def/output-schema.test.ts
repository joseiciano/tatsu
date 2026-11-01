import { describe, it, expect } from 'vitest'
import {
  STEP_OUTPUT_ARRAY_MAX_ITEMS,
  STEP_OUTPUT_MAX_ERRORS,
  STEP_OUTPUT_STRING_MAX_CHARS,
  STEP_SUMMARY_MAX_CHARS,
  outputJsonSchema,
  validateStepOutput,
  type StepOutputFieldError,
  type StepOutputValue,
  type WorkflowOutputSchema
} from '.'

const schema: WorkflowOutputSchema = {
  fields: {
    title: { type: 'string' },
    score: { type: 'number' },
    approved: { type: 'boolean' },
    verdict: { enum: ['pass', 'fail'] },
    level: { type: 'number', enum: [1, 2, 3] },
    tags: { type: 'array', items: { type: 'string' } },
    picks: { type: 'array', items: { enum: ['a', 'b'] } }
  },
  required: ['verdict']
}

describe('validateStepOutput: accepted values', () => {
  it.each<{ name: string; input: Record<string, unknown>; value: StepOutputValue }>([
    {
      name: 'status defaults to done',
      input: { summary: 's', verdict: 'pass' },
      value: { status: 'done', summary: 's', data: { verdict: 'pass' } }
    },
    {
      name: 'explicit failed status',
      input: { status: 'failed', summary: '', verdict: 'fail' },
      value: { status: 'failed', summary: '', data: { verdict: 'fail' } }
    },
    {
      name: 'needs-input status',
      input: { status: 'needs-input', summary: 'q?', verdict: 'pass' },
      value: { status: 'needs-input', summary: 'q?', data: { verdict: 'pass' } }
    },
    {
      name: 'every type',
      input: {
        summary: 's',
        title: 't',
        score: -1.5,
        approved: false,
        verdict: 'pass',
        level: 2,
        tags: ['x', 'y'],
        picks: []
      },
      value: {
        status: 'done',
        summary: 's',
        data: { title: 't', score: -1.5, approved: false, verdict: 'pass', level: 2, tags: ['x', 'y'], picks: [] }
      }
    }
  ])('$name', ({ input, value }) => {
    expect(validateStepOutput(schema, input)).toEqual({ ok: true, value })
  })

  it('omits data when no fields are given', () => {
    expect(validateStepOutput(undefined, { summary: 'ok' })).toEqual({
      ok: true,
      value: { status: 'done', summary: 'ok' }
    })
  })

  it('accepts a string at the length cap', () => {
    const title = 'x'.repeat(STEP_OUTPUT_STRING_MAX_CHARS)
    const result = validateStepOutput(schema, { summary: 's', verdict: 'pass', title })
    expect(result.ok).toBe(true)
  })

  it('accepts a schema whose fields have no prototype', () => {
    const fields = Object.assign(Object.create(null), { n: { type: 'number' } })
    expect(validateStepOutput({ fields }, { summary: 's', n: 3 })).toEqual({
      ok: true,
      value: { status: 'done', summary: 's', data: { n: 3 } }
    })
  })
})

describe('validateStepOutput: rejected values', () => {
  it.each<{ name: string; input: unknown; errors: StepOutputFieldError[] }>([
    { name: 'non-object', input: [], errors: [{ field: '', message: 'Expected an object' }] },
    { name: 'null', input: null, errors: [{ field: '', message: 'Expected an object' }] },
    {
      name: 'missing summary',
      input: { verdict: 'pass' },
      errors: [{ field: 'summary', message: 'Required' }]
    },
    {
      name: 'non-string summary',
      input: { summary: 1, verdict: 'pass' },
      errors: [{ field: 'summary', message: 'Expected a string' }]
    },
    {
      name: 'unknown status',
      input: { status: 'skipped', summary: 's', verdict: 'pass' },
      errors: [{ field: 'status', message: 'Expected one of: "done", "failed", "needs-input"' }]
    },
    {
      name: 'missing required field',
      input: { summary: 's' },
      errors: [{ field: 'verdict', message: 'Required' }]
    },
    {
      name: 'wrong string type',
      input: { summary: 's', verdict: 'pass', title: 3 },
      errors: [{ field: 'title', message: 'Expected a string' }]
    },
    {
      name: 'wrong number type',
      input: { summary: 's', verdict: 'pass', score: '3' },
      errors: [{ field: 'score', message: 'Expected a number' }]
    },
    {
      name: 'non-finite number',
      input: { summary: 's', verdict: 'pass', score: Number.POSITIVE_INFINITY },
      errors: [{ field: 'score', message: 'Expected a number' }]
    },
    {
      name: 'wrong boolean type',
      input: { summary: 's', verdict: 'pass', approved: 'true' },
      errors: [{ field: 'approved', message: 'Expected a boolean' }]
    },
    {
      name: 'enum miss',
      input: { summary: 's', verdict: 'maybe' },
      errors: [{ field: 'verdict', message: 'Expected one of: "pass", "fail"' }]
    },
    {
      name: 'enum compares strictly',
      input: { summary: 's', verdict: 'pass', level: '2' },
      errors: [{ field: 'level', message: 'Expected a number' }]
    },
    {
      name: 'typed enum miss',
      input: { summary: 's', verdict: 'pass', level: 4 },
      errors: [{ field: 'level', message: 'Expected one of: 1, 2, 3' }]
    },
    {
      name: 'array expected',
      input: { summary: 's', verdict: 'pass', tags: 'x' },
      errors: [{ field: 'tags', message: 'Expected an array' }]
    },
    {
      name: 'bad array item',
      input: { summary: 's', verdict: 'pass', tags: ['x', 2] },
      errors: [{ field: 'tags[1]', message: 'Expected a string' }]
    },
    {
      name: 'nested object item',
      input: { summary: 's', verdict: 'pass', picks: [{ a: 1 }] },
      errors: [{ field: 'picks[0]', message: 'Expected one of: "a", "b"' }]
    },
    {
      name: 'object for a scalar field',
      input: { summary: 's', verdict: 'pass', title: { a: 1 } },
      errors: [{ field: 'title', message: 'Expected a string' }]
    },
    {
      name: 'unknown extra field',
      input: { summary: 's', verdict: 'pass', extra: 1 },
      errors: [{ field: 'extra', message: 'Unknown field' }]
    },
    {
      name: 'runner-owned field',
      input: { summary: 's', verdict: 'pass', costUsd: 1 },
      errors: [{ field: 'costUsd', message: 'Unknown field' }]
    },
    {
      name: 'prototype key',
      input: JSON.parse('{"summary":"s","verdict":"pass","__proto__":{"polluted":true}}'),
      errors: [{ field: '__proto__', message: 'Reserved key' }]
    },
    {
      name: 'constructor key',
      input: { summary: 's', verdict: 'pass', constructor: 'x' },
      errors: [{ field: 'constructor', message: 'Reserved key' }]
    }
  ])('$name', ({ input, errors }) => {
    expect(validateStepOutput(schema, input)).toEqual({ ok: false, errors })
  })

  it('caps summary length', () => {
    const summary = 'x'.repeat(STEP_SUMMARY_MAX_CHARS + 1)
    expect(validateStepOutput(undefined, { summary })).toEqual({
      ok: false,
      errors: [{ field: 'summary', message: `Expected at most ${STEP_SUMMARY_MAX_CHARS} characters` }]
    })
  })

  it('caps string field length', () => {
    const title = 'x'.repeat(STEP_OUTPUT_STRING_MAX_CHARS + 1)
    expect(validateStepOutput(schema, { summary: 's', verdict: 'pass', title })).toEqual({
      ok: false,
      errors: [{ field: 'title', message: `Expected at most ${STEP_OUTPUT_STRING_MAX_CHARS} characters` }]
    })
  })

  it('caps array length', () => {
    const tags = Array.from({ length: STEP_OUTPUT_ARRAY_MAX_ITEMS + 1 }, () => 'x')
    expect(validateStepOutput(schema, { summary: 's', verdict: 'pass', tags })).toEqual({
      ok: false,
      errors: [{ field: 'tags', message: `Expected at most ${STEP_OUTPUT_ARRAY_MAX_ITEMS} items` }]
    })
  })

  it('caps the error list', () => {
    const input: Record<string, unknown> = { summary: 's', verdict: 'pass' }
    for (let i = 0; i < STEP_OUTPUT_MAX_ERRORS + 5; i++) input[`x${i}`] = i
    const result = validateStepOutput(schema, input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors).toHaveLength(STEP_OUTPUT_MAX_ERRORS)
  })

  it('truncates long unknown field names in errors', () => {
    const name = `a${'b'.repeat(200)}`
    const result = validateStepOutput(undefined, { summary: 's', [name]: 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0].field.length).toBeLessThanOrEqual(65)
  })

  it('never echoes submitted values in errors', () => {
    const result = validateStepOutput(schema, { summary: 's', verdict: 'sk-secret-123', title: 'sk-secret-123'.length })
    expect(JSON.stringify(result)).not.toContain('sk-secret-123')
  })

  it.each(['status', 'summary', 'constructor'])('fails closed when the definition declares the reserved field %s', (name) => {
    const fields = Object.assign(Object.create(null), { [name]: { type: 'string' } })
    const result = validateStepOutput({ fields }, { summary: 's' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toEqual({ field: name, message: 'Output field uses a reserved name; fix the workflow definition' })
  })

  it('a required constructor field never passes with an empty body', () => {
    const fields = Object.assign(Object.create(null), { constructor: { type: 'string' } })
    expect(validateStepOutput({ fields, required: ['constructor'] }, {}).ok).toBe(false)
  })

  it('does not pollute Object.prototype', () => {
    validateStepOutput(schema, JSON.parse('{"summary":"s","verdict":"pass","__proto__":{"polluted":true}}'))
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('outputJsonSchema', () => {
  it('describes status, summary and every declared field', () => {
    expect(outputJsonSchema({ output: schema })).toEqual({
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['done', 'failed', 'needs-input'],
          default: 'done',
          description: expect.any(String)
        },
        summary: { type: 'string', maxLength: STEP_SUMMARY_MAX_CHARS, description: expect.any(String) },
        title: { type: 'string', maxLength: STEP_OUTPUT_STRING_MAX_CHARS },
        score: { type: 'number' },
        approved: { type: 'boolean' },
        verdict: { enum: ['pass', 'fail'] },
        level: { type: 'number', enum: [1, 2, 3] },
        tags: {
          type: 'array',
          items: { type: 'string', maxLength: STEP_OUTPUT_STRING_MAX_CHARS },
          maxItems: STEP_OUTPUT_ARRAY_MAX_ITEMS
        },
        picks: { type: 'array', items: { enum: ['a', 'b'] }, maxItems: STEP_OUTPUT_ARRAY_MAX_ITEMS }
      },
      required: ['summary', 'verdict'],
      additionalProperties: false
    })
  })

  it('has only status and summary without an output schema', () => {
    const result = outputJsonSchema({})
    expect(Object.keys(result.properties)).toEqual(['status', 'summary'])
    expect(result.required).toEqual(['summary'])
  })

  it('omits reserved field names', () => {
    const fields = Object.assign(Object.create(null), {
      status: { type: 'string' },
      constructor: { type: 'string' },
      ok: { type: 'boolean' }
    })
    const result = outputJsonSchema({ output: { fields, required: ['constructor', 'ok'] } })
    expect(Object.keys(result.properties)).toEqual(['status', 'summary', 'ok'])
    expect(result.properties.status.enum).toEqual(['done', 'failed', 'needs-input'])
    expect(result.required).toEqual(['summary', 'ok'])
  })
})

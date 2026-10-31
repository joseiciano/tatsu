import { describe, it, expect } from 'vitest'
import { formatTemplateRef, renderTemplate, tokenizeTemplate, type TemplateRef, type TemplateScope } from '.'

describe('tokenizeTemplate: references', () => {
  it.each<{ text: string; ref: TemplateRef }>([
    { text: '{{inputs.task}}', ref: { root: 'inputs', name: 'task' } },
    { text: '{{ steps.plan.summary }}', ref: { root: 'steps', step: 'plan', property: 'summary' } },
    { text: '{{steps.test-1.status}}', ref: { root: 'steps', step: 'test-1', property: 'status' } },
    { text: '{{steps.review.data.verdict}}', ref: { root: 'steps', step: 'review', property: 'data', field: 'verdict' } },
    { text: '{{run.id}}', ref: { root: 'run', field: 'id' } },
    { text: '{{run.worktree}}', ref: { root: 'run', field: 'worktree' } },
    { text: '{{\trun.contextPath\n}}', ref: { root: 'run', field: 'contextPath' } },
    { text: '{{item.title}}', ref: { root: 'item', field: 'title' } }
  ])('parses $text', ({ text, ref }) => {
    expect(tokenizeTemplate(text)).toEqual([{ kind: 'ref', start: 0, raw: text, ref }])
  })

  it('splits text and references with their offsets', () => {
    expect(tokenizeTemplate('a {{inputs.x}} b {{run.id}}')).toEqual([
      { kind: 'text', start: 0, text: 'a ' },
      { kind: 'ref', start: 2, raw: '{{inputs.x}}', ref: { root: 'inputs', name: 'x' } },
      { kind: 'text', start: 14, text: ' b ' },
      { kind: 'ref', start: 17, raw: '{{run.id}}', ref: { root: 'run', field: 'id' } }
    ])
  })

  it('returns plain text without tokens', () => {
    expect(tokenizeTemplate('no refs } { here')).toEqual([{ kind: 'text', start: 0, text: 'no refs } { here' }])
    expect(tokenizeTemplate('')).toEqual([])
  })

  it('round-trips every reference through formatTemplateRef', () => {
    const tokens = tokenizeTemplate('{{ inputs.a }}{{steps.s.data.f}}{{run.id}}{{item.k}}{{steps.s.status}}')
    expect(tokens.map((t) => (t.kind === 'ref' ? formatTemplateRef(t.ref) : t.kind))).toEqual([
      'inputs.a',
      'steps.s.data.f',
      'run.id',
      'item.k',
      'steps.s.status'
    ])
  })
})

describe('tokenizeTemplate: errors', () => {
  it.each([
    { name: 'unclosed token', text: 'x {{inputs.task', start: 2, message: /Unclosed "\{\{"/ },
    { name: 'empty token', text: '{{ }}', start: 0, message: /Empty/ },
    { name: 'unknown root', text: '{{env.HOME}}', start: 0, message: /Unknown template root "env"/ },
    { name: 'root alone', text: '{{inputs}}', start: 0, message: /needs a name/ },
    { name: 'bad segment', text: '{{inputs.ta sk}}', start: 0, message: /Malformed/ },
    { name: 'nested braces', text: '{{inputs.{{x}}}}', start: 0, message: /Malformed/ },
    { name: 'expression syntax', text: '{{inputs.a | upper}}', start: 0, message: /Malformed/ },
    { name: 'step without property', text: '{{steps.plan}}', start: 0, message: /needs a property/ },
    { name: 'unknown step property', text: '{{steps.plan.output}}', start: 0, message: /Unknown step property "output"/ },
    { name: 'data without field', text: '{{steps.plan.data}}', start: 0, message: /needs a field/ },
    { name: 'nested data field', text: '{{steps.plan.data.a.b}}', start: 0, message: /one level/ },
    { name: 'extra segment after summary', text: '{{steps.plan.summary.x}}', start: 0, message: /Unknown step property|Malformed|too many/i },
    { name: 'unknown run field', text: '{{run.branch}}', start: 0, message: /Unknown run property "branch"/ },
    { name: 'nested item field', text: '{{item.a.b}}', start: 0, message: /one level/ },
    { name: 'wildcard', text: '{{steps.*.summary}}', start: 0, message: /Malformed/ }
  ])('$name', ({ text, start, message }) => {
    const errors = tokenizeTemplate(text).filter((t) => t.kind === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].start).toBe(start)
    expect(errors[0].kind === 'error' && errors[0].message).toMatch(message)
  })

  it('keeps tokenizing after a malformed token', () => {
    const tokens = tokenizeTemplate('{{bad.x}} then {{inputs.y}}')
    expect(tokens.map((t) => t.kind)).toEqual(['error', 'text', 'ref'])
  })

  it('treats the rest of the text as one unclosed token', () => {
    const tokens = tokenizeTemplate('{{inputs.a}} {{ inputs.b')
    expect(tokens.map((t) => t.kind)).toEqual(['ref', 'text', 'error'])
    expect(tokens[2]).toMatchObject({ start: 13, raw: '{{ inputs.b' })
  })
})

describe('renderTemplate', () => {
  const scope: TemplateScope = {
    inputs: { task: 'fix the bug' },
    steps: {
      plan: { summary: 'the plan', status: 'done' },
      review: { data: { verdict: 'fail', score: 3, ok: false, tags: ['a', 'b'] } }
    },
    run: { id: 'run-1', worktree: '/w', contextPath: '/w/.ctx' },
    item: { title: 'Issue 7' }
  }

  it('substitutes every root', () => {
    const text =
      '{{inputs.task}}|{{steps.plan.summary}}|{{steps.plan.status}}|{{steps.review.data.verdict}}|{{run.id}}|{{run.worktree}}|{{run.contextPath}}|{{ item.title }}'
    expect(renderTemplate(text, scope)).toEqual({
      text: 'fix the bug|the plan|done|fail|run-1|/w|/w/.ctx|Issue 7',
      missing: []
    })
  })

  it('stringifies non-string data values', () => {
    expect(renderTemplate('{{steps.review.data.score}} {{steps.review.data.ok}} {{steps.review.data.tags}}', scope).text).toBe('3 false ["a","b"]')
  })

  it('renders missing values as empty and lists each once', () => {
    expect(renderTemplate('[{{inputs.other}}][{{steps.build.summary}}][{{steps.plan.data.x}}][{{inputs.other}}]', scope)).toEqual({
      text: '[][][][]',
      missing: ['inputs.other', 'steps.build.summary', 'steps.plan.data.x']
    })
    expect(renderTemplate('{{run.id}}{{item.title}}', {})).toEqual({ text: '', missing: ['run.id', 'item.title'] })
  })

  it('does not re-expand substituted values', () => {
    const hostile: TemplateScope = { inputs: { x: 'secret', task: '{{inputs.x}} and {{run.id' } }
    expect(renderTemplate('Task: {{inputs.task}}', hostile)).toEqual({ text: 'Task: {{inputs.x}} and {{run.id', missing: [] })
  })

  it('does not read inherited properties', () => {
    expect(renderTemplate('{{inputs.constructor}}{{steps.toString.summary}}{{item.hasOwnProperty}}', scope)).toEqual({
      text: '',
      missing: ['inputs.constructor', 'steps.toString.summary', 'item.hasOwnProperty']
    })
  })

  it('treats null data values as missing', () => {
    expect(renderTemplate('{{item.n}}', { item: { n: null } })).toEqual({ text: '', missing: ['item.n'] })
  })

  it('leaves malformed tokens verbatim', () => {
    expect(renderTemplate('a {{env.HOME}} b {{inputs.task', scope)).toEqual({ text: 'a {{env.HOME}} b {{inputs.task', missing: [] })
  })
})

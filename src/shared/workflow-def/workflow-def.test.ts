import { describe, it, expect } from 'vitest'
import { evaluateCondition, validateWorkflowDefinition, type WorkflowCondition, type WorkflowDiagnostic } from '.'

const PLAN_EXAMPLE = `name: plan-build-review
inputs:
  task: { type: text }
item_input: task
defaults:
  permissions: edit
  allow: ["pnpm *", "git status", "git diff *"]
steps:
  - id: plan
    agent: claude
    model: claude-opus-5-5
    permissions: read-only
    prompt: "Plan this task. Return the full plan as your complete_step summary. Task: {{inputs.task}}"
    gate: approve
  - id: build
    agent: codex
    prompt: "Implement this plan:\\n{{steps.plan.summary}}"
    on_loop: "Review feedback to address:\\n{{steps.review.summary}}"
  - id: test
    kind: shell
    run: pnpm typecheck && npx vitest run
  - id: review
    agent: opencode
    needs: [build, test]
    permissions: read-only
    prompt: "Review the diff against this plan:\\n{{steps.plan.summary}}\\nTest result: {{steps.test.summary}}"
    output:
      verdict: { enum: [pass, fail] }
    loop: { back_to: build, until: { field: verdict, equals: pass }, max: 3 }
`

function errorsOf(text: string): WorkflowDiagnostic[] {
  return validateWorkflowDefinition(text).diagnostics.filter((d) => d.severity === 'error')
}

describe('validateWorkflowDefinition: plan example', () => {
  it('parses the plan example with no diagnostics', () => {
    const result = validateWorkflowDefinition(PLAN_EXAMPLE)
    expect(result.diagnostics).toEqual([])
    expect(result.parsed?.name).toBe('plan-build-review')
    expect(result.parsed?.inputs).toEqual({ task: { type: 'text' } })
    expect(result.parsed?.steps.map((s) => s.id)).toEqual(['plan', 'build', 'test', 'review'])
  })

  it('keeps the typed shape of every field', () => {
    const parsed = validateWorkflowDefinition(PLAN_EXAMPLE).parsed!
    expect(parsed.item_input).toBe('task')
    expect(parsed.defaults).toEqual({ permissions: 'edit', allow: ['pnpm *', 'git status', 'git diff *'] })
    expect(parsed.steps[0]).toMatchObject({ agent: 'claude', model: 'claude-opus-5-5', permissions: 'read-only', gate: 'approve' })
    expect(parsed.steps[1].prompt).toBe('Implement this plan:\n{{steps.plan.summary}}')
    expect(parsed.steps[2]).toEqual({ id: 'test', kind: 'shell', run: 'pnpm typecheck && npx vitest run' })
    expect(parsed.steps[3].needs).toEqual(['build', 'test'])
    expect(parsed.steps[3].output).toEqual({ fields: { verdict: { enum: ['pass', 'fail'] } } })
    expect(parsed.steps[3].loop).toEqual({ back_to: 'build', until: { field: 'verdict', equals: 'pass' }, max: 3 })
  })

  it('leaves kind and defaults unresolved for later stages', () => {
    const parsed = validateWorkflowDefinition(PLAN_EXAMPLE).parsed!
    expect(parsed.steps[0].kind).toBeUndefined()
    expect(parsed.steps[1].permissions).toBeUndefined()
  })
})

describe('validateWorkflowDefinition: positioned errors', () => {
  const minimal = (step: string) => `name: x\nsteps:\n  - id: a\n${step}`

  it.each([
    {
      name: 'YAML syntax error',
      text: 'name: x\nsteps: [\n',
      expected: { code: 'yaml-syntax', path: '', line: 3, col: 1 }
    },
    {
      name: 'unknown top-level key',
      text: 'name: x\ncolour: red\nsteps:\n  - id: a\n',
      expected: { code: 'unknown-key', path: 'colour', line: 2, col: 1 }
    },
    {
      name: 'unknown step key',
      text: minimal('    promt: hi\n'),
      expected: { code: 'unknown-key', path: 'steps[0].promt', line: 4, col: 5 }
    },
    {
      name: 'wrong type for a string field',
      text: minimal('    prompt: [a, b]\n'),
      expected: { code: 'wrong-type', path: 'steps[0].prompt', line: 4, col: 13 }
    },
    {
      name: 'wrong type for needs',
      text: minimal('    needs: build\n'),
      expected: { code: 'wrong-type', path: 'steps[0].needs', line: 4, col: 12 }
    },
    {
      name: 'missing step id',
      text: 'name: x\nsteps:\n  - id: a\n  - prompt: hi\n',
      expected: { code: 'missing-field', path: 'steps[1].id', line: 4, col: 5 }
    },
    {
      name: 'missing name',
      text: 'steps:\n  - id: a\n',
      expected: { code: 'missing-field', path: 'name', line: 1, col: 1 }
    },
    {
      name: 'bad permissions value',
      text: minimal('    permissions: admin\n'),
      expected: { code: 'bad-value', path: 'steps[0].permissions', line: 4, col: 18 }
    },
    {
      name: 'bad defaults permissions value',
      text: 'name: x\ndefaults:\n  permissions: Full\nsteps:\n  - id: a\n',
      expected: { code: 'bad-value', path: 'defaults.permissions', line: 3, col: 16 }
    },
    {
      name: 'bad output type',
      text: minimal('    output:\n      verdict: { type: date }\n'),
      expected: { code: 'bad-value', path: 'steps[0].output.verdict.type', line: 5, col: 24 }
    },
    {
      name: 'array output without items',
      text: minimal('    output:\n      tasks: { type: array }\n'),
      expected: { code: 'missing-field', path: 'steps[0].output.tasks.items', line: 5, col: 14 }
    },
    {
      name: 'bad step kind',
      text: minimal('    kind: python\n'),
      expected: { code: 'bad-value', path: 'steps[0].kind', line: 4, col: 11 }
    },
    {
      name: 'bad input type',
      text: 'name: x\ninputs:\n  task: { type: url }\nsteps:\n  - id: a\n',
      expected: { code: 'bad-value', path: 'inputs.task.type', line: 3, col: 17 }
    },
    {
      name: 'condition with zero operators',
      text: minimal('    when: { field: verdict }\n'),
      expected: { code: 'bad-condition', path: 'steps[0].when', line: 4, col: 11 }
    },
    {
      name: 'condition with two operators',
      text: minimal('    loop: { back_to: a, until: { field: v, equals: pass, not: fail }, max: 2 }\n'),
      expected: { code: 'bad-condition', path: 'steps[0].loop.until', line: 4, col: 32 }
    },
    {
      name: 'exit condition combined with field',
      text: minimal('    when: { exit: 0, field: v }\n'),
      expected: { code: 'bad-condition', path: 'steps[0].when', line: 4, col: 11 }
    },
    {
      name: 'non-integer exit code',
      text: minimal('    when: { exit: "0" }\n'),
      expected: { code: 'wrong-type', path: 'steps[0].when.exit', line: 4, col: 19 }
    },
    {
      name: 'empty in list',
      text: minimal('    when: { field: v, in: [] }\n'),
      expected: { code: 'bad-value', path: 'steps[0].when.in', line: 4, col: 27 }
    },
    {
      name: 'loop without max',
      text: minimal('    loop: { back_to: a, until: { exit: 0 } }\n'),
      expected: { code: 'missing-field', path: 'steps[0].loop.max', line: 4, col: 11 }
    },
    {
      name: 'non-positive timeout',
      text: minimal('    timeout: 0\n'),
      expected: { code: 'bad-value', path: 'steps[0].timeout', line: 4, col: 14 }
    },
    {
      name: 'bad gate value',
      text: minimal('    gate: yes\n'),
      expected: { code: 'bad-value', path: 'steps[0].gate', line: 4, col: 11 }
    },
    {
      name: 'step id that is not an identifier',
      text: 'name: x\nsteps:\n  - id: "a b"\n',
      expected: { code: 'bad-value', path: 'steps[0].id', line: 3, col: 9 }
    },
    {
      name: 'input named __proto__',
      text: 'name: x\ninputs:\n  __proto__: { type: text }\nsteps:\n  - id: a\n',
      expected: { code: 'bad-value', path: 'inputs.__proto__', line: 3, col: 3 }
    },
    {
      name: 'empty steps list',
      text: 'name: x\nsteps: []\n',
      expected: { code: 'missing-field', path: 'steps', line: 2, col: 8 }
    },
    {
      name: 'duplicate key',
      text: 'name: x\nname: y\nsteps:\n  - id: a\n',
      expected: { code: 'yaml-syntax', path: '', line: 2, col: 1 }
    },
    {
      name: 'merge key is not special',
      text: 'name: x\n<<: { steps: [] }\nsteps:\n  - id: a\n',
      expected: { code: 'unknown-key', path: '<<', line: 2, col: 1 }
    },
    {
      name: 'custom tag',
      text: 'name: x\nsteps:\n  - id: a\n    prompt: !js/function "f"\n',
      expected: { code: 'yaml-tag', path: '', line: 4, col: 13 }
    },
    {
      name: 'YAML 1.1 binary tag',
      text: 'name: x\nsteps:\n  - id: a\n    prompt: !!binary aGk=\n',
      expected: { code: 'yaml-tag', path: '', line: 4, col: 13 }
    }
  ])('$name', ({ text, expected }) => {
    let result: ReturnType<typeof validateWorkflowDefinition> | undefined
    expect(() => {
      result = validateWorkflowDefinition(text)
    }).not.toThrow()
    expect(result!.parsed).toBeUndefined()
    expect(result!.diagnostics).toContainEqual(expect.objectContaining({ severity: 'error', ...expected }))
  })

  it('reports every problem, not just the first', () => {
    const errors = errorsOf('name: 3\nsteps:\n  - id: a\n    bogus: 1\n    gate: later\n')
    expect(errors.map((d) => d.path)).toEqual(['name', 'steps[0].bogus', 'steps[0].gate'])
  })

  it('names the expected type in the message', () => {
    const [error] = errorsOf('name: x\nsteps:\n  - id: a\n    parallel_safe: "true"\n')
    expect(error.message).toMatch(/boolean/)
  })
})

describe('validateWorkflowDefinition: hostile and degenerate input', () => {
  const BILLION_LAUGHS = `name: x
steps:
  - id: a
    allow: &a ["x","x","x","x","x","x","x","x","x"]
  - id: b
    allow: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]
  - id: c
    allow: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]
  - id: d
    allow: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]
  - id: e
    allow: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]
  - id: f
    allow: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]
  - id: g
    allow: [*f,*f,*f,*f,*f,*f,*f,*f,*f]
`

  it('rejects billion-laughs alias expansion without hanging', () => {
    const started = Date.now()
    const result = validateWorkflowDefinition(BILLION_LAUGHS)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result.parsed).toBeUndefined()
    expect(result.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'alias-limit' })])
  })

  it('resolves a small alias', () => {
    const result = validateWorkflowDefinition('name: x\ndefaults:\n  allow: &cmds [git status]\nsteps:\n  - id: a\n    allow: *cmds\n')
    expect(result.diagnostics).toEqual([])
    expect(result.parsed?.steps[0].allow).toEqual(['git status'])
  })

  it('rejects an alias that refers to its own container', () => {
    const result = validateWorkflowDefinition('name: x\nsteps: &s\n  - id: a\n    needs: *s\n')
    expect(result.parsed).toBeUndefined()
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'alias-limit', path: 'steps[0].needs' }))
  })

  it('does not enable merge keys through a YAML 1.1 directive', () => {
    const errors = errorsOf('%YAML 1.1\n---\nbase: &b { id: a }\nname: x\nsteps:\n  - <<: *b\n')
    expect(errors).toContainEqual(expect.objectContaining({ code: 'unknown-key', path: 'base' }))
  })

  it('rejects oversized source', () => {
    const result = validateWorkflowDefinition(`name: x\nsteps:\n  - id: a\n    prompt: "${'a'.repeat(600_000)}"\n`)
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'too-large', line: 1, col: 1 })])
  })

  it.each([
    { name: 'empty source', text: '' },
    { name: 'comment only', text: '# nothing\n' },
    { name: 'scalar root', text: 'hello\n' },
    { name: 'sequence root', text: '- id: a\n' },
    { name: 'multiple documents', text: 'name: x\nsteps:\n  - id: a\n---\nname: y\n' },
    { name: 'null step', text: 'name: x\nsteps:\n  -\n' },
    { name: 'empty value', text: 'name:\nsteps:\n  - id: a\n' },
    { name: 'complex key', text: '? [a, b]\n: 1\nname: x\nsteps:\n  - id: a\n' },
    { name: 'numeric key', text: '1: x\nname: x\nsteps:\n  - id: a\n' },
    { name: 'tab indentation', text: 'name: x\nsteps:\n\t- id: a\n' }
  ])('returns a positioned error for $name without throwing', ({ text }) => {
    let result: ReturnType<typeof validateWorkflowDefinition> | undefined
    expect(() => {
      result = validateWorkflowDefinition(text)
    }).not.toThrow()
    expect(result!.parsed).toBeUndefined()
    const errors = result!.diagnostics.filter((d) => d.severity === 'error')
    expect(errors.length).toBeGreaterThan(0)
    for (const d of errors) {
      expect(d.line).toBeGreaterThanOrEqual(1)
      expect(d.col).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('validateWorkflowDefinition: reserved step kinds and fields', () => {
  it('accepts foreach and orchestrator steps with their reserved fields', () => {
    const result = validateWorkflowDefinition(
      'name: x\nsteps:\n  - id: split\n    output:\n      tasks: { type: array, items: { type: string } }\n      required: [tasks]\n  - id: each\n    kind: foreach\n    over: steps.split.data.tasks\n    mode: stacked\n  - id: boss\n    kind: orchestrator\n    agent: claude\n    prompt: decide\n    timeout: 600\n    parallel_safe: false\n'
    )
    expect(result.diagnostics).toEqual([])
    expect(result.parsed?.steps[0].output).toEqual({ fields: { tasks: { type: 'array', items: { type: 'string' } } }, required: ['tasks'] })
    expect(result.parsed?.steps[1]).toEqual({ id: 'each', kind: 'foreach', over: 'steps.split.data.tasks', mode: 'stacked' })
    expect(result.parsed?.steps[2].timeout).toBe(600)
  })

  it('leaves agent names to the graph stage', () => {
    const result = validateWorkflowDefinition('name: x\nsteps:\n  - id: a\n    agent: pi\n')
    expect(result.diagnostics).toEqual([])
    expect(result.parsed?.steps[0].agent).toBe('pi')
  })

  it('accepts every condition shape', () => {
    const result = validateWorkflowDefinition(
      'name: x\nsteps:\n  - id: a\n    when: { field: v, in: [1, two, true] }\n  - id: b\n    when: { field: v, not: fail }\n  - id: c\n    kind: shell\n    run: "true"\n    when: { exit: 0 }\n'
    )
    expect(result.diagnostics).toEqual([])
    expect(result.parsed?.steps.map((s) => s.when)).toEqual([
      { field: 'v', in: [1, 'two', true] },
      { field: 'v', not: 'fail' },
      { exit: 0 }
    ])
  })
})

describe('evaluateCondition', () => {
  const data = { verdict: 'pass', score: 3, ok: false }

  it.each<{ name: string; cond: WorkflowCondition; ctx: Parameters<typeof evaluateCondition>[1]; expected: boolean }>([
    { name: 'equals matches', cond: { field: 'verdict', equals: 'pass' }, ctx: { data }, expected: true },
    { name: 'equals mismatches', cond: { field: 'verdict', equals: 'fail' }, ctx: { data }, expected: false },
    { name: 'equals does not coerce types', cond: { field: 'score', equals: '3' }, ctx: { data }, expected: false },
    { name: 'equals matches false', cond: { field: 'ok', equals: false }, ctx: { data }, expected: true },
    { name: 'in matches', cond: { field: 'score', in: [1, 2, 3] }, ctx: { data }, expected: true },
    { name: 'in mismatches', cond: { field: 'verdict', in: ['fail', 'skip'] }, ctx: { data }, expected: false },
    { name: 'not matches a different value', cond: { field: 'verdict', not: 'fail' }, ctx: { data }, expected: true },
    { name: 'not mismatches an equal value', cond: { field: 'verdict', not: 'pass' }, ctx: { data }, expected: false },
    { name: 'equals on a missing field', cond: { field: 'missing', equals: 'pass' }, ctx: { data }, expected: false },
    { name: 'in on a missing field', cond: { field: 'missing', in: ['pass'] }, ctx: { data }, expected: false },
    { name: 'not on a missing field', cond: { field: 'missing', not: 'pass' }, ctx: { data }, expected: false },
    { name: 'field condition with no data', cond: { field: 'verdict', equals: 'pass' }, ctx: { status: 'done' }, expected: false },
    { name: 'prototype property is not a field', cond: { field: 'toString', not: 'x' }, ctx: { data: {} }, expected: false },
    { name: 'exit matches', cond: { exit: 0 }, ctx: { exitCode: 0 }, expected: true },
    { name: 'exit mismatches', cond: { exit: 0 }, ctx: { exitCode: 1 }, expected: false },
    { name: 'exit with no exit code', cond: { exit: 0 }, ctx: { status: 'done' }, expected: false }
  ])('$name', ({ cond, ctx, expected }) => {
    expect(evaluateCondition(cond, ctx)).toBe(expected)
  })
})

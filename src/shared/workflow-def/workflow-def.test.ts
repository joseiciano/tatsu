import { describe, it, expect } from 'vitest'
import { ALL_WORKFLOW_FEATURES, BASELINE_SUPPORTED_FEATURES, WORKFLOW_FEATURES, evaluateCondition, needsClosure, validateWorkflowDefinition, type ValidateWorkflowOptions, type WorkflowCondition, type WorkflowDiagnostic, type WorkflowFeature } from '.'

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

const ALL: ValidateWorkflowOptions = { supportedFeatures: ALL_WORKFLOW_FEATURES }

function errorsOf(text: string, opts?: ValidateWorkflowOptions): WorkflowDiagnostic[] {
  return validateWorkflowDefinition(text, opts).diagnostics.filter((d) => d.severity === 'error')
}

describe('validateWorkflowDefinition: plan example', () => {
  it('parses the plan example with no diagnostics', () => {
    const result = validateWorkflowDefinition(PLAN_EXAMPLE, ALL)
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
    const result = validateWorkflowDefinition('name: x\ndefaults:\n  allow: &cmds [git status]\nsteps:\n  - id: a\n    agent: claude\n    prompt: go\n    allow: *cmds\n')
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
      'name: x\nsteps:\n  - id: split\n    agent: claude\n    prompt: split\n    output:\n      tasks: { type: array, items: { type: string } }\n      required: [tasks]\n  - id: each\n    kind: foreach\n    over: steps.split.data.tasks\n    mode: stacked\n  - id: boss\n    kind: orchestrator\n    agent: claude\n    prompt: decide\n    timeout: 600\n    parallel_safe: false\n', ALL
    )
    expect(result.diagnostics).toEqual([])
    expect(result.parsed?.steps[0].output).toEqual({ fields: { tasks: { type: 'array', items: { type: 'string' } } }, required: ['tasks'] })
    expect(result.parsed?.steps[1]).toEqual({ id: 'each', kind: 'foreach', over: 'steps.split.data.tasks', mode: 'stacked' })
    expect(result.parsed?.steps[2].timeout).toBe(600)
  })

  it('leaves agent names to the graph stage', () => {
    const result = validateWorkflowDefinition('name: x\nsteps:\n  - id: a\n    agent: pi\n    prompt: go\n')
    expect(result.parsed?.steps[0].agent).toBe('pi')
    expect(result.definition).toBeUndefined()
    expect(result.diagnostics.map((d) => d.path)).toEqual(['steps[0].agent'])
  })

  it('accepts every condition shape', () => {
    const result = validateWorkflowDefinition(
      'name: x\nsteps:\n  - id: a\n    agent: claude\n    prompt: go\n    when: { field: v, in: [1, two, true] }\n  - id: b\n    agent: claude\n    prompt: go\n    when: { field: v, not: fail }\n  - id: c\n    kind: shell\n    run: "true"\n    when: { exit: 0 }\n', ALL
    )
    expect(result.diagnostics).toEqual([])
    expect(result.parsed?.steps.map((s) => s.when)).toEqual([
      { field: 'v', in: [1, 'two', true] },
      { field: 'v', not: 'fail' },
      { exit: 0 }
    ])
  })
})

describe('validateWorkflowDefinition: resolved definition', () => {
  it('resolves the plan example', () => {
    const result = validateWorkflowDefinition(PLAN_EXAMPLE, ALL)
    expect(result.diagnostics).toEqual([])
    const steps = result.definition!.steps
    expect(steps.map((s) => s.id)).toEqual(['plan', 'build', 'test', 'review'])
    expect(steps.map((s) => s.needs)).toEqual([[], ['plan'], ['build'], ['build', 'test']])
    expect(steps.map((s) => s.kind)).toEqual(['agent', 'agent', 'shell', 'agent'])
    expect(steps[0]).toMatchObject({ permissions: 'read-only', allow: ['pnpm', 'git status', 'git diff'] })
    expect(steps[1]).toMatchObject({ agent: 'codex', permissions: 'edit', allow: ['pnpm', 'git status', 'git diff'] })
    expect(steps[2]).toEqual({ id: 'test', kind: 'shell', needs: ['build'], run: 'pnpm typecheck && npx vitest run' })
    expect(steps[3]).toMatchObject({ permissions: 'read-only', loop: { back_to: 'build', until: { field: 'verdict', equals: 'pass' }, max: 3 } })
  })

  it('keeps the parsed shape unresolved alongside the definition', () => {
    const result = validateWorkflowDefinition(PLAN_EXAMPLE)
    expect(result.parsed?.steps[1].needs).toBeUndefined()
    expect(result.parsed?.steps[1].permissions).toBeUndefined()
  })

  it('defaults permissions to edit with no defaults block', () => {
    const result = validateWorkflowDefinition('name: x\nsteps:\n  - id: a\n    agent: claude\n    prompt: go\n')
    expect(result.definition?.steps[0]).toEqual({ id: 'a', kind: 'agent', agent: 'claude', prompt: 'go', needs: [], permissions: 'edit', allow: [] })
  })

  it('replaces defaults.allow with a step allow list instead of merging', () => {
    const result = validateWorkflowDefinition(
      'name: x\ndefaults:\n  allow: ["pnpm *", git status]\nsteps:\n  - id: a\n    agent: claude\n    prompt: go\n    allow: ["git log *"]\n  - id: b\n    agent: claude\n    prompt: go\n  - id: c\n    agent: claude\n    prompt: go\n    allow: []\n'
    )
    expect(result.diagnostics).toEqual([])
    expect(result.definition?.steps.map((s) => ('allow' in s ? s.allow : undefined))).toEqual([['git log'], ['pnpm', 'git status'], []])
  })

  it('warns once per dropped allow entry and still resolves', () => {
    const result = validateWorkflowDefinition(
      'name: x\ndefaults:\n  allow: ["pnpm *", "rm $(x)", "a*b", "pnpm"]\nsteps:\n  - id: a\n    agent: claude\n    prompt: go\n    allow: ["git \'log\'"]\n'
    )
    expect(result.diagnostics.map((d) => [d.severity, d.code, d.path, d.line, d.col])).toEqual([
      ['warning', 'unsafe-allow', 'defaults.allow[1]', 3, 21],
      ['warning', 'unsafe-allow', 'defaults.allow[2]', 3, 32],
      ['warning', 'unsafe-allow', 'steps[0].allow[0]', 8, 13]
    ])
    expect(result.definition?.steps[0]).toMatchObject({ allow: [] })
  })

  it('fills omitted needs with the previous step in file order', () => {
    const step = (id: string, extra = '') => `  - id: ${id}\n    agent: claude\n    prompt: go\n${extra}`
    const result = validateWorkflowDefinition(
      `name: x\nsteps:\n${step('a')}${step('b', '    needs: []\n')}${step('c')}${step('d', '    needs: [a]\n')}${step('e')}`, ALL
    )
    expect(result.diagnostics).toEqual([])
    expect(result.definition?.steps.map((s) => s.needs)).toEqual([[], [], ['b'], ['a'], ['d']])
  })
})

describe('needsClosure', () => {
  it.each([
    { name: 'linear chain', steps: [{ id: 'a', needs: [] }, { id: 'b', needs: ['a'] }, { id: 'c', needs: ['b'] }], of: 'c', expected: ['a', 'b'] },
    { name: 'diamond', steps: [{ id: 'a', needs: [] }, { id: 'b', needs: ['a'] }, { id: 'c', needs: ['a'] }, { id: 'd', needs: ['b', 'c'] }], of: 'd', expected: ['a', 'b', 'c'] },
    { name: 'root step', steps: [{ id: 'a', needs: [] }, { id: 'b', needs: ['a'] }], of: 'a', expected: [] },
    { name: 'unknown refs are skipped', steps: [{ id: 'a', needs: ['ghost'] }, { id: 'b', needs: ['a', 'nope'] }], of: 'b', expected: ['a'] },
    { name: 'unknown step', steps: [{ id: 'a', needs: [] }], of: 'zz', expected: [] },
    { name: 'cycle terminates', steps: [{ id: 'a', needs: ['c'] }, { id: 'b', needs: ['a'] }, { id: 'c', needs: ['b'] }], of: 'c', expected: ['a', 'b', 'c'] }
  ])('$name', ({ steps, of, expected }) => {
    expect([...needsClosure(steps, of)].sort()).toEqual(expected)
  })
})

describe('validateWorkflowDefinition: graph and per-kind errors', () => {
  const A = '    agent: claude\n    prompt: go\n'
  const loop = (target: string) => `    loop: { back_to: ${target}, until: { field: v, equals: x }, max: 2 }\n`

  it.each([
    { name: 'duplicate id', text: `  - id: a\n${A}  - id: a\n${A}`, expected: { code: 'duplicate-id', path: 'steps[1].id', line: 6, col: 9 } },
    { name: 'unknown needs ref', text: `  - id: a\n${A}  - id: b\n    needs: [a, nope]\n${A}`, expected: { code: 'unknown-ref', path: 'steps[1].needs[1]', line: 7, col: 16 } },
    { name: 'self cycle', text: `  - id: a\n    needs: [a]\n${A}`, expected: { code: 'cycle', path: 'steps[0].needs[0]', line: 4, col: 13, message: 'Steps form a "needs" cycle: a -> a' } },
    { name: '2-step cycle', text: `  - id: a\n    needs: [b]\n${A}  - id: b\n    needs: [a]\n${A}`, expected: { code: 'cycle', path: 'steps[0].needs[0]', line: 4, col: 13, message: 'Steps form a "needs" cycle: a -> b -> a' } },
    { name: '3-step cycle through implicit needs', text: `  - id: a\n    needs: [c]\n${A}  - id: b\n${A}  - id: c\n${A}`, expected: { code: 'cycle', path: 'steps[0].needs[0]', line: 4, col: 13, message: 'Steps form a "needs" cycle: a -> c -> b -> a' } },
    { name: 'back_to downstream', text: `  - id: a\n${A}${loop('b')}  - id: b\n${A}`, expected: { code: 'bad-back-to', path: 'steps[0].loop.back_to', line: 6, col: 22 } },
    { name: 'back_to self', text: `  - id: a\n${A}${loop('a')}`, expected: { code: 'bad-back-to', path: 'steps[0].loop.back_to', line: 6, col: 22 } },
    { name: 'back_to unknown', text: `  - id: a\n${A}${loop('zz')}`, expected: { code: 'unknown-ref', path: 'steps[0].loop.back_to', line: 6, col: 22 } },
    { name: 'unknown needs does not cascade into back_to', text: `  - id: a\n${A}  - id: b\n    needs: [nope]\n${A}${loop('a')}`, expected: { code: 'unknown-ref', path: 'steps[1].needs[0]', line: 7, col: 13 } },
    { name: 'shell step with prompt', text: '  - id: a\n    kind: shell\n    run: make\n    prompt: hi\n', expected: { code: 'kind-mismatch', path: 'steps[0].prompt', line: 6, col: 13 } },
    { name: 'shell step with an unsafe allow', text: '  - id: a\n    kind: shell\n    run: make\n    allow: ["a*b"]\n', expected: { code: 'kind-mismatch', path: 'steps[0].allow', line: 6, col: 12 } },
    { name: 'shell step without run', text: '  - id: a\n    kind: shell\n', expected: { code: 'missing-field', path: 'steps[0].run', line: 3, col: 5 } },
    { name: 'agent step without prompt', text: '  - id: a\n    agent: claude\n', expected: { code: 'missing-field', path: 'steps[0].prompt', line: 3, col: 5 } },
    { name: 'agent step without agent', text: '  - id: a\n    prompt: go\n', expected: { code: 'missing-field', path: 'steps[0].agent', line: 3, col: 5 } },
    { name: 'agent: pi', text: '  - id: a\n    agent: pi\n    prompt: go\n', expected: { code: 'bad-value', path: 'steps[0].agent', line: 4, col: 12, message: 'pi is a tab harness, not a workflow step harness in v1' } },
    { name: 'unknown agent', text: '  - id: a\n    agent: gemini\n    prompt: go\n', expected: { code: 'bad-value', path: 'steps[0].agent', line: 4, col: 12 } },
    { name: 'exit condition on an agent step', text: `  - id: a\n${A}    when: { exit: 0 }\n`, expected: { code: 'bad-condition', path: 'steps[0].when.exit', line: 6, col: 19 } },
    { name: 'item_input naming no input', text: `  - id: a\n${A}`, prefix: 'inputs:\n  task: { type: text }\nitem_input: tsk\n', expected: { code: 'unknown-ref', path: 'item_input', line: 4, col: 13 } },
    { name: 'required naming an undeclared output field', text: `  - id: a\n${A}    output:\n      verdict: { enum: [pass, fail] }\n      required: [verdikt]\n`, expected: { code: 'unknown-ref', path: 'steps[0].output.required[0]', line: 8, col: 18 } }
  ])('$name', ({ text, prefix, expected }) => {
    const result = validateWorkflowDefinition(`name: x\n${prefix ?? ''}steps:\n${text}`)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({ severity: 'error', ...expected })
    expect(result.parsed).toBeDefined()
    expect(result.definition).toBeUndefined()
  })

  it('allows an exit condition on a shell step', () => {
    const result = validateWorkflowDefinition(
      `name: x\nsteps:\n  - id: a\n${A}  - id: t\n    kind: shell\n    run: make\n    loop: { back_to: a, until: { exit: 0 }, max: 2 }\n`, ALL
    )
    expect(result.diagnostics).toEqual([])
    expect(result.definition?.steps[1]).toEqual({ id: 't', kind: 'shell', needs: ['a'], run: 'make', loop: { back_to: 'a', until: { exit: 0 }, max: 2 } })
  })

  it('skips the graph stage when the shape stage fails', () => {
    const result = validateWorkflowDefinition('name: x\nsteps:\n  - id: a\n    needs: [nope]\n    gate: later\n')
    expect(result.diagnostics.map((d) => d.code)).toEqual(['bad-value'])
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

describe('validateWorkflowDefinition: template references', () => {
  const base = (steps: string, extra = '') => `name: x\ninputs:\n  task: { type: text }\n${extra}steps:\n${steps}`
  const agent = (id: string, rest = '') => `  - id: ${id}\n    agent: claude\n${rest}`

  it('accepts the plan example references, including on_loop into the loop span', () => {
    const result = validateWorkflowDefinition(PLAN_EXAMPLE, ALL)
    expect(result.diagnostics).toEqual([])
    expect(result.definition).toBeDefined()
  })

  it.each([
    {
      name: 'unknown input',
      text: base(agent('a', '    prompt: "Do {{inputs.nope}}"\n')),
      expected: { code: 'unknown-ref', path: 'steps[0].prompt', line: 7, col: 17 }
    },
    {
      name: 'unknown step',
      text: base(agent('a', '    prompt: "{{steps.ghost.summary}}"\n')),
      expected: { code: 'unknown-ref', path: 'steps[0].prompt', line: 7, col: 14 }
    },
    {
      name: 'later step in a prompt',
      text: base(agent('a', '    prompt: "{{steps.b.summary}}"\n') + agent('b', '    prompt: go\n')),
      expected: { code: 'template-scope', path: 'steps[0].prompt', line: 7, col: 14 }
    },
    {
      name: 'a step referencing itself in its prompt',
      text: base(agent('a', '    prompt: "{{steps.a.status}}"\n')),
      expected: { code: 'template-scope', path: 'steps[0].prompt', line: 7, col: 14 }
    },
    {
      name: 'data field not declared in output',
      text: base(
        agent('a', '    prompt: go\n    output:\n      verdict: { enum: [pass, fail] }\n') + agent('b', '    prompt: "Use {{steps.a.data.score}}"\n')
      ),
      expected: { code: 'unknown-ref', path: 'steps[1].prompt', line: 12, col: 18 }
    },
    {
      name: 'data field on a step with no output',
      text: base(agent('a', '    prompt: go\n') + agent('b', '    prompt: "{{steps.a.data.verdict}}"\n')),
      expected: { code: 'unknown-ref', path: 'steps[1].prompt', line: 10, col: 14 }
    },
    {
      name: 'data.* on a shell step',
      text: base('  - id: a\n    kind: shell\n    run: echo hi\n' + agent('b', '    prompt: "{{steps.a.data.x}}"\n')),
      expected: { code: 'kind-mismatch', path: 'steps[1].prompt', line: 10, col: 14 }
    },
    {
      name: 'item.* without item_input or foreach',
      text: base(agent('a', '    prompt: "{{item.title}}"\n')),
      expected: { code: 'template-scope', path: 'steps[0].prompt', line: 7, col: 14 }
    },
    {
      name: 'malformed token',
      text: base(agent('a', '    prompt: "{{ inputs.task b }}"\n')),
      expected: { code: 'bad-template', path: 'steps[0].prompt', line: 7, col: 14 }
    },
    {
      name: 'unclosed token',
      text: base(agent('a', '    prompt: "go {{inputs.task"\n')),
      expected: { code: 'bad-template', path: 'steps[0].prompt', line: 7, col: 17 }
    },
    {
      name: 'unknown root',
      text: base(agent('a', '    prompt: "{{env.HOME}}"\n')),
      expected: { code: 'bad-template', path: 'steps[0].prompt', line: 7, col: 14 }
    },
    {
      name: 'unknown step property',
      text: base(agent('a', '    prompt: go\n') + agent('b', '    prompt: "{{steps.a.output}}"\n')),
      expected: { code: 'bad-template', path: 'steps[1].prompt', line: 10, col: 14 }
    },
    {
      name: 'later step in a shell run (plain scalar)',
      text: base('  - id: a\n    kind: shell\n    run: echo {{steps.b.summary}}\n' + agent('b', '    prompt: go\n')),
      expected: { code: 'template-scope', path: 'steps[0].run', line: 7, col: 15 }
    },
    {
      name: 'on_loop outside any loop span',
      text: base(agent('a', '    prompt: go\n    on_loop: "{{steps.b.summary}}"\n') + agent('b', '    prompt: go\n')),
      expected: { code: 'template-scope', path: 'steps[0].on_loop', line: 8, col: 15 }
    },
    {
      name: 'second token after an escape in a double-quoted scalar',
      text: base(agent('a', '    prompt: "a\\n{{inputs.task}} {{inputs.nope}}"\n')),
      expected: { code: 'unknown-ref', path: 'steps[0].prompt', line: 7, col: 33 }
    },
    {
      name: 'token inside a literal block scalar',
      text: base(agent('a', '    prompt: |\n      line one\n      use {{inputs.nope}}\n')),
      expected: { code: 'unknown-ref', path: 'steps[0].prompt', line: 9, col: 11 }
    },
    {
      name: 'token inside a folded block scalar',
      text: base(agent('a', '    prompt: >-\n      first\n      then {{steps.zz.summary}}\n')),
      expected: { code: 'unknown-ref', path: 'steps[0].prompt', line: 9, col: 12 }
    }
  ])('$name', ({ text, expected }) => {
    const result = validateWorkflowDefinition(text)
    const errors = result.diagnostics.filter((d) => d.severity === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject(expected)
    expect(errors[0].message).not.toBe('')
    expect(result.parsed).toBeDefined()
    expect(result.definition).toBeUndefined()
  })

  it('reports every bad reference in one field', () => {
    const errors = errorsOf(base(agent('a', '    prompt: "{{inputs.x}} {{inputs.y}} {{inputs.task}}"\n')))
    expect(errors.map((e) => [e.code, e.col])).toEqual([
      ['unknown-ref', 14],
      ['unknown-ref', 27]
    ])
  })

  it('falls back to the scalar start when the source cannot be mapped', () => {
    const errors = errorsOf(base(agent('a', '    prompt: "\\x7b{inputs.nope}}"\n')))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'unknown-ref', line: 7, col: 13 })
  })

  it('accepts item.* with item_input or a foreach step', () => {
    expect(errorsOf(base(agent('a', '    prompt: "{{item.task}}"\n'), 'item_input: task\n'), ALL)).toEqual([])
    const foreach = base(agent('a', '    prompt: "{{item.title}}"\n') + '  - id: each\n    kind: foreach\n    over: a\n')
    expect(errorsOf(foreach).filter((d) => d.path.endsWith('.prompt'))).toEqual([])
  })

  it('accepts run.* and transitive needs in every field', () => {
    const text = base(
      agent('a', '    prompt: "{{run.id}} {{run.worktree}} {{run.contextPath}} {{inputs.task}}"\n    output:\n      score: { type: number }\n') +
        '  - id: b\n    kind: shell\n    run: echo {{steps.a.summary}} {{steps.a.status}}\n' +
        agent('c', '    prompt: "{{steps.a.data.score}} {{steps.b.summary}}"\n')
    )
    expect(validateWorkflowDefinition(text).diagnostics).toEqual([])
  })

  describe('loop span', () => {
    const loop = (bOnLoop: string, cOnLoop = 'again') =>
      base(
        agent('a', '    prompt: go\n') +
          agent('b', `    prompt: build\n    on_loop: "${bOnLoop}"\n`) +
          agent('x', '    needs: [a]\n    prompt: side\n') +
          agent('c', `    needs: [b]\n    prompt: test\n    on_loop: "${cOnLoop}"\n`) +
          agent(
            'd',
            '    needs: [c, x]\n    prompt: "{{steps.x.summary}} {{steps.c.summary}}"\n    output:\n      verdict: { enum: [pass, fail] }\n    loop: { back_to: b, until: { field: verdict, equals: pass }, max: 3 }\n'
          )
      )

    it('lets every step in the span reference the rest of the span, both ends included', () => {
      expect(validateWorkflowDefinition(loop('{{steps.d.summary}} {{steps.c.status}} {{steps.b.summary}} {{steps.d.data.verdict}}', '{{steps.d.summary}}'), ALL).diagnostics).toEqual([])
    })

    it('rejects a step upstream of the looping step but outside the span', () => {
      const errors = errorsOf(loop('{{steps.x.summary}}'))
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({ code: 'template-scope', path: 'steps[1].on_loop' })
    })

    it('keeps the span out of prompt scope', () => {
      const text = loop('ok').replace('    prompt: build\n', '    prompt: "{{steps.d.summary}}"\n')
      expect(errorsOf(text)).toMatchObject([{ code: 'template-scope', path: 'steps[1].prompt' }])
    })
  })
})

describe('validateWorkflowDefinition: unsupported features', () => {
  const featuresOf = (text: string, supportedFeatures?: readonly WorkflowFeature[]) =>
    validateWorkflowDefinition(text, supportedFeatures ? { supportedFeatures } : {}).diagnostics.map((d) => ({
      code: d.code,
      feature: d.feature,
      path: d.path,
      line: d.line,
      col: d.col
    }))

  it('reports each unsupported feature in the plan example once, in file order, at the key or offending value', () => {
    expect(featuresOf(PLAN_EXAMPLE)).toEqual([
      { code: 'unsupported-feature', feature: 'item_input', path: 'item_input', line: 4, col: 1 },
      { code: 'unsupported-feature', feature: 'gate', path: 'steps[0].gate', line: 14, col: 5 },
      { code: 'unsupported-feature', feature: 'agent-codex', path: 'steps[1].agent', line: 16, col: 12 },
      { code: 'unsupported-feature', feature: 'on_loop', path: 'steps[1].on_loop', line: 18, col: 5 },
      { code: 'unsupported-feature', feature: 'agent-opencode', path: 'steps[3].agent', line: 23, col: 12 },
      { code: 'unsupported-feature', feature: 'loop', path: 'steps[3].loop', line: 29, col: 5 }
    ])
  })

  it('keeps parsed but withholds the definition when only feature errors remain', () => {
    const result = validateWorkflowDefinition(PLAN_EXAMPLE)
    expect(result.parsed?.name).toBe('plan-build-review')
    expect(result.definition).toBeUndefined()
  })

  it('names the phase that adds the feature in the message', () => {
    const loop = validateWorkflowDefinition(PLAN_EXAMPLE).diagnostics.find((d) => d.feature === 'loop')
    expect(loop?.message).toBe(WORKFLOW_FEATURES.loop.message)
    expect(loop?.message).toContain('phase 4')
  })

  it('validates the plan example with every feature supported', () => {
    const result = validateWorkflowDefinition(PLAN_EXAMPLE, { supportedFeatures: ALL_WORKFLOW_FEATURES })
    expect(result.diagnostics).toEqual([])
    expect(result.definition?.steps.map((s) => s.id)).toEqual(['plan', 'build', 'test', 'review'])
  })

  it('reports only the features left out of supportedFeatures', () => {
    const supported = ALL_WORKFLOW_FEATURES.filter((f) => f !== 'gate')
    expect(featuresOf(PLAN_EXAMPLE, supported).map((d) => d.feature)).toEqual(['gate'])
  })

  it('defaults to the baseline from the feature table', () => {
    expect(BASELINE_SUPPORTED_FEATURES).toEqual(ALL_WORKFLOW_FEATURES.filter((f) => WORKFLOW_FEATURES[f].supported))
    expect(featuresOf(PLAN_EXAMPLE, BASELINE_SUPPORTED_FEATURES)).toEqual(featuresOf(PLAN_EXAMPLE))
  })

  it('skips feature checks while other errors remain', () => {
    const result = validateWorkflowDefinition('name: x\nsteps:\n  - id: a\n    agent: codex\n    prompt: "{{inputs.nope}}"\n    gate: approve\n')
    expect(result.diagnostics.map((d) => d.code)).toEqual(['unknown-ref'])
  })

  it('accepts a linear chain of implicit needs on claude and shell steps', () => {
    const result = validateWorkflowDefinition('name: x\nsteps:\n  - id: a\n    agent: claude\n    prompt: go\n  - id: b\n    kind: shell\n    run: make\n  - id: c\n    agent: claude\n    needs: [a, b]\n    prompt: go\n')
    expect(result.diagnostics).toEqual([])
    expect(result.definition?.steps.map((s) => s.needs)).toEqual([[], ['a'], ['a', 'b']])
  })

  const step = (id: string, extra = '') => `  - id: ${id}\n    agent: claude\n    prompt: go\n${extra}`

  it('reports one non-linear needs error when two steps share one parent', () => {
    const text = `name: x\nsteps:\n${step('a')}${step('b', '    needs: [a]\n')}${step('c', '    needs: [a]\n')}`
    expect(featuresOf(text)).toEqual([{ code: 'unsupported-feature', feature: 'nonlinear-needs', path: 'steps[2].needs', line: 13, col: 5 }])
  })

  it('reports non-linear needs for an explicit empty list after the first step', () => {
    const text = `name: x\nsteps:\n${step('a')}${step('b', '    needs: []\n')}`
    expect(featuresOf(text).map((d) => [d.feature, d.path])).toEqual([['nonlinear-needs', 'steps[1].needs']])
  })

  it('does not repeat the non-linear error on implicit steps that follow the break', () => {
    const text = `name: x\nsteps:\n${step('a')}${step('b', '    needs: [a]\n')}${step('c', '    needs: [a]\n')}${step('d')}`
    expect(featuresOf(text).map((d) => d.path)).toEqual(['steps[2].needs'])
  })

  it.each([
    ['parallel_safe', `name: x\nsteps:\n${step('a')}  - id: b\n    kind: shell\n    run: make\n    parallel_safe: true\n`, 'steps[1].parallel_safe', 4],
    ['timeout', `name: x\nsteps:\n${step('a', '    timeout: 60\n')}`, 'steps[0].timeout', 4],
    ['when', `name: x\nsteps:\n${step('a', '    output:\n      ok: { type: boolean }\n')}${step('b', '    when: { field: ok, equals: true }\n')}`, 'steps[1].when', 4],
    ['foreach', 'name: x\nsteps:\n  - id: each\n    kind: foreach\n    over: inputs.list\n', 'steps[0].kind', 6],
    ['orchestrator', 'name: x\nsteps:\n  - id: boss\n    kind: orchestrator\n    agent: claude\n    prompt: decide\n', 'steps[0].kind', 8]
  ] as const)('reports one %s error naming its phase', (feature, text, path, phase) => {
    expect(validateWorkflowDefinition(text, { supportedFeatures: ALL_WORKFLOW_FEATURES }).diagnostics).toEqual([])
    const diagnostics = validateWorkflowDefinition(text).diagnostics
    expect(diagnostics.map((d) => [d.code, d.feature, d.path])).toEqual([['unsupported-feature', feature, path]])
    expect(WORKFLOW_FEATURES[feature].phase).toBe(phase)
    expect(diagnostics[0].message).toContain(`phase ${phase}`)
  })
})

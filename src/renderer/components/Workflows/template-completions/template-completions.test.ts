import { describe, expect, it } from 'vitest'
import { openTemplatePrefix, templateCompletions } from '.'
import { validateWorkflowDefinition, type ParsedWorkflowDefinition } from '../../../../shared/workflow-def'

const SOURCE = `name: ship
inputs:
  task: { type: text }
  issue: { type: issue }
steps:
  - id: plan
    prompt: Plan {{inputs.task}}
    output:
      verdict: { type: string }
      files: { type: array, items: { type: string } }
  - id: build
    kind: shell
    run: echo build
`

function parse(source: string): ParsedWorkflowDefinition {
  const { parsed } = validateWorkflowDefinition(source)
  if (!parsed) throw new Error('fixture does not parse')
  return parsed
}

function labels(parsed: ParsedWorkflowDefinition | undefined, prefix: string): string[] {
  return templateCompletions(parsed, prefix).map((c) => c.label)
}

describe('templateCompletions', () => {
  const parsed = parse(SOURCE)

  it('offers every reference the definition declares for an empty prefix', () => {
    expect(labels(parsed, '')).toEqual([
      'inputs.task',
      'inputs.issue',
      'steps.plan.summary',
      'steps.plan.status',
      'steps.plan.data.verdict',
      'steps.plan.data.files',
      'steps.build.summary',
      'steps.build.status',
      'run.id',
      'run.worktree',
      'run.contextPath'
    ])
  })

  it('offers data fields only for steps that declare an output', () => {
    expect(labels(parsed, 'steps.build.')).toEqual(['steps.build.summary', 'steps.build.status'])
    expect(labels(parsed, 'steps.plan.data.')).toEqual(['steps.plan.data.verdict', 'steps.plan.data.files'])
  })

  it('filters by a case-sensitive prefix of the whole reference', () => {
    expect(labels(parsed, 'inputs.')).toEqual(['inputs.task', 'inputs.issue'])
    expect(labels(parsed, 'steps.pl')).toEqual(['steps.plan.summary', 'steps.plan.status', 'steps.plan.data.verdict', 'steps.plan.data.files'])
    expect(labels(parsed, 'run.c')).toEqual(['run.contextPath'])
    expect(labels(parsed, 'Run.')).toEqual([])
    expect(labels(parsed, 'run.id.x')).toEqual([])
  })

  it('offers the item root only when item_input is set', () => {
    expect(labels(parsed, 'item')).toEqual([])
    const batch = parse(SOURCE.replace('steps:', 'item_input: issue\nsteps:'))
    expect(labels(batch, 'item')).toEqual(['item.'])
    expect(labels(batch, '')).toContain('item.')
  })

  it('gives each completion a detail naming what it refers to', () => {
    expect(templateCompletions(parsed, 'steps.plan.data.v')).toEqual([{ label: 'steps.plan.data.verdict', detail: 'Data field "verdict" of step "plan"' }])
  })

  it('offers only run properties without a parsed definition', () => {
    expect(labels(undefined, '')).toEqual(['run.id', 'run.worktree', 'run.contextPath'])
  })
})

describe('openTemplatePrefix', () => {
  it('returns the text after an open {{ and where it starts', () => {
    expect(openTemplatePrefix('    prompt: Use {{')).toEqual({ start: 18, prefix: '' })
    expect(openTemplatePrefix('run: echo {{steps.pl')).toEqual({ start: 12, prefix: 'steps.pl' })
  })

  it('skips whitespace after {{, which templates allow', () => {
    expect(openTemplatePrefix('x {{  inputs.t')).toEqual({ start: 6, prefix: 'inputs.t' })
  })

  it('looks only at the last {{ after closed tokens', () => {
    expect(openTemplatePrefix('{{inputs.a}} and {{run.')).toEqual({ start: 19, prefix: 'run.' })
  })

  it('returns null outside an open {{', () => {
    expect(openTemplatePrefix('run: echo hi')).toBeNull()
    expect(openTemplatePrefix('{{inputs.a}} done')).toBeNull()
    expect(openTemplatePrefix('{{inputs.a }')).toBeNull()
    expect(openTemplatePrefix('{{inputs.a | upper')).toBeNull()
  })
})

import { createHash } from 'crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { capIssues, createWorkflowDefsLoader, MAX_WORKFLOW_FILE_BYTES } from '.'
import type { WorkflowDefinitionSummary, WorkflowsEvent } from '../../shared/state/workflows'
import type { WorkflowDiagnostic } from '../../shared/workflow-def'

const VALID_YAML = `name: Valid flow
steps:
  - id: plan
    agent: claude
    prompt: Plan it
  - id: check
    kind: shell
    run: pnpm test
`

const PLAN_EXAMPLE_YAML = `name: plan-build-review
inputs:
  task: { type: text }
item_input: task
steps:
  - id: plan
    agent: claude
    prompt: "Plan this task: {{inputs.task}}"
    gate: approve
  - id: build
    agent: codex
    prompt: "Implement this plan:\\n{{steps.plan.summary}}"
    on_loop: "Feedback:\\n{{steps.review.summary}}"
  - id: test
    kind: shell
    run: pnpm typecheck
  - id: review
    agent: opencode
    needs: [build, test]
    prompt: "Review against {{steps.plan.summary}}"
    output:
      verdict: { enum: [pass, fail] }
    loop: { back_to: build, until: { field: verdict, equals: pass }, max: 3 }
`

interface LogLine {
  category: string
  message: string
  data?: unknown
}

let dir: string
let dispatched: WorkflowsEvent[]
let logs: LogLine[]

function makeLoader(target = dir) {
  return createWorkflowDefsLoader({
    dir: target,
    dispatch: (event) => dispatched.push(event),
    log: (category, message, data) => logs.push({ category, message, data })
  })
}

function lastDefinitions(): WorkflowDefinitionSummary[] {
  const event = dispatched.at(-1)
  if (!event) throw new Error('nothing dispatched')
  return event.payload.definitions
}

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex')
}

function diag(severity: WorkflowDiagnostic['severity'], message: string, line = 1): WorkflowDiagnostic {
  return { severity, code: 'bad-value', message, path: '', line, col: 1 }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workflow-defs-'))
  dispatched = []
  logs = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createWorkflowDefsLoader().reload', () => {
  it('summarizes valid and invalid YAML files and ignores other files', () => {
    writeFileSync(join(dir, 'valid.yaml'), VALID_YAML)
    writeFileSync(join(dir, 'Plan Example.yml'), PLAN_EXAMPLE_YAML)
    writeFileSync(join(dir, 'notes.txt'), 'not a workflow')

    const count = makeLoader().reload()

    expect(count).toBe(2)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].type).toBe('workflows/definitionsLoaded')
    expect(dispatched[0].payload.scope).toBe('personal')
    const byId = Object.fromEntries(lastDefinitions().map((d) => [d.id, d]))
    expect(Object.keys(byId).sort()).toEqual(['personal:plan-example', 'personal:valid'])

    expect(byId['personal:valid']).toEqual({
      id: 'personal:valid',
      name: 'Valid flow',
      scope: 'personal',
      path: join(dir, 'valid.yaml'),
      hash: sha256(VALID_YAML),
      stepIds: ['plan', 'check'],
      issues: []
    })

    const invalid = byId['personal:plan-example']
    expect(invalid.name).toBe('plan-build-review')
    expect(invalid.stepIds).toEqual(['plan', 'build', 'test', 'review'])
    expect(invalid.hash).toBe(sha256(PLAN_EXAMPLE_YAML))
    expect(invalid.issues).toHaveLength(5)
    expect(invalid.issues[0]).toContain('item_input')
  })

  it('falls back to the filename stem and no steps when the file does not parse', () => {
    writeFileSync(join(dir, 'Broken Flow.yaml'), 'name: [unclosed\n')

    makeLoader().reload()

    const [summary] = lastDefinitions()
    expect(summary.id).toBe('personal:broken-flow')
    expect(summary.name).toBe('Broken Flow')
    expect(summary.stepIds).toEqual([])
    expect(summary.issues.length).toBeGreaterThan(0)
  })

  it('keeps the first file in sorted order when two files share a slug', () => {
    writeFileSync(join(dir, 'my-plan.yml'), VALID_YAML.replace('Valid flow', 'Second'))
    writeFileSync(join(dir, 'My Plan.yaml'), VALID_YAML.replace('Valid flow', 'First'))

    expect(makeLoader().reload()).toBe(1)

    const [summary] = lastDefinitions()
    expect(summary.id).toBe('personal:my-plan')
    expect(summary.name).toBe('First')
    expect(summary.path).toBe(join(dir, 'My Plan.yaml'))
    expect(logs).toContainEqual(
      expect.objectContaining({ category: 'workflow', data: expect.objectContaining({ file: 'my-plan.yml', reason: 'duplicate-id' }) })
    )
  })

  it('skips a directory named like a YAML file without throwing', () => {
    mkdirSync(join(dir, 'folder.yaml'))
    writeFileSync(join(dir, 'valid.yaml'), VALID_YAML)

    expect(makeLoader().reload()).toBe(1)
    expect(lastDefinitions().map((d) => d.id)).toEqual(['personal:valid'])
  })

  it.skipIf(process.getuid?.() === 0)('skips an unreadable file without throwing', () => {
    const locked = join(dir, 'locked.yaml')
    writeFileSync(locked, VALID_YAML)
    chmodSync(locked, 0o000)
    try {
      expect(makeLoader().reload()).toBe(0)
      expect(lastDefinitions()).toEqual([])
      expect(logs).toContainEqual(
        expect.objectContaining({ data: expect.objectContaining({ file: 'locked.yaml', reason: 'unreadable' }) })
      )
    } finally {
      chmodSync(locked, 0o600)
    }
  })

  it('skips files over the size cap', () => {
    writeFileSync(join(dir, 'huge.yaml'), `name: huge\n#${'x'.repeat(MAX_WORKFLOW_FILE_BYTES)}\n`)

    expect(makeLoader().reload()).toBe(0)
    expect(logs).toContainEqual(
      expect.objectContaining({ data: expect.objectContaining({ file: 'huge.yaml', reason: 'too-large' }) })
    )
  })

  it('skips files whose name yields an empty slug', () => {
    writeFileSync(join(dir, '!!!.yaml'), VALID_YAML)

    expect(makeLoader().reload()).toBe(0)
  })

  it('creates the directory when it is missing', () => {
    const missing = join(dir, 'nested', 'workflows')

    expect(makeLoader(missing).reload()).toBe(0)
    expect(lastDefinitions()).toEqual([])
    writeFileSync(join(missing, 'valid.yaml'), VALID_YAML)
    expect(makeLoader(missing).reload()).toBe(1)
  })

  it('logs file names, ids and counts but never YAML content or messages', () => {
    writeFileSync(join(dir, 'plan.yaml'), PLAN_EXAMPLE_YAML)

    makeLoader().reload()

    const serialized = JSON.stringify(logs)
    expect(serialized).not.toContain('Plan this task')
    expect(serialized).not.toContain('need phase')
    expect(logs).toContainEqual({
      category: 'workflow',
      message: 'definition loaded',
      data: { file: 'plan.yaml', id: 'personal:plan', errors: 6, warnings: 0, unsupported: 6 }
    })
    expect(logs.every((line) => line.category === 'workflow')).toBe(true)
  })
})

describe('createWorkflowDefsLoader().getDefinition', () => {
  it('returns the fresh source and validation for a known id', () => {
    const file = join(dir, 'plan.yaml')
    writeFileSync(file, PLAN_EXAMPLE_YAML)
    const loader = makeLoader()
    loader.reload()
    writeFileSync(file, VALID_YAML)

    const detail = loader.getDefinition('personal:plan')

    expect(detail?.source).toBe(VALID_YAML)
    expect(detail?.summary.hash).toBe(sha256(VALID_YAML))
    expect(detail?.summary.stepIds).toEqual(['plan', 'check'])
    expect(detail?.definition?.name).toBe('Valid flow')
    expect(detail?.diagnostics).toEqual([])
  })

  it('returns null for unknown, path-like and non-string ids', () => {
    writeFileSync(join(dir, 'plan.yaml'), VALID_YAML)
    const loader = makeLoader()
    loader.reload()

    expect(loader.getDefinition('personal:other')).toBeNull()
    expect(loader.getDefinition('../plan.yaml')).toBeNull()
    expect(loader.getDefinition(join(dir, 'plan.yaml'))).toBeNull()
    expect(loader.getDefinition('personal:../plan')).toBeNull()
    expect(loader.getDefinition(42)).toBeNull()
  })

  it('returns null when a known file was deleted after the scan', () => {
    const file = join(dir, 'plan.yaml')
    writeFileSync(file, VALID_YAML)
    const loader = makeLoader()
    loader.reload()
    rmSync(file)

    expect(loader.getDefinition('personal:plan')).toBeNull()
  })
})

describe('capIssues', () => {
  it('puts errors first, keeps at most five and truncates each to 200 characters', () => {
    const issues = capIssues([
      diag('warning', 'warn one', 1),
      diag('error', 'x'.repeat(500), 2),
      diag('error', 'err two', 3),
      diag('error', 'err three', 4),
      diag('error', 'err four', 5),
      diag('error', 'err five', 6),
      diag('error', 'err six', 7)
    ])

    expect(issues).toHaveLength(5)
    expect(issues.every((issue) => issue.length <= 200)).toBe(true)
    expect(issues[0].startsWith('Line 2: xxx')).toBe(true)
    expect(issues.slice(1)).toEqual(['Line 3: err two', 'Line 4: err three', 'Line 5: err four', 'Line 6: err five'])
  })

  it('returns no issues for no diagnostics', () => {
    expect(capIssues([])).toEqual([])
  })
})

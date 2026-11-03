import { describe, expect, it } from 'vitest'
import {
  buildInputFields,
  canStart,
  needsFull,
  showRunWorkflowItem,
  startBlockReason,
  trustNeeded,
  trustStepRows,
  type CanStartArgs
} from '.'
import { validateWorkflowDefinition, type ResolvedDefinition } from '../../../../shared/workflow-def'
import type { WorkflowRun, WorkflowRunStatus } from '../../../../shared/state/workflows'
import type { CodexHookTrustSummary } from '../../../../shared/state/hooks'

function resolve(yaml: string): ResolvedDefinition {
  const definition = validateWorkflowDefinition(yaml).definition
  if (!definition) throw new Error('fixture did not resolve')
  return definition
}

const ALL_INPUTS = resolve(`name: all
inputs:
  task: { type: text }
  issue: { type: issue }
  pr: { type: pr }
  file: { type: file }
steps:
  - id: plan
    agent: claude
    prompt: "{{inputs.task}} {{inputs.issue}} {{inputs.pr}} {{inputs.file}}"
`)

const SHELL_ONLY = resolve(`name: shell
steps:
  - id: test
    kind: shell
    run: "true"
`)

const EDIT_AGENT = resolve(`name: edit
steps:
  - id: plan
    agent: claude
    permissions: edit
    prompt: go
`)

const FULL_STEP = resolve(`name: full
steps:
  - id: test
    kind: shell
    run: "true"
  - id: fix
    agent: claude
    permissions: full
    prompt: go
`)

const FULL_DEFAULT = resolve(`name: full-default
defaults:
  permissions: full
steps:
  - id: fix
    agent: claude
    prompt: go
`)

const CODEX_STEP = resolve(`name: codex
steps:
  - id: plan
    agent: codex
    permissions: read-only
    prompt: go
  - id: test
    kind: shell
    run: "true"
`)

const CODEX_OK: CodexHookTrustSummary = { state: 'ok', reviewEvents: [] }

const FILLED = { task: 'ship it', issue: '#1', pr: '#2', file: 'a.ts' }

function args(overrides: Partial<CanStartArgs> = {}): CanStartArgs {
  return {
    consent: 'accepted',
    codexTrust: null,
    inputs: FILLED,
    needsFull: false,
    allowFull: false,
    trustNeeded: false,
    definition: ALL_INPUTS,
    ...overrides
  }
}

describe('buildInputFields', () => {
  it('maps text to a textarea and issue, pr and file to single-line fields, in declared order', () => {
    expect(buildInputFields(ALL_INPUTS)).toEqual([
      { name: 'task', type: 'text', control: 'textarea' },
      { name: 'issue', type: 'issue', control: 'text' },
      { name: 'pr', type: 'pr', control: 'text' },
      { name: 'file', type: 'file', control: 'text' }
    ])
  })

  it('returns no fields for a definition without inputs or a missing definition', () => {
    expect(buildInputFields(SHELL_ONLY)).toEqual([])
    expect(buildInputFields(null)).toEqual([])
  })
})

describe('needsFull', () => {
  it('is true for an agent step with full permissions, set on the step or by defaults', () => {
    expect(needsFull(FULL_STEP)).toBe(true)
    expect(needsFull(FULL_DEFAULT)).toBe(true)
  })

  it('is false for edit agents, shell-only and missing definitions', () => {
    expect(needsFull(EDIT_AGENT)).toBe(false)
    expect(needsFull(SHELL_ONLY)).toBe(false)
    expect(needsFull(null)).toBe(false)
  })
})

describe('canStart', () => {
  it.each<[string, CodexHookTrustSummary | null]>([
    ['not computed yet', null],
    ['needing review', { state: 'needs-review', reviewEvents: ['Stop'] }],
    ['not installed', { state: 'not-installed', reviewEvents: [] }]
  ])('blocks a Codex definition while Codex hooks are %s', (_name, codexTrust) => {
    const codex = args({ definition: CODEX_STEP, inputs: {}, codexTrust })
    expect(canStart(codex)).toBe(false)
    expect(startBlockReason(codex)).toBe('Open a Codex tab and run /hooks')
    expect(canStart(args({ codexTrust }))).toBe(true)
  })

  it('starts a Codex definition once Codex trusts the hooks, after the consent check', () => {
    expect(canStart(args({ definition: CODEX_STEP, inputs: {}, codexTrust: CODEX_OK }))).toBe(true)
    expect(startBlockReason(args({ definition: CODEX_STEP, inputs: {}, consent: 'pending' }))).toBe(
      'Install hooks to start a workflow'
    )
  })

  it('is true with consent accepted, every input filled and no full step', () => {
    expect(canStart(args())).toBe(true)
    expect(startBlockReason(args())).toBeNull()
  })

  it.each(['pending', 'declined'] as const)('is false while hooks consent is %s, even for a shell-only workflow', (consent) => {
    expect(canStart(args({ consent }))).toBe(false)
    expect(canStart(args({ consent, definition: SHELL_ONLY, inputs: {} }))).toBe(false)
    expect(startBlockReason(args({ consent }))).toBe('Install hooks to start a workflow')
  })

  it.each([
    ['absent', { task: 'x', issue: '#1', pr: '#2' }],
    ['empty', { ...FILLED, file: '' }],
    ['whitespace only', { ...FILLED, file: ' \n\t ' }]
  ])('is false when a declared input is %s', (_name, inputs) => {
    expect(canStart(args({ inputs }))).toBe(false)
    expect(startBlockReason(args({ inputs }))).toBe('Fill in file')
  })

  it('does not count an inherited key as a filled input', () => {
    const inputs = Object.create({ file: 'a.ts' }) as Record<string, string>
    Object.assign(inputs, { task: 'x', issue: '#1', pr: '#2' })
    expect(canStart(args({ inputs }))).toBe(false)
  })

  it('is false for a full step until full access is confirmed', () => {
    const full = args({ definition: FULL_STEP, inputs: {}, needsFull: true })
    expect(canStart(full)).toBe(false)
    expect(startBlockReason(full)).toBe('Confirm full access to start')
    expect(canStart({ ...full, allowFull: true })).toBe(true)
  })

  it('is false for an untrusted repo definition before any other check', () => {
    const untrusted = args({ trustNeeded: true, consent: 'pending', inputs: {} })
    expect(canStart(untrusted)).toBe(false)
    expect(startBlockReason(untrusted)).toBe('Trust this definition to start it')
    expect(canStart(args({ trustNeeded: false }))).toBe(true)
  })

  it('is false when the definition is missing or broken', () => {
    expect(canStart(args({ definition: null }))).toBe(false)
    expect(startBlockReason(args({ definition: null }))).toBe('Pick a valid workflow')
  })
})

describe('trustNeeded', () => {
  const hash = 'a'.repeat(64)

  it('needs trust for a repo definition with no trusted hash or a different one', () => {
    expect(trustNeeded({ scope: 'repo', hash, trustedHash: undefined })).toBe(true)
    expect(trustNeeded({ scope: 'repo', hash, trustedHash: 'b'.repeat(64) })).toBe(true)
  })

  it('does not need trust for a repo definition trusted at this hash or for a personal one', () => {
    expect(trustNeeded({ scope: 'repo', hash, trustedHash: hash })).toBe(false)
    expect(trustNeeded({ scope: 'personal', hash, trustedHash: undefined })).toBe(false)
  })
})

describe('trustStepRows', () => {
  it('lists each step with its agent and resolved permission level, defaults included, and shell steps as shell', () => {
    const definition = resolve(`name: mixed
defaults:
  permissions: full
steps:
  - id: plan
    agent: codex
    permissions: read-only
    prompt: go
  - id: build
    agent: claude
    allow: ["pnpm test"]
    prompt: go
  - id: test
    kind: shell
    run: pnpm test
`)
    expect(trustStepRows(definition)).toEqual([
      { id: 'plan', agent: 'codex', permission: 'read-only' },
      { id: 'build', agent: 'claude', permission: 'full + pnpm test' },
      { id: 'test', agent: 'shell', permission: 'shell' }
    ])
  })

  it('uses the edit default when neither the step nor defaults set permissions', () => {
    expect(trustStepRows(resolve(`name: d
steps:
  - id: plan
    agent: claude
    prompt: go
`))).toEqual([{ id: 'plan', agent: 'claude', permission: 'edit' }])
  })
})

describe('showRunWorkflowItem', () => {
  function run(worktreePath: string, status: WorkflowRunStatus): WorkflowRun {
    return { defId: 'personal:x', defHash: 'h', worktreePath, status, startedAt: 1, steps: {} }
  }

  it('is hidden when labs workflows are off', () => {
    expect(showRunWorkflowItem({ labsWorkflows: false, worktreePath: '/wt/a', runs: {} })).toBe(false)
  })

  it('is shown with labs on and no runs, or only finished runs, in the worktree', () => {
    expect(showRunWorkflowItem({ labsWorkflows: true, worktreePath: '/wt/a', runs: {} })).toBe(true)
    const runs = { r1: run('/wt/a', 'done'), r2: run('/wt/a', 'failed'), r3: run('/wt/a', 'cancelled') }
    expect(showRunWorkflowItem({ labsWorkflows: true, worktreePath: '/wt/a', runs })).toBe(true)
  })

  it.each(['queued', 'running', 'paused'] as const)('is hidden while a run in the worktree is %s', (status) => {
    expect(showRunWorkflowItem({ labsWorkflows: true, worktreePath: '/wt/a', runs: { r: run('/wt/a', status) } })).toBe(false)
  })

  it('ignores busy runs in other worktrees, including path prefixes', () => {
    const runs = { r1: run('/wt/ab', 'running'), r2: run('/wt/a/', 'paused'), r3: run('/wt', 'queued') }
    expect(showRunWorkflowItem({ labsWorkflows: true, worktreePath: '/wt/a', runs })).toBe(true)
  })
})

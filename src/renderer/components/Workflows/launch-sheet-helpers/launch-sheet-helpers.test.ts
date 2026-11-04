import { describe, expect, it } from 'vitest'
import {
  buildInputFields,
  canStart,
  definitionsForRepo,
  existingWorktreeOptions,
  isWorktreeBusy,
  needsFull,
  overrideRows,
  resolveOverrides,
  targetBlockReason,
  workflowBranchName,
  showRunWorkflowItem,
  startBlockReason,
  trustNeeded,
  trustStepRows,
  type CanStartArgs
} from '.'
import { validateWorkflowDefinition, type ResolvedDefinition } from '../../../../shared/workflow-def'
import type { WorkflowDefinitionSummary, WorkflowRun, WorkflowRunStatus } from '../../../../shared/state/workflows'
import type { Worktree } from '../../../../shared/state/worktrees'
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
      { name: 'issue', type: 'issue', control: 'picker' },
      { name: 'pr', type: 'pr', control: 'picker' },
      { name: 'file', type: 'file', control: 'picker' }
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

function liveRun(worktreePath: string, status: WorkflowRunStatus): WorkflowRun {
  return { defId: 'personal:x', defHash: 'h', worktreePath, status, startedAt: 1, steps: {} }
}

function worktree(path: string, repoRoot: string, extra: Partial<Worktree> = {}): Worktree {
  return { path, branch: path.split('/').pop() ?? path, head: 'abc', isBare: false, isMain: false, createdAt: 0, repoRoot, ...extra }
}

describe('isWorktreeBusy', () => {
  it('is true only for a queued, running or paused run on the exact path', () => {
    const runs = { a: liveRun('/wt/a', 'paused'), b: liveRun('/wt/b', 'done'), c: liveRun('/wt/ab', 'running') }
    expect(isWorktreeBusy(runs, '/wt/a')).toBe(true)
    expect(isWorktreeBusy(runs, '/wt/b')).toBe(false)
    expect(isWorktreeBusy(runs, '/wt')).toBe(false)
  })
})

describe('definitionsForRepo', () => {
  function def(id: string, scope: 'personal' | 'repo', repoRoot?: string): WorkflowDefinitionSummary {
    return { id, name: id, scope, ...(repoRoot ? { repoRoot } : {}), path: `/x/${id}.yaml`, hash: 'h', stepIds: [], issues: [] }
  }
  const defs = {
    p: def('p', 'personal'),
    a: def('a', 'repo', '/repo/a'),
    b: def('b', 'repo', '/repo/b')
  }

  it('lists personal definitions and the chosen repo’s definitions only', () => {
    expect(definitionsForRepo(defs, '/repo/a').map((d) => d.id)).toEqual(['p', 'a'])
    expect(definitionsForRepo(defs, '/repo/b').map((d) => d.id)).toEqual(['p', 'b'])
  })

  it('lists only personal definitions without a repo', () => {
    expect(definitionsForRepo(defs, null).map((d) => d.id)).toEqual(['p'])
  })
})

describe('existingWorktreeOptions', () => {
  it('lists the repo’s non-bare worktrees without a live run', () => {
    const worktrees = [
      worktree('/repo/a', '/repo/a', { isMain: true }),
      worktree('/wts/busy', '/repo/a'),
      worktree('/wts/free', '/repo/a'),
      worktree('/wts/bare', '/repo/a', { isBare: true }),
      worktree('/wts/other', '/repo/b')
    ]
    const runs = { r: liveRun('/wts/busy', 'running'), d: liveRun('/wts/free', 'done') }
    expect(existingWorktreeOptions({ worktrees, repoRoot: '/repo/a', runs })).toEqual([
      { path: '/repo/a', label: 'a' },
      { path: '/wts/free', label: 'free' }
    ])
  })

  it('is empty without a repo', () => {
    expect(existingWorktreeOptions({ worktrees: [worktree('/repo/a', '/repo/a')], repoRoot: null, runs: {} })).toEqual([])
  })
})

describe('workflowBranchName', () => {
  it('builds wf/<definition>/<suffix> from a sanitized definition name', () => {
    expect(workflowBranchName('Plan & Ship!', 'k3x9ab12')).toBe('wf/plan-ship/k3x9ab12')
    expect(workflowBranchName('browser-hang', 'abc')).toBe('wf/browser-hang/abc')
  })

  it('falls back to "workflow" when nothing usable is left and caps the length', () => {
    expect(workflowBranchName('…', 'abc')).toBe('wf/workflow/abc')
    expect(workflowBranchName('x'.repeat(100), 'abc')).toBe(`wf/${'x'.repeat(40)}/abc`)
  })

  it('never produces a name the branch rules reject', () => {
    for (const name of ['.hidden', 'a..b', 'end.lock', '-lead', 'a/b', 'ünï cödé', '__']) {
      expect(targetBlockReason({
        target: { kind: 'new', repoRoot: '/repo/a', branchName: workflowBranchName(name, 'abc') },
        repoRoots: ['/repo/a'],
        worktrees: [],
        runs: {}
      })).toBeNull()
    }
  })
})

describe('targetBlockReason', () => {
  const repoRoots = ['/repo/a']
  const worktrees = [worktree('/repo/a', '/repo/a', { isMain: true }), worktree('/wts/busy', '/repo/a')]
  const runs = { r: liveRun('/wts/busy', 'paused') }
  const base = { repoRoots, worktrees, runs }

  it('accepts a preset target', () => {
    expect(targetBlockReason({ ...base, target: { kind: 'preset', worktreePath: '/repo/a' } })).toBeNull()
  })

  it('requires a registered repo', () => {
    expect(targetBlockReason({ ...base, target: { kind: 'new', repoRoot: null, branchName: 'x' } })).toBe('Choose a repository')
    expect(targetBlockReason({ ...base, target: { kind: 'new', repoRoot: '/gone', branchName: 'x' } })).toBe('Choose a repository')
  })

  it('applies the branch name rules to a new worktree', () => {
    expect(targetBlockReason({ ...base, target: { kind: 'new', repoRoot: '/repo/a', branchName: 'wf/plan/abc' } })).toBeNull()
    expect(targetBlockReason({ ...base, target: { kind: 'new', repoRoot: '/repo/a', branchName: '' } })).toBe('Enter a branch name')
    expect(targetBlockReason({ ...base, target: { kind: 'new', repoRoot: '/repo/a', branchName: 'a..b' } })).toBe(
      'A branch name can’t contain “..”'
    )
  })

  it('requires an existing worktree of the repo without a live run', () => {
    expect(targetBlockReason({ ...base, target: { kind: 'existing', repoRoot: '/repo/a', worktreePath: '/repo/a' } })).toBeNull()
    expect(targetBlockReason({ ...base, target: { kind: 'existing', repoRoot: '/repo/a', worktreePath: null } })).toBe(
      'Choose a worktree'
    )
    expect(targetBlockReason({ ...base, target: { kind: 'existing', repoRoot: '/repo/a', worktreePath: '/wts/busy' } })).toBe(
      'Choose a worktree'
    )
    expect(targetBlockReason({ ...base, target: { kind: 'existing', repoRoot: '/repo/a', worktreePath: '/elsewhere' } })).toBe(
      'Choose a worktree'
    )
  })
})

const MIXED = resolve(`name: mixed
steps:
  - id: plan
    agent: claude
    permissions: read-only
    model: opus
    prompt: go
  - id: test
    kind: shell
    run: "true"
  - id: fix
    agent: claude
    permissions: full
    prompt: go
`)

describe('overrideRows', () => {
  it('lists only agent steps with their definition agent and model', () => {
    expect(overrideRows(MIXED)).toStrictEqual([
      { id: 'plan', agent: 'claude', model: 'opus' },
      { id: 'fix', agent: 'claude', model: undefined }
    ])
    expect(overrideRows(SHELL_ONLY)).toStrictEqual([])
    expect(overrideRows(null)).toStrictEqual([])
  })
})

describe('resolveOverrides', () => {
  it('sends no overrides and keeps the definition when nothing changed', () => {
    const untouched = resolveOverrides(MIXED, {})
    expect(untouched).toStrictEqual({ overrides: undefined, effective: MIXED, reason: null, invalidStep: null })
    const same = resolveOverrides(MIXED, { plan: { agent: 'claude', model: ' opus ' }, fix: { model: '   ' } })
    expect(same.overrides).toBeUndefined()
    expect(same.effective).toBe(MIXED)
  })

  it('emits only the changed agent or model of each step, never undefined keys', () => {
    const { overrides } = resolveOverrides(MIXED, { plan: { agent: 'opencode' }, fix: { model: ' sonnet ' } })
    expect(overrides).toStrictEqual({ plan: { agent: 'opencode' }, fix: { model: 'sonnet' } })
    expect(Object.keys(overrides?.plan ?? {})).toStrictEqual(['agent'])
    expect(Object.keys(overrides?.fix ?? {})).toStrictEqual(['model'])
  })

  it('sends a typed model with an agent change even when it equals the definition model', () => {
    const { overrides } = resolveOverrides(MIXED, { plan: { agent: 'codex', model: 'opus' } })
    expect(overrides).toStrictEqual({ plan: { agent: 'codex', model: 'opus' } })
  })

  it('ignores drafts for steps that are not agent steps', () => {
    expect(resolveOverrides(MIXED, { test: { agent: 'codex' } }).overrides).toBeUndefined()
  })

  it('drops the definition model when the agent changes without a model, as the server does', () => {
    const { effective } = resolveOverrides(MIXED, { plan: { agent: 'opencode' } })
    const plan = effective.steps.find((step) => step.id === 'plan')
    expect(plan?.kind === 'agent' && plan.agent).toBe('opencode')
    expect(plan && 'model' in plan).toBe(false)
  })

  it('makes overriding a step to Codex block on Codex hooks, and overriding a Codex step away clear it', () => {
    const toCodex = resolveOverrides(MIXED, { plan: { agent: 'codex' } }).effective
    expect(startBlockReason(args({ definition: toCodex, inputs: {} }))).toBe('Open a Codex tab and run /hooks')
    expect(startBlockReason(args({ definition: toCodex, inputs: {}, codexTrust: CODEX_OK }))).toBeNull()
    const away = resolveOverrides(CODEX_STEP, { plan: { agent: 'claude' } }).effective
    expect(startBlockReason(args({ definition: CODEX_STEP, inputs: {} }))).toBe('Open a Codex tab and run /hooks')
    expect(startBlockReason(args({ definition: away, inputs: {} }))).toBeNull()
  })

  it('feeds the effective definition to needsFull', () => {
    const { effective } = resolveOverrides(MIXED, { fix: { agent: 'opencode' } })
    expect(effective).not.toBe(MIXED)
    expect(needsFull(effective)).toBe(true)
    expect(needsFull(resolveOverrides(EDIT_AGENT, { plan: { agent: 'codex' } }).effective)).toBe(false)
  })

  it('blocks Start with an inline reason on an invalid model and keeps the raw definition', () => {
    const long = resolveOverrides(MIXED, { plan: { model: 'm'.repeat(201) } })
    expect(long.reason).toBe('Model for plan is too long')
    expect(long.invalidStep).toBe('plan')
    expect(long.effective).toBe(MIXED)
    expect(resolveOverrides(MIXED, { fix: { model: 'bad\u0007model' } }).reason).toBe('Model for fix is invalid')
    expect(resolveOverrides(MIXED, { plan: { model: 'm'.repeat(200) } }).reason).toBeNull()
  })
})

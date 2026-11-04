import { randomUUID } from 'crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../../store'
import { initialState } from '../../../shared/state'
import { GATE_FEEDBACK_MAX_CHARS } from '../../../shared/state/workflows'
import type { TerminalTab } from '../../../shared/state/terminals'
import type { HooksConsent } from '../../../shared/state/hooks'
import type { StepSpawnExtras } from '../../agent-spawn'
import type { TrustStatus } from '../../folder-trust'
import { removeStepMarker, stepMarkerPath, writeStepMarker } from '../../mcp-config'
import {
  type ResolvedAgentStep,
  type TemplateScope,
  validateWorkflowDefinition
} from '../../../shared/workflow-def'
import {
  AGENT_START_SUMMARIES,
  CLAUDE_START_SUMMARIES,
  PROMPT_INLINE_MAX_BYTES,
  bracketedPaste,
  StepPauseError,
  StepStartError,
  createClaudeStepDriver,
  stepPromptPath,
  writeStepPromptFile,
  type AgentStopEvent,
  type StepAttempt,
  type StepDriverEvent,
  type StepExecution
} from '.'

vi.mock('../../perf-log', () => ({
  perfLog: vi.fn(),
  getPerfLogFilePath: vi.fn(() => '/tmp/perf.log')
}))

vi.mock('../../debug', () => ({ log: vi.fn() }))

const PROMPT_SECRET = 'PROMPT-SECRET-heron-5'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

let worktree: string
let markerDir: string

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), 'claude-step-wt-'))
  markerDir = mkdtempSync(join(tmpdir(), 'claude-step-markers-'))
})

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true })
  rmSync(markerDir, { recursive: true, force: true })
})

function resolvedStep(source: string, stepId: string): ResolvedAgentStep {
  const step = validateWorkflowDefinition(source).definition?.steps.find((candidate) => candidate.id === stepId)
  if (step?.kind !== 'agent') throw new Error(`no agent step ${stepId}`)
  return step
}

const DEFAULTS_SOURCE = `name: perms
inputs:
  task: { type: text }
defaults:
  permissions: read-only
  allow: [pnpm test]
steps:
  - id: plan
    agent: claude
    prompt: "${PROMPT_SECRET} plan {{inputs.task}}"
  - id: build
    agent: claude
    model: opus
    permissions: full
    allow: [make, pnpm build]
    prompt: "build"
`

function scope(inputs: Record<string, string> = { task: 'ship it' }): TemplateScope {
  return { inputs, steps: {}, run: { id: 'run-1', worktree, contextPath: join(worktree, 'ctx.md') } }
}

class FakeClaude {
  readonly store = new Store({ ...initialState, hooks: { ...initialState.hooks, consent: 'accepted' } })
  readonly tabs: Array<{ worktreePath: string; tab: TerminalTab; spawn: StepSpawnExtras; markerPresent: boolean }> =
    []
  readonly killed: Array<{ id: string; signal: string }> = []
  readonly alive = new Set<string>()
  readonly logs: string[] = []
  readonly bound: StepExecution[] = []
  readonly events: StepDriverEvent[] = []
  readonly writes: Array<{ id: string; data: string }> = []
  trust: TrustStatus | 'throw' = 'trusted'
  trustChecks = 0
  failSpawn = false
  private readonly exitListeners = new Set<(id: string, code: number, signal?: number) => void>()
  private readonly stopListeners = new Set<(event: AgentStopEvent) => void>()
  private readonly promptListeners = new Set<(event: { terminalId: string }) => void>()
  private ids = 0

  readonly driver = createClaudeStepDriver({
    addTab: (worktreePath, tab, spawn) => {
      this.tabs.push({ worktreePath, tab, spawn, markerPresent: existsSync(stepMarkerPath(tab.id, markerDir)) })
      if (!this.failSpawn) this.alive.add(tab.id)
    },
    hasTerminal: (id) => this.alive.has(id),
    onExit: (listener) => {
      this.exitListeners.add(listener)
      return () => {
        this.exitListeners.delete(listener)
      }
    },
    kill: (id, signal) => {
      this.killed.push({ id, signal })
    },
    onStopEvent: (listener) => {
      this.stopListeners.add(listener)
      return () => {
        this.stopListeners.delete(listener)
      }
    },
    onPromptSubmit: (listener) => {
      this.promptListeners.add(listener)
      return () => {
        this.promptListeners.delete(listener)
      }
    },
    store: this.store,
    checkFolderTrust: async () => {
      this.trustChecks += 1
      if (this.trust === 'throw') throw new Error('unreadable')
      return { status: this.trust }
    },
    writeMarker: (id, marker) => {
      writeStepMarker(id, marker, markerDir)
    },
    removeMarker: (id) => removeStepMarker(id, markerDir),
    writePromptFile: writeStepPromptFile,
    write: (id, data) => {
      this.writes.push({ id, data })
    },
    newTabId: () => `agent-tab-${++this.ids}`,
    newSessionId: () => randomUUID(),
    log: (category, message, data) => {
      this.logs.push(`[${category}] ${message} ${JSON.stringify(data ?? {})}`)
    }
  })

  constructor() {
    this.driver.onEvent((event) => this.events.push(event))
  }

  attempt(step: ResolvedAgentStep, overrides: Partial<StepAttempt> = {}): StepAttempt {
    return {
      runId: 'run-1',
      stepId: step.id,
      attemptId: `att-${step.id}`,
      n: 1,
      worktreePath: worktree,
      inputs: { task: 'ship it' },
      step,
      scope: scope(),
      bind: (execution) => {
        this.bound.push(execution)
        return true
      },
      ...overrides
    }
  }

  setConsent(consent: HooksConsent): void {
    this.store.dispatch({ type: 'hooks/consentChanged', payload: consent })
  }

  status(id: string, status: 'idle' | 'processing' | 'waiting' | 'needs-approval'): void {
    this.store.dispatch({ type: 'terminals/statusChanged', payload: { id, status, pendingTool: null } })
  }

  stop(terminalId: string, lastAssistantMessage: string | null, continued?: boolean, stopHookActive?: boolean): void {
    for (const listener of [...this.stopListeners]) {
      listener({ terminalId, lastAssistantMessage, continued, stopHookActive })
    }
  }

  promptSubmit(terminalId: string): void {
    for (const listener of [...this.promptListeners]) listener({ terminalId })
  }

  exit(id: string, code: number, signal?: number): void {
    this.alive.delete(id)
    for (const listener of [...this.exitListeners]) listener(id, code, signal)
  }

  get listenerCount(): number {
    return this.exitListeners.size + this.stopListeners.size + this.promptListeners.size
  }

  markerExists(id: string): boolean {
    return existsSync(stepMarkerPath(id, markerDir))
  }
}

describe('createClaudeStepDriver start', () => {
  it('resumes a stored session in a new tab and binds that session id', async () => {
    const fake = new FakeClaude()
    const plan = resolvedStep(DEFAULTS_SOURCE, 'plan')
    const stored = randomUUID()
    const first = await fake.driver.start(fake.attempt(plan))
    const resumed = await fake.driver.start(fake.attempt(plan, { attemptId: 'att-plan-2', n: 2, resumeSessionId: stored }))

    expect(resumed).toEqual({ executionId: 'agent-tab-2', sessionId: stored })
    expect(resumed.executionId).not.toBe(first.executionId)
    expect(fake.tabs[1].spawn.sessionId).toBe(stored)
    expect(fake.tabs[1].spawn).not.toHaveProperty('promptOnResume')
    expect(fake.bound.at(-1)).toEqual({ executionId: 'agent-tab-2', sessionId: stored })
  })

  it('asks the resumed session to take a continuation prompt override', async () => {
    const fake = new FakeClaude()
    const plan = resolvedStep(DEFAULTS_SOURCE, 'plan')
    const stored = randomUUID()
    await fake.driver.start(fake.attempt(plan, { resumeSessionId: stored, prompt: `${PROMPT_SECRET} fix` }))
    expect(fake.tabs[0].spawn).toMatchObject({ sessionId: stored, initialPrompt: `${PROMPT_SECRET} fix`, promptOnResume: true })
  })

  it('opens a tagged Claude tab with the step permissions, a fresh session and the rendered prompt', async () => {
    const fake = new FakeClaude()
    const plan = resolvedStep(DEFAULTS_SOURCE, 'plan')
    const build = resolvedStep(DEFAULTS_SOURCE, 'build')

    const first = await fake.driver.start(fake.attempt(plan))
    const second = await fake.driver.start(fake.attempt(build))

    expect(fake.tabs.map(({ worktreePath, tab }) => ({ worktreePath, tab }))).toEqual([
      {
        worktreePath: worktree,
        tab: {
          id: first.executionId,
          type: 'agent',
          agentKind: 'claude',
          label: '⚙ plan · Claude',
          workflow: { runId: 'run-1', stepId: 'plan', attemptId: 'att-plan' }
        }
      },
      {
        worktreePath: worktree,
        tab: {
          id: second.executionId,
          type: 'agent',
          agentKind: 'claude',
          label: '⚙ build · Claude',
          workflow: { runId: 'run-1', stepId: 'build', attemptId: 'att-build' }
        }
      }
    ])
    expect(fake.tabs[0].spawn).toEqual({
      permissionLevel: 'read-only',
      bashAllow: ['pnpm test'],
      initialPrompt: `${PROMPT_SECRET} plan ship it`,
      sessionId: first.sessionId
    })
    expect(fake.tabs[1].spawn).toEqual({
      permissionLevel: 'full',
      bashAllow: ['make', 'pnpm build'],
      initialPrompt: 'build',
      sessionId: second.sessionId,
      model: 'opus'
    })
    expect(first.sessionId).toMatch(UUID)
    expect(second.sessionId).toMatch(UUID)
    expect(first.sessionId).not.toBe(second.sessionId)
  })

  it('binds the tab id and session before writing the marker and opening the tab', async () => {
    const fake = new FakeClaude()
    const execution = await fake.driver.start(fake.attempt(resolvedStep(DEFAULTS_SOURCE, 'plan')))
    expect(fake.bound).toEqual([execution])
    expect(fake.tabs[0].markerPresent).toBe(true)
    expect(JSON.parse(readFileSync(stepMarkerPath(execution.executionId, markerDir), 'utf8'))).toEqual({
      runId: 'run-1',
      stepId: 'plan',
      attemptId: 'att-plan'
    })
  })

  it('removes the marker on release without killing the tab, and kills with SIGHUP on cancel', async () => {
    const fake = new FakeClaude()
    const step = resolvedStep(DEFAULTS_SOURCE, 'plan')
    const kept = await fake.driver.start(fake.attempt(step))
    const cancelled = await fake.driver.start(fake.attempt(step, { attemptId: 'att-2' }))

    fake.driver.release(kept.executionId)
    fake.driver.cancel(cancelled.executionId)

    expect(fake.markerExists(kept.executionId)).toBe(false)
    expect(fake.markerExists(cancelled.executionId)).toBe(false)
    expect(fake.killed).toEqual([{ id: cancelled.executionId, signal: 'SIGHUP' }])
  })

  it('writes a prompt over 8 KiB to the run folder and tells Claude to read it', async () => {
    const fake = new FakeClaude()
    const step = { ...resolvedStep(DEFAULTS_SOURCE, 'plan'), prompt: `${PROMPT_SECRET} ${'x'.repeat(10 * 1024)}` }
    await fake.driver.start(fake.attempt(step))
    const path = stepPromptPath(worktree, 'run-1', 'plan')
    expect(path).toBe(join(worktree, '.harness', 'runs', 'run-1', 'plan.prompt.md'))
    expect(readFileSync(path, 'utf8')).toBe(step.prompt)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(fake.tabs[0].spawn.initialPrompt).toBe(`Read ${path} and follow it.`)
  })

  it('keeps a prompt of exactly 8 KiB inline', async () => {
    const fake = new FakeClaude()
    const step = { ...resolvedStep(DEFAULTS_SOURCE, 'plan'), prompt: 'é'.repeat(PROMPT_INLINE_MAX_BYTES / 2) }
    await fake.driver.start(fake.attempt(step))
    expect(fake.tabs[0].spawn.initialPrompt).toBe(step.prompt)
    expect(existsSync(join(worktree, '.harness'))).toBe(false)
  })

  it('logs ids and the missing reference count but never prompt text', async () => {
    const fake = new FakeClaude()
    const step = { ...resolvedStep(DEFAULTS_SOURCE, 'plan'), prompt: `${PROMPT_SECRET} {{steps.gone.summary}} ${'y'.repeat(9000)}` }
    await fake.driver.start(fake.attempt(step))
    expect(fake.logs.some((line) => line.includes('prompt refs missing 1'))).toBe(true)
    expect(fake.logs.some((line) => line.includes('step spawned'))).toBe(true)
    expect(fake.logs.join('\n')).not.toContain(PROMPT_SECRET)
  })

  it.each([
    ['a shell step', { kind: 'shell', id: 'plan', run: 'true', needs: [] }, CLAUDE_START_SUMMARIES.notClaude],
    [
      'a non-Claude agent step',
      { kind: 'agent', id: 'plan', agent: 'codex', prompt: 'p', permissions: 'edit', allow: [], needs: [] },
      CLAUDE_START_SUMMARIES.notClaude
    ],
    [
      'a step without a permission level',
      { kind: 'agent', id: 'plan', agent: 'claude', prompt: 'p', allow: [], needs: [] },
      CLAUDE_START_SUMMARIES.noPermission
    ],
    [
      'a step with an unknown permission level',
      { kind: 'agent', id: 'plan', agent: 'claude', prompt: 'p', permissions: 'yolo', allow: [], needs: [] },
      CLAUDE_START_SUMMARIES.noPermission
    ],
    [
      'a step without an allow list',
      { kind: 'agent', id: 'plan', agent: 'claude', prompt: 'p', permissions: 'edit', needs: [] },
      CLAUDE_START_SUMMARIES.noPermission
    ],
    [
      'a step id that is not a file name',
      { kind: 'agent', id: '../plan', agent: 'claude', prompt: 'p', permissions: 'edit', allow: [], needs: [] },
      CLAUDE_START_SUMMARIES.unsafeId
    ]
  ])('fails closed for %s without binding or opening a tab', async (_name, rawStep, summary) => {
    const fake = new FakeClaude()
    const step = structuredClone(rawStep) as unknown as ResolvedAgentStep
    const attempt = fake.attempt(step, { stepId: rawStep.id })
    await expect(fake.driver.start(attempt)).rejects.toEqual(new StepStartError(summary))
    expect(fake.tabs).toEqual([])
    expect(fake.bound).toEqual([])
  })

  it('opens nothing when the attempt has ended before it binds', async () => {
    const fake = new FakeClaude()
    const attempt = fake.attempt(resolvedStep(DEFAULTS_SOURCE, 'plan'), { bind: () => false })
    await expect(fake.driver.start(attempt)).rejects.toEqual(new StepStartError(CLAUDE_START_SUMMARIES.ended))
    expect(fake.tabs).toEqual([])
    expect(fake.markerExists('agent-tab-1')).toBe(false)
  })

  it('fails the start when the PTY did not spawn', async () => {
    const fake = new FakeClaude()
    fake.failSpawn = true
    await expect(fake.driver.start(fake.attempt(resolvedStep(DEFAULTS_SOURCE, 'plan')))).rejects.toEqual(
      new StepStartError(CLAUDE_START_SUMMARIES.spawnFailed)
    )
  })
})

describe('createClaudeStepDriver pre-spawn checks', () => {
  it.each(['pending', 'declined'] as const)(
    'pauses for input with no tab or trust read when hooks consent is %s',
    async (consent) => {
      const fake = new FakeClaude()
      fake.setConsent(consent)
      const started = fake.driver.start(fake.attempt(resolvedStep(DEFAULTS_SOURCE, 'plan')))
      await expect(started).rejects.toEqual(new StepPauseError('needs-input', 'hooks consent required'))
      await expect(started).rejects.toBeInstanceOf(StepPauseError)
      expect(fake.tabs).toEqual([])
      expect(fake.bound).toEqual([])
      expect(fake.trustChecks).toBe(0)
    }
  )

  it.each(['untrusted', 'unknown', 'throw'] as const)(
    'pauses for trust with no tab or marker when folder trust is %s',
    async (trust) => {
      const fake = new FakeClaude()
      fake.trust = trust
      const started = fake.driver.start(fake.attempt(resolvedStep(DEFAULTS_SOURCE, 'plan')))
      await expect(started).rejects.toEqual(new StepPauseError('trust', CLAUDE_START_SUMMARIES.trust))
      expect(fake.tabs).toEqual([])
      expect(fake.bound).toEqual([])
      expect(fake.markerExists('agent-tab-1')).toBe(false)
    }
  )
})

describe('createClaudeStepDriver events', () => {
  it('reports needs-approval once per transition and only for its own tabs', async () => {
    const fake = new FakeClaude()
    const { executionId } = await fake.driver.start(fake.attempt(resolvedStep(DEFAULTS_SOURCE, 'plan')))
    fake.status('user-tab', 'needs-approval')
    fake.status(executionId, 'processing')
    fake.status(executionId, 'needs-approval')
    fake.status(executionId, 'needs-approval')
    fake.status(executionId, 'needs-approval')
    expect(fake.events).toEqual([{ type: 'needsApproval', executionId }])
    fake.status(executionId, 'processing')
    fake.status(executionId, 'needs-approval')
    expect(fake.events).toHaveLength(2)
    fake.driver.release(executionId)
    fake.status(executionId, 'processing')
    fake.status(executionId, 'needs-approval')
    expect(fake.events).toHaveLength(2)
  })

  it('forwards Stop events of its own tabs as turn ends with the last message', async () => {
    const fake = new FakeClaude()
    const { executionId } = await fake.driver.start(fake.attempt(resolvedStep(DEFAULTS_SOURCE, 'plan')))
    fake.stop('user-tab', 'not mine')
    fake.stop(executionId, 'all done')
    fake.stop(executionId, null)
    fake.driver.release(executionId)
    fake.stop(executionId, 'after release')
    expect(fake.events).toEqual([
      { type: 'turnEnded', executionId, lastMessage: 'all done' },
      { type: 'turnEnded', executionId }
    ])
  })

  it('forwards the continued flag of a Stop and prompt submits of its own tabs only', async () => {
    const fake = new FakeClaude()
    const { executionId } = await fake.driver.start(fake.attempt(resolvedStep(DEFAULTS_SOURCE, 'plan')))
    fake.stop(executionId, 'nudged', true)
    fake.stop(executionId, 'plain', false)
    fake.promptSubmit('user-tab')
    fake.promptSubmit(executionId)
    fake.driver.release(executionId)
    fake.promptSubmit(executionId)
    expect(fake.events).toEqual([
      { type: 'turnEnded', executionId, lastMessage: 'nudged', continued: true },
      { type: 'turnEnded', executionId, lastMessage: 'plain' },
      { type: 'promptSubmitted', executionId }
    ])
  })

  it('forwards every PTY exit so reattached executions are not lost, with a signal death as null', () => {
    const fake = new FakeClaude()
    fake.exit('reattached-tab', 1)
    fake.exit('other-tab', 0, 1)
    expect(fake.events).toEqual([
      { type: 'exited', executionId: 'reattached-tab', code: 1 },
      { type: 'exited', executionId: 'other-tab', code: null }
    ])
  })

  it('unsubscribes from PTY, Stop and store events on dispose', async () => {
    const fake = new FakeClaude()
    const { executionId } = await fake.driver.start(fake.attempt(resolvedStep(DEFAULTS_SOURCE, 'plan')))
    fake.driver.dispose()
    fake.status(executionId, 'needs-approval')
    fake.stop(executionId, 'late')
    fake.promptSubmit(executionId)
    fake.exit(executionId, 0)
    expect(fake.events).toEqual([])
    expect(fake.listenerCount).toBe(0)
  })
})

describe('bracketedPaste', () => {
  it('frames sanitized text in paste markers and a CR, so an embedded paste end cannot close the paste early', () => {
    const text = 'a\x1b[201~b\x9b201~c\r\n\td\x00\x07\x7f\x85é漢 z'
    expect(bracketedPaste(text)).toBe('\x1b[200~a[201~b201~c\n\tdé漢 z\x1b[201~\r')
    expect(Buffer.from(bracketedPaste('x\x1b[201~'))).toEqual(
      Buffer.from([0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e, 0x78, 0x5b, 0x32, 0x30, 0x31, 0x7e, 0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e, 0x0d])
    )
  })
})

describe('createClaudeStepDriver continue', () => {
  async function started(fake: FakeClaude) {
    const plan = resolvedStep(DEFAULTS_SOURCE, 'plan')
    const execution = await fake.driver.start(fake.attempt(plan))
    fake.driver.release(execution.executionId)
    const next = fake.attempt(plan, { attemptId: 'att-plan-2', n: 2 })
    return { plan, execution, next }
  }

  it('pastes the prompt into the live tab, rewrites the marker for the new attempt and owns the tab again', async () => {
    const fake = new FakeClaude()
    const { execution, next } = await started(fake)
    const { executionId } = execution

    await fake.driver.continue(next, executionId, `${PROMPT_SECRET}\nfix it`)

    expect(fake.writes).toEqual([{ id: executionId, data: `\x1b[200~${PROMPT_SECRET}\nfix it\x1b[201~\r` }])
    expect(fake.bound.at(-1)).toEqual({ executionId })
    expect(JSON.parse(readFileSync(stepMarkerPath(executionId, markerDir), 'utf8'))).toEqual({
      runId: 'run-1',
      stepId: 'plan',
      attemptId: 'att-plan-2'
    })
    expect(fake.tabs).toHaveLength(1)
    fake.stop(executionId, 'second', false, true)
    expect(fake.events).toEqual([{ type: 'turnEnded', executionId, lastMessage: 'second', stopHookActive: true }])
    expect(fake.logs.join('\n')).not.toContain(PROMPT_SECRET)
  })

  it('sanitizes before the 8 KiB threshold, then writes a longer prompt to the run folder and pastes the read line', async () => {
    const fake = new FakeClaude()
    const { execution, next } = await started(fake)
    const inline = `${'\x1b'.repeat(PROMPT_INLINE_MAX_BYTES)}${'z'.repeat(PROMPT_INLINE_MAX_BYTES)}`
    await fake.driver.continue(next, execution.executionId, inline)
    expect(fake.writes[0].data).toBe(bracketedPaste('z'.repeat(PROMPT_INLINE_MAX_BYTES)))
    const path = stepPromptPath(worktree, 'run-1', 'plan')
    expect(existsSync(path)).toBe(false)

    const long = `${PROMPT_SECRET}\x1b[201~ ${'x'.repeat(10 * 1024)}`
    await fake.driver.continue(next, execution.executionId, long)
    expect(readFileSync(path, 'utf8')).toBe(`${PROMPT_SECRET}[201~ ${'x'.repeat(10 * 1024)}`)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(fake.writes[1].data).toBe(bracketedPaste(`Read ${path} and follow it.`))
    expect(fake.logs.join('\n')).not.toContain(PROMPT_SECRET)
  })

  it('writes the largest gate feedback (16384 three-byte characters) to the prompt file, not the PTY', async () => {
    const fake = new FakeClaude()
    const { execution, next } = await started(fake)
    const feedback = '€'.repeat(GATE_FEEDBACK_MAX_CHARS)
    await fake.driver.continue(next, execution.executionId, feedback)
    const path = stepPromptPath(worktree, 'run-1', 'plan')
    expect(readFileSync(path, 'utf8')).toBe(feedback)
    expect(fake.writes).toEqual([{ id: execution.executionId, data: bracketedPaste(`Read ${path} and follow it.`) }])
  })

  it('refuses a dead tab or an ended attempt without writing to the PTY or the marker', async () => {
    const fake = new FakeClaude()
    const { execution, next } = await started(fake)
    const { executionId } = execution

    await expect(fake.driver.continue({ ...next, bind: () => false }, executionId, 'p')).rejects.toEqual(
      new StepStartError(AGENT_START_SUMMARIES.ended)
    )
    expect(fake.markerExists(executionId)).toBe(false)
    fake.exit(executionId, 0)
    await expect(fake.driver.continue(next, executionId, 'p')).rejects.toEqual(
      new StepStartError(AGENT_START_SUMMARIES.gone)
    )
    expect(fake.writes).toEqual([])
    expect(fake.markerExists(executionId)).toBe(false)
  })

  it('starts a new execution from a prompt override without rendering it as a template', async () => {
    const fake = new FakeClaude()
    const plan = resolvedStep(DEFAULTS_SOURCE, 'plan')
    await fake.driver.start(fake.attempt(plan, { prompt: `${PROMPT_SECRET} keep {{inputs.task}} literal` }))
    expect(fake.tabs[0].spawn.initialPrompt).toBe(`${PROMPT_SECRET} keep {{inputs.task}} literal`)
    expect(fake.logs.join('\n')).not.toContain(PROMPT_SECRET)
  })
})

describe('writeStepPromptFile', () => {
  it('replaces an existing prompt file with a 0600 file', async () => {
    const path = stepPromptPath(worktree, 'run-1', 'plan')
    mkdirSync(join(worktree, '.harness', 'runs', 'run-1'), { recursive: true })
    writeFileSync(path, 'old', { mode: 0o644 })
    await writeStepPromptFile(path, 'new')
    expect(readFileSync(path, 'utf8')).toBe('new')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(worktree, '.harness', 'runs', 'run-1'))).toEqual(['plan.prompt.md'])
  })

  it('replaces a planted symlink instead of writing through it', async () => {
    const outside = join(markerDir, 'outside.txt')
    writeFileSync(outside, 'keep me', { mode: 0o644 })
    const path = stepPromptPath(worktree, 'run-1', 'plan')
    mkdirSync(join(worktree, '.harness', 'runs', 'run-1'), { recursive: true })
    symlinkSync(outside, path)
    await writeStepPromptFile(path, 'new')
    expect(readFileSync(outside, 'utf8')).toBe('keep me')
    expect(statSync(outside).mode & 0o777).toBe(0o644)
    expect(lstatSync(path).isSymbolicLink()).toBe(false)
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8')).toBe('new')
  })
})

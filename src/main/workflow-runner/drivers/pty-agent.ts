import { mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { renderTemplate } from '../../../shared/workflow-def'
import { isPermissionLevel, sanitizeBashAllow } from '../../../shared/permission-level'
import type { PtyStatus, TerminalTab } from '../../../shared/state/terminals'
import type { StepSpawnExtras } from '../../agent-spawn'
import type { TrustStatus } from '../../folder-trust'
import type { StepMarker } from '../../mcp-config'
import type { Store } from '../../store'
import { runArtifactsDir } from '../run-artifacts'
import type { WorkflowLog } from '../types'
import {
  StepPauseError,
  StepStartError,
  type StepAttempt,
  type StepDriver,
  type StepDriverEvent,
  type StepDriverListener,
  type StepExecution
} from './types'

export const CLAUDE_CANCEL_SIGNAL = 'SIGHUP'
export const PROMPT_INLINE_MAX_BYTES = 8192

const FILE_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export const CLAUDE_START_SUMMARIES = {
  notClaude: 'not a claude agent step',
  noPermission: 'step has no explicit permission level',
  unsafeId: 'step or run id is not a safe file name',
  consent: 'hooks consent required',
  trust: 'claude folder trust required',
  ended: 'attempt ended before spawn',
  spawnFailed: 'claude failed to start'
} as const

export interface ClaudeStopEvent {
  terminalId: string
  lastAssistantMessage: string | null
  continued?: boolean
}

export interface ClaudeStepDriverDeps {
  addTab(worktreePath: string, tab: TerminalTab, spawn: StepSpawnExtras): void
  hasTerminal(id: string): boolean
  onExit(listener: (id: string, exitCode: number, signal?: number) => void): () => void
  kill(id: string, signal: typeof CLAUDE_CANCEL_SIGNAL): void
  onStopEvent(listener: (event: ClaudeStopEvent) => void): () => void
  onPromptSubmit(listener: (event: { terminalId: string }) => void): () => void
  store: Pick<Store, 'getSnapshot' | 'subscribe'>
  checkFolderTrust(path: string): Promise<{ status: TrustStatus }>
  writeMarker(terminalId: string, marker: StepMarker): void
  removeMarker(terminalId: string): void
  writePromptFile(path: string, text: string): Promise<void>
  newTabId(): string
  newSessionId(): string
  log: WorkflowLog
}

export interface ClaudeStepDriver extends StepDriver {
  start(attempt: StepAttempt): Promise<Required<StepExecution>>
  release(executionId: string): void
  dispose(): void
}

export async function writeStepPromptFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, { encoding: 'utf8', mode: 0o600 })
}

export function stepPromptPath(worktreePath: string, runId: string, stepId: string): string {
  return join(runArtifactsDir(worktreePath, runId), `${stepId}.prompt.md`)
}

async function folderTrust(deps: ClaudeStepDriverDeps, path: string): Promise<TrustStatus> {
  try {
    return (await deps.checkFolderTrust(path)).status
  } catch {
    return 'unknown'
  }
}

export function createClaudeStepDriver(deps: ClaudeStepDriverDeps): ClaudeStepDriver {
  const listeners = new Set<StepDriverListener>()
  const owned = new Set<string>()
  const lastStatus = new Map<string, PtyStatus>()
  const emit = (event: StepDriverEvent): void => {
    for (const listener of [...listeners]) listener(event)
  }
  const log = (message: string, ids: Record<string, string>): void => deps.log('workflow', message, ids)

  const unsubscribers = [
    deps.onExit((id, exitCode, signal) => {
      emit({ type: 'exited', executionId: id, code: signal ? null : exitCode })
    }),
    deps.onStopEvent(({ terminalId, lastAssistantMessage, continued }) => {
      if (!owned.has(terminalId)) return
      emit({
        type: 'turnEnded',
        executionId: terminalId,
        ...(lastAssistantMessage === null ? {} : { lastMessage: lastAssistantMessage }),
        ...(continued === true ? { continued } : {})
      })
    }),
    deps.onPromptSubmit(({ terminalId }) => {
      if (owned.has(terminalId)) emit({ type: 'promptSubmitted', executionId: terminalId })
    }),
    deps.store.subscribe((event) => {
      if (event.type !== 'terminals/statusChanged') return
      const { id, status } = event.payload
      if (!owned.has(id) || lastStatus.get(id) === status) return
      lastStatus.set(id, status)
      if (status === 'needs-approval') emit({ type: 'needsApproval', executionId: id })
    })
  ]

  const release = (executionId: string): void => {
    owned.delete(executionId)
    lastStatus.delete(executionId)
    deps.removeMarker(executionId)
  }

  return {
    async start(attempt: StepAttempt): Promise<Required<StepExecution>> {
      const { step, runId, stepId, attemptId, worktreePath, scope } = attempt
      const ids = { runId, stepId, attemptId }
      if (step.kind !== 'agent' || step.agent !== 'claude') throw new StepStartError(CLAUDE_START_SUMMARIES.notClaude)
      if (!isPermissionLevel(step.permissions) || !Array.isArray(step.allow)) {
        throw new StepStartError(CLAUDE_START_SUMMARIES.noPermission)
      }
      if (!FILE_SAFE_ID.test(runId) || !FILE_SAFE_ID.test(stepId)) {
        throw new StepStartError(CLAUDE_START_SUMMARIES.unsafeId)
      }
      if (deps.store.getSnapshot().state.hooks.consent !== 'accepted') {
        log('step blocked consent', ids)
        throw new StepPauseError('needs-input', CLAUDE_START_SUMMARIES.consent)
      }
      const trust = await folderTrust(deps, worktreePath)
      if (trust !== 'trusted') {
        log(`step blocked trust ${trust}`, ids)
        throw new StepPauseError('trust', CLAUDE_START_SUMMARIES.trust)
      }
      const rendered = renderTemplate(step.prompt, scope)
      if (rendered.missing.length > 0) log(`prompt refs missing ${rendered.missing.length}`, ids)
      let initialPrompt = rendered.text
      if (Buffer.byteLength(initialPrompt, 'utf8') > PROMPT_INLINE_MAX_BYTES) {
        const path = stepPromptPath(worktreePath, runId, stepId)
        await deps.writePromptFile(path, initialPrompt)
        initialPrompt = `Read ${path} and follow it.`
        log('prompt written to file', ids)
      }
      const executionId = deps.newTabId()
      const sessionId = deps.newSessionId()
      if (!attempt.bind({ executionId, sessionId })) throw new StepStartError(CLAUDE_START_SUMMARIES.ended)
      owned.add(executionId)
      deps.writeMarker(executionId, ids)
      const tab: TerminalTab = {
        id: executionId,
        type: 'agent',
        agentKind: 'claude',
        label: `⚙ ${stepId} · Claude`,
        workflow: ids
      }
      deps.addTab(worktreePath, tab, {
        permissionLevel: step.permissions,
        bashAllow: sanitizeBashAllow(step.allow.filter((entry): entry is string => typeof entry === 'string')),
        initialPrompt,
        sessionId,
        ...(step.model === undefined ? {} : { model: step.model })
      })
      if (!deps.hasTerminal(executionId)) throw new StepStartError(CLAUDE_START_SUMMARIES.spawnFailed)
      log('step spawned', { ...ids, executionId })
      return { executionId, sessionId }
    },
    continue() {},
    cancel(executionId: string) {
      deps.kill(executionId, CLAUDE_CANCEL_SIGNAL)
      release(executionId)
    },
    release,
    onEvent(listener: StepDriverListener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      for (const unsubscribe of unsubscribers) unsubscribe()
      listeners.clear()
      owned.clear()
      lastStatus.clear()
    }
  }
}

import { mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { renderTemplate, type WorkflowAgent } from '../../../shared/workflow-def'
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

export const AGENT_START_SUMMARIES = {
  unsupported: 'not a claude agent step',
  noPermission: 'step has no explicit permission level',
  unsafeId: 'step or run id is not a safe file name',
  consent: 'hooks consent required',
  ended: 'attempt ended before spawn'
} as const

export const CLAUDE_START_SUMMARIES = {
  notClaude: AGENT_START_SUMMARIES.unsupported,
  noPermission: AGENT_START_SUMMARIES.noPermission,
  unsafeId: AGENT_START_SUMMARIES.unsafeId,
  consent: AGENT_START_SUMMARIES.consent,
  trust: 'claude folder trust required',
  ended: AGENT_START_SUMMARIES.ended,
  spawnFailed: 'claude failed to start'
} as const

export interface AgentProfile {
  kind: WorkflowAgent
  label: string
  session: 'preassigned' | 'discovered'
  checkTrust(worktreePath: string): Promise<TrustStatus>
  startSummaries: { trust: string; spawnFailed: string }
}

export interface ClaudeStopEvent {
  terminalId: string
  lastAssistantMessage: string | null
  continued?: boolean
}

export interface AgentStepDriverDeps {
  profiles: readonly AgentProfile[]
  addTab(worktreePath: string, tab: TerminalTab, spawn: StepSpawnExtras): void
  hasTerminal(id: string): boolean
  onExit(listener: (id: string, exitCode: number, signal?: number) => void): () => void
  kill(id: string, signal: typeof CLAUDE_CANCEL_SIGNAL): void
  onStopEvent(listener: (event: ClaudeStopEvent) => void): () => void
  onPromptSubmit(listener: (event: { terminalId: string }) => void): () => void
  store: Pick<Store, 'getSnapshot' | 'subscribe'>
  writeMarker(terminalId: string, marker: StepMarker): void
  removeMarker(terminalId: string): void
  writePromptFile(path: string, text: string): Promise<void>
  newTabId(): string
  newSessionId(): string
  log: WorkflowLog
}

export interface ClaudeStepDriverDeps extends Omit<AgentStepDriverDeps, 'profiles'> {
  checkFolderTrust(path: string): Promise<{ status: TrustStatus }>
}

export interface AgentStepDriver extends StepDriver {
  start(attempt: StepAttempt): Promise<StepExecution>
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

async function folderTrust(profile: AgentProfile, path: string): Promise<TrustStatus> {
  try {
    return await profile.checkTrust(path)
  } catch {
    return 'unknown'
  }
}

export function claudeProfile(checkFolderTrust: ClaudeStepDriverDeps['checkFolderTrust']): AgentProfile {
  return {
    kind: 'claude',
    label: 'Claude',
    session: 'preassigned',
    checkTrust: async (path) => (await checkFolderTrust(path)).status,
    startSummaries: { trust: CLAUDE_START_SUMMARIES.trust, spawnFailed: CLAUDE_START_SUMMARIES.spawnFailed }
  }
}

export function createClaudeStepDriver({ checkFolderTrust, ...deps }: ClaudeStepDriverDeps): AgentStepDriver {
  return createAgentStepDriver({ ...deps, profiles: [claudeProfile(checkFolderTrust)] })
}

export function createAgentStepDriver(deps: AgentStepDriverDeps): AgentStepDriver {
  const profiles = new Map(deps.profiles.map((profile) => [profile.kind, profile]))
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
    async start(attempt: StepAttempt): Promise<StepExecution> {
      const { step, runId, stepId, attemptId, worktreePath, scope } = attempt
      const ids = { runId, stepId, attemptId }
      const profile = step.kind === 'agent' ? profiles.get(step.agent) : undefined
      if (step.kind !== 'agent' || profile === undefined) throw new StepStartError(AGENT_START_SUMMARIES.unsupported)
      if (!isPermissionLevel(step.permissions) || !Array.isArray(step.allow)) {
        throw new StepStartError(AGENT_START_SUMMARIES.noPermission)
      }
      if (!FILE_SAFE_ID.test(runId) || !FILE_SAFE_ID.test(stepId)) {
        throw new StepStartError(AGENT_START_SUMMARIES.unsafeId)
      }
      if (deps.store.getSnapshot().state.hooks.consent !== 'accepted') {
        log('step blocked consent', ids)
        throw new StepPauseError('needs-input', AGENT_START_SUMMARIES.consent)
      }
      const trust = await folderTrust(profile, worktreePath)
      if (trust !== 'trusted') {
        log(`step blocked trust ${trust}`, ids)
        throw new StepPauseError('trust', profile.startSummaries.trust)
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
      const sessionId =
        profile.session === 'preassigned' ? (attempt.resumeSessionId ?? deps.newSessionId()) : attempt.resumeSessionId
      const execution: StepExecution = sessionId === undefined ? { executionId } : { executionId, sessionId }
      if (!attempt.bind(execution)) throw new StepStartError(AGENT_START_SUMMARIES.ended)
      owned.add(executionId)
      deps.writeMarker(executionId, ids)
      const tab: TerminalTab = {
        id: executionId,
        type: 'agent',
        agentKind: profile.kind,
        label: `⚙ ${stepId} · ${profile.label}`,
        workflow: ids
      }
      deps.addTab(worktreePath, tab, {
        permissionLevel: step.permissions,
        bashAllow: sanitizeBashAllow(step.allow.filter((entry): entry is string => typeof entry === 'string')),
        initialPrompt,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(step.model === undefined ? {} : { model: step.model })
      })
      if (!deps.hasTerminal(executionId)) throw new StepStartError(profile.startSummaries.spawnFailed)
      log('step spawned', { ...ids, executionId })
      return execution
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

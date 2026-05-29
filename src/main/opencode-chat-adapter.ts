import type { Store } from './store'
import type { ChatSessionAdapter, RewindOutcome } from './chat-provider'
import type { JsonClaudePermissionMode, JsonClaudeMessageBlock } from '../shared/state/json-claude'
import type { ApprovalResult } from './approval-bridge'
import { AcpClient, type AcpMessage } from './opencode-acp-client'
import { log } from './debug'

const PARTIAL_TEXT_FLUSH_MS = 30

export class OpencodeChatAdapter implements ChatSessionAdapter {
  readonly provider = 'opencode' as const
  readonly sessionId: string
  private store: Store
  private client: AcpClient
  private getOpencodeCommand: () => string
  private worktreePath: string
  private providerSessionId: string | null = null
  private partialText = ''
  private textFlushTimer: NodeJS.Timeout | null = null
  private entryCounter = 0
  private busy = false
  private initialized = false
  private pendingPermissionId: string | null = null
  private pendingPermissionAcpId: string | number | null = null
  private currentPartialEntryId: string | null = null
  private currentPromptPromise: Promise<unknown> | null = null
  private isReplayingHistory = false

  constructor(
    sessionId: string,
    worktreePath: string,
    store: Store,
    getOpencodeCommand: () => string
  ) {
    this.sessionId = sessionId
    this.worktreePath = worktreePath
    this.store = store
    this.getOpencodeCommand = getOpencodeCommand
    this.client = new AcpClient(worktreePath, getOpencodeCommand)
    this.client.onEvent((msg) => this.handleAcpEvent(msg))
  }

  async start(worktreePath: string, _opts?: {
    permissionMode?: JsonClaudePermissionMode
    modelOverride?: string
  }): Promise<void> {
    this.worktreePath = worktreePath
    this.client.start()

    // Step 1: Initialize
    const initResult = await this.client.sendRequest('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true
      },
      clientInfo: { name: 'harness', version: '1.0.0' }
    }) as { agentCapabilities?: { loadSession?: boolean; sessionCapabilities?: { resume?: unknown } } } | undefined

    if (!initResult) {
      log('opencode-adapter', `initialize failed or timed out sessionId=${this.sessionId}`)
      this.dispatchError('Failed to initialize Opencode ACP connection')
      return
    }

    this.initialized = true
    const caps = initResult.agentCapabilities

    // Check if we have a persisted providerSessionId to resume/load
    const persistedProviderSessionId = this.findPersistedProviderSessionId()

    if (persistedProviderSessionId && caps?.loadSession) {
      // Try to load existing session (replays history via session/update)
      this.providerSessionId = persistedProviderSessionId
      this.isReplayingHistory = true
      await this.client.sendRequest('session/load', {
        sessionId: this.providerSessionId,
        cwd: this.worktreePath,
        mcpServers: []
      })
      this.isReplayingHistory = false
    } else if (persistedProviderSessionId && caps?.sessionCapabilities?.resume) {
      // Try to resume without replaying history
      this.providerSessionId = persistedProviderSessionId
      await this.client.sendRequest('session/resume', {
        sessionId: this.providerSessionId,
        cwd: this.worktreePath,
        mcpServers: []
      })
    } else {
      // Create new session
      const newResult = await this.client.sendRequest('session/new', {
        cwd: this.worktreePath,
        mcpServers: []
      }) as { sessionId?: string } | undefined

      if (!newResult?.sessionId) {
        log('opencode-adapter', `session/new failed sessionId=${this.sessionId}`)
        this.dispatchError('Failed to create Opencode session')
        return
      }

      this.providerSessionId = newResult.sessionId
      this.persistProviderSessionId(newResult.sessionId)
    }

    this.store.dispatch({
      type: 'jsonClaude/sessionStateChanged',
      payload: { sessionId: this.sessionId, state: 'running' }
    })
  }

  send(text: string, _images?: Array<{ mediaType: string; data: string; path: string }>): void {
    if (!this.providerSessionId || !this.initialized) {
      log('opencode-adapter', `send called before initialization sessionId=${this.sessionId}`)
      return
    }

    // Append user entry optimistically for live prompts only (not history replay)
    this.appendUserEntry(text)
    this.setBusy(true)

    this.currentPromptPromise = this.client.sendRequest('session/prompt', {
      sessionId: this.providerSessionId,
      prompt: [{ type: 'text', text }]
    })

    this.currentPromptPromise.then((result) => {
      this.handlePromptResult(result)
    }).catch(() => {
      this.flushPartialText()
      this.setBusy(false)
    })
  }

  private handlePromptResult(result: unknown): void {
    this.flushPartialText()
    const promptResult = result as { stopReason?: string } | undefined
    const stopReason = promptResult?.stopReason

    if (stopReason === 'cancelled') {
      // User cancelled — busy already cleared by interrupt()
    } else if (stopReason === 'refusal') {
      this.dispatchError('Model refused the request')
    } else if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
      // Turn ended normally but hit a limit
    }

    // Finalize the partial entry if any
    if (this.currentPartialEntryId) {
      this.finalizePartialEntry()
    }

    this.setBusy(false)
    this.currentPromptPromise = null
  }

  cancelQueued(_entryId: string): void {
    this.store.dispatch({
      type: 'jsonClaude/entryRemoved',
      payload: { sessionId: this.sessionId, entryId: _entryId }
    })
  }

  interrupt(): void {
    if (!this.providerSessionId) return
    this.client.sendNotification('session/cancel', {
      sessionId: this.providerSessionId
    })
    this.flushPartialText()
    this.setBusy(false)
  }

  kill(): void {
    this.client.kill()
    this.store.dispatch({
      type: 'jsonClaude/sessionStateChanged',
      payload: {
        sessionId: this.sessionId,
        state: 'exited',
        exitReason: 'killed by user'
      }
    })
  }

  killAll(): void {
    this.kill()
  }

  rewindTo(_entryId: string): RewindOutcome {
    return { ok: false, reason: 'rewind not supported for opencode' }
  }

  setPermissionMode(_mode: JsonClaudePermissionMode): void {
    // Opencode doesn't support permission modes
  }

  seedFromTranscript(_worktreePath: string): void {
    // History is replayed via session/load when resuming
  }

  resolveApproval(requestId: string, result: ApprovalResult): boolean {
    if (!this.providerSessionId || this.pendingPermissionId !== requestId || this.pendingPermissionAcpId === null) {
      return false
    }

    let optionId: string
    if (result.behavior === 'allow') {
      optionId = 'allow-once'
    } else {
      optionId = 'reject'
    }

    this.client.sendResponse(this.pendingPermissionAcpId, {
      outcome: { outcome: 'selected', optionId }
    })

    this.pendingPermissionId = null
    this.pendingPermissionAcpId = null
    return true
  }

  rerunAutoApprovalReview(_requestId: string): boolean {
    return false
  }

  private handleAcpEvent(msg: AcpMessage): void {
    const method = msg.method
    const params = msg.params as Record<string, unknown> | undefined

    if (method === 'session/update') {
      this.handleSessionUpdate(params)
      return
    }

    if (method === 'session/request_permission') {
      this.handlePermissionRequest(msg as AcpMessage & { id: string | number; params: Record<string, unknown> })
      return
    }

    if (method === 'error') {
      const message = typeof params?.message === 'string' ? params.message : 'Unknown error'
      this.dispatchError(message)
      this.setBusy(false)
      return
    }

    if (method === 'session/exit') {
      const code = typeof params?.code === 'number' ? params.code : null
      const signal = typeof params?.signal === 'string' ? params.signal : null
      const exitReason = signal
        ? `signal ${signal}`
        : code === 0
          ? 'clean'
          : `exit ${code}`
      this.store.dispatch({
        type: 'jsonClaude/sessionStateChanged',
        payload: { sessionId: this.sessionId, state: 'exited', exitCode: code, exitReason }
      })
      this.dispatchError(exitReason)
      this.setBusy(false)
      return
    }
  }

  private handleSessionUpdate(params: Record<string, unknown> | undefined): void {
    if (!params) return
    const update = params.update as Record<string, unknown> | undefined
    if (!update) return

    const sessionUpdate = update.sessionUpdate as string
    if (!sessionUpdate) return

    switch (sessionUpdate) {
      case 'agent_message_chunk': {
        const content = update.content as Record<string, unknown> | undefined
        const text = typeof content?.text === 'string' ? content.text : ''
        if (text) {
          this.ensurePartialEntry()
          this.partialText += text
          this.scheduleTextFlush()
        }
        break
      }

      case 'user_message_chunk': {
        const content = update.content as Record<string, unknown> | undefined
        const text = typeof content?.text === 'string' ? content.text : ''
        if (text && this.isReplayingHistory) {
          // Only append user entries from history replay; live sends are optimistic
          this.appendUserEntry(text)
        }
        break
      }

      case 'agent_thought_chunk': {
        const content = update.content as Record<string, unknown> | undefined
        const text = typeof content?.text === 'string' ? content.text : ''
        if (text) {
          this.store.dispatch({
            type: 'jsonClaude/assistantThinkingDelta',
            payload: {
              sessionId: this.sessionId,
              entryId: `${this.sessionId}-a-thought`,
              textDelta: text
            }
          })
        }
        break
      }

      case 'tool_call': {
        this.flushPartialText()
        const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : `tool-${this.entryCounter++}`
        const title = typeof update.title === 'string' ? update.title : 'unknown'
        const kind = typeof update.kind === 'string' ? update.kind : 'unknown'
        this.appendAssistantEntry([
          { type: 'tool_use', id: toolCallId, name: title, input: { kind } }
        ])
        break
      }

      case 'tool_call_update': {
        const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : ''
        const status = typeof update.status === 'string' ? update.status : ''

        if (status === 'completed' || status === 'failed') {
          const content = update.content as Array<Record<string, unknown>> | undefined
          let textContent = ''
          let isError = status === 'failed'

          if (Array.isArray(content)) {
            for (const item of content) {
              if (item.type === 'content' && typeof item.content === 'object' && item.content) {
                const c = item.content as Record<string, unknown>
                if (typeof c.text === 'string') {
                  textContent += c.text
                }
              }
            }
          }

          this.store.dispatch({
            type: 'jsonClaude/toolResultAttached',
            payload: { sessionId: this.sessionId, toolUseId: toolCallId, content: textContent, isError }
          })
        }
        break
      }

      case 'available_commands_update': {
        const commands = update.availableCommands as string[] | undefined
        if (Array.isArray(commands)) {
          // Opencode commands include a leading '/' (e.g. '/compact'); the
          // renderer adds its own '/' prefix, so strip it here to avoid '//'.
          const normalized = commands.map((c) => c.replace(/^\//, ''))
          this.store.dispatch({
            type: 'jsonClaude/slashCommandsChanged',
            payload: { sessionId: this.sessionId, slashCommands: normalized }
          })
        }
        break
      }
    }
  }

  private handlePermissionRequest(msg: AcpMessage & { id: string | number; params: Record<string, unknown> }): void {
    const params = msg.params
    const toolCall = params.toolCall as Record<string, unknown> | undefined
    if (!toolCall) return

    const requestId = `perm-${this.sessionId}-${Date.now()}`
    this.pendingPermissionId = requestId
    this.pendingPermissionAcpId = msg.id

    this.store.dispatch({
      type: 'jsonClaude/approvalRequested',
      payload: {
        requestId,
        sessionId: this.sessionId,
        toolName: typeof toolCall.title === 'string' ? toolCall.title : 'unknown',
        input: toolCall as Record<string, unknown>,
        toolUseId: typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : undefined,
        timestamp: Date.now()
      }
    })
  }

  private findPersistedProviderSessionId(): string | undefined {
    const panes = this.store.getSnapshot().state.terminals.panes
    for (const tree of Object.values(panes)) {
      for (const leaf of this.getLeaves(tree)) {
        for (const tab of leaf.tabs) {
          if (tab.id === this.sessionId && tab.type === 'json-claude') {
            return tab.providerSessionId
          }
        }
      }
    }
    return undefined
  }

  private persistProviderSessionId(providerSessionId: string): void {
    this.store.dispatch({
      type: 'terminals/providerSessionIdDiscovered',
      payload: { terminalId: this.sessionId, providerSessionId }
    })
  }

  private getLeaves(node: { type: string; tabs?: Array<{ id: string; type: string; providerSessionId?: string }>; children?: [unknown, unknown] }): Array<{ tabs: Array<{ id: string; type: string; providerSessionId?: string }> }> {
    if (node.type === 'leaf') {
      return [{ tabs: node.tabs || [] }]
    }
    if (node.children) {
      return [...this.getLeaves(node.children[0] as typeof node), ...this.getLeaves(node.children[1] as typeof node)]
    }
    return []
  }

  private appendUserEntry(text: string): void {
    this.store.dispatch({
      type: 'jsonClaude/entryAppended',
      payload: {
        sessionId: this.sessionId,
        entry: {
          entryId: `${this.sessionId}-u-${this.entryCounter++}`,
          kind: 'user',
          text,
          timestamp: Date.now()
        }
      }
    })
  }

  private appendAssistantEntry(blocks: JsonClaudeMessageBlock[]): void {
    this.store.dispatch({
      type: 'jsonClaude/entryAppended',
      payload: {
        sessionId: this.sessionId,
        entry: {
          entryId: `${this.sessionId}-a-${this.entryCounter++}`,
          kind: 'assistant',
          blocks,
          timestamp: Date.now()
        }
      }
    })
  }

  private ensurePartialEntry(): void {
    if (this.currentPartialEntryId) return
    this.currentPartialEntryId = `${this.sessionId}-a-partial-${this.entryCounter++}`
    this.store.dispatch({
      type: 'jsonClaude/entryAppended',
      payload: {
        sessionId: this.sessionId,
        entry: {
          entryId: this.currentPartialEntryId,
          kind: 'assistant',
          blocks: [{ type: 'text', text: '' }],
          timestamp: Date.now(),
          isPartial: true
        }
      }
    })
  }

  private finalizePartialEntry(): void {
    if (!this.currentPartialEntryId) return
    // The entry is already in the store with isPartial: true.
    // We dispatch assistantEntryFinalized to clear isPartial.
    this.store.dispatch({
      type: 'jsonClaude/assistantEntryFinalized',
      payload: {
        sessionId: this.sessionId,
        entryId: this.currentPartialEntryId
      }
    })
    this.currentPartialEntryId = null
  }

  private dispatchError(message: string): void {
    this.store.dispatch({
      type: 'jsonClaude/entryAppended',
      payload: {
        sessionId: this.sessionId,
        entry: {
          entryId: `${this.sessionId}-error-${Date.now()}`,
          kind: 'error',
          timestamp: Date.now(),
          errorKind: 'subprocess-exit',
          errorMessage: message,
          exitWasClean: false
        }
      }
    })
  }

  private setBusy(busy: boolean): void {
    if (this.busy === busy) return
    this.busy = busy
    this.store.dispatch({
      type: 'jsonClaude/busyChanged',
      payload: { sessionId: this.sessionId, busy }
    })
  }

  private scheduleTextFlush(): void {
    if (this.textFlushTimer) return
    this.textFlushTimer = setTimeout(() => {
      this.textFlushTimer = null
      this.flushPartialText()
    }, PARTIAL_TEXT_FLUSH_MS)
  }

  private flushPartialText(): void {
    if (this.textFlushTimer) {
      clearTimeout(this.textFlushTimer)
      this.textFlushTimer = null
    }
    if (!this.partialText) return
    const text = this.partialText
    this.partialText = ''
    if (this.currentPartialEntryId) {
      this.store.dispatch({
        type: 'jsonClaude/assistantTextDelta',
        payload: {
          sessionId: this.sessionId,
          entryId: this.currentPartialEntryId,
          textDelta: text
        }
      })
    }
  }
}

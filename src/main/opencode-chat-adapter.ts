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
  private partialText = ''
  private textFlushTimer: NodeJS.Timeout | null = null
  private entryCounter = 0
  private busy = false

  constructor(
    sessionId: string,
    worktreePath: string,
    store: Store,
    getOpencodeCommand: () => string
  ) {
    this.sessionId = sessionId
    this.store = store
    this.getOpencodeCommand = getOpencodeCommand
    this.client = new AcpClient(sessionId, worktreePath, getOpencodeCommand)
    this.client.onEvent((msg) => this.handleAcpEvent(msg))
  }

  start(worktreePath: string): void {
    if (this.client) {
      this.client.start()
      this.store.dispatch({
        type: 'jsonClaude/sessionStateChanged',
        payload: { sessionId: this.sessionId, state: 'running' }
      })
    }
  }

  send(text: string): void {
    this.client.sendNotification('message/send', { text })
    this.appendUserEntry(text)
    this.setBusy(true)
  }

  cancelQueued(_entryId: string): void {
    // Opencode ACP doesn't support canceling queued messages in the same way
    // Dispatch entryRemoved optimistically
    this.store.dispatch({
      type: 'jsonClaude/entryRemoved',
      payload: { sessionId: this.sessionId, entryId: _entryId }
    })
  }

  interrupt(): void {
    this.client.sendNotification('message/interrupt')
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
    // TODO: Implement transcript seeding via opencode export
  }

  resolveApproval(_requestId: string, _result: ApprovalResult): boolean {
    // Opencode ACP approval flow not yet implemented
    return false
  }

  rerunAutoApprovalReview(_requestId: string): boolean {
    return false
  }

  private handleAcpEvent(msg: AcpMessage): void {
    const method = msg.method
    const params = msg.params as Record<string, unknown> | undefined

    if (method === 'assistant/text') {
      const text = typeof params?.text === 'string' ? params.text : ''
      if (text) {
        this.partialText += text
        this.scheduleTextFlush()
      }
      return
    }

    if (method === 'assistant/complete') {
      this.flushPartialText()
      const blocks = this.buildBlocksFromParams(params)
      this.appendAssistantEntry(blocks)
      this.setBusy(false)
      return
    }

    if (method === 'assistant/tool_use') {
      this.flushPartialText()
      const toolName = typeof params?.name === 'string' ? params.name : 'unknown'
      const toolUseId = typeof params?.id === 'string' ? params.id : `tool-${this.entryCounter++}`
      const input = typeof params?.input === 'object' && params?.input
        ? (params.input as Record<string, unknown>)
        : {}
      this.appendAssistantEntry([
        { type: 'tool_use', id: toolUseId, name: toolName, input }
      ])
      return
    }

    if (method === 'tool/result') {
      const toolUseId = typeof params?.toolUseId === 'string' ? params.toolUseId : ''
      const content = typeof params?.content === 'string' ? params.content : ''
      const isError = params?.isError === true
      this.store.dispatch({
        type: 'jsonClaude/toolResultAttached',
        payload: { sessionId: this.sessionId, toolUseId, content, isError }
      })
      return
    }

    if (method === 'error') {
      const message = typeof params?.message === 'string' ? params.message : 'Unknown error'
      this.appendErrorEntry(message)
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
      this.appendErrorEntry(exitReason)
      this.setBusy(false)
      return
    }
  }

  private buildBlocksFromParams(params: Record<string, unknown> | undefined): JsonClaudeMessageBlock[] {
    const blocks: JsonClaudeMessageBlock[] = []
    const text = typeof params?.text === 'string' ? params.text : ''
    if (text) {
      blocks.push({ type: 'text', text })
    }
    return blocks
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

  private appendErrorEntry(message: string): void {
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
    this.store.dispatch({
      type: 'jsonClaude/assistantTextDelta',
      payload: {
        sessionId: this.sessionId,
        entryId: `${this.sessionId}-a-partial`,
        textDelta: text
      }
    })
  }
}

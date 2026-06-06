import type { ChatRuntime } from './types'
import type { Store } from '../store'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { createRequire } from 'module'
import { dirname, join, sep } from 'path'

import type {
  Query,
  SDKMessage,
  SDKUserMessage,
  Options,
  PermissionMode
} from '@anthropic-ai/claude-agent-sdk'
import type {
  JsonClaudePermissionMode,
  ChatRuntimeCapabilities,
  JsonClaudeChatEntry,
  JsonClaudeMessageBlock
} from '../../shared/state/json-claude'
import { defaultCapabilitiesFor } from '../../shared/state/json-claude'

interface AcpSession {
  query: Query
  abortController: AbortController
  worktreePath: string
  busy: boolean
  entryCounter: number
  currentAssistantEntryId: string | null
  currentMessageId: string | null
  interrupted: boolean
  pendingTextDelta: string
  pendingThinkingDelta: string
  flushTimer: ReturnType<typeof setTimeout> | null
}

function mapPermissionMode(mode: JsonClaudePermissionMode): PermissionMode {
  return mode as PermissionMode
}

function makeUserMessage(
  text: string,
  images?: Array<{ mediaType: string; data: string; path: string }>
): SDKUserMessage {
  const content = images?.length
    ? [
        ...images.map((img) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: img.mediaType,
            data: img.data
          }
        })),
        { type: 'text' as const, text }
      ]
    : text

  return {
    type: 'user',
    message: { role: 'user', content: content as any },
    parent_tool_use_id: null
  } as SDKUserMessage
}

interface ClaudeAcpRuntimeOptions {
  resolveExecutablePath?: () => string | undefined
}

export function resolveClaudeAgentSdkExecutablePath(opts: {
  platform?: NodeJS.Platform
  arch?: string
  resolveFromSdk?: (id: string) => string
} = {}): string | undefined {
  try {
    const { platform = process.platform, arch = process.arch, resolveFromSdk } = opts
    const dynamicRequire = createRequire(__filename)
    const sdkEntry = dynamicRequire.resolve('@anthropic-ai/claude-agent-sdk')
    const sdkRequire = createRequire(sdkEntry)
    const resolveNative = resolveFromSdk ?? ((id: string) => sdkRequire.resolve(id))
    const nativePackageJson = resolveNative(
      `@anthropic-ai/claude-agent-sdk-${platform}-${arch}/package.json`
    )
    return join(dirname(nativePackageJson), 'claude').replace(
      `${sep}app.asar${sep}`,
      `${sep}app.asar.unpacked${sep}`
    )
  } catch {
    return undefined
  }
}

/** Real ACP runtime using @anthropic-ai/claude-agent-sdk.
 *
 *  Supports start, send, streaming assistant output, interrupt, kill,
 *  and clear unsupported-action behavior. History/transcript replay is
 *  isolated from legacy jsonl. Output is normalized into existing store
 *  events so the current renderer functions. */
export class ClaudeAcpRuntime implements ChatRuntime {
  private store: Store
  private sessions: Map<string, AcpSession> = new Map()
  private startedSessions: Set<string> = new Set()
  private pendingSends: Map<string, Array<{ text: string; images?: Array<{ mediaType: string; path: string; data: string }> }>> = new Map()
  private modelOverrides: Map<string, string> = new Map()
  private resolveExecutablePath: () => string | undefined

  constructor(store: Store, opts: ClaudeAcpRuntimeOptions = {}) {
    this.store = store
    this.resolveExecutablePath = opts.resolveExecutablePath ?? resolveClaudeAgentSdkExecutablePath
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId) || this.startedSessions.has(sessionId)
  }

  start(
    sessionId: string,
    worktreePath: string,
    opts?: {
      permissionMode?: JsonClaudePermissionMode
      modelOverride?: string
    }
  ): void {
    // Move fresh/woken tabs out of connecting into a sensible non-running
    // state until the first send actually creates the query.
    this.startedSessions.add(sessionId)
    this.store.dispatch({
      type: 'jsonClaude/sessionStateChanged',
      payload: { sessionId, state: 'idle' }
    })
    if (opts?.modelOverride) {
      this.modelOverrides.set(sessionId, opts.modelOverride)
    }
  }

  send(
    sessionId: string,
    text: string,
    images?: Array<{ mediaType: string; data: string; path: string }>
  ): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      this._createQuery(sessionId, text, images)
      return
    }

    if (session.busy) {
      // Queue the message for when the current turn finishes.
      const entryId = `${sessionId}-u-${session.entryCounter++}`
      this._appendQueuedUserEntry(sessionId, entryId, text, images)
      const queue = this.pendingSends.get(sessionId) ?? []
      queue.push({
        text,
        images: images?.map((img) => ({
          mediaType: img.mediaType,
          path: img.path,
          data: img.data
        }))
      })
      this.pendingSends.set(sessionId, queue)
      return
    }

    // Subsequent send: stream input into the existing query.
    const entryId = `${sessionId}-u-${session.entryCounter++}`
    this._appendUserEntry(sessionId, entryId, text, images)

    session.busy = true
    this.store.dispatch({
      type: 'jsonClaude/busyChanged',
      payload: { sessionId, busy: true }
    })

    session.query
      .streamInput(
        (async function* () {
          yield makeUserMessage(text, images)
        })()
      )
      .catch((err) => {
        this._emitError(sessionId, `Send failed: ${err instanceof Error ? err.message : String(err)}`)
      })
  }

  interrupt(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.interrupted = true
    session.query.interrupt().catch(() => {
      // ignore interrupt errors
    })
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      this.startedSessions.delete(sessionId)
      this.pendingSends.delete(sessionId)
      this.modelOverrides.delete(sessionId)
      return
    }
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    session.abortController.abort()
    try {
      session.query.close()
    } catch {
      // ignore close errors
    }
    this.sessions.delete(sessionId)
    this.startedSessions.delete(sessionId)
    this.pendingSends.delete(sessionId)
    this.modelOverrides.delete(sessionId)
    this.store.dispatch({
      type: 'jsonClaude/busyChanged',
      payload: { sessionId, busy: false }
    })
    this.store.dispatch({
      type: 'jsonClaude/sessionStateChanged',
      payload: { sessionId, state: 'exited', exitCode: 0, exitReason: 'killed' }
    })
  }

  killAll(): void {
    for (const sessionId of Array.from(this.sessions.keys())) {
      this.kill(sessionId)
    }
    this.startedSessions.clear()
    this.pendingSends.clear()
    this.modelOverrides.clear()
  }

  rewindTo(_sessionId: string, _fromEntryId: string): { ok: boolean; reason?: string } {
    return { ok: false, reason: 'Rewind is not supported by the ACP runtime' }
  }

  setPermissionMode(_sessionId: string, _mode: JsonClaudePermissionMode): void {
    // Unsupported: capability canSetPermissionMode is false.
  }

  cancelQueued(_sessionId: string, _entryId: string): void {
    // Unsupported: no queued-message cancellation in ACP MVP.
  }

  getCapabilities(_sessionId: string): ChatRuntimeCapabilities {
    return defaultCapabilitiesFor('acp')
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private _createQuery(
    sessionId: string,
    text: string,
    images?: Array<{ mediaType: string; data: string; path: string }>
  ): void {
    const snapshot = this.store.getSnapshot()
    const sessionState = snapshot.state.jsonClaude.sessions[sessionId]
    const worktreePath = sessionState?.worktreePath ?? '/tmp'
    // Force ACP to a safe permission mode; do not inherit acceptEdits.
    const permissionMode: JsonClaudePermissionMode = 'default'
    if (sessionState?.permissionMode && sessionState.permissionMode !== permissionMode) {
      this.store.dispatch({
        type: 'jsonClaude/permissionModeChanged',
        payload: { sessionId, mode: permissionMode }
      })
    }
    this.startedSessions.delete(sessionId)
    const abortController = new AbortController()
    const modelOverride = this.modelOverrides.get(sessionId)
    this.modelOverrides.delete(sessionId)

    const pathToClaudeCodeExecutable = this.resolveExecutablePath()
    const opts: Options = {
      cwd: worktreePath,
      env: {
        ...process.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: 'harness'
      },
      abortController,
      includePartialMessages: true,
      permissionMode: mapPermissionMode(permissionMode),
      persistSession: false,
      ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
      ...(modelOverride ? { model: modelOverride } : {})
    }

    let q: Query
    try {
      const prompt = images?.length
        ? (async function* () {
            yield makeUserMessage(text, images)
          })()
        : text
      q = query({
        prompt: prompt as string | AsyncIterable<SDKUserMessage>,
        options: opts
      })
    } catch (err) {
      this._emitError(
        sessionId,
        `Failed to start ACP session: ${err instanceof Error ? err.message : String(err)}`
      )
      this.store.dispatch({
        type: 'jsonClaude/sessionStateChanged',
        payload: {
          sessionId,
          state: 'exited',
          exitCode: 1,
          exitReason: 'ACP query creation failed'
        }
      })
      return
    }

    const session: AcpSession = {
      query: q,
      abortController,
      worktreePath,
      busy: true,
      entryCounter: 0,
      currentAssistantEntryId: null,
      currentMessageId: null,
      interrupted: false,
      pendingTextDelta: '',
      pendingThinkingDelta: '',
      flushTimer: null
    }
    this.sessions.set(sessionId, session)

    // Append the user entry immediately for UI feedback.
    const entryId = `${sessionId}-u-${session.entryCounter++}`
    this._appendUserEntry(sessionId, entryId, text, images)
    this.store.dispatch({
      type: 'jsonClaude/busyChanged',
      payload: { sessionId, busy: true }
    })

    this._iterateMessages(sessionId, q).catch((err) => {
      this._emitError(
        sessionId,
        `ACP iteration error: ${err instanceof Error ? err.message : String(err)}`
      )
    })
  }

  private _flushDeltas(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    if (session.pendingTextDelta && session.currentAssistantEntryId) {
      this.store.dispatch({
        type: 'jsonClaude/assistantTextDelta',
        payload: { sessionId, entryId: session.currentAssistantEntryId, textDelta: session.pendingTextDelta }
      })
      session.pendingTextDelta = ''
    }
    if (session.pendingThinkingDelta && session.currentAssistantEntryId) {
      this.store.dispatch({
        type: 'jsonClaude/assistantThinkingDelta',
        payload: { sessionId, entryId: session.currentAssistantEntryId, textDelta: session.pendingThinkingDelta }
      })
      session.pendingThinkingDelta = ''
    }
  }

  private async _iterateMessages(sessionId: string, q: Query): Promise<void> {
    try {
      for await (const msg of q) {
        this._handleSdkMessage(sessionId, msg)
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Normal abort from interrupt/kill.
      } else {
        this._emitError(
          sessionId,
          `ACP stream error: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    } finally {
      const session = this.sessions.get(sessionId)
      if (session) {
        this._flushDeltas(sessionId)

        session.busy = false
        this.store.dispatch({
          type: 'jsonClaude/busyChanged',
          payload: { sessionId, busy: false }
        })

        if (session.interrupted) {
          session.interrupted = false
          this.store.dispatch({
            type: 'jsonClaude/sessionStateChanged',
            payload: { sessionId, state: 'idle' }
          })

          // Try to send any queued messages for interrupted sessions.
          const queue = this.pendingSends.get(sessionId)
          if (queue && queue.length > 0) {
            const pending = queue.shift()!
            if (queue.length === 0) {
              this.pendingSends.delete(sessionId)
            }
            this.store.dispatch({
              type: 'jsonClaude/userEntriesUnqueued',
              payload: { sessionId }
            })
            session.busy = true
            this.store.dispatch({
              type: 'jsonClaude/busyChanged',
              payload: { sessionId, busy: true }
            })
            session.query
              .streamInput(
                (async function* () {
                  yield makeUserMessage(pending.text, pending.images)
                })()
              )
              .catch((err) => {
                this._emitError(sessionId, `Send failed: ${err instanceof Error ? err.message : String(err)}`)
              })
          }
        } else {
          this.store.dispatch({
            type: 'jsonClaude/sessionStateChanged',
            payload: {
              sessionId,
              state: 'exited',
              exitCode: 0,
              exitReason: 'ACP query ended'
            }
          })
          this.sessions.delete(sessionId)
          this.pendingSends.delete(sessionId)
          this.modelOverrides.delete(sessionId)
        }

        this._flushDeltas(sessionId)

        // Finalize any dangling partial entry so the renderer doesn't
        // leave a blinking cursor forever.
        if (session.currentAssistantEntryId) {
          this.store.dispatch({
            type: 'jsonClaude/assistantEntryFinalized',
            payload: { sessionId, entryId: session.currentAssistantEntryId, blocks: [] }
          })
          session.currentAssistantEntryId = null
        }
      }
    }
  }

  private _handleSdkMessage(sessionId: string, msg: SDKMessage): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    switch (msg.type) {
      case 'user': {
        // SDK echoes user messages; we already appended optimistically.
        // Some user messages carry tool results — normalize those.
        const userMsg = msg as any
        if (userMsg.tool_use_result) {
          const tr = userMsg.tool_use_result as any
          this.store.dispatch({
            type: 'jsonClaude/toolResultAttached',
            payload: {
              sessionId,
              toolUseId: tr.tool_use_id ?? '',
              content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content ?? ''),
              isError: tr.is_error ?? false
            }
          })
        }
        break
      }

      case 'assistant': {
        this._handleAssistantMessage(sessionId, msg as any)
        break
      }

      case 'stream_event': {
        this._handleStreamEvent(sessionId, msg as any)
        break
      }

      case 'result': {
        this._handleResult(sessionId, msg as any)
        break
      }

      case 'system': {
        this._handleSystemMessage(sessionId, msg as any)
        break
      }

      case 'tool_progress': {
        // MVP: ignore tool progress; renderer doesn't have a dedicated slot.
        break
      }

      case 'auth_status': {
        const authMsg = msg as any
        if (authMsg.error) {
          this._emitError(sessionId, `Auth error: ${authMsg.error}`, 'auth-failure')
        }
        break
      }

      case 'rate_limit_event': {
        const rl = msg as any
        this._emitRateLimit(sessionId, rl.rate_limit_info)
        break
      }

      default: {
        // Ignore other message types for MVP.
        break
      }
    }
  }

  private _handleAssistantMessage(sessionId: string, msg: any): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const message = msg.message
    if (!message || !message.content) return

    const blocks: JsonClaudeMessageBlock[] = []
    for (const block of message.content) {
      if (block.type === 'text') {
        blocks.push({ type: 'text', text: block.text })
      } else if (block.type === 'thinking') {
        blocks.push({ type: 'thinking', text: block.thinking })
      } else if (block.type === 'tool_use') {
        blocks.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input
        })
      } else if (block.type === 'tool_result') {
        blocks.push({
          type: 'tool_result',
          toolUseId: block.tool_use_id,
          content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
          isError: block.is_error ?? false
        })
      }
    }

    // If we have a partial entry for this message, finalize it in-place
    // instead of appending a duplicate row.
    if (
      session.currentAssistantEntryId &&
      message.id &&
      message.id === session.currentMessageId
    ) {
      this.store.dispatch({
        type: 'jsonClaude/assistantEntryFinalized',
        payload: {
          sessionId,
          entryId: session.currentAssistantEntryId,
          blocks
        }
      })
      session.currentAssistantEntryId = null
      return
    }

    const entryId = `${sessionId}-a-${session.entryCounter++}`

    this.store.dispatch({
      type: 'jsonClaude/entryAppended',
      payload: {
        sessionId,
        entry: {
          entryId,
          kind: 'assistant',
          timestamp: Date.now(),
          blocks,
          apiMessageId: message.id ?? undefined
        }
      }
    })
  }

  private _handleStreamEvent(sessionId: string, msg: any): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const event = msg.event
    if (!event) return

    switch (event.type) {
      case 'message_start': {
        const messageId = event.message?.id
        session.currentMessageId = messageId
        const entryId = `${sessionId}-a-${session.entryCounter++}`
        session.currentAssistantEntryId = entryId
        this.store.dispatch({
          type: 'jsonClaude/entryAppended',
          payload: {
            sessionId,
            entry: {
              entryId,
              kind: 'assistant',
              timestamp: Date.now(),
              blocks: [],
              isPartial: true,
              apiMessageId: messageId
            }
          }
        })
        break
      }

      case 'content_block_start': {
        this._flushDeltas(sessionId)
        const entryId = session.currentAssistantEntryId
        if (!entryId) break
        const block = event.content_block
        if (!block) break

        if (block.type === 'text') {
          this.store.dispatch({
            type: 'jsonClaude/assistantBlockAppended',
            payload: {
              sessionId,
              entryId,
              block: { type: 'text', text: '' }
            }
          })
        } else if (block.type === 'thinking') {
          this.store.dispatch({
            type: 'jsonClaude/assistantBlockAppended',
            payload: {
              sessionId,
              entryId,
              block: { type: 'thinking', text: '' }
            }
          })
        } else if (block.type === 'tool_use') {
          this.store.dispatch({
            type: 'jsonClaude/assistantBlockAppended',
            payload: {
              sessionId,
              entryId,
              block: {
                type: 'tool_use',
                id: block.id,
                name: block.name,
                input: block.input
              }
            }
          })
        }
        break
      }

      case 'content_block_delta': {
        const entryId = session.currentAssistantEntryId
        if (!entryId) break
        const delta = event.delta
        if (!delta) break

        if (delta.type === 'text_delta') {
          session.pendingTextDelta += delta.text
          if (!session.flushTimer) {
            session.flushTimer = setTimeout(() => this._flushDeltas(sessionId), 50)
          }
        } else if (delta.type === 'thinking_delta') {
          session.pendingThinkingDelta += delta.thinking
          if (!session.flushTimer) {
            session.flushTimer = setTimeout(() => this._flushDeltas(sessionId), 50)
          }
        }
        break
      }

      case 'message_stop': {
        // Do not finalize here — the complete assistant message will arrive
        // next and _handleAssistantMessage will finalize the partial entry
        // with the actual blocks. If the assistant message never arrives,
        // the finally block in _iterateMessages will clean up.
        this._flushDeltas(sessionId)
        break
      }

      default:
        break
    }
  }

  private async _handleResult(sessionId: string, msg: any): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.busy = false
    this.store.dispatch({
      type: 'jsonClaude/busyChanged',
      payload: { sessionId, busy: false }
    })

    if (msg.subtype === 'error_during_execution' || msg.is_error) {
      const errors = msg.errors?.join('; ') || 'Unknown error'
      this._emitError(sessionId, `Turn failed: ${errors}`)
    }

    // Send any queued message now that the turn has finished.
    const queue = this.pendingSends.get(sessionId)
    if (queue && queue.length > 0) {
      const pending = queue.shift()!
      if (queue.length === 0) {
        this.pendingSends.delete(sessionId)
      }
      this.store.dispatch({
        type: 'jsonClaude/userEntriesUnqueued',
        payload: { sessionId }
      })
      session.busy = true
      this.store.dispatch({
        type: 'jsonClaude/busyChanged',
        payload: { sessionId, busy: true }
      })
      session.query
        .streamInput(
          (async function* () {
            yield makeUserMessage(pending.text, pending.images)
          })()
        )
        .catch((err) => {
          this._emitError(sessionId, `Send failed: ${err instanceof Error ? err.message : String(err)}`)
        })
    }
  }

  private _handleSystemMessage(sessionId: string, msg: any): void {
    if (msg.subtype === 'init') {
      const slashCommands: string[] = msg.slash_commands ?? []
      if (slashCommands.length > 0) {
        this.store.dispatch({
          type: 'jsonClaude/slashCommandsChanged',
          payload: { sessionId, slashCommands }
        })
      }
    } else if (msg.subtype === 'session_state_changed') {
      const state = msg.state === 'running' ? 'running' : 'idle'
      this.store.dispatch({
        type: 'jsonClaude/sessionStateChanged',
        payload: { sessionId, state }
      })
    }
  }

  private _appendUserEntry(
    sessionId: string,
    entryId: string,
    text: string,
    images?: Array<{ mediaType: string; data: string; path: string }>
  ): void {
    const entry: JsonClaudeChatEntry = {
      entryId,
      kind: 'user',
      text,
      timestamp: Date.now(),
      images: images?.map((img) => ({ path: img.path, mediaType: img.mediaType }))
    }
    this.store.dispatch({
      type: 'jsonClaude/entryAppended',
      payload: { sessionId, entry }
    })
  }

  private _appendQueuedUserEntry(
    sessionId: string,
    entryId: string,
    text: string,
    images?: Array<{ mediaType: string; data: string; path: string }>
  ): void {
    const entry: JsonClaudeChatEntry = {
      entryId,
      kind: 'user',
      text,
      timestamp: Date.now(),
      images: images?.map((img) => ({ path: img.path, mediaType: img.mediaType })),
      isQueued: true
    }
    this.store.dispatch({
      type: 'jsonClaude/entryAppended',
      payload: { sessionId, entry }
    })
  }

  private _emitError(
    sessionId: string,
    message: string,
    errorKind: JsonClaudeChatEntry['errorKind'] = 'subprocess-exit'
  ): void {
    this.store.dispatch({
      type: 'jsonClaude/entryAppended',
      payload: {
        sessionId,
        entry: {
          entryId: `${sessionId}-error-${Date.now()}`,
          kind: 'error',
          timestamp: Date.now(),
          errorKind,
          errorMessage: message
        }
      }
    })
  }

  private _emitRateLimit(sessionId: string, info: any): void {
    const status = info?.status
    if (!status) return
    const isWarning = status === 'allowed_warning'
    const isError = status === 'rejected'
    if (!isWarning && !isError) return

    this.store.dispatch({
      type: 'jsonClaude/entryAppended',
      payload: {
        sessionId,
        entry: {
          entryId: `${sessionId}-ratelimit-${Date.now()}`,
          kind: 'error',
          timestamp: Date.now(),
          errorKind: isError ? 'rate-limit-error' : 'rate-limit-warning',
          errorMessage: `Rate limit ${status}`,
          rateLimitDetail: {
            utilization: info.utilization,
            resetAt: info.resetsAt,
            tier: info.rateLimitType,
            isUsingOverage: info.isUsingOverage
          }
        }
      }
    })
  }
}

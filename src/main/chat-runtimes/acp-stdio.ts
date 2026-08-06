// Generic ACP stdio runtime. Implements the shared ChatRuntime contract for
// any ACP-compatible agent (OpenCode, Codex, ...) by driving a spawned
// subprocess over newline-delimited JSON-RPC via AcpStdioClient. This is the
// stdio transport — distinct from ClaudeAcpRuntime (./claude-acp.ts) which
// uses @anthropic-ai/claude-agent-sdk's query() stream.
//
// Lifecycle mirrors Claude: start() boots slice state; the first send()
// spawns the subprocess, performs `initialize`, then `session/new`, then
// `session/prompt`. ACP transcripts are runtime bootstrap, not Harness-managed
// resume — persistSession-style behavior is intentionally absent.

import type { ChatRuntime } from './types'
import type { Store } from '../store'
import type {
  JsonClaudePermissionMode,
  ChatRuntimeCapabilities,
  JsonClaudeChatEntry,
  JsonClaudeMessageBlock
} from '../../shared/state/json-claude'
import type { AgentKind } from '../../shared/state/terminals'
import {
  AcpStdioClient,
  type AcpStdioClientOptions
} from './acp-stdio-client'

/** Conservative capability set for ACP stdio runtimes. Rewind/permission/
 *  approval are unsupported because the stdio transport exposes no safe
 *  primitive for them; interrupt is always available. canResume starts false
 *  and flips true only if `initialize` reports sessionCapabilities.resume. */
export function defaultAcpStdioCapabilities(): ChatRuntimeCapabilities {
  return {
    canInterrupt: true,
    canRewind: false,
    canSetPermissionMode: false,
    canApproveTools: false,
    canResume: false,
    canOpenAuthLogin: false,
    hasSlashCommands: false,
    hasCostTracking: false
  }
}

export interface AcpStdioRuntimeOptions {
  /** Which agent kind this runtime serves — used for routing + sessionStarted. */
  agentKind: AgentKind
  /** Command + args for the ACP stdio subprocess, e.g. ['opencode', 'acp']. */
  command: string[]
  env?: NodeJS.ProcessEnv
  clientInfo?: { name: string; version: string }
  /** Injectable client factory for tests. Defaults to a real AcpStdioClient. */
  createClient?: (opts: AcpStdioClientOptions) => AcpStdioClient
  /** Delta-flush cadence in ms. Defaults to 50. */
  flushIntervalMs?: number
  /** Finite per-request JSON-RPC timeout in ms for the bootstrap handshake
   *  (initialize / session/new), passed to the client. Defaults to 180000
   *  (3 min); a stuck agent handshake fails instead of hanging forever.
   *  `session/prompt` deliberately has no timeout (0) — turns can run
   *  arbitrarily long and stay recoverable via interrupt/kill. */
  requestTimeoutMs?: number
}

interface QueuedMessage {
  text: string
  entryId: string
  images?: Array<{ mediaType: string; data: string; path: string }>
}

interface AcpRuntimeSession {
  worktreePath: string
  busy: boolean
  /** Bumped on every teardown so stale async continuations can't touch a
   *  dead/reborn session record (see _isCurrent). */
  generation: number
  entryCounter: number
  currentAssistantEntryId: string | null
  currentMessageId: string | null
  currentBlocks: JsonClaudeMessageBlock[]
  pendingTextDelta: string
  pendingThinkingDelta: string
  flushTimer: ReturnType<typeof setTimeout> | null
  interrupted: boolean
  client: AcpStdioClient | null
  clientReady: Promise<void> | null
  acpSessionId: string | null
  pendingSends: QueuedMessage[]
}

export class AcpStdioRuntime implements ChatRuntime {
  private store: Store
  private agentKind: AgentKind
  private command: string[]
  private env?: NodeJS.ProcessEnv
  private clientInfo: { name: string; version: string }
  private createClient: (opts: AcpStdioClientOptions) => AcpStdioClient
  private flushIntervalMs: number
  private requestTimeoutMs: number
  private sessions = new Map<string, AcpRuntimeSession>()
  private startedSessions = new Map<string, string>()

  constructor(store: Store, opts: AcpStdioRuntimeOptions) {
    this.store = store
    this.agentKind = opts.agentKind
    this.command = opts.command
    this.env = opts.env
    this.clientInfo = opts.clientInfo ?? { name: 'harness', version: '1.0.0' }
    this.createClient = opts.createClient ?? ((o) => new AcpStdioClient(o))
    this.flushIntervalMs = opts.flushIntervalMs ?? 50
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 180000
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId) || this.startedSessions.has(sessionId)
  }

  start(
    sessionId: string,
    worktreePath: string,
    _opts?: {
      permissionMode?: JsonClaudePermissionMode
      modelOverride?: string
    }
  ): void {
    this.startedSessions.set(sessionId, worktreePath)
    this.store.dispatch({
      type: 'jsonClaude/sessionStateChanged',
      payload: { sessionId, state: 'idle' }
    })
  }

  send(
    sessionId: string,
    text: string,
    images?: Array<{ mediaType: string; data: string; path: string }>
  ): void {
    let session = this.sessions.get(sessionId)
    if (!session) {
      session = this._createSession(sessionId)
      this.sessions.set(sessionId, session)
    }

    if (session.busy) {
      // Queue for when the current turn completes — never silently dropped.
      const entryId = `${sessionId}-u-${session.entryCounter++}`
      this._appendUserEntry(sessionId, entryId, text, images, { queued: true })
      session.pendingSends.push({
        text,
        entryId,
        images: this._copyImages(images)
      })
      return
    }

    const entryId = `${sessionId}-u-${session.entryCounter++}`
    this._appendUserEntry(sessionId, entryId, text, images)
    this._beginPrompt(sessionId, session, text, images)
  }

  interrupt(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.client && session.acpSessionId) {
      session.interrupted = true
      session.client.notify('session/cancel', {
        sessionId: session.acpSessionId
      })
      return
    }
    if (session.client) {
      // Bootstrap is in flight (client spawned, but initialize / session/new
      // hasn't resolved yet — acpSessionId still null). The protocol has no
      // cancel for initialize, so recover safely by terminating the session:
      // the pending bootstrap request is aborted (the client rejects
      // in-flight requests on kill) and the UI reaches a terminal state
      // instead of interrupt being a silent no-op.
      this.kill(sessionId)
      return
    }
    // No client yet — nothing in flight to cancel.
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      this.startedSessions.delete(sessionId)
      return
    }
    this._teardown(sessionId, session)
    this.store.dispatch({
      type: 'jsonClaude/sessionStateChanged',
      payload: {
        sessionId,
        state: 'exited',
        exitCode: 0,
        exitReason: 'killed'
      }
    })
  }

  killAll(): void {
    for (const sessionId of Array.from(this.sessions.keys())) {
      this.kill(sessionId)
    }
    this.startedSessions.clear()
  }

  rewindTo(_sessionId: string, _fromEntryId: string): { ok: boolean; reason?: string } {
    return { ok: false, reason: 'Rewind is not supported by the ACP stdio runtime' }
  }

  setPermissionMode(_sessionId: string, _mode: JsonClaudePermissionMode): void {
    // Unsupported: capability canSetPermissionMode is false.
  }

  cancelQueued(sessionId: string, entryId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const idx = session.pendingSends.findIndex((q) => q.entryId === entryId)
    if (idx === -1) return
    // Remove from the send queue so it can never reach the agent, and drop
    // the matching queued entry from the transcript.
    session.pendingSends.splice(idx, 1)
    this.store.dispatch({
      type: 'jsonClaude/entryRemoved',
      payload: { sessionId, entryId }
    })
  }

  getCapabilities(_sessionId: string): ChatRuntimeCapabilities {
    return defaultAcpStdioCapabilities()
  }

  // ------------------------------------------------------------------
  // Private — lifecycle
  // ------------------------------------------------------------------

  private _createSession(sessionId: string): AcpRuntimeSession {
    const snapshot = this.store.getSnapshot()
    const sessionState = snapshot.state.jsonClaude.sessions[sessionId]
    const worktreePath = sessionState?.worktreePath ?? this.startedSessions.get(sessionId)
    if (!worktreePath) {
      throw new Error(`Missing worktree path for jsonClaude session ${sessionId}`)
    }
    this.startedSessions.delete(sessionId)
    return {
      worktreePath,
      busy: false,
      generation: 0,
      entryCounter: 0,
      currentAssistantEntryId: null,
      currentMessageId: null,
      currentBlocks: [],
      pendingTextDelta: '',
      pendingThinkingDelta: '',
      flushTimer: null,
      interrupted: false,
      client: null,
      clientReady: null,
      acpSessionId: null,
      pendingSends: []
    }
  }

  /** Session-record identity guard for async continuations. Returns false once
   *  the session has been torn down (kill/exit/protocol-termination) or reborn
   *  under the same id, so stale init/prompt work can't dispatch idle/error or
   *  clobber an already-dispatched exited state. */
  private _isCurrent(sessionId: string, session: AcpRuntimeSession): boolean {
    const current = this.sessions.get(sessionId)
    return current === session && current.generation === session.generation
  }

  private _beginPrompt(
    sessionId: string,
    session: AcpRuntimeSession,
    text: string,
    images?: Array<{ mediaType: string; data: string; path: string }>
  ): void {
    session.busy = true
    this.store.dispatch({
      type: 'jsonClaude/busyChanged',
      payload: { sessionId, busy: true }
    })
    this.store.dispatch({
      type: 'jsonClaude/sessionStateChanged',
      payload: { sessionId, state: 'running' }
    })
    void this._runPrompt(sessionId, session, text, images)
  }

  private async _runPrompt(
    sessionId: string,
    session: AcpRuntimeSession,
    text: string,
    images?: Array<{ mediaType: string; data: string; path: string }>
  ): Promise<void> {
    try {
      await this._ensureClient(sessionId, session)
    } catch (err) {
      // Client bootstrap failed (spawn/initialize). This is not recoverable —
      // surface a terminal error + exited, never a recoverable idle.
      if (!this._isCurrent(sessionId, session)) return
      this._terminateWithError(
        sessionId,
        session,
        `ACP subprocess failed to start: ${err instanceof Error ? err.message : String(err)}`
      )
      return
    }
    if (!this._isCurrent(sessionId, session)) return
    const client = session.client!
    try {
      const result = await client.request<{ stopReason: string }>(
        'session/prompt',
        {
          sessionId: session.acpSessionId,
          prompt: this._buildPromptContent(text, images)
        },
        // session/prompt can run arbitrarily long (agent thinking). It must
        // not carry the bootstrap timeout — 0 = no timeout. A stuck turn
        // stays recoverable via interrupt (session/cancel) or kill.
        0
      )
      if (!this._isCurrent(sessionId, session)) return
      this._handlePromptCompletion(sessionId, session, result?.stopReason)
    } catch (err) {
      if (!this._isCurrent(sessionId, session)) return
      this._emitError(
        sessionId,
        `ACP session/prompt failed: ${err instanceof Error ? err.message : String(err)}`
      )
      this._setIdle(sessionId, session)
    }
  }

  private async _ensureClient(
    sessionId: string,
    session: AcpRuntimeSession
  ): Promise<void> {
    if (session.clientReady) return session.clientReady
    session.clientReady = this._spawnAndInitialize(sessionId, session)
    return session.clientReady
  }

  private async _spawnAndInitialize(
    sessionId: string,
    session: AcpRuntimeSession
  ): Promise<void> {
    const client = this.createClient({
      command: this.command,
      env: this.env,
      clientInfo: this.clientInfo,
      requestTimeoutMs: this.requestTimeoutMs
    })
    session.client = client
    client.onNotification((method, params) =>
      this._handleNotification(sessionId, method, params)
    )
    client.onRequest((method, params) =>
      this._handleClientRequest(sessionId, session, method, params)
    )
    client.onExit((code, signal) =>
      this._handleClientExit(sessionId, session, code, signal)
    )
    client.onError((err) =>
      console.warn(`[acp-stdio] ${sessionId} client error: ${err.message}`)
    )
    client.onMalformedFrame((raw) =>
      console.warn(`[acp-stdio] ${sessionId} malformed frame: ${raw}`)
    )

    const initResult = await client.request<{
      protocolVersion?: number
      agentCapabilities?: { sessionCapabilities?: { resume?: unknown } }
    }>(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false
        },
        clientInfo: this.clientInfo
      },
      // Bootstrap must not hang forever — finite per-request timeout.
      this.requestTimeoutMs
    )
    if (!this._isCurrent(sessionId, session)) return

    // ACP protocol is version 1 only. Any other advertised version is an
    // unsupported peer: terminate without session/new and surface terminal
    // error/exited rather than a recoverable idle.
    if (initResult?.protocolVersion !== 1) {
      this._terminateWithError(
        sessionId,
        session,
        `ACP initialize returned unsupported protocol version: ${initResult?.protocolVersion ?? 'missing'}`,
        'protocol-version'
      )
      return
    }

    // canResume depends on what the agent advertised at initialize.
    if (initResult?.agentCapabilities?.sessionCapabilities?.resume) {
      this.store.dispatch({
        type: 'jsonClaude/capabilitiesChanged',
        payload: { sessionId, capabilities: { ...defaultAcpStdioCapabilities(), canResume: true } }
      })
    }

    const newRes = await client.request<{ sessionId: string }>(
      'session/new',
      { cwd: session.worktreePath, mcpServers: [] },
      // Bootstrap must not hang forever — finite per-request timeout.
      this.requestTimeoutMs
    )
    if (!this._isCurrent(sessionId, session)) return
    // ACP session id is distinct from the Tatsu session/tab id.
    session.acpSessionId = newRes.sessionId
  }

  /** Terminate the connection and surface error/exited (no idle, no further
   *  session/new) for an unrecoverable bootstrap/init failure. Finalizes any
   *  partial assistant entry first. */
  private _terminateWithError(
    sessionId: string,
    session: AcpRuntimeSession,
    message: string,
    errorKind: JsonClaudeChatEntry['errorKind'] = 'subprocess-exit'
  ): void {
    this._finalizeActiveAssistantEntry(sessionId, session)
    session.client?.kill()
    this._emitError(sessionId, message, errorKind)
    session.generation++
    this.sessions.delete(sessionId)
    this.startedSessions.delete(sessionId)
    this.store.dispatch({
      type: 'jsonClaude/busyChanged',
      payload: { sessionId, busy: false }
    })
    this.store.dispatch({
      type: 'jsonClaude/sessionStateChanged',
      payload: {
        sessionId,
        state: 'exited',
        exitCode: 1,
        exitReason: 'exited'
      }
    })
  }

  private _teardown(sessionId: string, session: AcpRuntimeSession): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    this._finalizeActiveAssistantEntry(sessionId, session)
    // Remove from maps before killing so a synchronous/async exit callback
    // from the client is a no-op (see _handleClientExit).
    session.generation++
    this.sessions.delete(sessionId)
    this.startedSessions.delete(sessionId)
    session.client?.kill()
    this.store.dispatch({
      type: 'jsonClaude/busyChanged',
      payload: { sessionId, busy: false }
    })
  }

  private _handleClientExit(
    sessionId: string,
    session: AcpRuntimeSession,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    // Only the *current* session record may react to an exit. The map-lookup
    // alone is not enough: after kill() the id may be restarted under a new
    // record (generation 0), and a stale exit from the killed subprocess must
    // not tear down that replacement. Compare identity + generation.
    if (!this._isCurrent(sessionId, session)) return
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    // Flush pending deltas and finalize the partial assistant entry before the
    // terminal error/exited events so no text is lost.
    this._finalizeActiveAssistantEntry(sessionId, session)
    this._emitError(
      sessionId,
      `ACP subprocess exited unexpectedly (code ${code}, signal ${signal ?? 'none'})`,
      'subprocess-exit'
    )
    session.generation++
    this.sessions.delete(sessionId)
    this.startedSessions.delete(sessionId)
    this.store.dispatch({
      type: 'jsonClaude/busyChanged',
      payload: { sessionId, busy: false }
    })
    this.store.dispatch({
      type: 'jsonClaude/sessionStateChanged',
      payload: {
        sessionId,
        state: 'exited',
        exitCode: code ?? 1,
        exitReason: 'exited'
      }
    })
  }

  // ------------------------------------------------------------------
  // Private — inbound protocol handling
  // ------------------------------------------------------------------

  private _handleNotification(
    sessionId: string,
    method: string,
    params: unknown
  ): void {
    if (method === 'session/update') {
      const p = params as { sessionId?: string; update?: any }
      this._handleSessionUpdate(sessionId, p?.update)
      return
    }
    console.warn(`[acp-stdio] ${sessionId} unknown notification: ${method}`)
  }

  /** Server→client requests. We always answer session/request_permission with
   *  the `cancelled` outcome (approvals unsupported). Unknown methods return
   *  undefined so the client replies -32601 instead of crashing. */
  private _handleClientRequest(
    sessionId: string,
    _session: AcpRuntimeSession,
    method: string,
    params: unknown
  ): { outcome: { outcome: 'cancelled' } } | undefined {
    if (method === 'session/request_permission') {
      const p = params as { sessionId?: string }
      console.warn(
        `[acp-stdio] ${sessionId} agent requested permission (${p?.sessionId ?? 'unknown'}); auto-cancelling`
      )
      return { outcome: { outcome: 'cancelled' } }
    }
    return undefined
  }

  private _handleSessionUpdate(sessionId: string, update: any): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (!update || typeof update !== 'object') return

    const su = update.sessionUpdate
    switch (su) {
      case 'agent_message_chunk':
        this._handleMessageChunk(sessionId, session, update, 'text')
        break
      case 'agent_thought_chunk':
        this._handleMessageChunk(sessionId, session, update, 'thinking')
        break
      case 'user_message_chunk':
        // We already echo user entries optimistically; nothing to render.
        break
      case 'tool_call':
        this._handleToolCall(sessionId, session, update)
        break
      case 'tool_call_update':
        this._handleToolCallUpdate(sessionId, session, update)
        break
      case 'plan':
      case 'available_commands_update':
      case 'current_mode_update':
      case 'config_option_update':
      case 'session_info_update':
      case 'usage_update':
        // Not surfaced by the current jsonClaude slice — tolerate + ignore.
        break
      default:
        console.warn(`[acp-stdio] ${sessionId} unknown session/update variant: ${su}`)
        break
    }
  }

  private _handleMessageChunk(
    sessionId: string,
    session: AcpRuntimeSession,
    update: any,
    kind: 'text' | 'thinking'
  ): void {
    const messageId = update.messageId ?? null
    if (
      session.currentAssistantEntryId &&
      messageId &&
      session.currentMessageId !== messageId
    ) {
      // Changed messageId ⇒ new message: finalize the prior partial row.
      this._finalizeActiveAssistantEntry(sessionId, session)
    }
    if (!session.currentAssistantEntryId) {
      this._openAssistantEntry(sessionId, session, messageId)
    }
    const delta = this._extractText(update.content)
    if (!delta) return
    // If the last block is a different kind, a new segment begins here. Flush
    // the prior segment's pending delta first so it stays in its own block and
    // noncontiguous same-kind chunks are never merged (text→tool→text, etc.).
    const last = session.currentBlocks[session.currentBlocks.length - 1]
    if (last && last.type !== kind) {
      this._flushDeltas(sessionId)
    }
    this._ensureBlock(sessionId, session, kind)
    if (kind === 'text') {
      session.pendingTextDelta += delta
    } else {
      session.pendingThinkingDelta += delta
    }
    this._scheduleFlush(sessionId, session)
  }

  private _handleToolCall(
    sessionId: string,
    session: AcpRuntimeSession,
    update: any
  ): void {
    if (!session.currentAssistantEntryId) {
      this._openAssistantEntry(sessionId, session, null)
    }
    // Close out any pending text/thinking segment before inserting the tool
    // block so it lands as its own block, preserving text→tool→text order.
    this._flushDeltas(sessionId)
    const toolCallId = update.toolCallId ?? `tool_${session.entryCounter}`
    const block: JsonClaudeMessageBlock = {
      type: 'tool_use',
      id: toolCallId,
      name: update.title ?? update.kind ?? 'tool',
      input: update.rawInput ?? {}
    }
    this._appendBlock(sessionId, session, block)
  }

  private _handleToolCallUpdate(
    sessionId: string,
    session: AcpRuntimeSession,
    update: any
  ): void {
    const toolCallId = update.toolCallId
    if (!toolCallId) return
    const status = update.status
    if (status === 'completed' || status === 'failed') {
      const text = this._extractToolContent(update.content)
      this.store.dispatch({
        type: 'jsonClaude/toolResultAttached',
        payload: {
          sessionId,
          toolUseId: toolCallId,
          content: text,
          isError: status === 'failed'
        }
      })
    }
    // in_progress / pending are not rendered by the current slice — skip.
  }

  // ------------------------------------------------------------------
  // Private — entries + batching
  // ------------------------------------------------------------------

  private _openAssistantEntry(
    sessionId: string,
    session: AcpRuntimeSession,
    messageId: string | null
  ): void {
    const entryId = `${sessionId}-a-${session.entryCounter++}`
    session.currentAssistantEntryId = entryId
    session.currentMessageId = messageId
    session.currentBlocks = []
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
          apiMessageId: messageId ?? undefined
        }
      }
    })
  }

  private _appendBlock(
    sessionId: string,
    session: AcpRuntimeSession,
    block: JsonClaudeMessageBlock
  ): void {
    const entryId = session.currentAssistantEntryId
    if (!entryId) return
    session.currentBlocks.push(block)
    this.store.dispatch({
      type: 'jsonClaude/assistantBlockAppended',
      payload: { sessionId, entryId, block }
    })
  }

  private _ensureBlock(
    sessionId: string,
    session: AcpRuntimeSession,
    type: 'text' | 'thinking'
  ): void {
    // Only merge into the most recent block when it is the same kind —
    // contiguous chunks share a block; a same-kind chunk after an intervening
    // tool/other-kind block opens a new block (order preservation).
    const last = session.currentBlocks[session.currentBlocks.length - 1]
    if (last && last.type === type) return
    this._appendBlock(sessionId, session, { type, text: '' })
  }

  private _scheduleFlush(
    sessionId: string,
    session: AcpRuntimeSession
  ): void {
    if (session.flushTimer) return
    session.flushTimer = setTimeout(() => {
      session.flushTimer = null
      this._flushDeltas(sessionId)
    }, this.flushIntervalMs)
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
        payload: {
          sessionId,
          entryId: session.currentAssistantEntryId,
          textDelta: session.pendingTextDelta
        }
      })
      this._applyDeltaToBlock(session, 'text', session.pendingTextDelta)
      session.pendingTextDelta = ''
    }
    if (session.pendingThinkingDelta && session.currentAssistantEntryId) {
      this.store.dispatch({
        type: 'jsonClaude/assistantThinkingDelta',
        payload: {
          sessionId,
          entryId: session.currentAssistantEntryId,
          textDelta: session.pendingThinkingDelta
        }
      })
      this._applyDeltaToBlock(session, 'thinking', session.pendingThinkingDelta)
      session.pendingThinkingDelta = ''
    }
  }

  private _applyDeltaToBlock(
    session: AcpRuntimeSession,
    type: 'text' | 'thinking',
    delta: string
  ): void {
    for (let i = session.currentBlocks.length - 1; i >= 0; i--) {
      const b = session.currentBlocks[i]
      if (b.type === type) {
        session.currentBlocks[i] = {
          ...b,
          text: (b.text ?? '') + delta
        }
        return
      }
    }
  }

  private _finalizeActiveAssistantEntry(
    sessionId: string,
    session: AcpRuntimeSession
  ): void {
    this._flushDeltas(sessionId)
    const entryId = session.currentAssistantEntryId
    if (!entryId) return
    this.store.dispatch({
      type: 'jsonClaude/assistantEntryFinalized',
      payload: { sessionId, entryId, blocks: session.currentBlocks }
    })
    session.currentAssistantEntryId = null
    session.currentMessageId = null
    session.currentBlocks = []
  }

  private _handlePromptCompletion(
    sessionId: string,
    session: AcpRuntimeSession,
    stopReason: string | undefined
  ): void {
    this._finalizeActiveAssistantEntry(sessionId, session)

    if (session.interrupted || stopReason === 'cancelled') {
      session.interrupted = false
      // Cancel the current turn, but never silently drop queued messages —
      // resume the next one (Claude runtime behaves the same way). Only the
      // dispatched queued entry is promoted; later queued entries stay queued.
      const next = session.pendingSends.shift()
      if (next) {
        this.store.dispatch({
          type: 'jsonClaude/userEntryUnqueued',
          payload: { sessionId, entryId: next.entryId }
        })
        this.store.dispatch({
          type: 'jsonClaude/sessionStateChanged',
          payload: { sessionId, state: 'running' }
        })
        void this._runPrompt(sessionId, session, next.text, next.images)
        return
      }
      this._setIdle(sessionId, session)
      return
    }

    const next = session.pendingSends.shift()
    if (next) {
      this.store.dispatch({
        type: 'jsonClaude/userEntryUnqueued',
        payload: { sessionId, entryId: next.entryId }
      })
      void this._runPrompt(sessionId, session, next.text, next.images)
      return
    }

    this._setIdle(sessionId, session)
  }

  private _setIdle(sessionId: string, session: AcpRuntimeSession): void {
    session.busy = false
    this.store.dispatch({
      type: 'jsonClaude/busyChanged',
      payload: { sessionId, busy: false }
    })
    this.store.dispatch({
      type: 'jsonClaude/sessionStateChanged',
      payload: { sessionId, state: 'idle' }
    })
  }

  // ------------------------------------------------------------------
  // Private — content helpers
  // ------------------------------------------------------------------

  private _buildPromptContent(
    text: string,
    images?: Array<{ mediaType: string; data: string; path: string }>
  ): Array<Record<string, unknown>> {
    const content: Array<Record<string, unknown>> = []
    for (const img of images ?? []) {
      content.push({
        type: 'image',
        mimeType: img.mediaType,
        data: img.data,
        uri: img.path
      })
    }
    content.push({ type: 'text', text })
    return content
  }

  private _extractText(content: any): string {
    if (!content || typeof content !== 'object') return ''
    if (typeof content.text === 'string') return content.text
    // Nested content wrapper (e.g. ToolCallContent { type:'content', content }).
    if (content.content && typeof content.content === 'object') {
      return this._extractText(content.content)
    }
    return ''
  }

  private _extractToolContent(content: any): string {
    if (!Array.isArray(content)) return ''
    const parts: string[] = []
    for (const item of content) {
      const t = this._extractText(item)
      if (t) parts.push(t)
    }
    return parts.join('\n')
  }

  private _appendUserEntry(
    sessionId: string,
    entryId: string,
    text: string,
    images?: Array<{ mediaType: string; data: string; path: string }>,
    opts?: { queued?: boolean }
  ): void {
    const entry: JsonClaudeChatEntry = {
      entryId,
      kind: 'user',
      text,
      timestamp: Date.now(),
      images: images?.map((img) => ({ path: img.path, mediaType: img.mediaType })),
      ...(opts?.queued ? { isQueued: true } : {})
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

  private _copyImages(
    images?: Array<{ mediaType: string; data: string; path: string }>
  ): Array<{ mediaType: string; data: string; path: string }> | undefined {
    return images?.map((img) => ({
      mediaType: img.mediaType,
      data: img.data,
      path: img.path
    }))
  }
}

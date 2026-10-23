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

import type { ApprovalDecision, ChatRuntime } from './types'
import type { Store } from '../store'
import type {
  JsonClaudePermissionMode,
  ChatRuntimeCapabilities,
  JsonClaudeAuthMethod,
  JsonClaudeChatEntry,
  JsonClaudeMessageBlock
} from '../../shared/state/json-claude'
import type { AgentKind } from '../../shared/state/terminals'
import { RuntimeMissingError } from './runtime-path-resolver'
import { ACP_AUTH_REQUIRED, AcpRequestError } from './acp-stdio-client'
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
    canApproveTools: true,
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
  command?: string[]
  env?: NodeJS.ProcessEnv
  /** Resolves command + env at spawn time instead of construction, so a
   *  runtime downloaded after boot is picked up and a missing one surfaces
   *  as a `runtime-missing` card on the session rather than a boot crash. */
  launch?: () => { command: string[]; env?: NodeJS.ProcessEnv }
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
  /** Open `session/request_permission` requests awaiting the user. */
  pendingPermissions: Map<string, PendingPermission>
  permissionCounter: number
  /** Spawn + `initialize`, cached separately from `clientReady` (which also
   *  covers `session/new`) so a login can run on an initialized client
   *  before any ACP session exists. */
  initReady: Promise<void> | null
  authMethods: JsonClaudeAuthMethod[]
  /** `agentCapabilities.loadSession` from `initialize`. */
  canLoadSession: boolean
  capabilities: ChatRuntimeCapabilities
  /** From the `session/new` / `session/load` response. `modes` is the
   *  agent's permission-mode list (Codex: read-only / agent /
   *  agent-full-access; OpenCode: none); `configOptions` carries the
   *  `model` select when the agent exposes one. */
  modes: Array<{ id: string; name: string }> | null
  configOptions: Array<{ id: string; currentValue?: unknown }> | null
  /** Set while `session/load` replays history as session/update
   *  notifications. `silent` drops the replay when the slice already holds
   *  the entries (same app run); otherwise user chunks are collected into
   *  user entries and agent chunks flow through the normal batching. */
  replay: { silent: boolean; userText: string } | null
  /** The prompt that failed with "authentication required"; retried once
   *  `authenticate` succeeds (or the user retries after a terminal login). */
  authPending: { text: string; images?: Array<{ mediaType: string; data: string; path: string }> } | null
}

interface PermissionOption {
  optionId: string
  kind?: string
}

type PermissionOutcome =
  | { outcome: { outcome: 'selected'; optionId: string } }
  | { outcome: { outcome: 'cancelled' } }

interface PendingPermission {
  toolName: string
  options: PermissionOption[]
  resolve: (outcome: PermissionOutcome) => void
}

const CANCELLED: PermissionOutcome = { outcome: { outcome: 'cancelled' } }

/** Tatsu permission mode → the agent's mode id, when it offers one. Codex
 *  advertises read-only / agent / agent-full-access; `plan` is read-only
 *  and both other Tatsu modes are the agent's normal mode (full access is
 *  never selected from Tatsu). */
export function acpModeFor(
  mode: JsonClaudePermissionMode,
  modes: Array<{ id: string; name: string }>
): string | undefined {
  const ids = new Set(modes.map((m) => m.id))
  const wanted = mode === 'plan' ? ['read-only', 'plan'] : ['agent', 'default', 'auto']
  return wanted.find((id) => ids.has(id))
}

export function parseModes(raw: unknown): Array<{ id: string; name: string }> | null {
  const list = (raw as { availableModes?: unknown } | null)?.availableModes
  if (!Array.isArray(list)) return null
  return list
    .filter((m): m is { id: string; name?: string } => !!m && typeof m.id === 'string')
    .map((m) => ({ id: m.id, name: typeof m.name === 'string' ? m.name : m.id }))
}

export function parseConfigOptions(raw: unknown): Array<{ id: string; currentValue?: unknown }> | null {
  if (!Array.isArray(raw)) return null
  return raw
    .filter((o): o is { id: string; currentValue?: unknown } => !!o && typeof o.id === 'string')
    .map((o) => ({ id: o.id, currentValue: o.currentValue }))
}

/** ACP `authMethods` → slice shape. OpenCode's only method says "run
 *  `opencode auth login` in the terminal" without a `type`, so a method
 *  whose description names a terminal is treated as terminal-type too. */
export function parseAuthMethods(raw: unknown): JsonClaudeAuthMethod[] {
  if (!Array.isArray(raw)) return []
  const out: JsonClaudeAuthMethod[] = []
  for (const m of raw) {
    if (!m || typeof m.id !== 'string') continue
    const description = typeof m.description === 'string' ? m.description : undefined
    const terminal = m.type === 'terminal' || /\bterminal\b/i.test(description ?? '')
    out.push({
      id: m.id,
      name: typeof m.name === 'string' && m.name ? m.name : m.id,
      ...(description ? { description } : {}),
      type: terminal ? 'terminal' : 'agent'
    })
  }
  return out
}

/** First option whose ACP kind matches, in preference order. */
function pickOption(options: PermissionOption[], kinds: string[]): string | undefined {
  for (const kind of kinds) {
    const hit = options.find((o) => o.kind === kind)
    if (hit) return hit.optionId
  }
  return undefined
}

export class AcpStdioRuntime implements ChatRuntime {
  private store: Store
  private agentKind: AgentKind
  private command: string[]
  private env?: NodeJS.ProcessEnv
  private launch: () => { command: string[]; env?: NodeJS.ProcessEnv }
  private clientInfo: { name: string; version: string }
  private createClient: (opts: AcpStdioClientOptions) => AcpStdioClient
  private flushIntervalMs: number
  private requestTimeoutMs: number
  private sessions = new Map<string, AcpRuntimeSession>()
  private startedSessions = new Map<string, string>()
  private modelOverrides = new Map<string, string>()

  constructor(store: Store, opts: AcpStdioRuntimeOptions) {
    this.store = store
    this.agentKind = opts.agentKind
    if (!opts.command && !opts.launch) {
      throw new Error('AcpStdioRuntime needs either command or launch')
    }
    this.command = opts.command ?? []
    this.env = opts.env
    this.launch = opts.launch ?? (() => ({ command: this.command, env: this.env }))
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
    opts?: {
      permissionMode?: JsonClaudePermissionMode
      modelOverride?: string
      agentSessionId?: string
    }
  ): void {
    this.startedSessions.set(sessionId, worktreePath)
    if (opts?.modelOverride) this.modelOverrides.set(sessionId, opts.modelOverride)
    else this.modelOverrides.delete(sessionId)
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
    // A first prompt on a session the agent may `session/load` keeps its
    // user entry back until bootstrap finishes, so the replayed history
    // lands above it instead of after it.
    const willLoad =
      !session.client && !!this.store.getSnapshot().state.jsonClaude.sessions[sessionId]?.agentSessionId
    if (willLoad) {
      this._beginPrompt(sessionId, session, text, images, { entryId })
      return
    }
    this._appendUserEntry(sessionId, entryId, text, images)
    this._beginPrompt(sessionId, session, text, images)
  }

  interrupt(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.client && session.acpSessionId) {
      session.interrupted = true
      this._cancelPendingPermissions(session)
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

  setPermissionMode(sessionId: string, mode: JsonClaudePermissionMode): void {
    const session = this.sessions.get(sessionId)
    if (!session?.client || !session.acpSessionId || !session.modes) return
    const modeId = acpModeFor(mode, session.modes)
    if (!modeId) return
    void session.client
      .request('session/set_mode', { sessionId: session.acpSessionId, modeId }, this.requestTimeoutMs)
      .catch((err) =>
        console.warn(`[acp-stdio] ${sessionId} session/set_mode failed: ${err instanceof Error ? err.message : String(err)}`)
      )
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

  getCapabilities(sessionId: string): ChatRuntimeCapabilities {
    return this.sessions.get(sessionId)?.capabilities ?? defaultAcpStdioCapabilities()
  }

  private _updateCapabilities(
    sessionId: string,
    session: AcpRuntimeSession,
    patch: Partial<ChatRuntimeCapabilities>
  ): void {
    const next = { ...session.capabilities, ...patch }
    if (Object.keys(patch).every((k) => session.capabilities[k as keyof ChatRuntimeCapabilities] === next[k as keyof ChatRuntimeCapabilities])) {
      return
    }
    session.capabilities = next
    this.store.dispatch({ type: 'jsonClaude/capabilitiesChanged', payload: { sessionId, capabilities: next } })
  }

  /** After `session/new` / `session/load`: remember the agent's modes and
   *  config options, then push Tatsu's permission mode and the tab's model
   *  pin to the agent. Failures are logged, never fatal — the session works
   *  with the agent's defaults. */
  private _applySessionSettings(
    sessionId: string,
    session: AcpRuntimeSession,
    result: { modes?: unknown; configOptions?: unknown } | undefined
  ): void {
    session.modes = parseModes(result?.modes)
    session.configOptions = parseConfigOptions(result?.configOptions)
    this._updateCapabilities(sessionId, session, {
      canSetPermissionMode: session.modes !== null && session.modes.length > 0
    })
    const permissionMode =
      this.store.getSnapshot().state.jsonClaude.sessions[sessionId]?.permissionMode ?? 'default'
    this.setPermissionMode(sessionId, permissionMode)
    const model = this.modelOverrides.get(sessionId)
    const modelOption = session.configOptions?.find((o) => o.id === 'model')
    if (model && modelOption && modelOption.currentValue !== model && session.client && session.acpSessionId) {
      void session.client
        .request(
          'session/set_config_option',
          { sessionId: session.acpSessionId, configOptionId: 'model', value: model },
          this.requestTimeoutMs
        )
        .catch((err) =>
          console.warn(`[acp-stdio] ${sessionId} set model failed: ${err instanceof Error ? err.message : String(err)}`)
        )
    }
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
      pendingSends: [],
      pendingPermissions: new Map(),
      permissionCounter: 0,
      initReady: null,
      authMethods: [],
      authPending: null,
      canLoadSession: false,
      capabilities: defaultAcpStdioCapabilities(),
      modes: null,
      configOptions: null,
      replay: null
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
    images?: Array<{ mediaType: string; data: string; path: string }>,
    deferredUserEntry?: { entryId: string }
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
    void this._runPrompt(sessionId, session, text, images, deferredUserEntry)
  }

  private async _runPrompt(
    sessionId: string,
    session: AcpRuntimeSession,
    text: string,
    images?: Array<{ mediaType: string; data: string; path: string }>,
    deferredUserEntry?: { entryId: string }
  ): Promise<void> {
    const appendDeferred = (): void => {
      if (!deferredUserEntry) return
      this._appendUserEntry(sessionId, deferredUserEntry.entryId, text, images)
      deferredUserEntry = undefined
    }
    try {
      await this._ensureClient(sessionId, session)
      if (this._isCurrent(sessionId, session)) appendDeferred()
    } catch (err) {
      // Client bootstrap failed (spawn/initialize). This is not recoverable —
      // surface a terminal error + exited, never a recoverable idle.
      if (!this._isCurrent(sessionId, session)) return
      appendDeferred()
      if (err instanceof RuntimeMissingError) {
        this._terminateWithError(sessionId, session, err.message, 'runtime-missing')
        return
      }
      if (this._isAuthRequired(err)) {
        this._handleAuthRequired(sessionId, session, err, { text, images })
        return
      }
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
      if (this._isAuthRequired(err)) {
        this._handleAuthRequired(sessionId, session, err, { text, images })
        return
      }
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
    await this._ensureInitialized(sessionId, session)
    if (!this._isCurrent(sessionId, session) || !session.client) return
    const client = session.client
    const slice = this.store.getSnapshot().state.jsonClaude.sessions[sessionId]
    const previous = slice?.agentSessionId
    if (previous && session.canLoadSession) {
      session.replay = { silent: (slice?.entries.length ?? 0) > 0, userText: '' }
      try {
        const loaded = await client.request<{ modes?: unknown; configOptions?: unknown }>(
          'session/load',
          { sessionId: previous, cwd: session.worktreePath, mcpServers: [] },
          this.requestTimeoutMs
        )
        if (!this._isCurrent(sessionId, session)) return
        this._finishReplay(sessionId, session)
        session.acpSessionId = previous
        this._applySessionSettings(sessionId, session, loaded)
        return
      } catch (err) {
        if (!this._isCurrent(sessionId, session)) return
        this._finishReplay(sessionId, session)
        if (this._isAuthRequired(err)) throw err
        this.store.dispatch({
          type: 'jsonClaude/entryAppended',
          payload: {
            sessionId,
            entry: {
              entryId: `${sessionId}-sys-${Date.now()}`,
              kind: 'system',
              timestamp: Date.now(),
              errorKind: 'session-load-failed',
              errorMessage: `Could not continue the previous ${this.agentKind} session (${err instanceof Error ? err.message : String(err)}); started a new one.`
            }
          }
        })
      }
    }
    const newRes = await client.request<{ sessionId: string; modes?: unknown; configOptions?: unknown }>(
      'session/new',
      { cwd: session.worktreePath, mcpServers: [] },
      // Bootstrap must not hang forever — finite per-request timeout.
      this.requestTimeoutMs
    )
    if (!this._isCurrent(sessionId, session)) return
    // ACP session id is distinct from the Tatsu session/tab id.
    session.acpSessionId = newRes.sessionId
    this.store.dispatch({
      type: 'jsonClaude/agentSessionIdChanged',
      payload: { sessionId, agentSessionId: newRes.sessionId }
    })
    this._applySessionSettings(sessionId, session, newRes)
  }

  private _flushReplayUser(sessionId: string, session: AcpRuntimeSession): void {
    const text = session.replay?.userText
    if (!text) return
    session.replay!.userText = ''
    this._flushDeltas(sessionId)
    this._finalizeActiveAssistantEntry(sessionId, session)
    this._appendUserEntry(sessionId, `${sessionId}-u-${session.entryCounter++}`, text)
  }

  private _finishReplay(sessionId: string, session: AcpRuntimeSession): void {
    if (!session.replay) return
    this._flushReplayUser(sessionId, session)
    this._flushDeltas(sessionId)
    this._finalizeActiveAssistantEntry(sessionId, session)
    session.replay = null
  }

  private _ensureInitialized(sessionId: string, session: AcpRuntimeSession): Promise<void> {
    if (session.initReady) return session.initReady
    session.initReady = this._spawnClient(sessionId, session).catch((err) => {
      session.initReady = null
      throw err
    })
    return session.initReady
  }

  private async _spawnClient(sessionId: string, session: AcpRuntimeSession): Promise<void> {
    const launch = this.launch()
    const client = this.createClient({
      command: launch.command,
      env: launch.env,
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
      agentCapabilities?: { loadSession?: unknown; sessionCapabilities?: { resume?: unknown } }
      authMethods?: unknown
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

    session.authMethods = parseAuthMethods(initResult?.authMethods)
    session.canLoadSession = initResult?.agentCapabilities?.loadSession === true
    // canResume / canOpenAuthLogin depend on what the agent advertised.
    const canResume = !!initResult?.agentCapabilities?.sessionCapabilities?.resume
    const canOpenAuthLogin = session.authMethods.some((m) => m.type === 'terminal')
    this._updateCapabilities(sessionId, session, { canResume, canOpenAuthLogin })
  }

  /** Drop the subprocess without ending the Tatsu session, so the next
   *  prompt (or `authenticate`) spawns a fresh one with the current launch
   *  env. The exit handler is detached first: this exit is deliberate. */
  private _dropClient(session: AcpRuntimeSession): void {
    this._cancelPendingPermissions(session)
    session.client?.onExit(() => {})
    session.client?.kill()
    session.client = null
    session.clientReady = null
    session.initReady = null
    session.acpSessionId = null
  }

  /** ACP reserves -32000 for "authentication required", but agents also
   *  surface credential problems as generic -32603 errors (OpenCode: "This
   *  API key has expired…"), so the message is checked too. */
  private _isAuthRequired(err: unknown): boolean {
    if (!(err instanceof AcpRequestError)) return false
    if (err.code === ACP_AUTH_REQUIRED) return true
    return /\b(api key|unauthori[sz]ed|not (logged|signed) in|authenticat\w*|please (log|sign) in)\b/i.test(
      err.message
    )
  }

  /** "Authentication required" from `session/new` or `session/prompt`:
   *  keep the subprocess (an in-process login needs it), park the prompt,
   *  and show the auth card with the agent's login methods. */
  private _handleAuthRequired(
    sessionId: string,
    session: AcpRuntimeSession,
    err: unknown,
    pending: AcpRuntimeSession['authPending']
  ): void {
    // An auth error from `initialize` itself leaves a half-started client
    // behind; drop it so the next attempt (or login) spawns cleanly.
    if (!session.initReady) this._dropClient(session)
    session.clientReady = null
    session.acpSessionId = null
    session.authPending = pending
    const detail = err instanceof Error ? err.message : String(err)
    this.store.dispatch({
      type: 'jsonClaude/entryAppended',
      payload: {
        sessionId,
        entry: {
          entryId: `${sessionId}-error-${Date.now()}`,
          kind: 'error',
          timestamp: Date.now(),
          errorKind: 'auth-failure',
          errorMessage: `${this.agentKind} needs a login before it can run: ${detail}`,
          authMethods: session.authMethods
        }
      }
    })
    this._setIdle(sessionId, session)
  }

  async authenticate(sessionId: string, methodId: string): Promise<{ ok: boolean; error?: string }> {
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false, error: 'session is not running' }
    const method = session.authMethods.find((m) => m.id === methodId)
    if (!method) return { ok: false, error: `unknown login method ${methodId}` }
    if (method.type === 'terminal') {
      return { ok: false, error: `${method.name} must be completed in a terminal tab` }
    }
    try {
      // Env-based methods (Codex api-key) read the key at spawn, so the
      // subprocess must restart with the launch env main just updated.
      if (method.id === 'api-key') this._dropClient(session)
      await this._ensureInitialized(sessionId, session)
      if (!this._isCurrent(sessionId, session) || !session.client) {
        return { ok: false, error: 'session ended' }
      }
      // Browser flows wait on the user; no timeout.
      await session.client.request('authenticate', { methodId }, 0)
      if (!this._isCurrent(sessionId, session)) return { ok: false, error: 'session ended' }
      session.clientReady = null
      const pending = session.authPending
      session.authPending = null
      if (pending && !session.busy) this._beginPrompt(sessionId, session, pending.text, pending.images)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
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
    this._cancelPendingPermissions(session)
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
    this._cancelPendingPermissions(session)
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
    this._cancelPendingPermissions(session)
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

  /** Server→client requests. `session/request_permission` becomes a pending
   *  approval in the slice and resolves when the renderer answers (or the
   *  turn is interrupted / the session torn down → `cancelled`). Unknown
   *  methods return undefined so the client replies -32601. */
  private _handleClientRequest(
    sessionId: string,
    session: AcpRuntimeSession,
    method: string,
    params: unknown
  ): Promise<PermissionOutcome> | undefined {
    if (method === 'session/request_permission') {
      return this._handlePermissionRequest(sessionId, session, params)
    }
    return undefined
  }

  private _handlePermissionRequest(
    sessionId: string,
    session: AcpRuntimeSession,
    params: unknown
  ): Promise<PermissionOutcome> {
    const p = params as {
      toolCall?: { toolCallId?: unknown; title?: unknown; kind?: unknown; rawInput?: unknown }
      options?: unknown
    }
    const options: PermissionOption[] = Array.isArray(p?.options)
      ? p.options
          .filter((o): o is PermissionOption => !!o && typeof o.optionId === 'string')
          .map((o) => ({ optionId: o.optionId, kind: typeof o.kind === 'string' ? o.kind : undefined }))
      : []
    const toolCall = p?.toolCall ?? {}
    // ACP `kind` is the stable category (execute, edit, read, …); `title`
    // describes this one call ("Run `ls -la`"). Session grants key on the
    // tool name, so the name is the kind and the title rides in the input
    // where the card shows it.
    const toolName = typeof toolCall.kind === 'string' && toolCall.kind ? toolCall.kind : 'tool'
    const rawInput =
      toolCall.rawInput && typeof toolCall.rawInput === 'object'
        ? (toolCall.rawInput as Record<string, unknown>)
        : {}
    const input =
      typeof toolCall.title === 'string' && toolCall.title && !('title' in rawInput)
        ? { title: toolCall.title, ...rawInput }
        : rawInput
    const toolUseId = typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : undefined

    // "Allow this session" grants are recorded by tool name in the slice;
    // honor them here so the agent is not blocked on a card the user
    // already answered for this tool.
    const permissionMode =
      this.store.getSnapshot().state.jsonClaude.sessions[sessionId]?.permissionMode ?? 'default'
    const granted =
      this._sessionToolApprovals(sessionId).includes(toolName) ||
      (permissionMode === 'acceptEdits' && toolName === 'edit')
    if (granted) {
      const optionId = pickOption(options, ['allow_always', 'allow_once'])
      if (optionId) return Promise.resolve({ outcome: { outcome: 'selected', optionId } })
    }

    const requestId = `${sessionId}-perm-${++session.permissionCounter}`
    return new Promise((resolve) => {
      session.pendingPermissions.set(requestId, { toolName, options, resolve })
      this.store.dispatch({
        type: 'jsonClaude/approvalRequested',
        payload: { requestId, sessionId, toolName, input, toolUseId, timestamp: Date.now() }
      })
    })
  }

  private _sessionToolApprovals(sessionId: string): string[] {
    return this.store.getSnapshot().state.jsonClaude.sessions[sessionId]?.sessionToolApprovals ?? []
  }

  resolveApproval(requestId: string, decision: ApprovalDecision): boolean {
    for (const [sessionId, session] of this.sessions) {
      const pending = session.pendingPermissions.get(requestId)
      if (!pending) continue
      session.pendingPermissions.delete(requestId)
      const kinds =
        decision.behavior === 'allow'
          ? this._sessionToolApprovals(sessionId).includes(pending.toolName)
            ? ['allow_always', 'allow_once']
            : ['allow_once', 'allow_always']
          : ['reject_once', 'reject_always']
      const optionId = pickOption(pending.options, kinds)
      pending.resolve(optionId ? { outcome: { outcome: 'selected', optionId } } : CANCELLED)
      this.store.dispatch({ type: 'jsonClaude/approvalResolved', payload: { requestId } })
      if (decision.behavior === 'deny' && decision.interrupt) this.interrupt(sessionId)
      return true
    }
    return false
  }

  /** Answer every open permission request with `cancelled` — the protocol's
   *  required reply once the turn is cancelled or the session goes away. */
  private _cancelPendingPermissions(session: AcpRuntimeSession): void {
    for (const [requestId, pending] of session.pendingPermissions) {
      pending.resolve(CANCELLED)
      this.store.dispatch({ type: 'jsonClaude/approvalResolved', payload: { requestId } })
    }
    session.pendingPermissions.clear()
  }

  private _handleSessionUpdate(sessionId: string, update: any): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (!update || typeof update !== 'object') return

    const su = update.sessionUpdate
    // A silent replay (slice already holds the transcript) drops the
    // history but still takes the agent's command/mode/config updates.
    if (session.replay?.silent) {
      if (su === 'available_commands_update') this._handleAvailableCommands(sessionId, session, update)
      return
    }
    if (session.replay && su === 'user_message_chunk') {
      if (session.replay.userText) {
        session.replay.userText += this._extractText(update.content)
      } else {
        this._flushDeltas(sessionId)
        this._finalizeActiveAssistantEntry(sessionId, session)
        session.replay.userText = this._extractText(update.content)
      }
      return
    }
    if (session.replay) this._flushReplayUser(sessionId, session)
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
        this._handlePlan(sessionId, session, update)
        break
      case 'available_commands_update':
        this._handleAvailableCommands(sessionId, session, update)
        break
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

  /** ACP slash commands arrive as `{ availableCommands: [{ name, … }] }`;
   *  the renderer sends one back as `/name args` prompt text. */
  private _handleAvailableCommands(
    sessionId: string,
    session: AcpRuntimeSession,
    update: any
  ): void {
    const names: string[] = Array.isArray(update.availableCommands)
      ? update.availableCommands
          .map((c: any) => (c && typeof c.name === 'string' ? c.name : null))
          .filter((n: string | null): n is string => !!n)
      : []
    this.store.dispatch({
      type: 'jsonClaude/slashCommandsChanged',
      payload: { sessionId, slashCommands: names }
    })
    this._updateCapabilities(sessionId, session, { hasSlashCommands: names.length > 0 })
  }

  /** ACP `plan` updates carry the same shape as Claude's TodoWrite input,
   *  so they ride the existing TodoWrite card: a synthetic tool_use block
   *  plus an immediate empty result so the card renders as settled. */
  private _handlePlan(sessionId: string, session: AcpRuntimeSession, update: any): void {
    if (!Array.isArray(update.entries)) return
    const todos = update.entries
      .filter((e: any) => e && typeof e.content === 'string')
      .map((e: any) => ({
        content: e.content,
        status:
          e.status === 'in_progress' || e.status === 'completed' ? e.status : 'pending',
        ...(typeof e.priority === 'string' ? { priority: e.priority } : {})
      }))
    if (!session.currentAssistantEntryId) {
      this._openAssistantEntry(sessionId, session, null)
    }
    this._flushDeltas(sessionId)
    const id = `plan_${session.entryCounter++}`
    this._appendBlock(sessionId, session, {
      type: 'tool_use',
      id,
      name: 'TodoWrite',
      input: { todos }
    })
    this.store.dispatch({
      type: 'jsonClaude/toolResultAttached',
      payload: { sessionId, toolUseId: id, content: '', isError: false }
    })
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

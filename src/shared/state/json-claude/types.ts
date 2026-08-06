export type JsonClaudeSessionState =
  | 'idle'
  | 'connecting'
  | 'running'
  | 'exited'
  | 'auth-required'

/** Identifies the concrete runtime backend that owns a chat session.
 *  Mirrors the supported agent kinds — the registry keys its runtimes on
 *  this. Widened from the original Claude-only `'acp'` id so OpenCode and
 *  Codex can route once their runtimes land. */
export type ChatRuntimeId = 'claude' | 'opencode' | 'codex'

export interface ChatRuntimeCapabilities {
  canInterrupt: boolean
  canRewind: boolean
  canSetPermissionMode: boolean
  canApproveTools: boolean
  canResume: boolean
  canOpenAuthLogin: boolean
  hasSlashCommands: boolean
  hasCostTracking: boolean
}

/** Mirrors `claude --permission-mode` choices. Subset relevant to a
 *  json-claude tab: we don't expose bypassPermissions (unsafe) or
 *  dontAsk/auto (overlap with default). */
export type JsonClaudePermissionMode = 'default' | 'acceptEdits' | 'plan'

export interface JsonClaudeMessageBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result'
  // For 'text' and 'thinking': markdown content. The wire-format
  // `thinking` field on extended-thinking blocks maps onto this same
  // field so the delta-append code stays uniform.
  text?: string
  // For 'tool_use': content block fields.
  id?: string
  name?: string
  input?: Record<string, unknown>
  // For 'tool_result': correlation + rendered body.
  toolUseId?: string
  content?: string
  isError?: boolean
}

export interface JsonClaudeChatEntry {
  /** Monotonic per-session id so React can key rows stably. */
  entryId: string
  kind: 'user' | 'assistant' | 'system' | 'error' | 'tool_result' | 'compact'
  blocks?: JsonClaudeMessageBlock[]
  text?: string
  timestamp: number
  /** For kind === 'compact'. Whether the user invoked /compact ('manual')
   *  or claude autocompacted near the context limit ('auto'). Sourced
   *  from the system/compact_boundary record's compactMetadata.trigger. */
  compactTrigger?: 'auto' | 'manual'
  /** For kind === 'compact'. Token count just before compaction —
   *  rendered in the banner so the user can see roughly how much was
   *  rolled up. From compactMetadata.preTokens. */
  compactPreTokens?: number
  /** For kind === 'compact'. Token count immediately after compaction.
   *  From compactMetadata.postTokens — only present once compaction
   *  finishes (live stream may emit before the post count is known). */
  compactPostTokens?: number
  /** True while this assistant entry is still being streamed via
   *  --include-partial-messages. Cleared when the consolidated
   *  assistant event arrives and the manager dispatches
   *  assistantEntryFinalized. The renderer uses this to draw a
   *  blinking cursor at the end of the text. */
  isPartial?: boolean
  /** True for a user entry that was typed while busy=true and has
   *  been written to stdin but not yet resolved by claude (i.e.,
   *  no `result` boundary has fired since it was queued). The
   *  renderer styles these as dashed/muted "queued" bubbles with
   *  a cancel affordance. Cleared on the next `result`. */
  isQueued?: boolean
  /** Image attachments sent with this user message. Only the on-disk
   *  path + media type live in the slice — bytes would balloon the
   *  state event payload. The renderer lazy-fetches each path via the
   *  jsonClaude:readAttachmentImage IPC to render thumbnails in the
   *  chat history. The path is also embedded in the user message that
   *  Claude sees ("(image attached at <path>)") so the model can
   *  Read/Bash/Write the file. */
  images?: Array<{ path: string; mediaType: string }>
  /** For kind === 'assistant'. When this assistant message was emitted
   *  by a sub-agent spawned via the Task tool, this is the tool_use id
   *  of the parent Task call. The renderer's grouping pre-pass uses it
   *  to nest sub-agent activity inside the parent Task card instead of
   *  flattening it chronologically into the top-level transcript. */
  parentToolUseId?: string
  /** For inline system/error cards. Discriminator that tells the
   *  renderer which dedicated card component to dispatch on. Each
   *  worktree owns its own subset of variants and they coexist —
   *  subprocess-exit / auth-failure from crash recovery + reauth,
   *  rate-limit-warning / rate-limit-error from rate-limit display. */
  errorKind?:
    | 'subprocess-exit'
    | 'rate-limit'
    | 'rate-limit-warning'
    | 'rate-limit-error'
    | 'auth-failure'
    | 'protocol-version'
  /** For kind === 'error'. Human-readable detail (exitReason, rate-limit
   *  retry-at timestamp, original auth error string, etc.). */
  errorMessage?: string
  /** For kind === 'error' with errorKind === 'subprocess-exit'. Whether the
   *  exit was clean (user closed the tab) or unexpected (crash). */
  exitWasClean?: boolean
  /** On-disk transcript uuid for this entry — the `uuid` field on the
   *  matching line of `~/.claude/projects/<cwd-encoded>/<sessionId>.jsonl`.
   *  Only known for entries that were seeded from the transcript on
   *  resume (live-stream entries don't carry it because the jsonl uuid
   *  is minted server-side after the line is written). Not currently
   *  used at rewind time — see apiMessageId below — but kept around as
   *  a stable per-line key for future per-block operations. */
  transcriptUuid?: string
  /** Anthropic Messages-API id for the assistant message this entry
   *  belongs to. Stable across live + seeded representations: live
   *  entries get it from `message_start`, seeded entries from
   *  `parsed.message.id`. Critical for rewind: a single assistant turn
   *  is one API call but the on-disk jsonl writes one line per content
   *  block (thinking, tool_use, text), so multiple slice entries —
   *  whether live (one consolidated) or seeded (multiple split) — all
   *  share the same apiMessageId. Truncation cuts AFTER the last
   *  jsonl line carrying this id, which is the natural end of the
   *  assistant's turn. */
  apiMessageId?: string
  /** For errorKind === 'rate-limit-warning' | 'rate-limit-error'.
   *  Structured detail sourced from the SDK's `rate_limit_info`
   *  payload. All fields optional because the wire shape is sparse —
   *  different tiers and events fill in different subsets. */
  rateLimitDetail?: {
    /** 0–1 fraction of the current window's budget that's been used.
     *  Renderer formats as a percentage. */
    utilization?: number
    /** Unix ms timestamp at which the limiting window resets. */
    resetAt?: number
    /** Tier identifier, e.g. 'five_hour' / 'seven_day' / 'unified'. */
    tier?: string
    /** True when overage credits are currently being consumed. */
    isUsingOverage?: boolean
  }
}

export interface JsonClaudeSession {
  sessionId: string
  worktreePath: string
  /** Which agent this chat session belongs to. The registry routes
   *  runtime operations on this per-session value. */
  agentKind: AgentKind
  /** Concrete runtime backend id for the session — normally equal to
   *  agentKind, but kept separate so a future runtime swap doesn't
   *  rewrite the agent identity. */
  runtimeId: ChatRuntimeId
  state: JsonClaudeSessionState
  exitCode: number | null
  exitReason: string | null
  /** Buffered chat history for this session. Kept in the store so a
   *  reloading renderer doesn't lose the scrollback. */
  entries: JsonClaudeChatEntry[]
  /** True once `entries` reflects the authoritative server-side history
   *  for this session. The wire snapshot ships sessions with stripped
   *  entries (see `stripJsonClaudeEntries`) and `entriesHydrated: false`,
   *  so the renderer can distinguish "haven't lazy-fetched entries yet"
   *  from "session is genuinely empty" — and suppress the empty-state
   *  flash during the fetch window. The reducer flips this true on
   *  `entriesSeeded`. Server-side it's always true. */
  entriesHydrated: boolean
  /** Last text of the most recent user submission; used by the renderer to
   *  pair the echo against the user-card it just rendered optimistically. */
  busy: boolean
  /** --permission-mode flag passed to claude at spawn time. Mid-session
   *  changes are applied via a stdin control_request (subtype
   *  'set_permission_mode') so the in-flight turn is not aborted; the
   *  spawn-time flag is still consulted on the next respawn. */
  permissionMode: JsonClaudePermissionMode
  /** Slash command names (no leading `/`) advertised by Claude in the
   *  system/init message. Includes built-ins like 'clear'/'compact', the
   *  user's enabled Skills, plugin commands, and project-local
   *  `.claude/commands/*.md`. Empty until init lands. */
  slashCommands: string[]
  /** Audit map of tool calls that were auto-approved by the LLM-based
   *  reviewer (instead of going through the user UI). Keyed by toolUseId
   *  so the per-tool card can render a small "auto-approved" badge.
   *  Only populated when settings.autoApprovePermissions is on. */
  autoApprovedDecisions: Record<
    string,
    { model: string; reason: string; timestamp: number }
  >
  /** Tool names the user has granted "allow this session" for. The bridge
   *  consults this set before surfacing an approval card and resolves
   *  matching requests directly. Survives kill+respawn (permission-mode
   *  toggles) but is intentionally not persisted across app restarts. */
  sessionToolApprovals: string[]
  /** Audit map of tool calls auto-resolved because their tool name was in
   *  sessionToolApprovals. Keyed by toolUseId, parallel to
   *  autoApprovedDecisions, so the per-tool card can render a small
   *  "allowed by session policy" badge. */
  sessionAllowedDecisions: Record<
    string,
    { toolName: string; timestamp: number }
  >
  /** Capability flags advertised by the active runtime. The renderer gates
   *  UI actions (rewind, permission mode, approvals, etc.) from these
   *  rather than hardcoding runtime checks. */
  capabilities: ChatRuntimeCapabilities
}

/** Status of the LLM-based auto-reviewer for a single pending approval.
 *  Set on the pending entry only when settings.autoApprovePermissions is
 *  on. The renderer reads this to draw a small "asking auto-approver"
 *  spinner while pending and a muted "auto-approver: <reason>" line
 *  once the reviewer has decided to ask. We never see a finished
 *  'approve' here in practice — that path resolves the approval and
 *  drops the entry from pendingApprovals before the renderer can
 *  observe it. */
export interface AutoReviewStatus {
  state: 'pending' | 'finished'
  decision?: 'approve' | 'ask'
  reason?: string
  model?: string
}

export interface JsonClaudePendingApproval {
  requestId: string
  sessionId: string
  toolName: string
  input: Record<string, unknown>
  toolUseId?: string
  timestamp: number
  autoReview?: AutoReviewStatus
}

import type { AgentKind } from '../terminals'

export type { AgentKind } from '../terminals'

export interface JsonClaudeState {
  /** Per-session state keyed by session id (== terminal/tab id). */
  sessions: Record<string, JsonClaudeSession>
  /** Pending approvals keyed by request id (unique across sessions). */
  pendingApprovals: Record<string, JsonClaudePendingApproval>
}

export type JsonClaudeEvent =
  | {
      type: 'jsonClaude/sessionStarted'
      payload: {
        sessionId: string
        worktreePath: string
        /** Agent kind for this session. Required so the registry can
         *  route even on the first start (before a slice entry exists).
         *  Ignored on re-attach — the reducer preserves the existing
         *  session's kind. */
        agentKind: AgentKind
        /** Runtime backend id for this session. Required; on re-attach
         *  the reducer preserves the existing session's id. */
        runtimeId: ChatRuntimeId
        /** Permission mode applied only when this session id has no
         *  prior slice entry (fresh tab). When the session already
         *  exists (resume / re-attach / mode-change respawn), the
         *  reducer preserves the existing mode and ignores this. */
        defaultPermissionMode?: JsonClaudePermissionMode
        /** Capability flags advertised by the runtime. If omitted, the
         *  reducer seeds ACP defaults. */
        capabilities?: ChatRuntimeCapabilities
      }
    }
  | {
      type: 'jsonClaude/sessionStateChanged'
      payload: {
        sessionId: string
        state: JsonClaudeSessionState
        exitCode?: number | null
        exitReason?: string | null
      }
    }
  | {
      type: 'jsonClaude/entryAppended'
      payload: { sessionId: string; entry: JsonClaudeChatEntry }
    }
  | {
      type: 'jsonClaude/entriesSeeded'
      payload: { sessionId: string; entries: JsonClaudeChatEntry[] }
    }
  | {
      type: 'jsonClaude/assistantTextDelta'
      payload: { sessionId: string; entryId: string; textDelta: string }
    }
  | {
      type: 'jsonClaude/assistantThinkingDelta'
      payload: { sessionId: string; entryId: string; textDelta: string }
    }
  | {
      type: 'jsonClaude/assistantBlockAppended'
      payload: {
        sessionId: string
        entryId: string
        block: JsonClaudeMessageBlock
      }
    }
  | {
      type: 'jsonClaude/assistantEntryFinalized'
      payload: {
        sessionId: string
        entryId: string
        blocks: JsonClaudeMessageBlock[]
      }
    }
  | {
      type: 'jsonClaude/toolResultAttached'
      payload: {
        sessionId: string
        toolUseId: string
        content: string
        isError: boolean
      }
    }
  | {
      type: 'jsonClaude/busyChanged'
      payload: { sessionId: string; busy: boolean }
    }
  | {
      type: 'jsonClaude/sessionCleared'
      payload: { sessionId: string }
    }
  | {
      type: 'jsonClaude/approvalRequested'
      payload: JsonClaudePendingApproval
    }
  | {
      type: 'jsonClaude/approvalResolved'
      payload: { requestId: string }
    }
  | {
      type: 'jsonClaude/approvalAutoApproved'
      payload: {
        sessionId: string
        toolUseId: string
        model: string
        reason: string
        timestamp: number
      }
    }
  | {
      type: 'jsonClaude/approvalAutoReviewFinished'
      payload: {
        requestId: string
        decision: 'approve' | 'ask'
        reason: string
        model?: string
      }
    }
  | {
      type: 'jsonClaude/permissionModeChanged'
      payload: { sessionId: string; mode: JsonClaudePermissionMode }
    }
  | {
      type: 'jsonClaude/userEntriesUnqueued'
      payload: { sessionId: string }
    }
  | {
      type: 'jsonClaude/userEntryUnqueued'
      payload: { sessionId: string; entryId: string }
    }
  | {
      type: 'jsonClaude/entryRemoved'
      payload: { sessionId: string; entryId: string }
    }
  | {
      type: 'jsonClaude/entriesTruncated'
      payload: { sessionId: string; fromEntryId: string }
    }
  | {
      type: 'jsonClaude/slashCommandsChanged'
      payload: { sessionId: string; slashCommands: string[] }
    }
  | {
      type: 'jsonClaude/compactBoundaryReceived'
      payload: {
        sessionId: string
        entryId: string
        trigger?: 'auto' | 'manual'
        preTokens?: number
        postTokens?: number
        timestamp: number
      }
    }
  | {
      type: 'jsonClaude/sessionToolApprovalsGranted'
      payload: { sessionId: string; toolNames: string[] }
    }
  | {
      type: 'jsonClaude/sessionToolApprovalsCleared'
      payload: { sessionId: string; toolNames?: string[] }
    }
  | {
      type: 'jsonClaude/approvalSessionAllowed'
      payload: {
        sessionId: string
        toolUseId: string
        toolName: string
        timestamp: number
      }
    }
  | {
      type: 'jsonClaude/capabilitiesChanged'
      payload: { sessionId: string; capabilities: ChatRuntimeCapabilities }
    }

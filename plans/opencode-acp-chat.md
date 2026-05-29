# Opencode ACP chat — implementation plan

## 1. Problem / goal statement

Harness today supports Opencode only as a terminal/xterm-backed agent (`agentKind: 'opencode'`). The user spawns `opencode` inside a PTY, and the existing hook-based status system (via `src/main/agents/opencode.ts`) drives the sidebar dot + activity panel. There is no chat-mode (JSON-mode) equivalent for Opencode — the rich chat UI (`JsonModeChat.tsx`), transcript state (`json-claude.ts`), and approval bridge are all hardcoded around Claude Code's `stream-json` protocol and MCP permission-prompt tool.

Opencode exposes an **ACP (Agent Communication Protocol)** interface that is conceptually similar to Claude's `stream-json` — streaming assistant turns, tool calls, user messages, and permission requests — but the wire format, spawn flags, and approval mechanism differ. The goal is to reuse the existing chat UI and state machinery while swapping the backend transport so that Opencode can back a `json-claude`-style chat tab.

We want:
- A new tab type (or a generalized chat tab) that can be backed by **either** Claude Code or Opencode.
- The renderer's `JsonModeChat.tsx` and the `json-claude.ts` slice to stay provider-agnostic.
- A provider adapter layer in main that translates ACP events into the same slice events Claude uses today.
- Approval / tool-permission flow mapped onto Opencode's ACP permission model.
- History seeding, resume, and rewind working against Opencode's session store.

## 2. Current state in repo

### What exists today

| Concern | File | Notes |
|---|---|---|
| Chat UI | `src/renderer/components/JsonModeChat.tsx` | ~2K lines. Renders entries from `jsonClaude` slice. Hardcodes "Claude" in placeholder text and composer labels, but the entry rendering is provider-agnostic. |
| Chat state slice | `src/shared/state/json-claude.ts` | `JsonClaudeSession`, `JsonClaudeChatEntry`, `JsonClaudePendingApproval`, and the full event/reducer suite. The shape is generic enough (text/thinking/tool_use/tool_result) that it can represent any agent turn. |
| Claude backend | `src/main/json-claude-manager.ts` | Spawns bundled `claude -p --input-format stream-json`, pumps stdout, dispatches slice events. Deeply Claude-specific: `--permission-prompt-tool`, MCP config, `control_request` frames, transcript jsonl at `~/.claude/projects/...`. |
| Approval bridge | `src/main/approval-bridge.ts` | Unix-domain socket bridge for Claude's `permission-prompt-mcp.js`. Speaks Claude's `RequestFrame` / `ApprovalResult` shape. |
| Tab handlers | `src/renderer/hooks/useTabHandlers.ts` | `handleAddJsonClaudeTab` hardcodes `type: 'json-claude'` and `crypto.randomUUID()` session id. `handleSendToAgent` treats `json-claude` as the only chat tab type. |
| Pane / tab types | `src/shared/state/terminals.ts` | `TerminalTab` union has `type: 'json-claude'` as a distinct variant. Persistence, FSM, and type guards all know this string. |
| Main IPC wiring | `src/main/index.ts` | ~150 lines of `jsonClaude:*` IPC handlers wired directly to `JsonClaudeManager` and `ApprovalBridge`. `startJsonClaudeSession` helper assumes Claude. |
| Opencode terminal agent | `src/main/agents/opencode.ts` | Hook plugin for status events (`session.created`, `tool.execute.before`, etc.). No chat protocol support. |
| Agent registry | `src/main/agents/index.ts` | `AgentModule` interface — `buildSpawnArgs`, `installHooks`, `assignsSessionId`, etc. Used only for PTY-spawned agents today. |

### What's missing
- Any ACP client / parser / spawner for Opencode.
- A provider abstraction between the slice and the subprocess manager.
- Opencode-specific approval flow (ACP permissions are not MCP-based).
- Opencode session persistence / transcript format discovery.
- Generalization of tab types so "chat tab" is not synonymous with "Claude tab."

## 3. Target architecture

The high-level shape is a **provider-adapter pattern** in main, with the renderer and slice remaining agnostic.

```
Renderer
  JsonModeChat.tsx ──► useJsonClaudeSession() ──► json-claude slice
                                                        ▲
Main                                                    │
  ChatProvider (new) ──► ChatSessionAdapter (interface)
       │
       ├── ClaudeChatAdapter ──► JsonClaudeManager (existing)
       │                            └── ApprovalBridge (existing)
       │
       └── OpencodeChatAdapter (new) ──► AcpClient (new)
                                          └── OpencodeApprovalBridge (new)
```

**Principles:**
1. **Slice stays universal.** `json-claude.ts` is renamed to `chat-sessions.ts` (or kept with a legacy alias) and its event names stay the source of truth for both providers.
2. **Renderer stays universal.** `JsonModeChat.tsx` is renamed to `ChatPanel.tsx` (or kept with a legacy alias). Composer placeholder text and statusline labels move to capability flags (see §9).
3. **Main owns provider selection.** The tab's `agentKind` (or a new `provider` field) determines which adapter is instantiated.
4. **Adapters speak slice events.** Both `ClaudeChatAdapter` and `OpencodeChatAdapter` dispatch the same `chat/sessionStarted`, `chat/entryAppended`, `chat/approvalRequested`, etc. events.
5. **Kill / start / send / interrupt are adapter methods.** The IPC handlers call `ChatProvider.start(sessionId, worktreePath, provider)` instead of `jsonClaudeManager.create(...)`.

## 4. Proposed data-model changes

### 4.1 Slice rename (optional but recommended)

Rename `jsonClaude` → `chatSessions` in `src/shared/state/`. Keep the exact same `State`, `Event`, and `reducer` shapes. Add a re-export alias so existing imports don't break during the migration:

```ts
// src/shared/state/chat-sessions.ts
export { chatSessionsReducer as jsonClaudeReducer } // temporary alias
```

**Files to touch:**
- `src/shared/state/chat-sessions.ts` (rename from `json-claude.ts`)
- `src/shared/state/index.ts` (root reducer union)
- `src/main/build-initial-state.ts`
- `src/renderer/store.ts` (hooks like `useJsonClaudeSession` → `useChatSession`)

### 4.2 Session identity

`JsonClaudeSession` already has `sessionId` and `worktreePath`. Add an optional `provider` field:

```ts
export type ChatProvider = 'claude' | 'opencode'

export interface ChatSession {
  sessionId: string
  worktreePath: string
  provider: ChatProvider
  // ... rest unchanged
}
```

The reducer ignores `provider` — it's metadata for main to know which adapter to route to on resume.

### 4.3 Tab type generalization

In `src/shared/state/terminals.ts`, change the `json-claude` tab variant to a generic `chat` variant with a `provider` discriminator:

```ts
export interface ChatTab {
  id: string
  type: 'chat'
  provider: ChatProvider
  label: string
  sessionId: string
}
```

**Migration:** `persistence-migrations.ts` needs a v→v+1 migration that rewrites persisted panes containing `type: 'json-claude'` to `type: 'chat', provider: 'claude'`.

### 4.4 Pending approval shape

`JsonClaudePendingApproval` is already generic (tool name + input + toolUseId). No changes needed for Opencode — the ACP permission event maps onto the same fields.

## 5. Runtime abstraction / provider adapter design

### 5.1 `ChatProvider` (main singleton)

Replaces the direct `JsonClaudeManager` usage in `src/main/index.ts`.

```ts
// src/main/chat-provider.ts
export interface ChatProvider {
  start(sessionId: string, worktreePath: string, provider: ChatProvider, opts?: StartOpts): void
  send(sessionId: string, text: string, images?: ImageAttachment[]): void
  interrupt(sessionId: string): void
  kill(sessionId: string): void
  killAll(): void
  rewindTo(sessionId: string, entryId: string): RewindOutcome
  setPermissionMode(sessionId: string, mode: PermissionMode): void
  seedFromTranscript(sessionId: string, worktreePath: string): void
  hasSession(sessionId: string): boolean
}
```

Implementation holds a `Map<string, ChatSessionAdapter>` keyed by `sessionId`. Each adapter is created lazily on `start()` and destroyed on `kill()`.

### 5.2 `ChatSessionAdapter` interface

```ts
export interface ChatSessionAdapter {
  readonly provider: ChatProvider
  readonly sessionId: string
  start(worktreePath: string, opts?: StartOpts): void
  send(text: string, images?: ImageAttachment[]): void
  interrupt(): void
  kill(): void
  rewindTo(entryId: string): RewindOutcome
  setPermissionMode(mode: PermissionMode): void
  seedFromTranscript(): void
}
```

### 5.3 `ClaudeChatAdapter`

Thin wrapper around existing `JsonClaudeManager`. Move the manager's public methods onto the adapter interface. The manager itself stays largely unchanged — it just becomes an internal detail of the Claude adapter.

### 5.4 `OpencodeChatAdapter` (new)

Owns:
- **AcpClient** — spawns `opencode acp` (or the ACP subcommand) and pumps NDJSON from stdout.
- **OpencodeApprovalBridge** — listens for ACP `permission.asked` events and surfaces them via the same `approvalRequested` / `approvalResolved` slice events.
- **Transcript seeding** — reads Opencode's session export format (likely `opencode export <sessionId>`) and translates into `ChatEntry[]`.

The adapter translates ACP wire events into slice events (see §6).

## 6. ACP ↔ shared chat event mapping

Opencode's ACP protocol (observed in the plugin hook events and CLI behavior) emits events like:

| ACP event | Slice event | Notes |
|---|---|---|
| `session.created` | `chat/sessionStarted` | Adapter spawns; dispatch connecting → running. |
| `assistant.message_start` | `chat/assistantBlockAppended` (placeholder) | Create `isPartial: true` entry with empty text block. |
| `assistant.text_delta` | `chat/assistantTextDelta` | Coalesce at ~30ms same as Claude. |
| `assistant.tool_use` | `chat/assistantBlockAppended` | Block type `tool_use` with id + name. |
| `assistant.message_end` | `chat/assistantEntryFinalized` | Clear `isPartial`, replace blocks. |
| `user.message` | `chat/entryAppended` (kind: 'user') | |
| `tool.result` | `chat/toolResultAttached` | Map `tool_use_id` → content + isError. |
| `permission.asked` | `chat/approvalRequested` | |
| `permission.replied` | `chat/approvalResolved` | |
| `session.idle` | `chat/busyChanged` (busy: false) | |
| `compact_boundary` (if any) | `chat/compactBoundaryReceived` | TBD — verify Opencode exposes this. |

**Key assumption:** ACP events carry enough structure (message ids, tool_use ids, parent ids) to reconstruct the same `ChatEntry` graph Claude uses. If ACP does not expose `parent_tool_use_id` for sub-agents, sub-agent nesting is deferred.

**Delta coalescing:** Reuse the same `PARTIAL_TEXT_FLUSH_MS = 30` / `PARTIAL_THINKING_FLUSH_MS = 250` timers from `JsonClaudeManager` — move the coalescing logic into a shared `DeltaCoalescer` utility so both adapters use it.

## 7. Approval / tool-permission flow for ACP

Claude's approval flow is MCP-based: a stdio MCP server (`permission-prompt-mcp.js`) writes a request frame to a Unix socket, and `ApprovalBridge` writes back an `ApprovalResult`.

Opencode's approval flow is native to ACP: the `permission.asked` event arrives on the ACP stdout stream, and the reply is sent back as an ACP `permission.reply` frame on stdin.

### 7.1 `OpencodeApprovalBridge`

Not a socket server — it's an in-memory queue inside `OpencodeChatAdapter`:

1. On `permission.asked`, build a `PendingApproval` and dispatch `chat/approvalRequested`.
2. On renderer `resolveApproval`, write the ACP reply frame to the subprocess stdin.
3. On `permission.replied`, dispatch `chat/approvalResolved`.

No Unix socket, no MCP server, no `auto-approver` Haiku integration (unless we want to port it). The "Allow {tool} this session" feature works the same way: the adapter checks `sessionToolApprovals` before surfacing the permission event and auto-replies `allow` if matched.

### 7.2 Permission mode mapping

Claude has `--permission-mode default | acceptEdits | plan`. Opencode may not have an exact equivalent. The adapter should:
- Accept `setPermissionMode` calls but no-op if the provider doesn't support it.
- Surface the lack of support via a capability flag (see §9) so the UI can hide the mode chip.

## 8. History / resume / rewind strategy

### 8.1 Claude today

- Session jsonl lives at `~/.claude/projects/<cwd-encoded>/<sessionId>.jsonl`.
- `--resume <sessionId>` rehydrates Claude's Messages-API state.
- Rewind truncates the jsonl in place and re-seeds the slice.

### 8.2 Opencode approach

Opencode sessions are stored in its own state directory (likely `~/.config/opencode/sessions/` or similar). The adapter needs:

1. **Session export on seed:** `opencode export <sessionId>` returns a JSON/JSONL transcript. The adapter parses it into `ChatEntry[]` and dispatches `entriesSeeded`.
2. **Resume on start:** If the session file exists, pass `--session <sessionId>` (or ACP equivalent) at spawn time. If Opencode does not support resume, the adapter starts a fresh session and seeds from the exported transcript — the user loses the model's internal state but keeps the scrollback.
3. **Rewind:** If Opencode supports truncation or fork, use it. If not, the adapter can:
   - Export the session.
   - Truncate the exported transcript locally (same logic as Claude's `truncateTranscriptAfterMessage`).
   - Start a **new** session, seed the truncated transcript as the initial context, and update the tab's `sessionId` to the new one.
   - This is a fallback; it costs tokens on the next turn (no cache hit) but is functionally correct.

**Decision:** Implement the fallback first (export → truncate → new session). Upgrade to native Opencode rewind if/when the CLI exposes it.

## 9. Capability flags and UI behavior differences

Not all providers support the same features. The slice should expose a `capabilities` object per session so the renderer can adapt without provider-specific `if` statements.

```ts
export interface ChatCapabilities {
  supportsPermissionMode: boolean
  supportsRewind: boolean
  supportsSubAgentNesting: boolean
  supportsImageAttachments: boolean
  supportsSlashCommands: boolean
  supportsAutoApprover: boolean
  composerPlaceholder: string
  agentName: string
}
```

| Capability | Claude | Opencode (initial) |
|---|---|---|
| `supportsPermissionMode` | true | false (hide mode chip) |
| `supportsRewind` | true | true (via fallback) |
| `supportsSubAgentNesting` | true | false (until ACP exposes parent ids) |
| `supportsImageAttachments` | true | false (until verified) |
| `supportsSlashCommands` | true | false (or probe via ACP init) |
| `supportsAutoApprover` | true | false |
| `composerPlaceholder` | "Message Claude" | "Message Opencode" |
| `agentName` | "Claude" | "Opencode" |

The renderer reads `session.capabilities` (or a selector) and gates UI features accordingly. This avoids `if (provider === 'claude')` scattered through `JsonModeChat.tsx`.

## 10. File-by-file implementation plan

### Phase A — Slice + tab type generalization

| File | Change |
|---|---|
| `src/shared/state/json-claude.ts` | Rename to `chat-sessions.ts`. Add `provider: ChatProvider` to `ChatSession`. Add `capabilities` field. Keep legacy re-export alias. |
| `src/shared/state/index.ts` | Update root reducer union. Add `chat/*` event aliases alongside `jsonClaude/*` during migration. |
| `src/shared/state/terminals.ts` | Replace `type: 'json-claude'` with `type: 'chat' + provider: ChatProvider` in `TerminalTab` union. |
| `src/main/persistence-migrations.ts` | Add migration vN→vN+1 rewriting persisted `json-claude` tabs to `chat` + `provider: 'claude'`. |
| `src/main/build-initial-state.ts` | Update initial state key from `jsonClaude` to `chatSessions`. |
| `src/renderer/store.ts` | Rename hooks: `useJsonClaudeSession` → `useChatSession`, `useJsonClaudeApprovals` → `useChatApprovals`. Keep deprecated aliases. |

### Phase B — Provider abstraction in main

| File | Change |
|---|---|
| `src/main/chat-provider.ts` (new) | Singleton `ChatProvider` class. Holds `Map<sessionId, ChatSessionAdapter>`. Routes start/send/kill/interrupt/rewind to the active adapter. |
| `src/main/chat-session-adapter.ts` (new) | `ChatSessionAdapter` interface + `StartOpts`, `ImageAttachment`, `RewindOutcome` types. |
| `src/main/claude-chat-adapter.ts` (new) | Wraps `JsonClaudeManager`. Implements `ChatSessionAdapter`. |
| `src/main/json-claude-manager.ts` | Make internal to Claude adapter. Remove direct export; expose through `ClaudeChatAdapter`. |
| `src/main/approval-bridge.ts` | Move under `claude/` or keep flat. No functional changes. |
| `src/main/opencode-chat-adapter.ts` (new) | Implements `ChatSessionAdapter`. Spawns ACP, pumps events, manages `OpencodeApprovalBridge`. |
| `src/main/opencode-acp-client.ts` (new) | NDJSON stdout parser, delta coalescer, ACP frame builder for stdin. |
| `src/main/opencode-approval-bridge.ts` (new) | In-memory queue. Maps ACP `permission.asked` ↔ slice `approvalRequested`. |
| `src/main/opencode-transcript.ts` (new) | `exportSession(sessionId)` wrapper, parser into `ChatEntry[]`, truncate helper. |
| `src/main/index.ts` | Replace all `jsonClaudeManager.*` calls with `chatProvider.*`. Update IPC handler names from `jsonClaude:*` to `chat:*` (keep aliases). Update `startJsonClaudeSession` → `startChatSession`. |

### Phase C — Renderer generalization

| File | Change |
|---|---|
| `src/renderer/components/JsonModeChat.tsx` | Rename to `ChatPanel.tsx`. Replace hardcoded "Claude" strings with `capabilities.agentName` / `capabilities.composerPlaceholder`. Gate permission-mode chip, slash-command popover, and image paste on capability flags. |
| `src/renderer/components/ChatPanel.tsx` | Same file as above — just renamed. |
| `src/renderer/hooks/useTabHandlers.ts` | Generalize `handleAddJsonClaudeTab` → `handleAddChatTab(provider)`. Update `handleSendToAgent` to route `type: 'chat'` tabs through `sendChatMessage`. |
| `src/renderer/hooks/useChatApprovals.ts` (rename) | Same logic, provider-agnostic. |
| `src/renderer/backend.ts` | Update `ElectronAPI` interface: rename `startJsonClaude` → `startChat`, `sendJsonClaudeMessage` → `sendChatMessage`, etc. Keep deprecated aliases. |

### Phase D — Agents / spawn integration

| File | Change |
|---|---|
| `src/main/agents/index.ts` | Add `ChatProvider` to `AgentModule` or keep separate. The `AgentModule` interface is for PTY spawn; chat adapters are a parallel registry. |
| `src/main/agents/opencode.ts` | No changes needed for PTY path. The chat adapter is a separate code path. |

## 11. Suggested phased rollout with checkpoints

### Phase 1 — Slice rename + tab type migration (no user-visible change)
**Goal:** `json-claude` is internally `chat` with `provider: 'claude'`. Everything still works.

- Rename slice, add `provider` field, update persistence migration.
- Update all main + renderer imports to use new names (with aliases for safety).
- **Checkpoint:** `pnpm typecheck && npx electron-vite build && npx vitest run` clean. User sees no difference.

### Phase 2 — Provider abstraction skeleton (Claude only)
**Goal:** `ChatProvider` + `ClaudeChatAdapter` exist; `JsonClaudeManager` is hidden behind the adapter. No Opencode yet.

- Introduce `ChatProvider`, `ChatSessionAdapter`, `ClaudeChatAdapter`.
- Move all main-side `jsonClaudeManager` calls behind the provider.
- **Checkpoint:** All existing json-claude features work. Approval bridge, rewind, interrupt, permission mode unchanged.

### Phase 3 — Opencode ACP adapter (MVP)
**Goal:** User can open an Opencode chat tab, send messages, see assistant replies, and handle tool approvals.

- Build `OpencodeChatAdapter`, `AcpClient`, `OpencodeApprovalBridge`.
- Add `handleAddOpencodeChatTab` in renderer.
- Seed from `opencode export`.
- **Checkpoint:** Basic turn-by-turn chat works. Approvals surface in UI. No rewind, no sub-agent nesting, no images.

### Phase 4 — Capability flags + UI polish
**Goal:** Renderer adapts to provider capabilities. Opencode tab hides unsupported features.

- Populate `capabilities` per session.
- Gate permission-mode chip, slash commands, image paste, sub-agent nesting.
- **Checkpoint:** Opencode chat tab is visually complete. No broken/missing-feature UI.

### Phase 5 — Rewind + history for Opencode
**Goal:** Rewind works via export → truncate → new session fallback.

- Implement `OpencodeChatAdapter.rewindTo` using transcript truncation.
- **Checkpoint:** Rewind to any assistant message works. Session continues from truncated state.

### Phase 6 — Cleanup / remove legacy aliases
**Goal:** Delete `jsonClaude` naming everywhere.

- Remove deprecated re-exports, IPC aliases, and hook aliases.
- Rename files (`JsonModeChat.tsx` → `ChatPanel.tsx`).
- **Checkpoint:** Repo contains zero `jsonClaude` / `json-claude` references except in `git log`.

## 12. Testing strategy

| Layer | Test approach |
|---|---|
| Slice reducer | Extend existing `json-claude.test.ts` (rename to `chat-sessions.test.ts`). Add test for `provider` field preservation across events. |
| Persistence migration | Add a test in `persistence-migrations.test.ts` (or create one) that loads a vN panes blob with `json-claude` tabs and asserts the migrated blob has `chat` + `provider: 'claude'`. |
| Claude adapter | Existing `approval-bridge.test.ts` still passes. Add a thin test for `ClaudeChatAdapter` that mocks `JsonClaudeManager` and verifies the adapter interface is called through. |
| Opencode adapter | Unit test `AcpClient` with a mock child process emitting NDJSON lines. Verify correct slice events are dispatched. |
| Integration | Spawn real `opencode` (if available in CI) and exercise one user → assistant turn. Gate behind `OPENCODE_BIN` env var so CI skips it when absent. |
| Renderer | No new unit tests needed — `ChatPanel.tsx` is a view layer. Manual QA on both Claude and Opencode tabs to verify capability gating. |

## 13. Risks / open questions

1. **ACP protocol stability.** Opencode's ACP is less documented than Claude's `stream-json`. We may discover missing fields (e.g., `message.id` for rewind, `parent_tool_use_id` for nesting) after implementation starts. Mitigation: build the fallback paths first (no rewind, flat transcript) and upgrade when the protocol supports it.

2. **Session persistence format.** Opencode's `export` output format is not yet audited. If it's not JSONL or lacks turn boundaries, the seeding parser will need custom logic. Mitigation: spike `opencode export <id>` early in Phase 3.

3. **Approval semantics mismatch.** Claude's `ApprovalResult` supports `updatedInput`, `updatedPermissions`, and `interrupt`. ACP may only support allow/deny. Mitigation: the adapter should degrade gracefully — unsupported fields are omitted from the ACP reply frame.

4. **Performance of `opencode export` on large sessions.** If export is slow or unbounded, seeding could block the main thread. Mitigation: spawn export in a promise, cap output size, or stream-parse if possible.

5. **Dual binary path.** The renderer currently has hardcoded logic for bundled vs. system Claude (`useSystemClaudeForJsonMode`). Opencode will always be PATH-based (no bundled binary). The adapter should accept a `getCommand: () => string` callback, same as `JsonClaudeManagerOptions`.

6. **Tab-type conversion.** Today `panesConvertTabType` swaps between `agent` (xterm) and `json-claude`. With generalization, it should swap between `agent` and `chat` (changing `provider` as needed). The FSM needs to handle `provider` mutation.

## 14. Recommended first commit split

**Commit 1 — "Generalize chat slice and tab type"**
- Rename `json-claude.ts` → `chat-sessions.ts`, add `provider` field.
- Update `terminals.ts` tab type from `json-claude` to `chat`.
- Add persistence migration.
- Update all imports/hooks in main and renderer.
- **No user-visible change.** Pure refactor.

**Commit 2 — "Introduce ChatProvider abstraction for Claude"**
- Create `ChatProvider`, `ChatSessionAdapter`, `ClaudeChatAdapter`.
- Move `JsonClaudeManager` behind `ClaudeChatAdapter`.
- Update `src/main/index.ts` IPC handlers to use `ChatProvider`.
- **Still Claude-only.** Validates the abstraction layer.

**Commit 3 — "Opencode ACP chat backend"**
- `OpencodeChatAdapter`, `AcpClient`, `OpencodeApprovalBridge`.
- `opencode export` seeding.
- Add Opencode to agent registry as a chat provider.
- Renderer: add "Opencode Chat" tab creation affordance (behind feature flag if desired).

**Commit 4 — "Capability flags and UI provider agnosticism"**
- Populate `capabilities` for both adapters.
- Gate UI features in `ChatPanel.tsx`.
- Replace hardcoded "Claude" strings.

**Commit 5 — "Opencode rewind + history fallback"**
- Export → truncate → new session implementation.
- End-to-end QA and integration test.

This split keeps each commit reviewable (< 400 LOC delta) and ensures the abstraction is solid before the Opencode-specific work lands.

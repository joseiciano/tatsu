# Claude (legacy) + Claude (ACP) — implementation plan

## Goal

Add a second Claude chat runtime, **Claude (ACP)**, alongside the current
**Claude (legacy)** runtime, so both can coexist while we compare behavior in
real usage.

## Naming / product behavior

- Surface the two runtime labels as:
  - `Claude (legacy)`
  - `Claude (ACP)`
- Keep the existing JSON chat tab type for now.
- Store the runtime as metadata on the tab/session rather than introducing a
  second tab type immediately.
- Default new chat tabs to `legacy` until `acp` proves itself.

## Guardrails

- Do not break the current `JsonClaudeManager` flow while adding ACP.
- Do not force feature parity before shipping `Claude (ACP)`.
- Keep runtime branching concentrated in a small number of places:
  - runtime selection
  - capability declaration
  - main-process protocol adaptation
- Prefer capability checks over renderer-side `if (runtime === ...)` sprawl.

## Target architecture

### Runtime model

Introduce a main-process chat runtime abstraction with two implementations:

- `ClaudeLegacyRuntime`
- `ClaudeAcpRuntime`

The renderer should continue talking to the same `jsonClaude:*` backend API for
phase 1; the main process routes requests to the selected runtime.

### State model

Keep the existing `jsonClaude` slice name initially to minimize churn, but add:

- per-tab runtime metadata
- per-session runtime metadata
- per-session capability metadata

ACP should adapt its events into the existing chat-entry model instead of
forcing a second renderer stack immediately.

---

## Phase 1 — state + routing foundation

### 1. Add runtime type definitions

**Files**
- `src/shared/state/terminals.ts`
- `src/shared/state/settings.ts`
- `src/shared/state/json-claude.ts`
- related `*.test.ts`

**Changes**
- Add a runtime union, e.g. `type ClaudeChatRuntime = 'legacy' | 'acp'`.
- Add runtime metadata to `json-claude` tabs in `terminals.ts`.
- Add `defaultClaudeChatRuntime` to settings state.
- Add `runtime` and `capabilities` to `JsonClaudeSession`.
- Add reducer events/tests needed to persist/update this metadata.

**Notes**
- Keep default runtime = `legacy`.
- Do not rename `jsonClaude` yet.

### 2. Persist runtime in config/bootstrap

**Files**
- `src/main/persistence.ts`
- `src/main/build-initial-state.ts`
- `src/main/persistence-migrations.test.ts` (if needed)

**Changes**
- Add optional persisted config field for `defaultClaudeChatRuntime`.
- Seed initial shared state from config.
- Ensure missing config cleanly defaults to `legacy`.

### 3. Thread runtime through tab creation and tab state

**Files**
- `src/shared/state/terminals.ts`
- `src/shared/state/terminals.test.ts`
- `src/main/panes-fsm.ts`
- `src/renderer/hooks/useTabHandlers.ts`
- `src/renderer/components/NewWorktreeScreen.tsx` (if this flow creates chat tabs)

**Changes**
- Ensure all JSON chat tab creation paths can attach a runtime.
- Preserve runtime on pane mutations, sleep/wake, split, restart, etc.
- If a path creates a JSON chat tab implicitly, source runtime from settings.

---

## Phase 2 — runtime abstraction in main

### 4. Introduce chat runtime interface

**New files**
- `src/main/chat-runtimes/types.ts`
- `src/main/chat-runtimes/index.ts`

**Likely interface responsibilities**
- `hasSession(sessionId)`
- `start(sessionId, worktreePath, opts)`
- `send(sessionId, text, images?)`
- `interrupt(sessionId)`
- `kill(sessionId)`
- `rewindTo(sessionId, entryId)`
- `setPermissionMode(sessionId, mode)`
- `openAuthLoginTab(worktreePath)` or runtime capability equivalent
- `getCapabilities(sessionId)`
- `seedFromTranscript(...)` / history load if runtime uses it

**Notes**
- Keep the interface small and driven by current IPC surfaces.

### 5. Wrap existing manager as legacy runtime

**Files**
- `src/main/json-claude-manager.ts`
- `src/main/approval-bridge.ts`
- `src/main/index.ts`

**Changes**
- Extract an adapter/wrapper: `ClaudeLegacyRuntime`.
- Reuse existing `JsonClaudeManager` and `ApprovalBridge` internals.
- Avoid deep rewrites during extraction; start with delegation.

**Goal**
- After this step, legacy behavior should be functionally unchanged.

### 6. Add runtime registry/router in main

**Files**
- `src/main/index.ts`
- `src/main/panes-fsm.ts` (if it starts sessions directly)

**Changes**
- Create both runtime instances at boot.
- Resolve a session/tab runtime before handling `jsonClaude:*` actions.
- Route `start/send/interrupt/kill/...` to the correct runtime.
- Keep existing transport method names unchanged for phase 1.

**Important**
- Runtime selection should come from tab/session metadata, not ad hoc conditionals.

---

## Phase 3 — capability model

### 7. Add per-runtime capability surface

**Files**
- `src/shared/state/json-claude.ts`
- `src/main/chat-runtimes/types.ts`
- runtime implementations
- renderer consumers

**Suggested capabilities**
- `canInterrupt`
- `canRewind`
- `canSetPermissionMode`
- `canApproveTools`
- `canResume`
- `canOpenAuthLogin`
- `hasSlashCommands`
- `hasCostTracking`

**Changes**
- Store capabilities on the session.
- Update them at session start / reconnect if runtime-dependent.
- Drive UI enable/disable behavior from capabilities.

**Goal**
- Avoid renderer-wide runtime branching.

---

## Phase 4 — ACP runtime MVP

### 8. Create ACP runtime implementation

**New files**
- `src/main/chat-runtimes/claude-acp.ts`

**Changes**
- Implement the runtime interface for ACP.
- Start with the core loop only:
  - start session
  - send user message
  - stream assistant output
  - interrupt if ACP supports it
  - kill/reconnect
  - tool call / tool result mapping
  - error mapping

**Do not require v1 parity for**
- rewind
- permission-mode switching
- slash command discovery
- transcript replay/resume
- auth helper tab
- cost parsing from Claude transcript files
- Claude-specific compaction semantics

### 9. Normalize ACP events into the existing chat-entry model

**Files**
- `src/main/chat-runtimes/claude-acp.ts`
- `src/shared/state/json-claude.ts`
- renderer should remain mostly unchanged

**Changes**
- Map ACP events into existing entry shapes where possible:
  - `user`
  - `assistant`
  - `system`
  - `error`
  - `tool_result`
  - message blocks (`text`, `thinking`, `tool_use`, `tool_result`) as available
- If ACP lacks a concept, omit it and lower capabilities accordingly.

**Goal**
- Reuse current chat renderer rather than building a second one.

### 10. Decide ACP persistence strategy

**Files**
- likely new ACP persistence helpers under `src/main/`
- `src/main/index.ts`
- `src/shared/state/json-claude.ts`

**Changes**
- Do not assume Claude transcript compatibility.
- If ACP needs history persistence, prefer Harness-owned storage.
- Keep legacy transcript replay isolated to legacy runtime.

**Goal**
- Prevent ACP from inheriting Claude-specific filesystem coupling unless necessary.

---

## Phase 5 — renderer integration

### 11. Add settings control for default runtime

**Files**
- `src/renderer/components/Settings.tsx`
- `src/renderer/types.ts`
- `src/renderer/build-backend.ts`
- `src/main/index.ts`
- `src/shared/state/settings.ts`
- tests

**Changes**
- Add UI for selecting default chat runtime:
  - `Claude (legacy)`
  - `Claude (ACP)`
- Wire save/load through shared state + config.

### 12. Add runtime selection to chat-tab creation flows

**Files**
- `src/renderer/hooks/useTabHandlers.ts`
- `src/renderer/components/NewWorktreeScreen.tsx`
- `src/main/panes-fsm.ts`
- maybe context-menu / tab conversion flows if exposed

**Changes**
- Ensure a new JSON chat tab can be created with explicit runtime.
- For first pass, it is acceptable to source only from the default setting.
- If a runtime switch UI is added later, treat that as a follow-up.

### 13. Show runtime label in chat UI

**Files**
- `src/renderer/components/JsonModeChat.tsx`
- any header/status subcomponents used there

**Changes**
- Surface a subtle runtime label in the chat header or statusline.
- Use the exact labels:
  - `Claude (legacy)`
  - `Claude (ACP)`

### 14. Gate unsupported UI actions by capabilities

**Files**
- `src/renderer/components/JsonModeChat.tsx`
- `src/renderer/components/JsonClaudeApprovalCard.tsx`
- `src/renderer/hooks/useJsonClaudeApprovals.ts`
- any runtime-sensitive controls

**Changes**
- Disable or hide actions unsupported by ACP:
  - rewind
  - permission mode controls
  - auth login CTA
  - slash command affordances
  - approval-specific UI
- Base this on capabilities, not hardcoded runtime checks.

---

## Phase 6 — legacy/ACP-specific concerns

### 15. Keep legacy auth behavior isolated

**Files**
- `src/main/claude-auth.ts`
- `src/main/index.ts`
- `src/renderer/components/JsonModeChat.tsx`

**Changes**
- Keep current `~/.claude.json` auth-status reads for legacy.
- Keep current `jsonClaude:openAuthLoginTab` behavior for legacy.
- Decide ACP behavior explicitly:
  - unsupported in v1, or
  - separate ACP auth path if needed

**Important**
- Do not assume ACP shares legacy auth semantics unless confirmed.

### 16. Keep legacy approvals isolated

**Files**
- `src/main/approval-bridge.ts`
- `src/main/json-claude-manager.ts`
- renderer approval components/hooks

**Changes**
- Treat `ApprovalBridge` as legacy-specific unless ACP offers an equivalent.
- ACP can initially report `canApproveTools = false`.
- If ACP later supports approvals, add a parallel ACP approval adapter rather than bending legacy internals.

### 17. Keep legacy cost tracking isolated

**Files**
- `src/main/cost-tracker.ts`
- `src/main/cost-aggregator.ts`
- `src/main/claude-auth.ts`
- renderer cost consumers if needed

**Changes**
- Legacy continues using Claude transcript-based accounting.
- ACP should either:
  - report no cost tracking initially, or
  - use a runtime-specific cost adapter later.

---

## Phase 7 — testing

### 18. Reducer/unit coverage

**Files**
- `src/shared/state/settings.test.ts`
- `src/shared/state/terminals.test.ts`
- `src/shared/state/json-claude.test.ts`

**Add tests for**
- default runtime setting
- runtime persisted on JSON chat tabs
- session runtime/capabilities updates
- reducer behavior for runtime-specific metadata

### 19. Main-process runtime tests

**Files**
- new tests under `src/main/chat-runtimes/`
- `src/main/json-claude-manager.test.ts`
- `src/main/json-claude-status-deriver.test.ts` if capability/state changes affect status

**Add tests for**
- legacy runtime routing preserves current behavior
- ACP runtime start/send/interrupt/kill mapping
- unsupported ACP actions fail gracefully
- mixed-runtime sessions do not cross streams

### 20. Renderer behavior tests

**Files**
- chat component tests if present, otherwise add targeted coverage

**Add tests for**
- runtime label rendering
- capability-gated controls
- approval UI hidden/disabled when unsupported
- mixed-runtime tab interaction sanity

---

## Suggested implementation order

1. Add runtime types to state/settings/tab/session metadata.
2. Persist default runtime in config/bootstrap.
3. Thread runtime through tab creation and session start.
4. Introduce runtime interface + registry.
5. Wrap current manager as `ClaudeLegacyRuntime` with no behavior changes.
6. Add capability plumbing to shared state and renderer.
7. Implement `ClaudeAcpRuntime` MVP.
8. Add Settings UI for default runtime.
9. Surface runtime labels in chat UI.
10. Gate unsupported actions by capabilities.
11. Add ACP-specific persistence/auth only as needed.
12. Expand parity feature-by-feature after real usage.

---

## Definition of done for first shippable version

A first shippable version of `Claude (ACP)` should meet all of these:

- `Claude (legacy)` remains fully functional.
- New JSON chat tabs can be opened as `Claude (legacy)` or `Claude (ACP)`.
- Runtime is persisted on the tab/session and survives normal UI flows.
- ACP can complete the basic chat loop:
  - start
  - send
  - stream
  - interrupt/stop if supported
  - reconnect/kill
- Unsupported ACP features are visibly gated rather than half-working.
- No renderer-wide runtime-conditional sprawl was introduced.

## Follow-ups after first ship

- runtime switching for an existing chat tab
- ACP auth helper flow
- ACP persistence/resume model
- ACP approval support if the protocol exposes it
- ACP cost tracking
- possible future rename/generalization of `jsonClaude` slice once both runtimes are stable

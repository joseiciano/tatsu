# ACP chat runtime — implementation notes

> Historical note: this file originally described dual-runtime rollout where legacy and ACP would coexist. Final implementation diverged. Legacy runtime was removed before ship, and ACP is now only registered chat runtime.

## Outcome

Harness chat tabs now run through `ChatRuntimeRegistry` + `ClaudeAcpRuntime`. Renderer still speaks existing `jsonClaude:*` transport surface, but main routes that API into `@anthropic-ai/claude-agent-sdk`'s `query()` loop.

## Final architecture

### Runtime model

- `ClaudeAcpRuntime` is only `ChatRuntime` implementation currently registered.
- `ChatRuntimeRegistry` keeps runtime lookup/routing boundary in place so future runtimes can still slot in without transport churn.
- `ClaudeChatRuntime` currently narrows to `'acp'`.

### State + transport model

- Renderer/store contract stayed on `jsonClaude` slice and `jsonClaude:*` IPC names to avoid a broad transport rename.
- Session capability metadata now drives runtime-specific UI affordances.
- Chat tabs remain separate from PTY-backed terminal tabs.

### Session lifecycle

- `start()` boots slice state first, then first `send()` creates SDK `query()` instance.
- Runtime keeps bootstrap-only data in memory until query exists.
- `persistSession: false` is intentional: Harness slice state owns visible session lifecycle rather than SDK-managed transcript persistence.

### Streaming behavior

- ACP stream events are normalized into existing assistant/user/tool/result entry events.
- Partial text/thinking deltas are batched before dispatch so store does not churn on every token.
- Final assistant message replaces/finalizes partial row when full message arrives.

### Capability model

Current ACP defaults:

- `canInterrupt: true`
- `canResume: true`
- `canRewind: false`
- `canSetPermissionMode: false`
- `canApproveTools: false`
- `canOpenAuthLogin: false`
- `hasSlashCommands: false`
- `hasCostTracking: false`

UI should continue gating unsupported actions from capabilities instead of branching on runtime ids in renderer.

## Files that matter now

- `src/main/chat-runtimes/index.ts`
- `src/main/chat-runtimes/types.ts`
- `src/main/chat-runtimes/claude-acp.ts`
- `src/shared/state/json-claude.ts`
- `src/renderer/components/JsonModeChat.tsx`

## Follow-ups still open

- Add rewind support if ACP/runtime API exposes safe transcript truncation primitive.
- Add runtime-side permission-mode switching if SDK/API gains equivalent control.
- Decide whether ACP should get dedicated auth-helper flow instead of disabled capability.
- Add approvals/tool gating if protocol exposes enough structure.
- Add cost tracking if ACP surfaces stable usage events.
- Consider renaming/generalizing `jsonClaude` slice once transport churn worth it.

## Non-goals for current implementation

- Restoring legacy runtime side-by-side.
- Preserving old subprocess/jsonl manager architecture.
- Adding renderer-wide runtime conditionals.

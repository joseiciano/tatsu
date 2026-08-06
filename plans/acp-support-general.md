# First-class JsonModeChat support for all agents

## Outcome

Every currently supported agent — Claude Code, Opencode, Codex — gets a
first-class JsonModeChat tab driven through the existing chat-runtime
architecture, with **no requirement for a global CLI install and no
install-on-demand prompt**. All runtime dependencies ship with the app,
pinned to exact versions and locked via the lockfile. The renderer keeps
the existing `jsonClaude:*` transport surface and `JsonModeChat`
component; the main process gains per-agent runtimes behind the registry,
and session/tab metadata generalizes so the registry routes per session
by agent kind instead of hard-coding Claude.

Claude keeps its existing Agent SDK transport. Despite its name,
`ClaudeAcpRuntime` is not generic ACP stdio. OpenCode, Codex, and future
ACP-compatible agents share a generic ACP stdio runtime.

## Current code facts (anchor for the plan)

- `ChatRuntimeRegistry` (`src/main/chat-runtimes/index.ts`) keys runtimes
  on a single `ClaudeChatRuntime = 'acp'` id. `getDefaultRuntimeId()`
  returns `'acp'` and `getRuntime(sessionId)` ignores the session id, so
  routing is currently Claude-only by construction.
- `ClaudeAcpRuntime` (`src/main/chat-runtimes/claude-acp.ts`) implements
  the `ChatRuntime` interface over `@anthropic-ai/claude-agent-sdk`
  `query()`. It owns the full lifecycle: start/send, streaming event
  normalization into `jsonClaude/*` entries, partial-delta batching,
  interrupt, kill, error/auth/rate-limit cards. Capabilities come from
  `defaultAcpCapabilities()`.
- `JsonClaudeSession` (`src/shared/state/json-claude/types.ts`) carries
  `permissionMode`, `capabilities`, `state`, `entries` — but no
  agent-kind or runtime-id field today. `ClaudeChatRuntime = 'acp'` is
  the only runtime discriminator type.
- Terminal tabs already carry `agentKind` (`'claude' | 'codex' |
  'opencode'`); `AGENT_REGISTRY` (`src/shared/agent-registry`) defines
  display names and whether Harness or the agent assigns the session id.
- `PanesFSM.convertTabType` (`src/main/panes-fsm/panes-fsm.ts`) refuses
  to swap any non-Claude agent tab to a json-claude tab today.
- Packaging already unpacks native binaries from `app.asar`:
  `asarUnpack` covers `node-pty` and `@anthropic-ai/claude-agent-sdk`
  native platform packages, and `resolveClaudeAgentSdkExecutablePath`
  rewrites the `app.asar` path to `app.asar.unpacked` for the bundled
  `claude` executable.
- Headless/PR CI runs `scripts/smoke-headless.sh` after build/tests.

## Architecture

### Runtime model

- `ClaudeAcpRuntime` becomes `ClaudeSdkRuntime` (or keeps its file name
  with a corrected doc comment) and remains the reference for the SDK
  transport. Naming in docs/code no longer implies it is the generic ACP
  stdio path.
- New `AcpStdioRuntime` (shared by OpenCode and Codex) implements the
  same `ChatRuntime` interface but drives a spawned subprocess over ACP
  stdio JSON-RPC instead of an SDK `query()`.
- `ChatRuntimeRegistry` routes by agent kind. `register(agentKind,
  runtime)` maps each of `claude`/`opencode`/`codex` to a runtime
  instance; `getRuntime(sessionId)` looks up the session's agent kind
  from the slice (not a hard-coded default) and returns the right
  runtime. No `getDefaultRuntimeId()` short-circuit.
- A single `AcpStdioRuntime` instance per agent kind, or one shared
  client keyed internally by session — both acceptable; the key is that
  per-session routing reaches the right transport.

### State + transport model

- Keep the `jsonClaude` slice and `jsonClaude:*` IPC surface as the
  contract to avoid a broad rename. Add a `runtimeId`/`agentKind` field
  to `JsonClaudeSession` (and the `sessionStarted` event) so the registry
  and renderer can reason about which agent a session belongs to.
- Generalize `ClaudeChatRuntime` into a wider union (e.g. `ChatRuntimeId
  = 'claude' | 'opencode' | 'codex'`) or keep a discriminated
  `runtimeId` string; wire the tab's `agentKind` through session start.
- Chat tabs stay distinct from PTY-backed terminal tabs.

### Session lifecycle

- `start()` mirrors Claude: boot slice state, then first `send()`
  creates the subprocess/query.
- `persistSession: false`-style behavior for Claude stays. For the stdio
  runtimes, Harness owns visible session state; ACP transcripts are
  treated as runtime bootstrap, not Harness-managed resume.
- `interrupt`, `kill`, `killAll`, `cancelQueued`, `rewindTo`,
  `setPermissionMode`, `getCapabilities` all keep their `ChatRuntime`
  signatures and are implemented per runtime against what each transport
  exposes.

### Streaming behavior

- Claude keeps its existing SDK normalization and delta batching.
- The ACP stdio runtime maps ACP protocol messages into the same
  `jsonClaude/*` entry events (assistant/user/tool/result), reusing the
  same partial-entry + batched-delta pattern so the store does not churn
  per token.
- Where OpenCode/Codex surface features Claude's SDK normalizes
  differently (permission/approval requests, tool progress, rate limits),
  the stdio runtime normalizes to the closest existing entry/card event;
  unsupported capabilities stay gated via capabilities, not runtime
  conditionals in the renderer.

### Capability model

Per-runtime `default*Capabilities()` factories mirroring
`defaultAcpCapabilities()`. Claude keeps the current defaults. OpenCode
and Codex start conservative; `canApproveTools`, `canSetPermissionMode`,
`canRewind`, etc. flip to true only where the ACP transport exposes
enough structure. UI gates from capabilities, never runtime ids.

## Bundled runtime dependencies

- **Claude**: unchanged — existing bundled `@anthropic-ai/claude-agent-sdk`
  (already `asarUnpack`ed, executable resolved in packaged app).
- **OpenCode**: bundle `opencode-ai`, launched as `opencode acp`. Pin the
  exact version in `dependencies` and lockfile.
- **Codex**: bundle `@agentclientprotocol/codex-acp`, which ships a
  compatible bundled Codex executable. Pin exact version and lockfile.
- No `install-on-demand` prompts and no dependence on a global `opencode`
  / `codex` on the user's PATH.

### Packaging requirements

- Keep native executables **outside** `app.asar` (extend `asarUnpack` /
  `extraResources`), preserve executable bits on extraction.
- Package platform/arch optional dependencies for each bundled runtime so
  the right native binary ships per target (`darwin-arm64`,
  `darwin-x64`, `linux-x64`, `linux-arm64` where supported).
- macOS code sign + notarize the new bundled binaries (they must not trip
  hardened runtime / Gatekeeper).
- Add packaged smoke coverage that boots the built app and confirms each
  bundled runtime resolves its executable and spawns (extend the existing
  headless smoke path or add a packaged-app smoke step).
- Reuse the `resolveClaudeAgentSdkExecutablePath` pattern for the new
  runtimes' native executable + resource resolution in the packaged app.

## Session and tab metadata generalization

- Add `agentKind`/`runtimeId` to `JsonClaudeSession` and the
  `jsonClaude/sessionStarted` payload so the registry routes per session.
- Persisted tab shape already carries `agentKind` on agent tabs; extend
  `json-claude` tabs to carry `agentKind` too so a reopened chat tab
  routes to the right runtime.
- Lift the `convertTabType` non-Claude refusal: allow `agent` ↔
  `json-claude` conversion for OpenCode and Codex. Conversion must
  preserve the on-disk session identity per agent (Claude jsonl,
  OpenCode session, Codex session) the way Claude conversion does today,
  and the destination component self-spawns the matching agent on mount.
- `PanesFSM.ensureInitialized` already branches to a json-claude default
  tab only for Claude; generalize to honor a per-agent default-tab-type
  preference so OpenCode/Codex can default to chat tabs too.

## Phases

### Phase 1 — Generalize session/registry metadata (no new runtimes)

- Add `agentKind`/`runtimeId` to `JsonClaudeSession` + `sessionStarted`;
  widen the runtime-id type; thread agent kind from the tab into session
  start.
- Registry: replace hard-coded default routing with per-session routing
  by agent kind; keep only Claude registered.
- Update `PanesFSM` to carry agentKind on json-claude tabs and relax the
  convert refusal plumbing (guard stays effective until Codex/OpenCode
  runtimes land).
- Persistence migration for the new session/tab field.
- Tests: reducer, wire-merge, panes-fsm, registry routing.

### Phase 2 — Shared ACP stdio runtime client

- Implement `AcpStdioRuntime` implementing `ChatRuntime` over a spawned
  ACP stdio subprocess (JSON-RPC message loop, spawn/lifecycle, stream
  normalization, interrupt/kill, capability mapping).
- Add the reusable stdio client under `src/main/chat-runtimes/` with unit
  coverage for message framing, lifecycle, and normalization.
- Keep Claude on the SDK transport behind the same interface; do not move
  Claude to the stdio client in this phase.

### Phase 3 — Bundle and package OpenCode + Codex

- Add `opencode-ai` and `@agentclientprotocol/codex-acp` as pinned
  dependencies; platform/arch optional deps.
- Register `opencode` and `codex` runtimes on `AcpStdioRuntime`.
- Packaging: asarUnpack/extraResources for native binaries, preserve exec
  bits, macOS sign/notarize, executable path resolution in packaged app.
- Packaged smoke coverage for each runtime.

### Phase 4 — Wiring + rollout surface

- Tab conversion for OpenCode/Codex; per-agent default-tab-type.
- Renderer capabilities gating already in place; add per-agent affordances
  only where capabilities allow.
- Auth/session rehydration paths per agent (transcript/session discovery
  differs: Claude jsonl, OpenCode session list/export, Codex sessions).
- Rollout flag if needed to ship incrementally.

## Affected paths

- `src/main/chat-runtimes/index.ts` — registry routing by agent kind
- `src/main/chat-runtimes/types.ts` — `ChatRuntime` contract, runtime-id type
- `src/main/chat-runtimes/claude-acp.ts` — SDK runtime (nomenclature/rename)
- `src/main/chat-runtimes/acp-stdio.ts` (new) — shared ACP stdio runtime + client
- `src/shared/state/json-claude/types.ts` — `runtimeId`/`agentKind`, runtime-id union
- `src/shared/state/json-claude/json-claude.ts` + `constants.ts` — sessionStarted payload, per-runtime capabilities
- `src/shared/state/json-claude/json-claude.test.ts` + `wire-merge.test.ts`
- `src/main/panes-fsm/panes-fsm.ts` — agentKind on json-claude tabs, convert relaxation, default-tab-type
- `src/main/persistence-migrations/persistence-migrations.ts` — new field migration
- `src/shared/agent-registry/agent-registry.ts` — per-agent runtime mapping as needed
- `package.json` / `pnpm-lock.yaml` — pinned `opencode-ai`, `@agentclientprotocol/codex-acp`
- `electron-builder` build config (`build` block) — asarUnpack/extraResources, platform deps, signing
- `scripts/smoke-headless.sh` (or a packaged smoke step) — bundled-runtime boot coverage

## Test matrix

- Registry routing: each agent kind resolves the correct runtime per
  session; unknown session/kind handled.
- State: `sessionStarted` carries agentKind; capabilities per runtime;
  wire-merge of new field across old/new server skew.
- Panes-FSM: agent ↔ json-claude conversion for claude/opencode/codex;
  session identity preserved; default-tab-type per agent.
- Runtime (unit): Claude SDK unchanged; `AcpStdioRuntime` framing,
  spawn, interrupt, kill, stream normalization, error cards.
- Packaging: asarUnpack/extraResources lands native binaries outside
  asar with exec bits; platform/arch deps resolve; macOS sign+notarize
  passes; packaged smoke boots and spawns each runtime.
- Headless/PR CI: existing typecheck, build, vitest, and smoke all green.

## Rollout

- Ship Claude-only behavior first (Phase 1 lands with no visible change
  beyond metadata); then add OpenCode and Codex behind the same surface.
- If a feature flag is used, default flags off until the stdio runtime
  is validated in packaged builds, then flip per agent.
- Watch for regressions in Claude chat tabs (streaming, approvals,
  rewind, rate-limit cards) since session metadata changes touch shared
  paths.

## Non-goals

- Do not require a global CLI install or offer install-on-demand prompts.
- Do not port Claude off the SDK onto the shared ACP stdio client in
  this effort — it stays on its existing transport behind the same
  interface.
- Do not rename the `jsonClaude` slice/transport surface in this effort;
  generalization is additive.
- Defer a direct Codex app-server enhanced adapter (driving Codex's
  app-server API rather than the ACP stdio runtime) as a future,
  separate task.
- Do not add renderer-wide runtime conditionals; keep capability gating.

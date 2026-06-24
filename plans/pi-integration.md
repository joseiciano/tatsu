# Pi integration plan

## Goal

Add Pi (`https://pi.dev/`) as fourth supported terminal agent next to Claude Code, Codex, and Opencode.

First ship should make Pi available anywhere existing terminal-backed agents work:

- Settings default-agent picker
- New worktree agent picker
- `+` alternate-agent tab cycling
- persisted tabs and worktrees
- terminal status dots (`processing`, `waiting`, `needs-approval`)
- restart / resume where Pi session files allow it
- per-agent command, model, and env var settings
- headless/control-server API agent selection

Do not block first ship on JSON-mode chat, MCP, or cost tracking. Pi has its own RPC/SDK paths, but current app already has a clean terminal-agent abstraction. Start there.

## Pi facts that shape design

From Pi docs:

- CLI binary: `pi`
- Install: `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` or `curl -fsSL https://pi.dev/install.sh | sh`
- Auth:
  - interactive `/login` inside Pi
  - API keys via env vars or `~/.pi/agent/auth.json`
- Config and sessions:
  - global settings: `~/.pi/agent/settings.json`
  - project settings: `.pi/settings.json`
  - extensions: `~/.pi/agent/extensions/*.ts` and `.pi/extensions/*.ts`
  - sessions: `~/.pi/agent/sessions/`
- Extension events useful for Harness status:
  - `session_start`, `session_shutdown`
  - `agent_start`, `agent_end`
  - `turn_start`, `turn_end`
  - `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
  - `tool_call`
  - `model_select`
- CLI flags useful for first pass:
  - `--model <pattern>`
  - `--session <path>`
  - `-c` / `--continue`
  - `--name <name>`
  - `--approve` / `--no-approve` (project trust override, NOT tool approval)
  - `--mode rpc`, `--mode json`, `-p` / `--print` for future non-TUI modes
- Core Pi intentionally does not ship MCP. A community adapter exists, but Harness should not install it automatically.

Useful source links:

- Pi homepage: https://pi.dev/
- Docs index: https://pi.dev/docs/latest
- Quickstart: https://pi.dev/docs/latest/quickstart
- Settings: https://pi.dev/docs/latest/settings
- Providers/auth: https://pi.dev/docs/latest/providers
- Extensions: https://pi.dev/docs/latest/extensions
- RPC mode: https://pi.dev/docs/latest/rpc
- JSON mode: https://pi.dev/docs/latest/json
- SDK: https://pi.dev/docs/latest/sdk
- Session format: https://pi.dev/docs/latest/session-format
- GitHub: https://github.com/earendil-works/pi
- npm package: https://www.npmjs.com/package/@earendil-works/pi-coding-agent

Resolved questions (verified from Pi docs):

1. **TUI initial-prompt support** — Yes. Default TUI accepts positional prompt text: `pi "List all .ts files in src/"`. No special flag needed.
2. **Extension API for session file/path/id** — Stable. Every event handler receives `ctx.sessionManager` with `getSessionFile()` (absolute `.jsonl` path), `getSessionId()` (UUID), `getSessionDir()`, `getCwd()`, `isPersisted()`.
3. **`--session <path|id>` behavior** — Accepts both absolute file path and partial UUID. Session files live at `~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl` where `<path>` is cwd with `/` replaced by `-`. Store absolute path from `getSessionFile()`, pass to `--session` for resume.
4. **Extension auto-loading** — Yes. Files in `~/.pi/agent/extensions/*.ts` are auto-discovered and loaded for every Pi session with no extra enablement. Loaded via jiti (TypeScript without compilation). Project-local `.pi/extensions/` requires project trust; global scope does not.

## Current codebase map

### Canonical agent types

- `src/shared/state/terminals/types.ts`
  - `AgentKind = 'claude' | 'codex' | 'opencode'`
  - `TerminalTab.agentKind?: AgentKind`
- `src/shared/state/settings/types.ts`
  - `AgentKindSetting = 'claude' | 'codex' | 'opencode'`
  - settings fields exist per agent for command/model/env vars

### Registry and cycling

- `src/shared/agent-registry/agent-registry.ts`
  - `AGENT_REGISTRY`
  - `getAgentInfo`
  - `agentDisplayName`
  - `getNextAgentKind`
  - `cycleAltAgent`
  - model option lists for Claude and Codex
- `src/shared/agent-registry/agent-registry.test.ts`

### Main-process agent abstraction

- `src/main/agents/index.ts`
  - `AgentModule` interface
  - `agents: Record<AgentKind, AgentModule>`
  - `getAgent(kind)`
- Existing modules:
  - `src/main/agents/claude.ts`
  - `src/main/agents/codex.ts`
  - `src/main/agents/opencode.ts`
- Existing tests:
  - `src/main/agents/claude.test.ts`
  - `src/main/agents/codex.test.ts`
  - `src/main/agents/opencode.test.ts`

### Kind parsing

- `src/main/agent-kind/agent-kind.ts`
  - `toAgentKind` defaults unknown values to `claude`
- `src/main/agent-kind/agent-kind.test.ts`

### Hook/status pipeline

- `src/main/hooks/hooks.ts`
  - watches `/tmp/harness-status/<terminal-id>.ndjson`
  - expects normalized events: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `Notification`
  - derives terminal statuses from those normalized events
  - discovers agent-assigned session id from `payload.session_id`
- Existing agents already normalize their own hook/event systems into this pipeline.
- Pi should do same via user-scope extension file, not via a new status transport.

### Settings persistence and transport

- `src/shared/state/settings/types.ts`
- `src/shared/state/settings/constants.ts`
- `src/shared/state/settings/settings.ts`
- `src/shared/state/settings/settings.test.ts`
- `src/main/persistence/types.ts`
- `src/main/build-initial-state/build-initial-state.ts`
- `src/main/index.ts`
  - `config:setDefaultAgent`
  - `config:set{Claude,Codex,Opencode}Command`
  - `config:set{Claude,Codex,Opencode}Model`
  - `config:set{Claude,Codex,Opencode}EnvVars`
- `src/renderer/build-backend/build-backend.ts`
- `src/renderer/types/types.ts`

### Terminal creation and spawning

- `src/main/panes-fsm/panes-fsm.ts`
  - initial agent tab uses `getDefaultAgentKind()` and `getAgentInfo()`
  - only Claude can convert between terminal agent tab and JSON chat tab
- `src/renderer/hooks/useTabHandlers/useTabHandlers.ts`
  - creates agent tabs using registry labels
- `src/renderer/hooks/useWorktreeHandlers/useWorktreeHandlers.ts`
  - passes `agentKind` through new worktree creation
- `src/main/worktrees-fsm/worktrees-fsm.ts`
  - has hard-coded `agentKind?: 'claude' | 'codex' | 'opencode'` annotations
- `src/main/index.ts`
  - `agent:buildSpawnArgs` picks command/model per kind
  - PTY create path picks per-agent env vars

### Renderer UI

- `src/renderer/components/Settings/Settings.tsx`
  - per-agent command/model/env/default-agent controls
- `src/renderer/components/NewWorktreeScreen/NewWorktreeScreen.tsx`
  - agent picker
- `src/renderer/components/TerminalPanel/TerminalPanel.tsx`
  - alternate-agent cycling
- `src/renderer/components/AgentIcon/AgentIcon.tsx`
  - currently has Claude and Codex icons only; Opencode falls back to Claude icon

### Cost tracking

- `src/main/cost-tracker/cost-tracker.ts`
- `src/main/cost-aggregator/cost-aggregator.ts`
- `src/main/jsonl-fold/jsonl-fold.ts`
- `src/shared/pricing/pricing.ts`

First Pi release should not parse Pi costs. Add later after session/event format verified.

## Architecture decision

Use existing terminal-agent path for first release:

```text
Renderer agent tab → agent:buildSpawnArgs → PtyManager → /bin/zsh -ilc "pi ..."
Pi extension → /tmp/harness-status/<terminal-id>.ndjson → hooks watcher → terminals/statusChanged
```

Why this path:

- Smallest change set.
- Matches Codex and Opencode integration style.
- Keeps renderer generic through `AgentKind` + `AGENT_REGISTRY`.
- Avoids introducing Pi RPC runtime before product shape is known.
- Avoids coupling Electron main process to Pi SDK version/runtime.

Do not use Pi RPC mode for terminal tabs. RPC mode is future fit for dedicated React chat tabs, not xterm-hosted TUI tabs.

## Implementation phases

### Phase 0 — verify Pi behavior manually

Install Pi in disposable environment and verify:

```bash
pi --version
pi --help
pi --model '<known-model>'
pi --session '<path-from-existing-session>'
pi -c
```

Create user-scope test extension under `~/.pi/agent/extensions/` that writes events to temp file, then verify:

- extension loads automatically
- `HARNESS_TERMINAL_ID` from subprocess env is visible inside extension
- event payload/context exposes stable session file/path/id
- tool execution events include tool name and input
- Pi has no built-in permission popups or approval flow (confirmed from docs). `tool_call` event can block tools programmatically but there is no interactive approval prompt. Do not map approval events for first ship.

Output of this phase:

- `session_id` = `ctx.sessionManager.getSessionFile()` (absolute `.jsonl` path)
- initial prompt = positional argument: `pi "<prompt>"`
- resume syntax = `--session <absolute-path>`

### Phase 1 — expand shared agent type and registry

Files:

- `src/shared/state/terminals/types.ts`
- `src/shared/state/settings/types.ts`
- `src/shared/agent-registry/agent-registry.ts`
- `src/shared/agent-registry/agent-registry.test.ts`
- `src/main/agent-kind/agent-kind.ts`
- `src/main/agent-kind/agent-kind.test.ts`
- `src/main/control-server/control-server.ts`
- `src/main/control-server/types.ts`

Changes:

1. Add `'pi'` to `AgentKind`.
2. Add `'pi'` to `AgentKindSetting`.
3. Add registry row:

   ```ts
   { kind: 'pi', displayName: 'Pi', vendor: 'Earendil', assignsSessionId: false }
   ```

4. Update `toAgentKind` to return `'pi'` for `value === 'pi'`.
5. Update control-server agent parser to accept `pi`.
6. Update registry cycling tests so default-agent and alternate-agent cycling include Pi.
7. Update agent-kind tests.

Notes:

- `assignsSessionId: false` because Pi owns session files/ids.
- `cycleAltAgent` should pick Pi automatically once registry includes it.

### Phase 2 — add Pi settings state, persistence, and IPC

Files:

- `src/shared/state/settings/types.ts`
- `src/shared/state/settings/constants.ts`
- `src/shared/state/settings/settings.ts`
- `src/shared/state/settings/settings.test.ts`
- `src/main/persistence/types.ts`
- `src/main/build-initial-state/build-initial-state.ts`
- `src/main/index.ts`
- `src/renderer/build-backend/build-backend.ts`
- `src/renderer/types/types.ts`

Add fields:

```ts
piCommand: string
piEnvVars: Record<string, string>
piModel: string | null
```

Defaults:

```ts
piCommand: ''      // renderer initial placeholder
piEnvVars: {}
piModel: null
```

Main boot hydration:

```ts
piCommand: config.piCommand || 'pi'
piEnvVars: config.piEnvVars || {}
piModel: config.piModel || null
```

Persisted config:

```ts
defaultAgent?: 'claude' | 'codex' | 'opencode' | 'pi'
piCommand?: string
piEnvVars?: Record<string, string>
piModel?: string
```

Reducer events:

```ts
settings/piCommandChanged
settings/piEnvVarsChanged
settings/piModelChanged
```

Transport handlers:

```ts
config:setPiCommand
config:setPiEnvVars
config:setPiModel
```

Handler behavior should mirror Opencode:

- empty or `pi` command deletes `config.piCommand`
- empty env var map deletes `config.piEnvVars`
- null model deletes `config.piModel`

Tests:

- default state includes Pi fields
- reducer updates command/model/env vars
- boot hydration reads config values and falls back to defaults
- config type accepts `defaultAgent: 'pi'`

### Phase 3 — implement `src/main/agents/pi.ts`

Files:

- `src/main/agents/pi.ts`
- `src/main/agents/pi.test.ts`
- `src/main/agents/index.ts`

Module shape:

```ts
export const defaultCommand = 'pi'
export const assignsSessionId = false
export const hookEvents = [
  'session_start',
  'agent_start',
  'agent_end',
  'tool_execution_start',
  'tool_execution_end',
  'session_shutdown'
]
```

Add to agent map:

```ts
import * as pi from './pi'

const agents: Record<AgentKind, AgentModule> = { claude, codex, opencode, pi }
```

#### Pi extension file

Install a Harness-owned extension at:

```text
~/.pi/agent/extensions/harness-status.ts
```

Use signature:

```text
harness-pi-extension
```

Extension should:

- no-op unless `process.env.HARNESS_TERMINAL_ID || process.env.CLAUDE_HARNESS_ID` exists
- create `/tmp/harness-status`
- append one JSON line per event to `/tmp/harness-status/<terminal-id>.ndjson`
- normalize Pi events into existing Harness event names

Target normalized mapping:

| Pi event | Harness event | Payload |
|---|---|---|
| `session_start` | `UserPromptSubmit` | `{ session_id }` |
| `agent_start` | `UserPromptSubmit` | `{ session_id }` |
| `tool_execution_start` | `PreToolUse` | `{ session_id, tool_name, tool_input }` |
| `tool_execution_end` | `PostToolUse` | `{ session_id, tool_name, tool_input }` |
| `agent_end` | `Stop` | `{ session_id, transcript_path }` if available |
| `session_shutdown` | `Stop` | `{ session_id, transcript_path }` if available |
| ~~approval~~ | ~~not mapped~~ | Pi has no built-in approval flow; see note below |

Pi intentionally has no built-in permission popups. The `tool_call` event can block tools programmatically (extension decision), but there is no interactive "approve this tool?" prompt. Do not emit `Notification permission_prompt` for Pi first ship. Status dots will show `processing` / `waiting` only. If a future Pi extension adds interactive approval, map it then.
`session_id` should be stable resume handle. Prefer absolute session file path if Pi's CLI resumes with `--session <path>`. If Pi exposes separate id and file path, emit path as `session_id` and path again as `transcript_path` so existing discovery/resume/cost hooks have same handle.

`installHooks()`:

- create `~/.pi/agent/extensions`
- write generated extension file
- overwrite only Harness-owned file

`hooksInstalled()`:

- check file exists and contains signature

`uninstallHooks()`:

- remove only if signature exists

`stripHooksFromWorktree()`:

- return false; Pi first ship has no legacy per-worktree Harness extension

#### Session helpers

`sessionFileExists(cwd, sessionId)`:

- if `sessionId` is absolute or starts with `~`, resolve and `existsSync`
- otherwise search `~/.pi/agent/sessions/` for matching basename/id after Phase 0 verifies format
- return false on errors

`latestSessionId(cwd)`:

- list files under `~/.pi/agent/sessions/`
- filter regular session files after format verified
- sort by mtime desc
- return absolute path to newest file
- return null on errors

`buildSpawnArgs(opts)`:

- start with `opts.command`
- add `--model <quoted>` when `opts.model` is set and command does not already include `--model`
- add `--name <quoted>` when `opts.sessionName` is set and command does not already include `--name`
- resume with `--session <quoted-session-path>` when `opts.sessionId` exists and `sessionFileExists` is true
- initial prompt:
  - if Phase 0 confirms default TUI prompt syntax, use it
  - if not confirmed, do not append prompt for Pi terminal tabs; document limitation in settings help text

Quoting:

- use same local `shellQuote` helper style as existing agents
- tests should cover quotes in model, session path, name, prompt

#### Tests for `pi.ts`

- installs extension in temp home path
- `hooksInstalled` detects signature
- reinstall overwrites stale Harness file without duplicating
- uninstall removes only signature-owned file
- uninstall leaves user file without signature untouched
- `stripHooksFromWorktree` returns false
- `sessionFileExists` accepts existing absolute session path
- `latestSessionId` picks newest session file
- `buildSpawnArgs` adds model
- `buildSpawnArgs` resumes existing session
- `buildSpawnArgs` does not append duplicate `--model` or `--session`
- initial prompt behavior matches Phase 0 decision

### Phase 4 — register Pi in global hook install/uninstall

Files:

- `src/main/index.ts`

Current code hard-codes:

```ts
[getAgent('claude'), getAgent('codex'), getAgent('opencode')]
```

Change to one source:

```ts
for (const { kind } of AGENT_REGISTRY) {
  getAgent(kind).installHooks()
}
```

Do same for uninstall.

Import `AGENT_REGISTRY` from shared registry.

Benefit: future agents avoid another hard-coded list.

### Phase 5 — wire spawn args, env vars, and model selection

Files:

- `src/main/index.ts`
- `src/renderer/build-backend/build-backend.ts`
- `src/renderer/types/types.ts`

Update `agent:buildSpawnArgs` command/model switch:

```ts
const command =
  kind === 'claude' ? (config.claudeCommand || agent.defaultCommand) :
  kind === 'codex' ? (config.codexCommand || agent.defaultCommand) :
  kind === 'opencode' ? (config.opencodeCommand || agent.defaultCommand) :
  (config.piCommand || agent.defaultCommand)
```

Model resolution:

```ts
if (kind === 'pi') model = override || config.piModel || null
```

PTY env vars:

- add Pi branch where Claude/Codex/Opencode env vars are merged now
- Pi env vars should be passed only for Pi tabs

MCP:

- `writeMcpConfigForTerminal` currently runs for all agents before calling `buildSpawnArgs`
- Pi should ignore `mcpConfigPath`
- optional cleanup: add `supportsHarnessMcp?: boolean` to `AgentModule` later; not required for first ship

### Phase 6 — remove hard-coded agent-kind unions

Files:

- `src/main/worktrees-fsm/worktrees-fsm.ts`
- any renderer/main file with `'claude' | 'codex' | 'opencode'`

Changes:

- replace local literal unions with imported `AgentKind`
- ensure request payloads and worktree creation params accept Pi
- update tests/fixtures that create worktrees with agent kinds

Search command:

```bash
rg "'claude' \| 'codex' \| 'opencode'|claude' \| 'codex' \| 'opencode|AgentKindSetting" src
```

### Phase 7 — renderer UI updates

Files:

- `src/renderer/components/Settings/Settings.tsx`
- `src/renderer/components/AgentIcon/AgentIcon.tsx`
- `src/renderer/components/NewWorktreeScreen/NewWorktreeScreen.tsx`
- `src/renderer/components/TerminalPanel/TerminalPanel.tsx`
- `src/renderer/App/App.tsx`

Settings:

- add Pi to default-agent picker through registry where possible
- add Pi command input
- add Pi model input
- add Pi env vars editor
- add help copy:
  - install: `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`
  - auth: run `pi`, then `/login`, or set provider API key env vars
  - sessions live under `~/.pi/agent/sessions/`
  - MCP not enabled by Harness for Pi first ship

Model UI:

- Prefer freeform model field for Pi first ship.
- Pi supports providers and model patterns; fixed model enum will stale quickly.
- Do not add `PI_MODELS` unless docs expose stable recommended set.

Icons:

- Add Pi icon or neutral currentColor glyph in `AgentIcon`.
- Also add Opencode icon while touching this file, or at least avoid Pi falling through to Claude.
- Use `width="1em" height="1em"` as existing icons do; call sites should continue using `icon-*` classes.

New worktree / Terminal panel:

- If these components already use `AGENT_REGISTRY`, Pi appears automatically.
- Verify any fixed layout assumptions with four agents.

### Phase 8 — persistence and migrations

No schema migration should be necessary if persisted tabs already store `agentKind` strings and unknown old values fallback through `toAgentKind`.

Still verify:

- old configs without Pi fields hydrate with defaults
- configs with `defaultAgent: 'pi'` hydrate correctly
- tabs persisted with `agentKind: 'pi'` restore correctly
- remote/web clients receiving older snapshots do not crash

If wire snapshot merge has any explicit agent-setting assumptions, update tests in:

- `src/shared/state/wire-merge.test.ts`

### Phase 9 — cost tracking follow-up, not first ship

Pi sessions are under `~/.pi/agent/sessions/` and docs mention JSONL tree format. Later work:

- add `foldPiLines` in `src/main/jsonl-fold/jsonl-fold.ts`
- update `src/main/cost-tracker/cost-tracker.ts` format union
- update `src/main/cost-aggregator/cost-aggregator.ts`
- add Pi pricing/model provider handling in `src/shared/pricing/pricing.ts`
- subscribe to Pi `Stop` events only if `transcript_path` points to parseable session file

Do not estimate Pi costs from incomplete extension events.

### Phase 10 — future JSON/RPC chat path

Pi exposes better programmatic modes than a TUI:

- `pi --mode rpc` with stdin/stdout JSONL
- `pi --mode json` for one-shot JSON event stream
- `@earendil-works/pi-coding-agent` SDK

Future chat plan:

- generalize `json-claude` slice naming or add runtime-specific chat slice
- implement `PiRpcRuntime` behind `ChatRuntimeRegistry`
- map RPC events to existing chat entry events
- use capabilities to gate Pi-specific affordances
- keep terminal-agent Pi support independent

Do this after terminal support proves useful.

## Detailed file checklist

### Shared state

- [ ] `src/shared/state/terminals/types.ts` — add `'pi'` to `AgentKind`
- [ ] `src/shared/state/settings/types.ts` — add `'pi'` to `AgentKindSetting`, add Pi settings fields
- [ ] `src/shared/state/settings/constants.ts` — initialize Pi settings fields
- [ ] `src/shared/state/settings/settings.ts` — add Pi reducer events
- [ ] `src/shared/state/settings/settings.test.ts` — add Pi reducer tests
- [ ] `src/shared/state/wire-merge.test.ts` — update only if Pi fields need explicit merge coverage

### Registry

- [ ] `src/shared/agent-registry/agent-registry.ts` — add Pi registry row
- [ ] `src/shared/agent-registry/agent-registry.test.ts` — update cycling tests

### Main process

- [ ] `src/main/agent-kind/agent-kind.ts` — parse `pi`
- [ ] `src/main/agent-kind/agent-kind.test.ts` — test `pi`
- [ ] `src/main/agents/pi.ts` — new module
- [ ] `src/main/agents/pi.test.ts` — hook/session/spawn tests
- [ ] `src/main/agents/index.ts` — import/register Pi
- [ ] `src/main/persistence/types.ts` — add persisted Pi config fields
- [ ] `src/main/build-initial-state/build-initial-state.ts` — hydrate Pi settings
- [ ] `src/main/index.ts` — Pi settings handlers, hook install loop, spawn command/model/env vars
- [ ] `src/main/worktrees-fsm/worktrees-fsm.ts` — replace hard-coded unions with `AgentKind`
- [ ] `src/main/control-server/control-server.ts` — parse Pi agent kind
- [ ] `src/main/control-server/types.ts` — accept Pi type

### Renderer

- [ ] `src/renderer/build-backend/build-backend.ts` — expose Pi settings methods
- [ ] `src/renderer/types/types.ts` — expose Pi settings methods
- [ ] `src/renderer/components/Settings/Settings.tsx` — Pi UI section
- [ ] `src/renderer/components/AgentIcon/AgentIcon.tsx` — Pi icon/fallback
- [ ] `src/renderer/components/NewWorktreeScreen/NewWorktreeScreen.tsx` — verify Pi appears
- [ ] `src/renderer/components/TerminalPanel/TerminalPanel.tsx` — verify cycling with four agents
- [ ] `src/renderer/App/App.tsx` — verify badge/default-agent display

### Tests and verification

- [ ] `npx vitest run src/main/agents/pi.test.ts`
- [ ] `npx vitest run src/main/agent-kind/agent-kind.test.ts src/shared/agent-registry/agent-registry.test.ts src/shared/state/settings/settings.test.ts`
- [ ] `pnpm typecheck`
- [ ] `pnpm build`
- [ ] manual: install Pi, accept hooks consent, open Pi tab, run prompt, observe status dot
- [ ] manual: Pi tool call shows `processing` status dot (no `needs-approval` — Pi has no built-in approval flow)
- [ ] manual: restart Pi tab preserves/resumes session when session path exists
- [ ] manual: set default agent to Pi, create new worktree, confirm Pi+Shell tabs
- [ ] manual: remote/headless control server can create Pi worktree/tab

## Risks and mitigations

### Pi TUI initial prompt may not be supported

Mitigation:

- first ship can omit initial prompt for Pi terminal tabs if default TUI has no stable syntax
- show note in Settings/New Worktree when Pi is selected
- future Pi RPC chat can support initial prompts cleanly

### Pi session id may be file path, not opaque id

Mitigation:

- store absolute session path in existing `TerminalTab.sessionId`
- existing type is `string`; no schema change needed
- quote path in `--session`

### Extension API may change

Mitigation:

- isolate all Pi event assumptions in `src/main/agents/pi.ts`
- include signature/version in generated extension
- tests cover generated extension content, not Pi runtime
- manual smoke on every Pi version bump

### MCP mismatch

Mitigation:

- ignore `mcpConfigPath` in Pi build args
- do not install community MCP adapter automatically
- document Pi MCP as unsupported in first ship

### Secret leakage through env vars

Mitigation:

- reuse existing per-agent env var editor behavior
- do not log `piEnvVars`
- do not copy env vars into generated extension

### Status mapping — no approval flow

Pi intentionally has no built-in permission popups or approval flow. First ship maps `processing` / `waiting` / `tool` statuses only. `needs-approval` will not fire for Pi tabs.

Mitigation:

- map `tool_execution_start` → `PreToolUse` and `tool_execution_end` → `PostToolUse` for status dots
- do not emit `Notification permission_prompt` — Pi has no interactive approval prompt
- if a future Pi extension adds approval, map it then

## Acceptance criteria

Pi support is complete for first ship when:

1. `AgentKind` and default-agent settings accept `pi` everywhere.
2. Settings can configure Pi command, model, and env vars.
3. User can create Pi terminal tabs from existing tab/worktree flows.
4. Pi tabs spawn `pi` through login shell like other terminal agents.
5. Harness installs/removes only its own Pi extension after hooks consent.
6. Pi extension writes normalized status events gated by `HARNESS_TERMINAL_ID`.
7. Main hook watcher updates Pi terminal status without new renderer-specific code.
8. Pi sessions are discovered from extension payload and persisted on tabs.
9. Restart/resume works when Pi `--session` accepts the stored path.
10. Existing Claude, Codex, and Opencode behavior stays unchanged.
11. Typecheck, build, and relevant vitest suites pass.

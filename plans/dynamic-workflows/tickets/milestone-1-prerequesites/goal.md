# Milestone 1: Prerequisites

## Goal

Close the gaps listed in `../../dynamic-workflows.md` under "Gaps found" so the workflow runner (Phase 2) can spawn, drive and complete agent steps for Claude, Codex and opencode with no client attached.

Each item ships on its own and improves today's tabs. 1, 2 and 3 fix behaviour that is broken now, independent of workflows.

Status as of 2026-10-02: every gap is still open. Two are partly done: the `[features]` placement for gap 4 (`156d4a1`), and the stable hook script plus the Settings and banner text for gap 9 (`7edfc85`).

## Items

| # | Item | Gap | Size | Depends on |
|---|---|---|---|---|
| 1 | Rewrite the opencode plugin to the documented ESM format | 3 | S | none |
| 2 | Fix the bridge's `agentKind` | 6 | XS | none |
| 3 | Hook payloads: `last_assistant_message` and line atomicity | 7 | S | 1 |
| 4 | Main-side agent spawn with create-or-attach | 1 | L | none |
| 5 | MCP for Codex and opencode | 2 | M | 1 |
| 6 | Permission levels | 5 | M | 4 |
| 7 | Folder-trust check helper | 8 | S | none |
| 8 | Codex hook trust and flag name | 9, 4 | M | none |

### 1. Rewrite the opencode plugin

- **Today:** `makePluginContent()` in `src/main/agents/opencode.ts:47` emits CommonJS `module.exports = { onEvent }` and reads `ev.payload.session.id`. Under opencode 1.18.30 it writes nothing, so opencode status detection is broken.
- **Done when:**
  - The plugin uses the documented format: `export const X = async ({ client }) => ({ event, 'tool.execute.before', 'tool.execute.after' })`.
  - Events are read as `{ type, properties }` with `properties.sessionID`. Tool calls come from the `tool.execute.*` hooks, not bus events.
  - On `session.idle`, it reads the final assistant message with `client.session.messages()` and includes it in the status line (feeds item 3).
  - Status detection works in a real opencode 1.18.x tab: working, idle and tool use show correctly.
  - `opencode.test.ts` covers the generated content.
- **Verify first:** which permission-prompt event 1.18 emits (`permission.updated` in the SDK types vs `permission.asked` in the current plugin).

### 2. Fix the bridge's `agentKind`

- **Today:** `resources/mcp-bridge.js:110` advertises `enum: ['claude', 'codex']`, and `:468-473` rejects anything else, while the server accepts `opencode`. The label at `:485` only knows Claude and Codex.
- **Done when:** `create_worktree` accepts `opencode` through the bridge, and the enum, the validation and the label all agree with the server's list.

### 3. Hook payloads

- **Today:** `src/main/hooks/hooks.ts:40` says each hook line is atomic because it is under `PIPE_BUF` (4096 B). Payloads that carry `last_assistant_message` often exceed that. `last_assistant_message` is not parsed.
- **Done when:**
  - `hooks.ts` parses `last_assistant_message` from Claude and Codex `Stop` payloads (nullable for Codex) and from the opencode plugin's idle line.
  - The comment says lines can exceed `PIPE_BUF` and why that's safe (only one agent writes each terminal file).
  - The reader keeps a partial trailing line until its newline arrives instead of dropping or mis-parsing it. Tests cover a line split across two reads.

### 4. Main-side agent spawn

- **Today:** `XTerminal.tsx:456-501` calls `agent:buildSpawnArgs` and then `pty:create`, and waits until the tab is at least 20px (`:465`). A tab in a background worktree doesn't start until someone opens it. On headless with no client attached, it never starts.
- **Done when:**
  - A main helper (`buildSpawnArgs` + `ptyManager.create`) can spawn an agent terminal with no renderer involved, at a default 120×30.
  - `pty:create` becomes create-or-attach: if the PTY already exists, the renderer joins it and replays its history instead of spawning a second one, then resizes to its layout.
  - Background and headless tabs start without being opened.
  - Existing tab behaviour is unchanged: control-taken, resize, restart and sleeping panes.

### 5. MCP for Codex and opencode

- **Today:** only Claude gets `--mcp-config` (`claude.ts:172`). The comment at `codex.ts:237` says Codex is configured globally through `~/.codex/config.toml`, but nothing writes it. opencode has no MCP wiring.
- **Done when:**
  - opencode gets the `harness-control` server per terminal through `OPENCODE_CONFIG_CONTENT`. This merges with the user's global config and is verified working.
  - Codex gets it per terminal through `-c mcp_servers.harness-control.*`. If that override doesn't work, fall back to a per-terminal `CODEX_HOME` that carries over `auth.json` and `config.toml`.
  - The stale comment in `codex.ts` is corrected.
  - A Codex tab and an opencode tab can both call a `harness-control` tool.
- **Verify first:** the Codex `-c mcp_servers.*` per-run override. Codex isn't installed on the dev machine yet.

### 6. Permission levels

- **Today:** `auto-approver` only serves chat-tab approval cards. A PTY step stops at its first permission prompt. On Claude 2.1.286, `--permission-mode plan` stops at "Would you like to proceed", and `acceptEdits` still prompts for every Bash command.
- **Done when:** `AgentSpawnOpts` takes a level of `read-only`, `edit` or `full`, mapped per the table in "Permissions & trust" of the plan:
  - **Claude:** `dontAsk` plus `--allowedTools`, passed comma-separated because the flag is variadic. The list always includes `mcp__harness-control__complete_step`. `full` maps to `bypassPermissions`.
  - **Codex:** `--sandbox read-only`, `workspace-write --ask-for-approval never`, or `danger-full-access`.
  - **opencode:** a `harness-step` agent defined in `OPENCODE_CONFIG_CONTENT` with its own `permission` map, `tools.task: false` and the step's model, launched with `--agent harness-step`. Top-level `permission` alone is not enough, because subagents use their own permissions.
  - At every level, a tool outside the allowance is denied without a prompt. Each harness is checked in a real tab.

### 7. Folder-trust check helper

- **Today:** in a folder Claude hasn't seen, it opens a trust dialog before running any prompt, and a spawned step waits on it. Trust is inherited from a trusted parent folder. Codex keeps a per-project `trust_level` in `config.toml`.
- **Done when:**
  - A read-only helper reports whether a worktree path, or one of its parents, is trusted for Claude and for Codex.
  - Tatsu never writes `~/.claude.json` or Codex trust itself.
  - Unit tests cover a trusted path, a trusted parent, an untrusted path and a missing config file.

### 8. Codex hook trust and flag name

- **Today:** since rust-v0.129.0, Codex ignores hooks until the user approves them in `/hooks`. Trust is keyed by the hook's position, `<hooks.json path>:<event>:<group>:<handler>`, plus a sha256 of the normalized entry; see "Codex hook trust" in the plan. `installHooks()` (`codex.ts:132-151`) strips Tatsu's entries and re-appends them on every boot, so a user hook added after Tatsu's entry moves it to a new index and loses trust. `ensureCodexHooksEnabled` writes `codex_hooks = true` (`codex.ts:101`), but current docs name the flag `[features] hooks`.
- **Done when:**
  - `installHooks` keeps each Tatsu entry at its index when an identical entry (same command and timeout) is already there. It replaces only legacy or mismatched entries, and skips writing `hooks.json` when nothing changed.
  - A read-only trust-status helper computes each entry's key and hash and compares them with `[hooks.state."<key>"] trusted_hash` in `~/.codex/config.toml`. A unit test pins it to a known hash.
  - Settings shows "Codex hooks need review: run /hooks" when any entry isn't trusted. The same helper will feed the launch-sheet readiness check later.
  - The flag is written as `[features] hooks` (keep reading `codex_hooks` for existing installs).
  - Tatsu never writes `trusted_hash` without an explicit opt-in.
- **Verify first:** the computed hash against a real Codex binary (≥ 0.129.0), for example with `codex app-server` `hooks/list`.

## Out of scope

- Anything in Phase 1 onward of the plan: the workflow-def package, the `workflows` slice, the runner, and the UI.
- The opt-in "Trust automatically" button for Codex hooks, and the `-c hooks.state={…}` per-launch override.
- Whether Codex hooks fire under `codex exec` (only matters for a headless driver).

## Milestone done when

- All eight items are merged, with `pnpm typecheck`, `pnpm build` and `npx vitest run` passing.
- Claude, Codex and opencode tabs each show correct status, can reach `harness-control` over MCP, and can be spawned from main with a permission level that never shows an interactive prompt.
- The plan's "Gaps found" section is updated to mark each gap closed, with the commit that closed it.

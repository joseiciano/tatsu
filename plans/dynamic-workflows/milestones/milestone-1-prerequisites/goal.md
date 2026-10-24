# Milestone 1: Prerequisites

## Goal

Close the gaps listed in `../../dynamic-workflows.md` under "Gaps found" so the workflow runner (Phase 2) can spawn, drive and complete agent steps for Claude, Codex and opencode with no client attached.

Each item ships on its own and improves today's tabs. 1, 2 and 3 fix behaviour that is broken now, independent of workflows.

Status as of 2026-10-24: gap 6 was already closed by `d4759f6` (2026-09-25) before this milestone was written, so Item 2 is reduced to a guard test. Two gaps are partly done: the `[features]` placement for gap 4 (`156d4a1`), and the stable hook script plus the Settings and banner text for gap 9 (`7edfc85`). Everything else is open.

**Pi.** Tatsu also ships a Pi tab harness (`src/main/agents/pi.ts`, `config.piCommand` / `piEnvVars` / `piModel`, `pi` branches in `agent:buildSpawnArgs` and `pty:create`). Pi is not a workflow step harness in this milestone, but every spawn path Items 4-6 move must keep its `pi` branch (command, env, model, no MCP, no permission level) and end in `assertNeverAgentKind`, so Pi tabs behave exactly as today.

**One Codex install.** Codex is not on the dev machine. Ticket 05 TASK-001 is the single `brew install codex` / `codex login` plus scratch-`CODEX_HOME` session; tickets 06 (TASK-003), 07 (TASK-001) and 08 (TASK-001) reuse it instead of installing again. Each still records "Codex not verified" if that install never happens.

## Items

| # | Item | Gap | Size | Depends on |
|---|---|---|---|---|
| 1 | Rewrite the opencode plugin to the documented ESM format | 3 | S | none |
| 2 | Guard the bridge's `agentKind` list against `AGENT_REGISTRY` (fix itself landed in `d4759f6`) | 6 | XS | none |
| 3 | Hook payloads: `last_assistant_message` and line atomicity | 7 | S | 1 |
| 4 | Main-side agent spawn with create-or-attach | 1 | L | none |
| 5 | MCP for Codex and opencode | 2 | M | 1, 4 |
| 6 | Permission levels | 5 | M | 4, 5 |
| 7 | Folder-trust check helper | 8 | S | none |
| 8 | Codex hook trust and flag name | 9, 4 | M | none |
| 9 | Codex per-terminal CODEX_HOME fallback (contingent, only if Item 5's gate fails) | 2 | S | 5, 8 |

Item 5 needs Item 4 only for its opencode phase (the spawner's `agentEnv`); its Codex phases can land first. Item 6 extends the spawner from 4 and the opencode config builder and Codex command from 5. Item 8 reuses Item 7's `codexConfigPath()` and `smol-toml` if 7 has landed, but does not wait for it.

Implementation order: 1, 2 and 7 (any order) → 3 → 4 → 5 → 6, with 8 anywhere after 7, and 9 (contingent) after 5 and 8.

Shortest path to the plan's phase 2 (Claude + shell linear runner): 3 → 4 → 7 → 6 (Claude part only; its Phase 1 and the Claude half of Phase 2 do not need ticket 05). Items 1, 5, 8 and 9 can run in parallel with phase 1/2 work and gate phase 3 (Codex and opencode steps).

### 1. Rewrite the opencode plugin

- **Today:** `makePluginContent()` in `src/main/agents/opencode.ts:47` emits CommonJS `module.exports = { onEvent }` and reads `ev.payload.session.id`. Under opencode 1.18.30 it writes nothing, so opencode status detection is broken.
- **Done when:**
  - The plugin uses the documented format: `export const X = async ({ client }) => ({ event, 'tool.execute.before', 'tool.execute.after' })`.
  - Events are read as `{ type, properties }` with `properties.sessionID`. Tool calls come from the `tool.execute.*` hooks, not bus events.
  - On `session.idle`, it reads the final assistant message with `client.session.messages()` and includes it in the status line (feeds item 3).
  - Status detection works in a real opencode 1.18.x tab: working, idle and tool use show correctly.
  - `opencode.test.ts` covers the generated content.
- **Verify first:** which permission-prompt event 1.18 emits (`permission.updated` in the SDK types vs `permission.asked` in the current plugin).

### 2. Guard the bridge's `agentKind` list

- **Today:** `resources/mcp-bridge.js` already derives the enum, the validation and the label from one `AGENT_KIND_LABELS` list (`claude`, `codex`, `opencode`, `pi`) since `d4759f6`, and `mcp-bridge.test.js` covers all four. The list is a hand copy of `AGENT_REGISTRY` (the bridge cannot import from `src/`), and nothing fails if the two drift. The bridge also does not `trim().toLowerCase()` like `parseAgentKind`.
- **Done when:** the bridge normalises `agentKind` like the server, a bridge test asserts the `tools/list` enum equals `AGENT_REGISTRY.map((a) => a.kind)`, and a control-server test asserts `parseAgentKind` accepts every registry kind.

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
  - UI-initiated tabs stay renderer-spawned; main spawns only for `create_worktree` with an `initialPrompt`/`teleportSessionId` and the Phase 2 runner (via a `fromMain` option).

### 5. MCP for Codex and opencode

- **Today:** only Claude gets `--mcp-config` (`claude.ts:172`). The comment at `codex.ts:237` says Codex is configured globally through `~/.codex/config.toml`, but nothing writes it. opencode has no MCP wiring.
- **Done when:**
  - opencode gets the `harness-control` server per terminal through `OPENCODE_CONFIG_CONTENT`. This merges with the user's global config and is verified working.
  - Codex gets it per terminal through `-c mcp_servers.harness-control.*`; if the Phase 0 gate fails, see Item 9.
  - The stale comment in `codex.ts` is corrected.
  - An opencode tab and, if the gate passed, a Codex tab can call a `harness-control` tool.
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
  - Codex paths come from a single `codexHomeDir()` that honours `CODEX_HOME` (realpath'd; the default `~/.codex` is not realpath'd), so "`config.toml`" here means `<codexHomeDir()>/config.toml`.
  - Unit tests cover a trusted path, a trusted parent, an untrusted path and a missing config file.

### 8. Codex hook trust and flag name

- **Today:** since rust-v0.129.0, Codex ignores hooks until the user approves them in `/hooks`. Trust is keyed by the hook's position, `<hooks.json path>:<event>:<group>:<handler>`, plus a sha256 of the normalized entry; see "Codex hook trust" in the plan. `installHooks()` (`codex.ts:132-151`) strips Tatsu's entries and re-appends them on every boot, so a user hook added after Tatsu's entry moves it to a new index and loses trust. `ensureCodexHooksEnabled` writes `codex_hooks = true` (`codex.ts:101`), but current docs name the flag `[features] hooks`.
- **Done when:**
  - `installHooks` keeps each Tatsu entry at its index when an identical entry (same command and timeout) is already there. It replaces only legacy or mismatched entries, and skips writing `hooks.json` when nothing changed.
  - A read-only trust-status helper computes each entry's key and hash and compares them with `[hooks.state."<key>"] trusted_hash` in `~/.codex/config.toml`. A unit test pins it to a known hash.
  - Settings shows "Codex hooks need review: run /hooks" when any entry isn't trusted. The same helper will feed the launch-sheet readiness check later.
  - The flag is written as `[features] hooks` (keep reading `codex_hooks` for existing installs).
  - Tatsu never writes `trusted_hash` without an explicit opt-in.
  - Codex paths come from a single `codexHomeDir()` that honours `CODEX_HOME` (realpath'd; the default `~/.codex` is not realpath'd); `~/.codex` above means that dir.
- **Verify first:** the computed hash against a real Codex binary (≥ 0.129.0), for example with `codex app-server` `hooks/list`.

### 9. Codex per-terminal CODEX_HOME fallback (contingent)

- **Today:** nothing; this item exists only if Item 5's Phase 0 gate fails (Codex rejects the `-c mcp_servers.*` overrides). Source at `rust-v0.129.0` and `rust-v0.160.0` expects the gate to pass, so the expected outcome is Skipped.
- **Blocker:** Codex canonicalizes `$CODEX_HOME`, so hook trust keys (`<home>/hooks.json:…`) change under a per-terminal home and Tatsu's hooks become untrusted. The only escapes are writing `trusted_hash` or `--dangerously-bypass-hook-trust` (≥ 0.131.0), both needing Item 8's opt-in. Ticket 09 Phase 0 asks the user to decide before any code.
- **Done when:** one of
  - Codex gets `harness-control` through a per-terminal `CODEX_HOME` (symlinked `auth.json` and `sessions/`, `config.toml` copy plus the server table), with hook trust handled as the user decided; or
  - it is recorded as Skipped (the Item 5 gate passed) or Descoped (decision), with gap 2's Codex status noted in the plan.
- **Verify first:** whether a newer Codex passes the Item 5 gate.

## Out of scope

- Anything in Phase 1 onward of the plan: the workflow-def package, the `workflows` slice, the runner, and the UI.
- The opt-in "Trust automatically" button for Codex hooks, and the `-c hooks.state={…}` per-launch override.
- Whether Codex hooks fire under `codex exec` (only matters for a headless driver).

## Milestone done when

- Items 1-8 are merged. Item 9 is merged, or recorded as Skipped because the Item 5 gate passed, or Descoped by decision. `pnpm typecheck`, `pnpm build` and `npx vitest run` pass.
- Claude, Codex and opencode tabs each show correct status, can reach `harness-control` over MCP, and can be spawned from main with a permission level that never shows an interactive prompt. Pi tabs spawn, resume and report status exactly as before the milestone (checked by hand once after Item 4 and once after Item 6).
- The plan's "Gaps found" section is updated to mark each gap closed, with the commit that closed it.

## Status (2026-10-24, branch `dynamic-workflows`)

- Items 1, 3, 4, 7, 8 Completed; Item 2 closed by `d4759f6` plus the guard test in `634b999`; Item 9 Skipped (the Item 5 gate passed on codex-cli 0.164.0). Items 5 and 6 In progress: all code landed, the Codex real-tab checks (ticket 05 TEST-013, ticket 06 TEST-013) wait for a Codex re-login.
- `pnpm typecheck`, `pnpm build`, `npx vitest run` and the headless smoke pass on `1881875`.
- Pi check: covered by tests only (Pi spawns get `mcpConfigPath: null`, `piEnvVars`, and an identical command and env at every permission level); the by-hand Pi tab check after Items 4 and 6 was not run.
- Every manual `pnpm dev` check in the tickets is recorded as not run in the commit messages.

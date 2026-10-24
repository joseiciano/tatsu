---
goal: Add read-only / edit / full permission levels to main-side agent spawns so Claude, Codex and opencode step terminals never stop at an interactive permission prompt, and a tool outside the level's allowance is denied without a prompt
date_created: 2026-10-02
status: 'Planned'
tags: [feature, permissions, agents, claude, codex, opencode, milestone-1, dynamic-workflows]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Milestone 1, Item 6 (closes gap 5 in `plans/dynamic-workflows/dynamic-workflows.md` "Gaps found"). Size M. Depends on Item 4 (ticket 04, `src/main/agent-spawn/`). Lands after Item 5 (ticket 05) because it extends the opencode config builder and the Codex command that ticket 05 introduces (DEP-002).

Today nothing makes a PTY agent run unattended:

| Location | Today | Problem |
|---|---|---|
| `src/main/auto-approver/auto-approver.ts` | Reviews tool calls for chat-tab approval cards only (`checkDenyList`, `AutoApproveDecision`). | Not wired to PTY tabs. A PTY step stops at its first permission prompt and the terminal goes `needs-approval`. |
| `src/main/agents/index.ts:8-19` (`AgentSpawnOpts`) | No permission field. | Main callers (the Phase 2 runner) cannot ask for an unattended mode. |
| `src/main/agents/claude.ts:170-193` (`buildSpawnArgs`) | No `--permission-mode` / `--allowedTools`. | Claude uses the user's default mode. Verified on Claude 2.1.286: `--permission-mode plan` stops at "Would you like to proceed", `acceptEdits` still prompts for every Bash command. |
| `src/main/agents/codex.ts:236-253` | No `--sandbox` / `--ask-for-approval`. | Codex uses its default approval policy and prompts. |
| `src/main/agents/opencode.ts:150-173` | No `--agent`; no agent definition. | opencode uses the user's default agent, whose `ask` permissions prompt. Top-level `permission` would not help: subagents launched through the `task` tool use their own permission maps. |

This ticket:

1. Adds a shared `PermissionLevel = 'read-only' | 'edit' | 'full'` type and a harness-neutral `bashAllow` prefix list.
2. Adds `permissionLevel` and `bashAllow` to `AgentSpawnRequest` (ticket 04) and `AgentSpawnOpts`, set only by main callers. `buildAgentSpawnOpts` (ticket 05) is the single place they enter the opts.
3. Maps each level per agent (table below) in pure, exported helpers inside each agent module.
4. Adds a dev-only env knob so each level can be checked in a real Tatsu tab before the runner exists.
5. Records gap 5 as closed in the plan, in a separate commit.

This ticket completes Item 6. The per-step `permissions:` field, the launch-sheet confirmation for `full`, and the `needs-input` path through `complete_step` are Phase 1-3 work and out of scope.

### Mapping (implemented by this ticket)

Every level is built so that a tool outside the allowance is **denied without a prompt**.

| Level | Claude (`buildSpawnArgs`) | Codex (`buildSpawnArgs`) | opencode (`OPENCODE_CONFIG_CONTENT` agent `harness-step`, launched `--agent harness-step`) |
|---|---|---|---|
| `read-only` | `--allowedTools 'Read,Grep,Glob,Edit(.harness/runs/**),mcp__harness-control__complete_step' --permission-mode dontAsk` | `--sandbox read-only --ask-for-approval never` | `permission: { "*": "deny", read/glob/grep/list: "allow", "harness-control_*": "allow", edit: { "*": "deny", ".harness/runs/**": "allow" }, bash: "deny", external_directory: "deny", doom_loop: "deny" }` |
| `edit` | `--allowedTools 'Read,Grep,Glob,Edit,Write,NotebookEdit,Bash(<p>:*)…,mcp__harness-control__complete_step' --permission-mode dontAsk` | `--sandbox workspace-write --ask-for-approval never` | as `read-only`, but `edit: "allow"` and `bash: { "*": "deny", "<p>": "allow", "<p> *": "allow" }` per `bashAllow` prefix |
| `full` | `--permission-mode bypassPermissions` | `--sandbox danger-full-access --ask-for-approval never` | `permission: { "*": "allow" }` |

All opencode levels also set `mode: "primary"`, `tools: { task: false }` and, when the spawn has one, `model`.

Notes on the mapping:

- **Claude `--allowedTools` is variadic** (`claude --help`: `--allowedTools, --allowed-tools <tools...>`). It swallows every following non-option argument, including a positional initial prompt. The list is therefore passed as **one comma-separated, shell-quoted argument**, and `--permission-mode dontAsk` is emitted **directly after it** so an option always terminates the variadic list, whatever follows (REQ-004). Verified 2026-10-02 (2.1.286/2.1.288, `-p`): `--allowedTools Read 'say PONG'` swallows the prompt ("Input must be provided"); `--allowedTools Read Grep --permission-mode dontAsk 'say PONG'` answers.
- **`dontAsk` still auto-allows read-only Bash** (verified 2026-10-02, no Bash entry in the list, empty user `permissions.allow`): `ls`, `cat README`, `git log -1` ran; `touch`, `git tag`, `curl` and an unlisted MCP tool were denied with no prompt (`permission_denials` in `-p` JSON). So `read-only` can run read-only shell commands, and a `Bash(<p>:*)` list only matters for commands Claude does not classify as read-only.
- **Claude allowlist always includes `mcp__harness-control__complete_step`**, otherwise `dontAsk` denies the completion call itself. The tool doesn't exist until Phase 2; allowing an absent tool is harmless.
- **Claude `Edit(...)` rules cover all built-in file-editing tools** (Edit, Write, NotebookEdit), so `Edit(.harness/runs/**)` lets a read-only step write into the run folder only.
- **Codex `--ask-for-approval never` at every level.** The plan's table lists it only for `edit`. Without it, `read-only` and `full` keep Codex's default policy, under which the model can request escalation or an untrusted command and Codex prompts. With `never`, a sandbox violation fails back to the model instead. The plan table is updated in TASK-016. Source confirms this is correct and needed (`openai/codex` `rust-v0.129.0` and `rust-v0.160.0`):
  - The default approval policy does not depend on `--sandbox`. It is `on-request` for a trusted or unlisted project and the internal `untrusted` policy for an untrusted one (`core/src/config/mod.rs:3737-3745`). So `read-only` and `danger-full-access` can both still prompt without `-a`.
  - `-a never` combines with `--sandbox` in the interactive TUI. Clap only declares conflicts with `--dangerously-bypass-approvals-and-sandbox` and `--approve-for-me` (`tui/src/cli.rs` `mark_tui_args`, `utils/cli/src/shared_options.rs`).
  - Spellings: `--sandbox`/`-s` takes `read-only|workspace-write|danger-full-access`; `--ask-for-approval`/`-a` takes `on-request|never` on 0.160 (0.129 also accepted `untrusted|on-failure`).
  - `--full-auto` does not exist in either version. Codex ignores `bashAllow`: its sandbox decides what a command may touch.
- **opencode needs its own agent, not top-level `permission`.** The top-level map only governs the default agent. A step's agent can call `task`, which runs a subagent (`general`, `explore`, …) under that subagent's own permission map, where `ask` entries prompt. `tools: { task: false }` removes the tool, and the dedicated `harness-step` agent carries the level's map. `doom_loop` and `external_directory` default to `ask`, so they are set to `deny` explicitly for `read-only` and `edit`. `"*": "deny"` catches any permission key not listed (for example `webfetch`, `question`).

## 1. Requirements & Constraints

- **REQ-001**: New shared package `src/shared/permission-level/` (`index.ts`, `permission-level.ts`, `permission-level.test.ts`):
  ```ts
  export type PermissionLevel = 'read-only' | 'edit' | 'full'
  export const PERMISSION_LEVELS: readonly PermissionLevel[] = ['read-only', 'edit', 'full']
  export const RUN_FOLDER_GLOB = '.harness/runs/**'
  export function isPermissionLevel(v: unknown): v is PermissionLevel
  /** Returns the entries that are safe to pass to every harness, trimmed,
   *  de-duplicated, in input order. */
  export function sanitizeBashAllow(list: readonly string[] | undefined): string[]
  ```
  `sanitizeBashAllow` drops (and the caller logs) any entry that is empty after `trim()`, longer than 200 chars, or contains any of `,` `(` `)` `'` `"` `` ` `` `*` `\n` `\r`. A `bashAllow` entry is a **command prefix** (`npm test`, `git diff`), never a glob or a Claude rule. Shared, not main-only, because Phase 1's `workflow-def` validates `permissions:` and `allow:` with the same type and rules.
  Also export `export function normalizeAllowEntry(entry: string): string`, which strips one trailing `' *'` (`'pnpm *'` → `'pnpm'`, `'git diff *'` → `'git diff'`) and returns any other entry unchanged. Phase 1's `workflow-def` must map every `allow:` entry through `normalizeAllowEntry` **before** calling `sanitizeBashAllow`, so the plan's YAML form (`allow: ["pnpm *", "git status", "git diff *"]`) is accepted as prefixes. `sanitizeBashAllow` itself does not normalise and still rejects any `*`, so a mid-entry or bare `*` (`'pnpm * x'`, `'*'`) is still dropped. Every harness already treats a prefix as "prefix plus any args" (Claude `Bash(<p>:*)`, opencode `<p>` + `<p> *`), so nothing is lost.
- **REQ-002**: `AgentSpawnOpts` (`src/main/agents/index.ts:8-19`) gains:
  ```ts
  permissionLevel?: PermissionLevel
  bashAllow?: string[]
  ```
  Absent `permissionLevel` means "today's behaviour": no flag, no agent, no config section. `bashAllow` is only read when `permissionLevel === 'edit'`.
- **REQ-003**: `src/main/agent-spawn/` (ticket 04 REQ-002/REQ-003, ticket 05 REQ-004):
  - `AgentSpawnRequest` gains `permissionLevel?: PermissionLevel` and `bashAllow?: string[]` (replacing the `// Item 6 adds` placeholder line).
  - `buildAgentSpawnOpts(req)` sets `permissionLevel: req.permissionLevel` and `bashAllow: sanitizeBashAllow(req.bashAllow)`. When `sanitizeBashAllow` dropped entries, log once: `log('agent-spawn', \`dropped ${n} bashAllow entries id=${terminalId}\`)`. Log only the count, not the entries.
  - The per-call spawn log line (ticket 04 REQ-004) appends ` perm=${req.permissionLevel ?? 'default'}`.
  - `createOrAttach(spec, ...)` builds its `AgentSpawnRequest` field by field from `TerminalSpawnSpec` and never spreads `spec`, so a client-sent `permissionLevel` / `bashAllow` property is ignored.
  - The legacy `agent:buildSpawnArgs` handler (ticket 04 REQ-011) passes an explicit field list (`terminalId`, `cwd`, `sessionId`, `initialPrompt`, `teleportSessionId`, `sessionName`, `modelOverride`) instead of `{ ...opts, agentKind }`, so a client cannot pass a level through it either.
  - **Attach wins** (ticket 04 "Create-or-attach semantics"): when the PTY is already running, the request's level is not applied and the outcome is `'attached'`. A caller that needs a different level uses a new terminal id.
  - **Pi**: `pi.ts` has no permission mapping. `buildAgentSpawnOpts` still copies `permissionLevel` into the opts, `pi.ts` `buildSpawnArgs` ignores it, and when a level is set for a Pi request `agent-spawn` logs `log('agent-spawn', 'permissionLevel not supported for pi; spawning with defaults')` once. Pi tabs are not step terminals in v1 (plan, "Scope").
- **REQ-004**: Claude (`src/main/agents/claude.ts`). New pure exports:
  ```ts
  export const CLAUDE_COMPLETE_STEP_TOOL = 'mcp__harness-control__complete_step'
  export const CLAUDE_READ_TOOLS = ['Read', 'Grep', 'Glob'] as const
  export function claudeAllowedTools(level: 'read-only' | 'edit', bashAllow: string[]): string[]
  export function claudePermissionFlags(level: PermissionLevel | undefined, bashAllow: string[] = []): string
  ```
  - `claudeAllowedTools('read-only', _)` → `[...CLAUDE_READ_TOOLS, \`Edit(${RUN_FOLDER_GLOB})\`, CLAUDE_COMPLETE_STEP_TOOL]`.
  - `claudeAllowedTools('edit', allow)` → `[...CLAUDE_READ_TOOLS, 'Edit', 'Write', 'NotebookEdit', ...allow.map((p) => \`Bash(${p}:*)\`), CLAUDE_COMPLETE_STEP_TOOL]`.
  - `claudePermissionFlags`: `undefined` → `''`. `'full'` → `' --permission-mode bypassPermissions'`. Otherwise `` ` --allowedTools ${shellQuote(list.join(','))} --permission-mode dontAsk` ``. The order (`--allowedTools` value, then `--permission-mode`) is fixed: an option must follow the variadic list.
  - `buildSpawnArgs`: insert `${permFlags}` (`claudePermissionFlags(opts.permissionLevel, opts.bashAllow)`) in the `cmd` template at `:176`, right after `${opts.command}` and before `${modelFlag}` (`modelFlag` itself is computed at `:171`), so the result is `${tuiPrefix}${opts.command}${permFlags}${modelFlag}${mcpFlag}${nameFlag}${systemPromptFlag}`.
  - Guard: when `opts.command` already contains `--permission-mode`, `--dangerously-skip-permissions`, `--allowedTools` or `--allowed-tools`, emit no permission flags and log `log('agent-spawn', 'claude command already sets permissions; permissionLevel not applied')`. Mirrors the `--model` guard (`:171`).
- **REQ-005**: Codex (`src/main/agents/codex.ts`). New pure export:
  ```ts
  export function codexPermissionFlags(level: PermissionLevel | undefined): string
  ```
  - `undefined` → `''`. `'read-only'` → `' --sandbox read-only --ask-for-approval never'`. `'edit'` → `' --sandbox workspace-write --ask-for-approval never'`. `'full'` → `' --sandbox danger-full-access --ask-for-approval never'`.
  - `buildSpawnArgs`: `cmd = opts.command + mcpOverrides (ticket 05 REQ-005) + codexPermissionFlags(opts.permissionLevel)`, then the existing `--model` and `resume <id>` logic. The flags sit before `resume` so they apply to a resumed session.
  - MCP approval: when `opts.permissionLevel` is set and `opts.mcpServer` is set, also append `-c 'mcp_servers.harness-control.default_tools_approval_mode="approve"'` (shell-quoted like ticket 05's overrides), after ticket 05's overrides. Without it, Codex ≥ 0.160 **denies** any unannotated MCP tool call (including `complete_step`) under `never` with `read-only`/`workspace-write` ("MCP tool call requires approval, but approval policy is never", `core/src/mcp_tool_call.rs`). Only `danger-full-access` + `never` auto-approves MCP tools. On 0.129 the same case skips the auto-approve check and continues into the approval-request path (hooks, then the approval prompt or elicitation). Exact behaviour there is unverified. `approve` short-circuits both (`codex-mcp/src/mcp/mod.rs` `mcp_permission_prompt_is_auto_approved`). Interactive tabs (no `permissionLevel`) keep Codex's normal MCP prompts.
  - Guard: when `opts.command` matches `/(^|\s)(--sandbox|-s|--ask-for-approval|-a|--full-auto|--dangerously-bypass-approvals-and-sandbox|--yolo|--approve-for-me|--not-so-yolo)(\s|=|$)/`, emit no permission flags and log `log('agent-spawn', 'codex command already sets sandbox/approval; permissionLevel not applied')`. Codex rejects a repeated flag, so appending would break the launch.
- **REQ-006**: opencode (`src/main/agents/opencode.ts`). Extend ticket 05's `buildOpencodeConfig(opts, base)`; do **not** add another writer of `OPENCODE_CONFIG_CONTENT`. New pure exports:
  ```ts
  export const OPENCODE_STEP_AGENT = 'harness-step'
  export function opencodeStepPermission(level: PermissionLevel, bashAllow: string[]): Record<string, unknown>
  export function opencodeStepAgent(level: PermissionLevel, bashAllow: string[], model?: string | null): Record<string, unknown>
  ```
  - `opencodeStepPermission('full', _)` → `{ '*': 'allow' }`.
  - `opencodeStepPermission('read-only', _)` → `{ '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', 'harness-control_*': 'allow', edit: { '*': 'deny', [RUN_FOLDER_GLOB]: 'allow' }, bash: 'deny', external_directory: 'deny', doom_loop: 'deny' }`.
  - `opencodeStepPermission('edit', allow)` → same as `read-only` except `edit: 'allow'` and `bash: { '*': 'deny', ...Object.fromEntries(allow.flatMap((p) => [[p, 'allow'], [\`${p} *\`, 'allow']])) }`.
  - Key order matters (opencode evaluates the last matching rule): `'*'` is always the first key of every map.
  - `opencodeStepAgent` → `{ mode: 'primary', description: 'Tatsu workflow step', tools: { task: false }, permission: opencodeStepPermission(level, bashAllow), ...(model ? { model } : {}) }`. No `prompt`: the provider's default system prompt applies, as for opencode's built-in `build` agent.
  - Inside `buildOpencodeConfig`, after the MCP section: if `opts.permissionLevel`, set `agent = { ...(base.agent as object ?? {}), [OPENCODE_STEP_AGENT]: opencodeStepAgent(opts.permissionLevel, opts.bashAllow ?? [], opts.model) }`. A user-defined `harness-step` in `base` is overwritten.
  - `buildSpawnArgs`: when `opts.permissionLevel` is set and `opts.command` does not contain `--agent`, append `` ` --agent ${OPENCODE_STEP_AGENT}` `` right after `opts.command` (before `--model`, `--session`, `--prompt`). When `--agent` is already in the command, log `log('agent-spawn', 'opencode command already sets --agent; permissionLevel not applied')` and skip both the flag and the config section. `buildOpencodeConfig` applies the same `opts.command.includes('--agent')` check, so no extra opts field is needed.
  - The `--model` flag logic is unchanged. The agent's `model` keeps the step's model even if a later prompt is sent without `--model`.
- **REQ-007**: Dev-only check path (needed for TEST-012..TEST-014 before the runner exists). In `src/main/index.ts`, the `startAgentTab` option (ticket 04 REQ-016) adds `...devPermissionOverride()` to its `spawnAgentTerminal` request, where:
  ```ts
  export function devPermissionOverride(
    isDev: boolean,
    env: NodeJS.ProcessEnv,
  ): { permissionLevel?: PermissionLevel; bashAllow?: string[] } {
    if (!isDev) return {}
    const level = env.HARNESS_DEV_PERMISSION_LEVEL
    if (!isPermissionLevel(level)) return {}
    const allow = (env.HARNESS_DEV_BASH_ALLOW ?? '').split(';').map((s) => s.trim()).filter(Boolean)
    return { permissionLevel: level, bashAllow: allow }
  }
  ```
  The call site in `src/main/index.ts` passes `devPermissionOverride(detectRuntime() === 'electron' && !isPackaged(), process.env)`, with `detectRuntime` and `isPackaged` imported from `./paths` (`src/main/paths/paths.ts:35`, `:70`). Do **not** gate on `!isPackaged()` alone: `isPackaged()` returns `false` under Node, so a headless production server would honour the env var (SEC-001). Headless therefore always gets `{}`; dev checks run in `pnpm dev` only. `HARNESS_DEV_BASH_ALLOW` is `;`-separated (prefixes may contain spaces, never `;`). `HARNESS_DEV_PERMISSION_LEVEL` and `HARNESS_DEV_BASH_ALLOW` come from the boot environment and only apply to agent tabs created through `startAgentTab` after boot. Tabs that already exist (including ones remounted after boot) keep their spawn-time behaviour, and changing either value needs a `pnpm dev` restart. Put the function in a small package `src/main/dev-permission-override/` (`index.ts`, `dev-permission-override.ts`, test); it takes `isDev` and `env` as parameters and never imports `paths` or `electron`, so it is unit-testable.
- **SEC-001**: Only main decides a level. `TerminalSpawnSpec` (ticket 04 REQ-001) has no permission field, `createOrAttach` and the legacy handler never forward one (REQ-003), and the dev override is ignored in packaged builds and in every headless build (REQ-007).
- **SEC-002**: `full` is never a default. `permissionLevel` undefined keeps today's interactive behaviour for every user-created tab. (The launch-sheet confirmation for `full` is Phase 3.)
- **SEC-003**: Tatsu never writes `~/.claude.json`, `~/.claude/settings*.json`, `~/.codex/config.toml` or `~/.config/opencode/*` for permissions. Everything is per launch (argv or `OPENCODE_CONFIG_CONTENT`).
- **CON-001**: Do not wire `auto-approver` into PTY tabs. Unattended behaviour comes from the harnesses' own modes. `auto-approver` keeps serving chat tabs only.
- **CON-002**: Do not change `TerminalSpawnSpec`, any store slice, `StateEvent`, or transport channel. No new renderer UI.
- **CON-003**: Do not change behaviour when `permissionLevel` is undefined: every existing `claude.test.ts`, `codex.test.ts`, `opencode.test.ts` and `agent-spawn.test.ts` expectation stays byte-identical.
- **CON-004**: Codex hook trust (Item 8) and folder trust (Item 7) are separate. Their prompts are not permission prompts and are not handled here; the manual checks run in folders that are already trusted.
- **GUD-001**: AGENTS.md: package-style dirs with barrels, imports through barrels (`../../shared/permission-level`), no new comments except the JSDoc in REQ-001. Before every commit run `pnpm typecheck`, `pnpm build`, `npx vitest run`. One commit per phase, push after each. The gap-5 plan edit is its own final commit (`Mark workflows gap 5 closed`), and this ticket file's front matter `status` change (TASK-014) goes in that same commit, not in a separate one.
- **PAT-001**: Agent module tests follow `src/main/agents/claude.test.ts` / `codex.test.ts` / `opencode.test.ts` (`vi.mock('fs')`, `vi.mock('../debug')`). Pure helpers need no mocks. `agent-spawn.test.ts` uses ticket 04's fake `pty` and fake `getAgent`, plus the real agent modules for TEST-010.

## 2. Implementation Steps

### Implementation Phase 0: Verify harness behaviour

- GOAL-001: Each mapping row is confirmed against the installed binary before code depends on it. No code changes. Record results for TASK-016.

- [x] **TASK-001**: The installed Claude (2.1.302 as of 2026-10-24; the pre-verifications below were on 2.1.286/2.1.288 and must be repeated on whatever `claude --version` prints), in a scratch git repo that Claude already trusts (`mkdir` under a trusted parent, `git init`). Note the user's shell alias adds `--append-system-prompt-file …` to every `claude` invocation; run `command claude …` to bypass it in these probes, and expect the extra flag in `ps` during TEST-012:
  - (a) `claude --allowedTools 'Read,Grep,Glob,Edit(.harness/runs/**),mcp__harness-control__complete_step' --permission-mode dontAsk 'list the files here, then run ls via Bash, then write hello to x.txt, then write hello to .harness/runs/t/x.md'`. Read/Glob succeed; Bash and `x.txt` are denied with no prompt; `.harness/runs/t/x.md` is written. The prompt was **not** swallowed (the agent acted on it).
  - (b) Same with `--permission-mode dontAsk` **omitted** and the prompt placed right after the list: confirm the prompt is swallowed (proves why the order in REQ-004 is fixed). Record the observed behaviour.
  - (c) `--allowedTools 'Read,Bash(git status:*)' --permission-mode dontAsk 'run git status, then run git tag probe'`: `git status` runs, `git tag` denied, no prompt (not `git log`: read-only Bash is auto-allowed under `dontAsk`). Pre-verified 2026-10-02 in `-p`. Confirms a pattern with a space inside parentheses survives the comma-separated form.
  - (d) `--permission-mode bypassPermissions 'run ls'`: runs with no prompt. Note whether a one-time "Bypass Permissions mode" acceptance dialog appears on this machine; if it does, record it as RISK-002 evidence (do not accept it on the user's behalf in a script). Pre-verified 2026-10-02: it **does** appear on this machine (see RISK-002).
  - **Result (2026-10-24, Claude 2.1.302, `command claude -p --output-format json`, scratch repo):** (a) Read/Glob ran, `ls` via Bash ran (read-only Bash is auto-allowed under `dontAsk`, as the mapping notes say), `x.txt` was denied with no prompt (`permission_denials: Write`), `.harness/runs/t/x.md` was written. (b) **differs from 2.1.286**: `--allowedTools 'Read,Grep,Glob' 'say PONG'` with no `--permission-mode` answered `PONG`; the comma-separated list did not swallow the prompt. The REQ-004 order (`--permission-mode` right after the list) stays as the safe form. (c) `git status` ran, `git tag probe` was denied with no prompt, no tag created. (d) not re-run (interactive only); the 2026-10-02 result stands.
- [x] **TASK-002**: opencode 1.18.30 (`/opt/homebrew/bin/opencode`), in the same scratch repo:
  - `OPENCODE_CONFIG_CONTENT='{"agent":{"harness-step":{"mode":"primary","tools":{"task":false},"permission":<read-only map from REQ-006>}}}' opencode --agent harness-step --prompt 'read README, then run ls with bash, then write x.txt, then write .harness/runs/t/x.md, then use the task tool to spawn a subagent that writes y.txt'`.
  - Expected: read succeeds; bash, `x.txt` and the task call are denied (task absent) with no prompt; `.harness/runs/t/x.md` written. `opencode agent list` with the same env shows `harness-step` (primary) **and** the user's own agents (merge, not replace).
  - Confirm the `edit` pattern map form (`edit: { "*": "deny", ".harness/runs/**": "allow" }`) and the `"*"` catch-all key are accepted on 1.18.30. If a pattern edit map is rejected, fall back to `edit: "deny"` for `read-only` and record that read-only steps can't write the run folder on opencode (RISK-004).
  - With ticket 05's `mcp.harness-control` section added to the same env, confirm `"harness-control_*": "allow"` lets `harness-control_list_repos` run under `"*": "deny"`, and that removing that key denies it with no prompt. If MCP tools are not governed by permission keys on 1.18.30, drop the key and record it.
  - Confirm the last-match-wins order with `bash: { "*": "deny", "git status": "allow", "git status *": "allow" }`.
  - **Result (2026-10-24, opencode 1.18.30, `opencode agent list` with the env set):** `harness-step (primary)` is listed next to the user's own agents (merge, not replace). The parsed rule list ends with our map in key order after opencode's defaults: `* deny`, `read/glob/grep/list allow`, `harness-control_* allow`, `edit * deny` then `edit .harness/runs/** allow` (the pattern edit map is accepted), `bash * deny` then `bash git status allow`, `bash git status * allow`, `external_directory deny`, `doom_loop deny`; opencode appends one trailing `external_directory <tool-output dir> allow`. The TUI denial checks and the MCP-key check were not run (unattended).
- [ ] **TASK-003** (pending: Codex not installed; waits for ticket 05 TASK-001): Codex. Reuse the install and login from ticket 05 TASK-001 (the milestone's single Codex install); do not install again. For each level, `codex --sandbox <mode> --ask-for-approval never '<prompt>'` in the scratch repo (trusted per Item 7's notes): `read-only` → a write fails back to the model with no prompt; `workspace-write` → writes inside the repo succeed, `touch ~/tatsu-codex-test` fails with no prompt; `danger-full-access` → both succeed. Also check `codex --sandbox read-only --ask-for-approval never resume --last` accepts the flags before `resume`. If Codex can't be installed or logged in, implement per REQ-005 from the documented flags, mark TEST-013 pending in TASK-016, and leave this ticket `In progress`.

### Implementation Phase 1: Shared level type and spawn plumbing

- GOAL-002: `PermissionLevel` exists, flows from `AgentSpawnRequest` into `AgentSpawnOpts`, and clients cannot set it. No agent output changes yet.

- [ ] **TASK-004**: Create `src/shared/permission-level/` (REQ-001) with TEST-001.
- [ ] **TASK-005**: Add `permissionLevel` and `bashAllow` to `AgentSpawnOpts` (REQ-002) and `AgentSpawnRequest`; set them in `buildAgentSpawnOpts`; extend the spawn log line; make `createOrAttach` and the legacy `agent:buildSpawnArgs` handler pass explicit fields (REQ-003).
- [ ] **TASK-006**: Add TEST-008 and TEST-009. Verify, commit (`Carry a permission level from main spawn requests into agent spawn opts`), push.

### Implementation Phase 2: Per-agent mappings

- GOAL-003: Each agent module turns a level into flags or config per the mapping table, and `undefined` is a no-op.

- [ ] **TASK-007**: Claude: REQ-004 in `src/main/agents/claude.ts`. TEST-002, TEST-003.
- [ ] **TASK-008**: Codex: REQ-005 in `src/main/agents/codex.ts`. TEST-004, TEST-005.
- [ ] **TASK-009**: opencode: REQ-006 in `src/main/agents/opencode.ts`. TEST-006, TEST-007.
- [ ] **TASK-010**: TEST-010 (agent-spawn end to end with the real modules) and TEST-011 (regressions). Verify, commit (`Map permission levels to Claude, Codex and opencode launch flags`), push.

### Implementation Phase 3: Real-tab checks

- GOAL-004: Every level is shown to run without an interactive prompt in a real Tatsu tab for each installed harness.

- [ ] **TASK-011**: Add `src/main/dev-permission-override/` and wire it into `startAgentTab` (REQ-007). TEST-015.
- [ ] **TASK-012**: Run TEST-012 (Claude), TEST-013 (Codex, or mark pending per TASK-003), TEST-014 (opencode). Record results.
- [ ] **TASK-013**: Verify (TEST-016), commit (`Add a dev-only permission level override for checking agent tabs`), push.

### Implementation Phase 4: Close gap 5 in the plan

- GOAL-005: The plan records gap 5 as closed and the mapping table matches what shipped.

- [ ] **TASK-014**: Set this ticket's front matter `status` to `'Completed'` (or `'In progress'` if TEST-013 is pending) in the same commit as TASK-016.
- [ ] **TASK-015**: Re-run TEST-016.
- [ ] **TASK-016**: Edit `plans/dynamic-workflows/dynamic-workflows.md`:
  - Gap 5 (line starting `5. **No unattended permission story.**`): append `Closed in <Phase 1 hash>..<Phase 3 hash>: \`AgentSpawnRequest.permissionLevel\` (\`read-only\` / \`edit\` / \`full\`, set only by main) maps to Claude \`--allowedTools <comma list> --permission-mode dontAsk\` or \`bypassPermissions\`, Codex \`--sandbox <mode> --ask-for-approval never\`, and an opencode \`harness-step\` agent (own permission map, \`tools.task: false\`) launched with \`--agent harness-step\`. Checked in real tabs: Claude <ver>, opencode <ver>, Codex <ver or "pending: not installed">.`
  - "Permissions & trust" mapping table, Codex column: `read-only` → `--sandbox read-only --ask-for-approval never`; `full` → `--sandbox danger-full-access --ask-for-approval never`. Add one sub-bullet under the table: `Codex gets \`--ask-for-approval never\` at every level: under its default policy a sandbox escalation prompts.`
  - Same table, opencode `read-only` cell: if TASK-002 forced the fallback, replace `edit and bash denied, except the run folder` with `edit and bash denied (run-folder pattern not supported on <ver>)`.
  - "Harness research" table, row "Unattended permissions", Codex cell: append `(**verified**, codex <ver>)` if TEST-013 passed.
  - Commit the plan edit together with TASK-014's ticket status change as one commit (`Mark workflows gap 5 closed`), separate from the Phase 1-3 commits, then push.

## 3. Alternatives

- **ALT-001**: Drive PTY prompts with `auto-approver` (answer prompts by writing keystrokes). Rejected: it parses TUI output per harness and version, is racy, and still shows a prompt. The harnesses' own unattended modes deny without a prompt (CON-001).
- **ALT-002**: Claude `--permission-mode acceptEdits` or `plan` for `edit` / `read-only`. Rejected: verified to stall (gap 5).
- **ALT-003**: Claude `--disallowedTools` deny lists on top of the default mode. Rejected: anything not denied still prompts. `dontAsk` + an allowlist is the only mode that denies the unknown without asking.
- **ALT-004**: Pass `--allowedTools` as several space-separated arguments. Rejected: the flag is variadic and would swallow the initial prompt; one comma-separated argument followed by an option is deterministic.
- **ALT-005**: opencode top-level `permission` in `OPENCODE_CONFIG_CONTENT`. Rejected: subagents launched through `task` use their own permission maps and prompt (plan, "Harness research", verified).
- **ALT-006**: opencode `--auto` (auto-approve anything not explicitly denied) for `full`. Rejected for consistency: every level uses the same `harness-step` agent with `tools.task: false`, so `full` behaves like the others apart from the map. Reconsider if the agent route misbehaves for `full`.
- **ALT-007**: Codex `--full-auto` / `--dangerously-bypass-approvals-and-sandbox`. Rejected: `--full-auto` uses `on-request` approvals, which can prompt; the explicit `--sandbox` + `--ask-for-approval never` pair is clearer and identical in shape across levels.
- **ALT-008**: Write per-worktree `.claude/settings.local.json` permission rules. Rejected: writes into the user's worktree (hooks-consent rule) and leaks into the user's own sessions there (SEC-003).
- **ALT-009**: Put `permissionLevel` on `TerminalSpawnSpec` so tabs remember it across remounts. Rejected: a client could ask for `full`. The runner owns step terminals and restarts them with a new id (SEC-001, RISK-005).

## 4. Dependencies

- **DEP-001**: Ticket 04 (`src/main/agent-spawn/`): `AgentSpawnRequest`, `buildAgentCommand`, `startAgentTab`, the legacy handler. Hard dependency.
- **DEP-002**: Ticket 05: `buildAgentSpawnOpts`, `buildAgentLaunch`, `AgentModule.spawnEnv`, `buildOpencodeConfig(opts, base)` and Codex `codexMcpOverrides`. This ticket extends all of them and must land after it. If 05 is not merged, stop after Phase 1 and the Claude part of Phase 2 (Claude needs neither).
- **DEP-003**: Ticket 01 (opencode plugin) for TEST-014's status column (a denied tool must not leave the tab in `needs-approval`).
- **DEP-004**: Items 7 and 8 (folder trust, Codex hook trust) for running steps in untrusted folders; the checks here use trusted folders (CON-004).
- **DEP-005**: Binaries: Claude Code 2.1.286 and opencode 1.18.30 (installed); Codex ≥ 0.129.0 with a login (not installed, TASK-003).
- **DEP-006**: Phase 1 `workflow-def` reuses `PermissionLevel`, `isPermissionLevel`, `normalizeAllowEntry` and `sanitizeBashAllow` (in that order for `allow:`, REQ-001) for `permissions:` / `allow:` validation. Phase 2's opencode continuation (`client.session.promptAsync`) must pass `agent: 'harness-step'` for step terminals (plan, "Harness research").

## 5. Files

- **FILE-001**: `src/shared/permission-level/index.ts`, `permission-level.ts`, `permission-level.test.ts` (new). REQ-001.
- **FILE-002**: `src/main/agents/index.ts`. `permissionLevel`, `bashAllow` on `AgentSpawnOpts` (REQ-002).
- **FILE-003**: `src/main/agents/claude.ts`, `claude.test.ts`. REQ-004.
- **FILE-004**: `src/main/agents/codex.ts`, `codex.test.ts`. REQ-005.
- **FILE-005**: `src/main/agents/opencode.ts`, `opencode.test.ts`. REQ-006.
- **FILE-006**: `src/main/agent-spawn/types.ts`, `agent-spawn.ts`, `agent-spawn.test.ts`. REQ-003.
- **FILE-007**: `src/main/index.ts`. Legacy handler explicit fields (REQ-003), dev override in `startAgentTab` (REQ-007).
- **FILE-008**: `src/main/dev-permission-override/index.ts`, `dev-permission-override.ts`, `dev-permission-override.test.ts` (new). REQ-007.
- **FILE-009**: `plans/dynamic-workflows/dynamic-workflows.md`. Gap 5, mapping table, research row (separate commit).
- **FILE-010**: `plans/dynamic-workflows/milestones/milestone-1-prerequisites/tickets/06-permission-levels.md`. Status update (same commit as FILE-009).

## 6. Testing

- **TEST-001** (`permission-level`): `isPermissionLevel` true for the three levels, false for `'Full'`, `''`, `undefined`, `1`. `sanitizeBashAllow([' npm test ', 'npm test', 'git diff', 'a,b', 'rm (x)', "it's", 'x*', '', 'ok\nno'])` → `['npm test', 'git diff']`. `undefined` → `[]`. `normalizeAllowEntry`: `'pnpm *'` → `'pnpm'`, `'git diff *'` → `'git diff'`, `'git status'` unchanged, `'*'` and `'pnpm * x'` unchanged. `sanitizeBashAllow(["pnpm *", "git status", "git diff *"].map(normalizeAllowEntry))` (the plan's example `allow:`) → `['pnpm', 'git status', 'git diff']`; without the map the same list → `['git status']`.
- **TEST-002** (`claudePermissionFlags`): `undefined` → `''`. `'full'` → `' --permission-mode bypassPermissions'`. `'read-only'` → `" --allowedTools 'Read,Grep,Glob,Edit(.harness/runs/**),mcp__harness-control__complete_step' --permission-mode dontAsk"`. `'edit'` with `['npm test', 'git diff']` → list `Read,Grep,Glob,Edit,Write,NotebookEdit,Bash(npm test:*),Bash(git diff:*),mcp__harness-control__complete_step`. Every non-`full`, non-`undefined` output contains `mcp__harness-control__complete_step` and ends with `--permission-mode dontAsk`.
- **TEST-003** (Claude `buildSpawnArgs`): with `initialPrompt: 'do it'`, `permissionLevel: 'read-only'` and no other flags: output is `claude --allowedTools '<list>' --permission-mode dontAsk 'do it'` (the token after the quoted list is `--permission-mode`). With `mcpConfigPath`, `sessionName`, `systemPrompt`, `model`: permission flags come right after the command, all others keep their order. Command `'claude --permission-mode plan'` → no permission flags added. `permissionLevel` undefined → output identical to the existing cases.
- **TEST-004** (`codexPermissionFlags`): exact strings for each level; `undefined` → `''`.
- **TEST-005** (Codex `buildSpawnArgs`): with `mcpServer` (ticket 05) and `permissionLevel: 'edit'`: output is `codex <-c overrides> --sandbox workspace-write --ask-for-approval never --model ... '<prompt>'`, i.e. the permission flags come after the last `-c` and before `--model`. With an existing session: `... --ask-for-approval never resume <id>`. Commands containing `--full-auto`, `-s read-only`, `-a never` or `--yolo` get no permission flags. `--sandbox` never appears twice.
- **TEST-006** (`opencodeStepPermission` / `opencodeStepAgent`): exact objects for each level per REQ-006; `Object.keys(map)[0] === '*'` for every map including nested `edit` / `bash`; `edit` level with `['git status']` has `bash` keys `['*', 'git status', 'git status *']`. Agent has `mode: 'primary'`, `tools: { task: false }`, and `model` only when given.
- **TEST-007** (opencode config and args): `buildOpencodeConfig({ ...opts, permissionLevel: 'edit', mcpServer }, { agent: { mine: { mode: 'subagent' } }, theme: 'x' })` keeps `theme`, `agent.mine`, `mcp['harness-control']`, and adds `agent['harness-step']`. A base with its own `agent['harness-step']` is overwritten. `permissionLevel` undefined → no `agent` key added. `spawnEnv` returns exactly one `OPENCODE_CONFIG_CONTENT` key whose JSON contains both `mcp` and `agent` sections. `buildSpawnArgs` with a level → `opencode --agent harness-step --model ... --prompt ...`; command already containing `--agent build` → no `--agent harness-step` and `buildOpencodeConfig` adds no `harness-step`.
- **TEST-008** (`agent-spawn`, plumbing): `spawnAgentTerminal({ ..., permissionLevel: 'edit', bashAllow: ['npm test', 'bad,entry'] })` → the fake module's recorded opts have `permissionLevel: 'edit'`, `bashAllow: ['npm test']`, and `log` was called with a `dropped 1` line. The spawn log line contains `perm=edit`; a request without a level logs `perm=default`.
- **TEST-009** (`agent-spawn`, clients can't set a level): `createOrAttach({ kind: 'agent', ..., permissionLevel: 'full' } as any, 'c1')` → recorded opts have `permissionLevel: undefined`. The legacy `buildAgentCommand` path, called the way `agent:buildSpawnArgs` calls it with an opts object containing `permissionLevel: 'full'`, records `undefined`. Running PTY + a request with a different level → outcome `'attached'`, `buildSpawnArgs` not called.
- **TEST-010** (`agent-spawn` with real agent modules, `vi.mock('fs')` for session lookups): `buildAgentLaunch` per kind × level gives the flags/env in the mapping table; for opencode `env.OPENCODE_CONFIG_CONTENT` parses and has `agent['harness-step'].permission`. For Pi × any level the command and env are identical to Pi × `undefined`, and `log` was called with the `not supported for pi` line.
- **TEST-011** (regressions): all pre-existing tests in `claude.test.ts`, `codex.test.ts`, `opencode.test.ts`, `agent-spawn.test.ts`, `auto-approver.test.ts` pass unchanged (CON-003).
- **TEST-012** (manual, Claude, real tab). `pnpm log:clear`, then for each level `HARNESS_DEV_PERMISSION_LEVEL=<level> HARNESS_DEV_BASH_ALLOW='git status' pnpm dev`. In a worktree under a Claude-trusted parent, add a Claude agent tab with the "+" menu. Check `pnpm log | grep agent-spawn` shows `perm=<level>` and `ps -ww -o args= -p <claude pid>` shows the flags. Then type in the tab:
  - `read-only`: "Read package.json and tell me its name" → works. "Run `touch y.txt` with Bash" → denied, no prompt (`ls` / `git log` are read-only and auto-allowed), tab never shows `needs-approval` in the sidebar. "Create notes.txt" → denied, no prompt. "Write hello to .harness/runs/check/x.md" → file exists. "Call the harness-control list_repos tool" → denied without a prompt (proves `dontAsk` covers MCP tools that aren't listed).
  - `edit`: "Create notes.txt with hello" → written. "Run git status" → runs. "Run git tag probe" → denied, no prompt. "Run `curl https://example.com`" → denied, no prompt.
  - `full`: "Run `ls ~` and create notes2.txt" → both run, no prompt. If the one-time bypass acceptance dialog appears, record it (RISK-002), accept it once by hand, and re-check that a second tab starts without it.
  - Without the env var: a new Claude tab has none of the flags (`ps` check) and prompts as before.
- **TEST-013** (manual, Codex, real tab; pending if Codex is not installed, TASK-003): same launch with each level, Codex agent tab.
  - `read-only`: "Create notes.txt" → the sandbox blocks the write, the model reports it, no approval prompt, status never `needs-approval`. Reading files works.
  - `edit`: "Create notes.txt" → written. "Run `touch ~/tatsu-codex-test`" → fails (outside the workspace), no prompt. `ps` shows `--sandbox workspace-write --ask-for-approval never` after the `-c mcp_servers...` overrides.
  - `full`: "Run `touch ~/tatsu-codex-test`" → succeeds, no prompt. Delete the file afterwards.
  - Restart the tab (resume): the flags are still in `ps`.
- **TEST-014** (manual, opencode 1.18.30, real tab): same launch with each level, opencode agent tab. `ps` shows `--agent harness-step`; in the TUI the agent indicator shows `harness-step`.
  - `read-only`: "Read package.json" → works. "Run ls" → denied, no prompt. "Create notes.txt" → denied, no prompt. "Write .harness/runs/check/x.md" → written (or denied with no prompt if TASK-002 forced the fallback). "Use the task tool to have a subagent create y.txt" → no task tool available, nothing written, no prompt. "Fetch https://example.com" → denied, no prompt.
  - `edit`: "Create notes.txt" → written. "Run git status" → runs. "Run git log -1" → denied, no prompt. Task tool still unavailable.
  - `full`: "Run `ls ~` and create notes2.txt" → both run, no prompt.
  - The sidebar status never shows `needs-approval` at any level, and the user's own MCP servers and agents (from `~/.config/opencode/`) are still listed (merge preserved).
- **TEST-015** (`dev-permission-override`): `isDev: false` → `{}` whatever the env (covers both packaged Electron and headless). `isDev: true`, `HARNESS_DEV_PERMISSION_LEVEL='edit'`, `HARNESS_DEV_BASH_ALLOW='npm test; git diff ;'` → `{ permissionLevel: 'edit', bashAllow: ['npm test', 'git diff'] }`. Invalid level → `{}`. Headless case: the `isDev` expression from REQ-007 evaluated with `detectRuntime()` = `'node'` (and `isPackaged()` = `false`, as under Node) is `false`, so `devPermissionOverride(<that>, { HARNESS_DEV_PERMISSION_LEVEL: 'full' })` → `{}`.
- **TEST-016**: `pnpm typecheck`, `pnpm build`, `npx vitest run` pass; `pnpm build:headless && bash scripts/smoke-headless.sh` passes. For setup (isolated `HARNESS_DATA_DIR`, log path, what it checks) see the header comment of `scripts/smoke-headless.sh`.

## 7. Risks & Assumptions

- **RISK-001**: Claude's `--allowedTools` **adds** to the user's own `permissions.allow` rules from `~/.claude/settings.json` and project settings, and their `deny` rules still apply. A step can therefore do more than its level when the user's settings allow it, and less when they deny it. Neither case prompts, which is the requirement. Documented, not mitigated (SEC-003 forbids touching those files; `--setting-sources` would also drop the user's hooks and MCP).
- **RISK-002**: `bypassPermissions` may show a one-time acceptance dialog per machine, and can be disabled by managed settings (`disableBypassPermissionsMode`) or when running as root. Then a `full` step stalls. **Verified 2026-10-02**: interactive `claude --permission-mode bypassPermissions` (and `--dangerously-skip-permissions`) in a trusted folder shows "WARNING: Claude Code running in Bypass Permissions mode … No, exit / Yes, I accept" on this machine. Accepting writes `skipDangerousModePermissionPrompt: true` to the **user settings file** (`$CLAUDE_CONFIG_DIR/settings.json`, default `~/.claude/settings.json`; checked with a scratch `CLAUDE_CONFIG_DIR`), not `~/.claude.json`. Passing `--settings '{"skipDangerousModePermissionPrompt":true}'` (flag settings) also skips the dialog without writing any file; using it means Tatsu accepts on the user's behalf, so it is only an option behind the Phase 3 launch-sheet confirmation for `full`, not part of this ticket. A readiness check for it belongs with Item 7's trust helper and the launch sheet (Phase 3); Tatsu never writes user settings to pre-accept it.
- **RISK-003**: Claude's `--mcp-config <configs...>` is also variadic (`claude.ts:172`). **Verified 2026-10-02**: `claude -p --mcp-config mcp.json 'say PONG'` fails with "MCP config file not found: …/say PONG"; with `--name x` between them it answers. In `buildSpawnArgs` the prompt directly follows `--mcp-config <path>` only when there is no `--name`, no `--append-system-prompt` (harness system prompt disabled or empty) **and** no `sessionId` (`--session-id <id>` otherwise sits in between). Claude tabs always get a `sessionId` today (`assignsSessionId: true`, `useTabHandlers.ts:60`, `panes-fsm.ts:260`), so it is latent, not live. It becomes live for any main-side spawn (ticket 04) that passes `initialPrompt` without a `sessionId`. Safe order: the prompt must follow an option (or `--`) after `--mcp-config`. Permission flags from this ticket sit before `--mcp-config`, so they don't fix it; report/fix separately (e.g. emit `--mcp-config` before `--model`, or put the prompt after `--`).
- **RISK-004**: opencode's `edit` pattern map and `"*"` catch-all are confirmed only by TASK-002. If 1.18.30 rejects either, `read-only` falls back to `edit: "deny"` (no run-folder writes on opencode) and the catch-all is replaced by an explicit list of every 1.18 permission key set to `deny`. Last-match-wins precedence is confirmed manually only (TASK-002, TEST-014); in CI it is guarded solely by TEST-006's key-order assertion (`'*'` first in every map), so an opencode upgrade that changes the precedence rule would not fail CI.
- **RISK-005**: A level lives only in the spawn request. Restarting a step tab from the tab menu, or a client remount after the PTY exited (ticket 04 RISK-004), respawns it **without** a level, i.e. with today's interactive defaults. The Phase 2 runner owns step terminals and must restart them itself with a new terminal id.
- **RISK-006**: Codex MCP tool calls have their own approval path (tool annotations plus per-server `default_tools_approval_mode`), separate from `--ask-for-approval`. Confirmed in source and handled by the `default_tools_approval_mode="approve"` override in REQ-005; TEST-005 should assert it is present only when `permissionLevel` and `mcpServer` are both set. TEST-013 only covers what can be checked once `complete_step` exists; recheck in Phase 2 with the fake agent and a real Codex step.
- **RISK-007**: A tool that waits for the user without being a permission prompt (Claude `AskUserQuestion`, opencode `question`) is denied at `read-only` / `edit` (not allowlisted / `"*": "deny"`) but allowed at `full`. At `full` the step can wait for an answer; the runner sees it as a turn end. Accepted.
- **RISK-008**: The user's shell rc exporting `OPENCODE_CONFIG_CONTENT` overrides ours (ticket 05 RISK-003), which would drop the `harness-step` agent; opencode then fails to start with `--agent harness-step` (unknown agent) rather than prompting. Visible failure, accepted.
- **ASSUMPTION-001**: Claude 2.1.286 `dontAsk` denies every tool not matched by an allow rule without prompting, including MCP tools (plan, "Harness research", verified for built-in tools; TEST-012 checks MCP). Verified 2026-10-02 in `-p` with a stub `harness-control` stdio server: `mcp__harness-control__complete_step` in the comma list ran, unlisted `mcp__harness-control__list_repos` was denied without a prompt. Exception: read-only Bash commands are auto-allowed (see "Notes on the mapping").
- **ASSUMPTION-002**: opencode's TUI accepts `--agent <name>` (present in `opencode --help` on 1.18.30) and resolves agents defined in `OPENCODE_CONFIG_CONTENT`.
- **ASSUMPTION-003**: Codex accepts `--sandbox` and `--ask-for-approval` as top-level options before the `resume` subcommand (TASK-003 confirms). Source agrees: `finalize_resume_interactive` starts from the root `TuiCli` and overrides only fields set after `resume` (`cli/src/main.rs` `merge_interactive_cli_flags`, `rust-v0.160.0`).

## 8. Related Specifications / Further Reading

- `plans/dynamic-workflows/milestones/milestone-1-prerequisites/goal.md`, Item 6
- `plans/dynamic-workflows/dynamic-workflows.md`: "Gaps found" (gap 5), "Permissions & trust" (mapping table), "Harness research (2026-10-01)" (row "Unattended permissions"), "Step output contract" (`needs-input`)
- `plans/dynamic-workflows/milestones/milestone-1-prerequisites/tickets/04-main-side-agent-spawn.md` (REQ-002/REQ-003 plug-in point, create-or-attach "attach wins", RISK-004), `05-mcp-codex-opencode.md` (REQ-004 `buildAgentSpawnOpts`, REQ-005 Codex overrides, REQ-006 `buildOpencodeConfig`, ALT-005), `01-opencode-plugin-esm.md`
- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/iam (permission modes and rule syntax)
- https://learn.chatgpt.com/docs/non-interactive-mode
- https://opencode.ai/docs/agents/
- https://opencode.ai/docs/permissions/

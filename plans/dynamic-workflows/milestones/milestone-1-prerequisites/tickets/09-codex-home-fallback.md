---
goal: Contingent follow-up to ticket 05. If Codex rejects the -c mcp_servers overrides, give Codex terminal tabs the harness-control MCP server through a per-terminal CODEX_HOME, once the user has decided how to handle hook trust
date_created: 2026-10-02
status: 'Skipped' # ticket 05 TASK-001 gate (a)-(c) passed on codex-cli 0.164.0 (2026-10-24, commit 72e6d9c); (d) pending a Codex re-login
tags: [feature, mcp, codex, agents, milestone-1, dynamic-workflows, contingent]
---

# Introduction

![Status: Skipped](https://img.shields.io/badge/status-Skipped-lightgrey)

> **Do not start unless ticket 05 TASK-001 failed. Otherwise mark Skipped.**

Milestone 1, Item 9 (contingent follow-up to Item 5; gap 2 in `plans/dynamic-workflows/dynamic-workflows.md` "Gaps found"). Size S. Goal table dependency: Items 5 and 8.

Ticket 05 wires `harness-control` into Codex tabs through `-c mcp_servers.harness-control.{command,args,env}` overrides behind a Phase 0 gate (ticket 05 REQ-008, TEST-014 (a)–(d)). The source read at `rust-v0.129.0` and `rust-v0.160.0` expects (a)–(c) to pass; only (d), a real TUI tool call, needs a binary. This ticket exists only for the case where the gate fails. It then replaces the overrides with a per-terminal `CODEX_HOME` whose `config.toml` carries the `[mcp_servers.harness-control]` table.

The fallback has a known blocker that source predicts **will** fire (`rust-v0.160.0`):

- `find_codex_home` canonicalizes `$CODEX_HOME` (`utils/home-dir/src/lib.rs`). The hook key is `<that dir>/hooks.json` joined without following the symlink (`hooks/src/engine/discovery.rs` `load_hooks_json`), so every key changes to `<userData>/codex-homes/<id>/hooks.json:…`.
- Trust state is read only from the user `config.toml` of that home plus `-c` session flags (`hooks/src/config_rules.rs` `hook_states_from_stack`). The copied `[hooks.state."~/.codex/hooks.json:…"]` entries never match, so Tatsu's hooks are `untrusted` and status detection silently dies.
- The only escapes are writing `trusted_hash` or passing `--dangerously-bypass-hook-trust` (Codex ≥ 0.131.0). Both need the explicit opt-in that Item 8 and the milestone's "Out of scope" forbid without a decision.

So Phase 0 ends in a user decision. Nothing is implemented without it.

This ticket:

1. Links the ticket 05 gate evidence and re-checks a newer Codex.
2. Gets the user's decision on hook trust (Phase 0 DECISION).
3. If the decision is to proceed: builds `src/main/codex-home/`, wires `codex.ts` `spawnEnv` and the prune call, and drops the `-c` overrides.
4. Records the outcome (Done, Skipped or Descoped) in the plan.

## 1. Requirements & Constraints

- **REQ-001 (precondition)**: Ticket 05 TASK-001 recorded a failure: the Codex version and which of TEST-014 (a)–(d) failed, in ticket 05's plan edit (ticket 05 TASK-017). Link that evidence (commit hash and the plan line) in this ticket before any other work. If ticket 05's gate passed, set `status: 'Skipped'` and stop.
- **REQ-002 (newer Codex)**: If (a), (b) or (c) failed on a version, first install the latest Codex and re-run ticket 05 TEST-014. If the gate now passes, raise ticket 05's minimum Codex version (its DEP-003) to that version, re-open ticket 05's Phase 2, and mark this ticket `Skipped`.
- **REQ-003 (DECISION, blocker)**: Present these options to the user and do not proceed without their choice. Record the choice and the date in this ticket.
  1. Accept Codex tabs without status detection when they run under a per-terminal home (MCP works; working/idle never shows).
  2. Opt in to `--dangerously-bypass-hook-trust` (Codex ≥ 0.131.0) or to `trusted_hash` writes into the per-terminal `config.toml`. This is Item 8's opt-in ("Trust automatically") and needs its own UI and consent.
  3. Ship Codex without MCP until Codex has a per-run mechanism that works. Mark this ticket `Descoped`.
  4. Look for a project-scoped config route (for example a `.codex/config.toml` in the worktree, or a profile). Unverified; investigate in Phase 0 against the installed binary and the source, and report whether it carries `mcp_servers` and leaves hook keys unchanged.
- **REQ-004 (implementation, only if the decision is to proceed)**: per-terminal `CODEX_HOME`. New main package `src/main/codex-home/` (`index.ts`, `codex-home.ts`, `codex-home.test.ts`):
  ```ts
  export function prepareCodexHome(
    terminalId: string,
    server: HarnessMcpServerSpec,
    opts?: { userHome?: string; root?: string }
  ): string | null
  export function pruneCodexHomes(keepIds: Set<string>, opts?: { root?: string }): void
  ```
  - `root` defaults to `join(userDataDir(), 'codex-homes')`; `userHome` defaults to `codexHomeDir()` from `src/main/agents/codex.ts` (ticket 08 REQ-010, built on ticket 07's `resolveCodexHome`: honours `CODEX_HOME`, realpath'd; the default `~/.codex` is not realpath'd). Do not inline `process.env.CODEX_HOME || join(homedir(), '.codex')`. If importing from `../agents` creates a cycle, import `resolveCodexHome` from `../folder-trust` instead. Dir: `<root>/<sanitize(terminalId)>`, created `0700`.
  - For every entry of `userHome` except `config.toml`: create a symlink to it (so `auth.json` refreshes, `sessions/` for resume and `CostTracker`, `hooks.json`, `harness-hook.sh` and `history.jsonl` stay shared). Never copy `auth.json`.
  - `config.toml`: copy of the user's (or empty), plus an appended `[mcp_servers.harness-control]` table with `command`, `args`, `env` written via `tomlValue` (ticket 05 REQ-005). If the user's file already has a `[mcp_servers.harness-control]` header, replace that table's body.
  - Returns the dir, or `null` on any fs error (logged; the tab then starts without MCP rather than failing).
  - `codex.ts` implements `spawnEnv` returning `{ CODEX_HOME: dir }` when `opts.mcpServer` and `prepareCodexHome` succeeds, else `{}`. `buildSpawnArgs` then does not emit the `-c` overrides. Keep `tomlValue` (used by `codex-home`).
  - `index.ts` calls `pruneCodexHomes(keepIds)` next to `pruneMcpConfigs(keepIds)`.
  - If the decision was option 2, apply the chosen opt-in only inside the per-terminal home or the spawn command, and only when the user has opted in.
- **SEC-001**: Per-terminal homes are `0700`. `auth.json` is symlinked, never copied. All writes stay under `<userData>/codex-homes/`.
- **SEC-002**: `HARNESS_TOKEN` never appears in a command line, a `log()` line or the per-terminal `config.toml`. The `env` table carries only `ELECTRON_RUN_AS_NODE`; the bridge reads the token from the `0600` per-terminal JSON (`--config`, ticket 05 REQ-001).
- **CON-001**: Do not write `~/.codex/config.toml` or any other user config file. `pruneCodexHomes` removes symlinks without following them.
- **CON-002**: Do not write `trusted_hash` or pass `--dangerously-bypass-hook-trust` unless the REQ-003 decision is option 2 with an explicit opt-in.
- **CON-003**: No store slice, event, or transport channel changes, unless option 2's opt-in needs one (then follow AGENTS.md's slice checklist).
- **GUD-001**: AGENTS.md: package-style dirs with barrels, imports through barrels, no new comments. Before committing run `pnpm typecheck`, `pnpm build`, `npx vitest run`. One commit for the code, then push. The plan edit is its own final commit.
- **PAT-001**: `codex-home.test.ts` uses a real `mkdtempSync` dir for `root` and `userHome`, like ticket 05 PAT-001.

## 2. Implementation Steps

### Implementation Phase 0: Precondition and decision

- GOAL-001: The gate failure is confirmed on the latest Codex, and the user has chosen how to handle hook trust. No code changes.

- [x] **TASK-001**: REQ-001. Link ticket 05's gate evidence (Codex version, failed check). If the gate passed, set `status: 'Skipped'` and stop. **Gate passed** (ticket 05 TASK-001 result, commit 72e6d9c): codex-cli 0.164.0 accepted the `-c mcp_servers.harness-control.*` overrides in `mcp list`, `mcp get --json` and before `resume`, and spawned the bridge with `--config`. Skipped.
- [ ] **TASK-002**: REQ-002. If (a)–(c) failed, re-run ticket 05 TEST-014 on the latest Codex. Gate passes → follow REQ-002 and stop.
- [ ] **TASK-003**: Confirm the stop condition on the installed binary: run TEST-001 with a hand-made per-terminal home (no code needed: `mkdir`, symlinks, `config.toml` copy). Record whether Tatsu's hooks are `trusted`.
- [ ] **TASK-004**: If option 4 is on the table, investigate it (REQ-003 (4)) and record the result.
- [ ] **TASK-005**: DECISION (REQ-003). Present options 1–4 with the TASK-003 and TASK-004 evidence. Do not proceed without the user's choice. Option 3 → set `status: 'Descoped'` and go to Phase 2. Option 4 confirmed → rewrite REQ-004 for that route before Phase 1.

### Implementation Phase 1: Per-terminal CODEX_HOME (only if proceeding)

- GOAL-002: Codex gets `harness-control` through a per-terminal `CODEX_HOME` without losing auth, sessions or cost tracking, with hook trust handled per the decision.

- [ ] **TASK-006**: Create `src/main/codex-home/` per REQ-004. Add `spawnEnv` to `codex.ts` and drop the `-c` overrides from `buildSpawnArgs` (keep `tomlValue`). Wire `pruneCodexHomes` in `index.ts`.
- [ ] **TASK-007**: Add TEST-002 and TEST-003.
- [ ] **TASK-008**: Run TEST-001 (hook trust under the fallback home, with the chosen option applied). Run TEST-004 (Codex manual). Verify (TEST-005), commit (`Fall back to a per-terminal CODEX_HOME for Codex MCP`), push.

### Implementation Phase 2: Close-out

- GOAL-003: The plan records the outcome for Codex MCP.

- [x] **TASK-009**: Set this ticket's front matter `status`: `'Completed'` (Phase 1 merged), `'Skipped'` (gate passed, TASK-001 or TASK-002) or `'Descoped'` (decision option 3). Same commit as TASK-010.
- [ ] **TASK-010**: Edit `plans/dynamic-workflows/dynamic-workflows.md`:
  - Gap 2: append `Codex closed in <hash>: per-terminal \`CODEX_HOME\` (ticket 09), because <failed check> on codex <ver>; hook trust: <decision>.` or, if descoped, `Codex: descoped (ticket 09), no per-run MCP mechanism on codex <ver>.`
  - "Harness research" table, row "Per-run MCP injection", Codex cell: record the mechanism that shipped and the Codex version, or the failure.
  - Commit separately (`Record the Codex MCP fallback outcome`), push.

## 3. Alternatives

- **ALT-001**: Write the fallback `config.toml` with full copies of `~/.codex` contents. Rejected: copied `auth.json` goes stale on token refresh, and copied `sessions/` breaks resume and `CostTracker`. Symlinks keep them shared.
- **ALT-002**: Register `harness-control` globally in `~/.codex/config.toml`. Rejected (ticket 05 ALT-001): one global entry can't carry a per-terminal id or scope, and it writes a user file.
- **ALT-003**: Copy the `[hooks.state."~/.codex/hooks.json:…"]` entries into the per-terminal `config.toml` under rewritten keys. Rejected unless the decision is option 2: it is a `trusted_hash` write.

## 4. Dependencies

- **DEP-001**: Ticket 05, gate failed (TASK-001 evidence), and ticket 05 Phases 1–3 merged (`HarnessMcpServerSpec`, `AgentModule.spawnEnv`, `agentEnv`, `tomlValue`).
- **DEP-002**: Ticket 08: `readCodexHookTrust` for TEST-001, and `codexHomeDir()` (REQ-010 there, using ticket 07's `resolveCodexHome`) for `userHome`.
- **DEP-003**: Ticket 06, if its Codex sandbox flags (`codexPermissionFlags`, `default_tools_approval_mode`) must coexist with `spawnEnv`: move `default_tools_approval_mode` into the per-terminal `config.toml` table when the `-c` overrides are dropped.
- **DEP-004**: A Codex binary ≥ 0.129.0 (≥ 0.131.0 for `--dangerously-bypass-hook-trust`) and a Codex login.

## 5. Files

- **FILE-001**: `src/main/codex-home/index.ts`, `codex-home.ts`, `codex-home.test.ts` (new). REQ-004.
- **FILE-002**: `src/main/agents/codex.ts`, `codex.test.ts`. `spawnEnv`; `-c` overrides dropped from `buildSpawnArgs`.
- **FILE-003**: `src/main/index.ts`. `pruneCodexHomes(keepIds)` next to `pruneMcpConfigs(keepIds)`.
- **FILE-004**: `plans/dynamic-workflows/dynamic-workflows.md`. Gap 2, research row (separate commit).
- **FILE-005**: `plans/dynamic-workflows/milestones/milestone-1-prerequisites/tickets/09-codex-home-fallback.md`. Evidence, decision, status.

## 6. Testing

- **TEST-001** (hook trust): with a fallback home, start Codex in a Tatsu tab and check Tatsu's hooks show as trusted in `/hooks` (or via Item 8's `readCodexHookTrust` / `codex app-server` `hooks/list` with `CODEX_HOME` set). Status changes appear in the sidebar. Without option 2 this is expected to fail (stop condition); record the result.
- **TEST-002** (`prepareCodexHome`): temp `userHome` with `auth.json`, `sessions/`, `hooks.json`, `config.toml` (`model = "m"`). Result dir has symlinks for all but `config.toml`; `config.toml` contains `model = "m"` and a `[mcp_servers.harness-control]` table with the spec; dir mode `0700`. A user `config.toml` already defining `[mcp_servers.harness-control]` ends up with exactly one such table. Missing `userHome` → dir with only `config.toml`. `auth.json` in the result is a symlink, never a regular file.
- **TEST-003** (`pruneCodexHomes`): dirs for ids outside `keepIds` are removed; kept ones and the user's real `~/.codex` targets are untouched (symlinks removed, not followed).
- **TEST-004** (manual): ticket 05 TEST-013 (a), (d) and (e) for Codex. `ps -ww -o args= -p <codex pid>` shows no `-c mcp_servers` and no token; the PTY env has `CODEX_HOME=<userData>/codex-homes/<id>`.
- **TEST-005**: `pnpm typecheck`, `pnpm build`, `npx vitest run` pass; `pnpm build:headless && bash scripts/smoke-headless.sh` passes.

## 7. Risks & Assumptions

- **RISK-001**: The fallback `CODEX_HOME` loses hook trust (key includes the canonicalized `hooks.json` path), breaks future `/hooks` approvals (written into the per-terminal `config.toml` copy) and misses Codex files created in `userHome` after spawn. That is why it is contingent and gated on a decision (REQ-003).
- **RISK-002**: Symlinked `sessions/` and `history.jsonl` are shared by concurrent Codex processes, as they are today with one `~/.codex`. No new risk.
- **ASSUMPTION-001**: Codex follows symlinks inside `CODEX_HOME` for `auth.json` and `sessions/`. TEST-004 confirms.

## 8. Related Specifications / Further Reading

- `plans/dynamic-workflows/milestones/milestone-1-prerequisites/goal.md`, Item 9 (and Items 5, 8)
- `plans/dynamic-workflows/dynamic-workflows.md`: "Gaps found" (gap 2), "Harness research (2026-10-01)" (row "Per-run MCP injection"), "Codex hook trust"
- `plans/dynamic-workflows/milestones/milestone-1-prerequisites/tickets/05-mcp-codex-opencode.md` (REQ-005, REQ-008, TEST-013, TEST-014), `07-folder-trust-helper.md` (`resolveCodexHome`), `08-codex-hook-trust.md` (`readCodexHookTrust`, `codexHomeDir`), `06-permission-levels.md` (Codex flags, `default_tools_approval_mode`)

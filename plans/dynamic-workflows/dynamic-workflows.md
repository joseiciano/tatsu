# Dynamic workflows plan

## Summary

### Goal

Users define, inside Tatsu, a workflow made of steps. Each step can run on a different harness (e.g. Claude Code plans, Codex implements, opencode reviews, a shell step runs the tests). They then run that workflow against a **body of work**: one task, a worktree, or an ordered list of items (issues, PRs, a task list, or tasks produced by an earlier step). Each item gets its own isolated run. Every step returns a uniform, machine-readable result, whichever harness produced it.

### Why

- Each harness/model has strengths; workflows let users pick the best one per step
- Tatsu already owns the primitives (agent tabs, status hooks, MCP control server, worktree creation). Workflows are an orchestration layer on top of them.
- A uniform step output contract makes handoff between harnesses deterministic
- Running many runs and batches side by side is the swarm part: N worktrees, N agents and one board, instead of N hand-started sessions

### What "dynamic" means here

Dynamism comes in rungs. Each one builds on the previous, and each ships on its own:

| Rung | What changes at runtime | Phase |
|---|---|---|
| 1. User-defined | Graph is data (YAML) authored in Tatsu, not code | 2 |
| 2. Conditional | Gates, loops, `when:` conditions driven by step `data` / shell exit codes | 4 |
| 3. Over a list of inputs | One definition × an ordered list of items → a chain of child runs (batch mode, independent or stacked) | 5 |
| 4. Over step output | A step emits a list (`data.tasks`), and a `foreach` step runs a chain with a child per entry | 6 |
| 5. Agent-orchestrated | An orchestrator step calls `run_step` / `await_step` and decides the graph itself | 8 |

Rung 4 lets a planner split the work and hand each piece to its own run while the graph stays inspectable and deterministic. Rung 5 is deliberately last.

## Scope

Included:
- Step harnesses: Claude Code, Codex, opencode
- **Pi** is a supported *tab* harness (`src/main/agents/pi.ts`, `config.piCommand` / `piEnvVars` / `piModel`, `pi` branches in `agent:buildSpawnArgs` and `pty:create`) but not a step harness in v1. Every spawn path the prerequisites move must keep its `pi` branch and end in `assertNeverAgentKind`; Pi tabs behave exactly as today. Adding Pi as a step harness is a later item (it has hooks but no MCP and no unattended permission mode mapped yet).
- Step kinds: `agent` (PTY tab) and `shell` (deterministic command, exit code = result)
- Workflows section UI (runs + chains + definitions library + editor + launch sheet)
- `workflows` slice, workflow runner FSM, `complete_step` MCP tool
- Prerequisites: main-side agent spawn, opencode plugin fix, MCP parity for Codex and opencode, per-step permission modes

Explicitly out of scope (for now):
- Generic / arbitrary harness support (revisit later, likely via ACP)
- Headless step execution (later, a second `StepDriver`)
- Event triggers (PR opened, issue labeled)
- Merging parallel writers back into one branch (each item produces its own branch/PR, stacked on the item before it; see "Isolation")
- Mixed chains: a chain is either all-independent or one linear stack in v1 (see "Chains"). A chain made of several sub-stacks is a later extension.

## Existing primitives

| Need | Already in Tatsu |
|---|---|
| Spawn harness X with a prompt | `AgentModule.buildSpawnArgs({initialPrompt, model, mcpConfigPath, systemPrompt})` in `src/main/agents/` |
| Know when an agent's turn ends | Hook NDJSON → `Stop` (Claude, Codex) / `session.idle` (opencode) → terminal status |
| Final assistant message | Hook command already appends the **entire** stdin payload, so Claude/Codex `last_assistant_message` is already in the NDJSON. `hooks.ts` parses it (and opencode's plugin-emitted value) into `StopEvent.lastAssistantMessage`. |
| Agents calling back into Tatsu | `harness-control` MCP bridge (`resources/mcp-bridge.js`) + control server; scope is resolved from `X-Harness-Terminal-Id` on every call |
| Fan out to new worktrees | `create_worktree` MCP tool, `runPendingPRWorktree` (accepts `agentKind`, `model`) |
| Deterministic commands | Shell tabs + `createShell` / `readShellOutput` (`ShellQueries`) |
| Visible, steerable sessions | Agent tabs via `PanesFSM`; spectators attach via `terminal:join` |
| Cost | `CostTracker` (Claude + Codex jsonl only). It parses nothing while no client has the cost panel open (`costs:setInterest`), so the runner must hold its own interest for the terminals it owns (see "Concurrency, budgets, recovery"). |
| Swapping the agent command | `settings.claudeCommand` (used by the e2e fake agent) |

### Gaps found (verified against code and installed harnesses, 2026-10-01; re-checked 2026-10-24)

Re-check note (2026-10-24): the 2026-10-01 pass read a checkout older than `origin/main`. Gap 6 was already closed, Pi was already wired into every spawn path, and `src/main/index.ts` line numbers in the tickets had drifted by 18-75 lines (refreshed in the tickets the same day). Claude on the dev machine is now 2.1.302; gap 5 and ticket 06 verifications were done on 2.1.286/2.1.288 and are re-run in ticket 06 Phase 0.

1. **Agent spawn is renderer-driven (blocker).** `XTerminal.tsx:456-501` calls `agent:buildSpawnArgs` and then `pty:create`, and **defers the spawn until the tab has layout** (≥20px). A step tab created in a background worktree doesn't start until someone opens it, and on headless with no client attached it never starts. The runner needs a main-side spawn path (see "Main-side spawn" under Architecture). Closed in c3e8766..93bec94: `src/main/agent-spawn/` builds and spawns agent terminals with no renderer (default 120×30, or a sibling tab's size), `pty:createOrAttach` / `terminal:attach` make terminal creation create-or-attach with ordered history replay, and agent tabs main creates with `fromMain` (prompted or teleported new worktrees) start from main. UI-initiated tabs are still spawned by the renderer at their fitted size, and tabs restored from disk still start on first view. REQ-018 shipped the `--` form for Claude's positional prompt (probe on 2.1.302).
2. **MCP only reaches Claude.** Claude gets `--mcp-config <per-terminal file>`. Codex's `buildSpawnArgs` comment claims a global `~/.codex/config.toml` registration, but nothing in `src/main` writes it. opencode has no MCP wiring at all.
3. **opencode plugin is broken (confirmed).** `makePluginContent()` in `src/main/agents/opencode.ts` emits a CommonJS `module.exports = { onEvent }` that reads `ev.payload.session.id`. Run under opencode 1.18.30 with `HARNESS_TERMINAL_ID` set, it writes nothing, so opencode status detection is broken today, independently of workflows. The documented format loads and works: `export const X = async ({ client }) => ({ event, 'tool.execute.before', ... })`, events shaped `{ type, properties }` with `properties.sessionID`. Tool calls arrive through the `tool.execute.before` / `tool.execute.after` hooks, not as bus events.
4. **Codex hooks flag name drift.** `ensureCodexHooksEnabled` writes `codex_hooks = true`, but the current docs name the flag `[features] hooks` (default on). This is harmless while the default holds; align it during MCP parity work. It also appended the key to the end of `config.toml`, landing it in whichever table came last; fixed in `156d4a1` (inserted under `[features]`).
5. **No unattended permission story.** `auto-approver` only serves chat-tab approval cards. A PTY step stalls on its first permission prompt (`needs-approval`). Verified on Claude 2.1.286: `--permission-mode plan` writes its plan to Claude's own plans folder and stops at "Would you like to proceed", and `acceptEdits` still prompts for every Bash command. See "Permissions & trust" for the fix.
6. **Bridge agentKind mismatch.** `create_worktree.agentKind` advertised `['claude', 'codex']` and the bridge rejected anything else, while the server accepted `opencode`. Closed in `d4759f6` (2026-09-25, before this plan): the enum, the validation and the label all derive from one `AGENT_KIND_LABELS` list covering `claude`, `codex`, `opencode`, `pi`, and `mcp-bridge.test.js` covers all four. Remaining (ticket 02, reduced): `trim().toLowerCase()` normalisation to match `parseAgentKind`, and a test tying the bridge list to `AGENT_REGISTRY`.
7. **Hook line atomicity.** The hook comment relies on writes < `PIPE_BUF` (4096 B) being atomic. Payloads that carry `last_assistant_message` will regularly exceed that. Only one agent writes per terminal file, so it's fine in practice, but the comment and the residual-line handling should acknowledge it. Closed in b0f7b63: the comment now says lines can exceed PIPE_BUF and why that is safe, the reader buffers partial lines as bytes, and every Stop's last_assistant_message reaches onStopEvent.
8. **Claude folder trust blocks unattended spawns.** In a folder Claude hasn't seen, it opens a trust dialog before running any prompt. Trust carries down from a trusted parent folder. A step spawned in an untrusted worktree path stalls on that dialog.
9. **Codex skips untrusted hooks.** Since rust-v0.129.0, Codex ignores user hooks (including `~/.codex/hooks.json`) until the user approves them in `/hooks`. Without that approval, Codex status detection and the workflow Stop hook never fire. Partly addressed in `7edfc85`: entries now run a fixed command (`bash '<home>/.codex/harness-hook.sh' <Event>`) so logic changes don't reset trust, and Settings and the consent banner tell users to approve once. Remaining work: `installHooks` must keep entry positions, and Tatsu should show trust status. See "Codex hook trust" under Harness research.

## Concepts

| Term | Meaning |
|---|---|
| **Definition** | YAML graph of steps + typed inputs. Personal or repo-scoped. |
| **Run** | Definition snapshot + target worktree + inputs. Owns one worktree. |
| **Chain** | One definition over an ordered list of **items**, one child run per item, one board. Created by the launch sheet (**batch** mode) or by a `foreach` step (phase 6). Mode `independent` (each item branches from base, items run in parallel up to the concurrency cap) or `stacked` (one linear chain, each item on the one before it, one at a time). |
| **Item** | One entry of a chain: `{ id, title, branch, baseBranch, prNumber?, prevItemId? }`. |
| **Step** | Node in the graph: `agent`, `shell`, `foreach` (phase 6), `orchestrator` (phase 8) |
| **Attempt** | One execution of a step, identified by a runner-generated `attemptId`. Retries, gate rework and loop iterations create attempts. |
| **StepDriver** | Runner-side adapter per step kind: `start(attempt) → executionId`, `continue(executionId, prompt)`, `cancel(executionId)`, emits `turnEnded(executionId, lastMessage?)` / `exited(executionId, code)`. Completion is **not** a driver event; it reaches the runner through `complete(attemptId, result)` from the control server (`complete_step`) or the UI (Mark done). The PTY agent driver (`executionId` = terminal id) and the shell driver are v1; a headless driver comes later. |

## Definition format

```yaml
name: plan-build-review
inputs:
  task: { type: text }
item_input: task
defaults:
  permissions: edit
  allow: ["pnpm *", "git status", "git diff *"]
steps:
  - id: plan
    agent: claude
    model: claude-opus-5-5
    permissions: read-only
    prompt: "Plan this task. Return the full plan as your complete_step summary. Task: {{inputs.task}}"
    gate: approve
  - id: build
    agent: codex
    prompt: "Implement this plan:\n{{steps.plan.summary}}"
    on_loop: "Review feedback to address:\n{{steps.review.summary}}"
  - id: test
    kind: shell
    run: pnpm typecheck && npx vitest run
  - id: review
    agent: opencode
    needs: [build, test]
    permissions: read-only
    prompt: "Review the diff against this plan:\n{{steps.plan.summary}}\nTest result: {{steps.test.summary}}"
    output:
      verdict: { enum: [pass, fail] }
    loop: { back_to: build, until: { field: verdict, equals: pass }, max: 3 }
```

Rules:
- **`needs:`** (GitHub Actions style). If omitted, it means "the previous step". Steps whose needs are all satisfied start together. This replaces the "run alongside previous step" toggle, which can't express diamonds.
- **`kind: shell`** steps run in a shell tab. `status = exit code == 0 ? done : failed`, `summary` = the last N lines of output. Deterministic checks belong here, not in an LLM verdict.
- **`allow:`** is a list of Bash command patterns the step may run without asking (see "Permissions & trust"). It can be set in `defaults` and per step; a step's list replaces the default.
- **`until` / `when` are structured** (`{field, equals | in | not}`), plus `{exit: 0}` for shell steps. There's no expression string and nothing to `eval`.
- **`on_loop`** is the prompt sent when a loop re-enters a step. The step **continues its existing session** (it keeps its context and costs less) instead of spawning a fresh one.
- **`output:`** is a JSON Schema subset (`string`, `number`, `boolean`, `enum`, `array` of those, plus `required`). It becomes `complete_step`'s input schema.
- **`item_input:`** names the input each batch item fills. Required for a definition to be launched as a batch.
- **`parallel_safe: true`** marks a shell step as not writing to the worktree, so it may run alongside other steps (see "Isolation").
- **Template scope**: `inputs.*`, `steps.<id>.summary|data.*|status`, `run.id`, `run.worktree`, `run.contextPath`, `item.*` (batch/foreach). Templates are checked when the definition is saved (unknown references fail validation) and filled in at run time; they're never run as code.
- **Validator scope**: the Phase 1 parser accepts the full schema (`needs`, `gate`, `loop`, `when`, `on_loop`, `output`, `allow`, `item_input`; `foreach` reserved). Fields the runner doesn't support yet fail validation with a clear message ("loops need phase 4") instead of being silently ignored, so the parser isn't rewritten as phases land.
- A run stores a **resolved snapshot** of the definition (plus a content hash). Editing or switching branches mid-run never changes a running graph.

### Control flow semantics

- **Gates**: after the step completes, the run pauses with `pausedReason: gate`. **Approve** moves on. **Request changes** continues the same session with the user's feedback as the next prompt (the same mechanism as `on_loop`). The step completes again as a new attempt and the gate is shown again.
- **Loops**: when `until` isn't met, every step between `back_to` and the looping step re-runs, both ends included (build → test → review in the example). Agent steps continue their sessions with `on_loop`, or with a default "your previous result was … address the feedback" prompt when they have none. Shell steps re-run from scratch. Each pass is a new attempt. Hitting `max` pauses the run with `pausedReason: loop-cap`.
- **Context growth**: continuing one session across many iterations fills the context window. `loop: { fresh: true }` starts each re-entered agent step in a new session (new terminal id) with `on_loop` plus `{{steps.<id>.summary}}` from the previous attempt as its prompt; the default is to continue. The gate's "Request changes" has a "fresh session" checkbox with the same effect. A later refinement can auto-switch to fresh after N continuations.

## Isolation and the body of work

- **One run = one worktree.** All steps of a run share it. Two runs never share a worktree concurrently; launching onto a busy worktree is refused.
- **Parallel steps inside a run must not write.** Agent steps running alongside others must be `permissions: read-only`, enforced through each harness's read-only mode, not by convention. Shell steps count as writers unless they set `parallel_safe: true`. Parallel writers aren't allowed in v1.
- **Chains**: each item gets its own new worktree and branch, and the runner **opens a PR automatically** when the item's run finishes `done`. Nothing merges back into a shared branch. In `independent` mode (the default) every item branches from the repo base and its PR targets the base; items run in parallel up to `maxConcurrentAgents`. In `stacked` mode (launch-sheet toggle "Items depend on each other") items form one linear stack, one at a time. See "Chains".
- **`foreach` over step output** (phase 6): children follow the same rules as a launch-sheet chain, in the mode the `foreach` step declares (`mode: independent | stacked`, default `independent`). In `stacked` mode the first child branches from the parent run's current snapshot. A `join` step afterward sees `{{steps.<foreach>.children.summaries}}`, a joined list the template grammar defines explicitly (no wildcard).

Item sources in the launch sheet:
- GitHub issues (label / search query) or PRs (picker / query)
- Free-text list (one item per line)
- File glob in the repo
- Later: event triggers

Whatever the source, the items become an ordered list in the launch sheet. The user reorders it before starting, and **that order is the chain**. No dependency data is imported from GitHub or parsed from text.

### Chains

**Why not stack by default** (review question): most lists of issues are independent, and stacking ties every item to unreviewed earlier work and lets one failure block the rest. Stacking is right when the items are steps of one piece of work, so it is the user's explicit choice per launch.

**Independent chain** (default): every item branches from the repo base, runs as its own run (parallel up to the cap), and gets a PR against the base. A failed item pauses only itself; the others continue. No restack is ever needed.

**Stacked chain** (toggle "Items depend on each other"): **one linear stack**. Every item branches from the item before it, so each branch contains all earlier work and nothing ever needs merging.

```
main
 └ 1           PR #1 → main
    └ 2        PR #2 → 1
       └ 3     PR #3 → 2
          └ 4  PR #4 → 3
```

- **One item runs at a time** in a stacked chain. Parallelism comes from independent chains or from running several runs side by side, limited by the global `maxConcurrentAgents`.
- **Earlier work counts as done.** Once an item finishes and its PR is open, the next item builds on it without waiting for review or merge. The PR chain records that assumption: each PR targets the branch of the item before it and shows only its own diff.
- **Scheduling**: item N stays `queued` until item N-1 is `done` and its PR is open. It then branches from that item's head (the branch tip after the runner's final commit).
- **Branch names**: `wf/<definition>/<item-slug>-<shortRunId>`.
- **Failure**: if an item fails or is cancelled, every later item stays `queued` and the batch shows the reason in Needs you. Retrying the item unblocks the chain; Skip offers "restack the rest onto the previous item" or "cancel the rest of the chain".
- **PR creation** (runner feature, via `src/main/github/`):
  1. Commit any leftover changes with the run summary as the message.
  2. Push the branch.
  3. Open the PR with its base set to the previous item's branch (or the repo base for the first item). The title comes from the item, and the body holds the run summary, step results, and a "Stacked on #N" line.
  4. Record the PR on the run so `PRPoller` tracks it.

  A launch-sheet toggle (default off) opens them as drafts.
- **Earlier item changes after review** (phase 5b, built only on demand): when a branch in the stack gets new commits (review fixes), every branch after it is stale. Run detail shows "Restack": rebase the rest of the chain, in order, and force-push each branch. Every restack needs an explicit click, because it force-pushes.
- **Restack conflicts**: if a rebase stops on a conflict, the runner aborts it, leaves that branch and everything after it untouched, and pauses the batch with "conflict restacking <item> onto <item>". The user can start a conflict-resolution agent step in that item's worktree, or resolve it by hand and click Restack again.
- **Earlier item merged**: GitHub retargets the next PR to the base branch when the merged PR's head branch is deleted. If the repo doesn't auto-delete branches, the runner retargets the next PR to the repo base itself once `PRPoller` reports the merge.

## UX

### Workflows section

A full-screen view alongside Activity / Cleanup / Command Center (`showWorkflows` in `App.tsx`), reachable from the sidebar, a hotkey and the command palette. Two tabs:

**Runs** (default)
- **Needs you** (pinned at the top): every `paused` run, labelled by its `pausedReason` (gate, failed step, `needs-approval`, `needs-input`, budget cap, loop cap, timeout, interrupted, folder trust, restack conflict). Fire an OS notification on entry.
- **Active**: one card per run or chain. Run card: workflow name, repo/worktree, step strip (`plan ✓ → build ● → review ○`), current agent + status, elapsed time, cost. Chain card: the items as a strip (`1 ✓ → 2 ● → 3 ○ → 4 ○`, with a stack glyph in stacked mode) and expands to its child runs, each with its PR link.
- **Recent**: finished / cancelled
- Run detail: read-only graph, timeline of attempts, each step's result + diff (from snapshots), "Jump to tab", and actions: Approve / Request changes (gates), Retry, Retry from clean, Skip, Swap harness/model, Mark done (manual summary), Cancel

**Library** (definitions)
- Grouped by scope: **Personal** / **This repo**
- Actions: Run, Edit, Duplicate, Delete, New workflow

Worktrees with a running workflow get a small badge in the sidebar.

### Running a workflow

A run = **definition + target + inputs**. Every entry point opens the same launch sheet:

1. **Target**: repo, then **new worktree** (default), **existing worktree**, or **batch over items** (source picker, the ordered item list with drag-to-reorder, "Items depend on each other" toggle for a stacked chain, draft-PR toggle)
2. **Inputs**: generated from the definition's typed inputs: `text` (textarea), `issue` / `pr` (GitHub picker), `file` (file picker). In a batch, each item fills the input named by `item_input`.
3. **Overrides** (collapsed): per-step agent/model swap, **autopilot** (auto-approves gates), and a budget cap

The launch sheet refuses to start until hooks consent is `accepted` for the repo, with an "Install hooks" button: status detection, final-message capture and Stop continuation all depend on the hooks. The runner re-checks consent (and, for Claude/Codex steps, folder trust) immediately before each spawn, since consent can be withdrawn while a run is queued.

### Step tabs

- The runner creates every step tab through `PanesFSM.addTab(wtPath, tab, paneId, { fromMain: true })` (ticket 04), labelled `⚙ <step> · <agent>`, with `tab.workflow = { runId, stepId, attemptId }` on the `TerminalTab` (slice field, so every client renders the badge and the rules below).
- **Closing a step tab** asks "Cancel step <id>?"; confirming cancels the attempt (run pauses with `pausedReason: step-failed`, reason "cancelled by user"). Declining keeps the tab.
- **Typing into a step tab** is allowed and is how the user steers. Keystrokes don't change the step's state; the next `Stop` is handled like any other turn end. The once-per-turn continuation counter resets on every `UserPromptSubmit`, so a user-sent prompt gets its own single continuation.
- **No respawn on remount**: `XTerminal` does not respawn a tab whose `workflow` field is set when its PTY has exited (ticket 04 RISK-004). The tab shows the exited overlay and the step's result; only the runner starts a new attempt, with a new terminal id.
- **Spectators**: other clients attach as today (`terminal:join`).

Entry points:
- Library → Run
- New Worktree screen → "Workflow" dropdown
- Worktree context menu → "Run workflow here…" (prefilled target)
- Command palette
- Later: `run_workflow` MCP tool; event triggers

### Definition editor

v1 is **YAML-first in Monaco** (already bundled via `monaco-setup`), with:
- schema-driven validation diagnostics (unknown step refs, template refs, cycles, invalid `needs`, fields the runner doesn't support yet)
- template autocomplete for `{{inputs.*}}` / `{{steps.<id>.*}}`
- a live read-only graph preview next to it

The form editor (step cards) comes later (phase 7). Two-way form↔YAML sync is a large amount of UI work for a power-user feature, and YAML is the storage format anyway. A cheap later win: "Describe a workflow" → a chat tab drafts the YAML.

### Storage

- **Personal**: `userData/workflows/*.yaml`, the default when creating from the UI
- **Repo**: `.harness/workflows/*.yaml`, committed and shared with the team ("Save to repo" in the editor). This matches the existing `.harness.json` / `HARNESS_*` naming. Don't introduce a `.tatsu/` prefix.
  - The Library reads repo definitions from the repo's **primary checkout** and watches that folder for changes. Other worktrees' copies (on other branches) are ignored in v1; a "use this worktree's copy" option can come later.
  - Trust is checked and the snapshot taken at launch, so a later edit never affects a running graph.
- **Run artifacts**: `<worktree>/.harness/runs/<runId>/` (rendered prompts, `context.md`, step outputs such as the plan), excluded via `$(git rev-parse --git-common-dir)/info/exclude`. In a worktree, `.git` is a file; never edit the user's `.gitignore`.
- **Run records**: `userData/workflow-runs/<runId>.json`. The slice holds definitions + active runs + a capped recent index; full history for older runs loads on demand.
- YAML over JSON because prompts are multi-line and they're the main content
- Selected tab, editor drafts, etc. stay renderer `useState`.

## Harness research (2026-10-01)

Rows marked **verified** were checked against Claude Code 2.1.286 and opencode 1.18.30 running in a real pty. Codex isn't installed on the dev machine yet.

| | Claude Code | Codex | opencode |
|---|---|---|---|
| Turn-end hook (already installed by Tatsu) | `Stop` | `Stop` | `session.idle` via plugin; current plugin broken, documented ESM format **verified** (gap 3) |
| Hook carries final message | yes (`last_assistant_message`) | yes (`last_assistant_message`, nullable) | no, but the plugin reads it with `client.session.messages()` (**verified**) |
| **Hook can force continuation** | yes: `{"decision":"block","reason":…}` | yes: same shape; `reason` becomes the next user prompt; `stop_hook_active` flag | `client.session.promptAsync()` from the plugin, **must pass `agent`** or the turn goes to the default agent (**verified** in the TUI) |
| Unattended permissions | `--permission-mode dontAsk` + `--allowedTools` (**verified**: allowed tools run, others are denied without a prompt). `plan` and `acceptEdits` stall (gap 5). | `--sandbox read-only` / `workspace-write` + `--ask-for-approval never` / `danger-full-access` | a dedicated `harness-step` agent in `OPENCODE_CONFIG_CONTENT` with its own `permission` map and `tools.task: false` (**verified**). Top-level `permission` is **not** enough: subagents use their own permissions. |
| Headless | `claude -p --output-format stream-json` | `codex exec --json` | `opencode run --format json` |
| Typed headless "done" event | yes (`result`) | yes (`turn.completed` / `turn.failed`) | **no**: process exit without `error` |
| Schema-validated output | `--json-schema` → `structured_output` | `--output-schema` (JSON as final message text) | **CLI: no** (server/SDK only) |
| Per-run MCP injection | `--mcp-config` | `-c mcp_servers.*` (unverified until the ticket 05 gate runs; if it fails, see ticket 09) | `OPENCODE_CONFIG_CONTENT` env var (**verified**; merges with the user's global config) |
| Resume | `--resume <id>` | `codex resume <id>` / `codex exec resume <id>` | `--session <id>` |
| ACP | adapter `@agentclientprotocol/claude-agent-acp` | adapter `@agentclientprotocol/codex-acp` | native `opencode acp` |
| Folder trust prompt | yes, inherited from a trusted parent (gap 8) | per-project `trust_level` in `config.toml` | none |

Unverified: Codex `-c mcp_servers.*` per-run override; whether Codex hooks fire under `codex exec`. Resolved: opencode 1.18.30 emits `permission.asked` (ticket 01 TASK-001, 2026-10-02; `permission.updated` never fired). Claude rows were verified on 2.1.286; the dev machine now runs 2.1.302 and ticket 06 Phase 0 re-runs them. Codex is still not installed: ticket 05 TASK-001 is the single install and scratch-`CODEX_HOME` session that tickets 06, 07 and 08 reuse.

### Codex hook trust (2026-10-02)

Read from the Codex source at `openai/codex@c5d242f`; not yet checked against a running binary. Hook trust landed in PR #20321 and shipped in **rust-v0.129.0**; the `/hooks` review UI followed in #21755.

- **Trust key and hash.** Each hook handler is tracked under a key and a content hash.
  - The key is `"<abs path of hooks.json>:<event_snake>:<group_index>:<handler_index>"`, e.g. `/Users/u/.codex/hooks.json:session_start:0:0` (`codex-rs/hooks/src/lib.rs:113-123`, `hooks/src/engine/discovery.rs:174`).
  - The hash is sha256 of the normalized identity `{event_name, matcher?, hooks:[{type, command, timeout, async, statusMessage?}]}`, serialized as JSON with recursively sorted keys and no whitespace, prefixed `sha256:` (`discovery.rs:770-794`, `config/src/fingerprint.rs:54`). `matcher` is dropped for `UserPromptSubmit` and `Stop`. The command is the raw string, before `${VAR}` substitution.
  - Status is `trusted` when the stored hash matches, `modified` when a different hash is stored, and `untrusted` when none is (`discovery.rs:796-817`).
- **Consequences for Tatsu.**
  - The contents of a referenced script are never hashed, so rewriting `harness-hook.sh` keeps trust. The flip side: anything that can write that file changes trusted behaviour without review.
  - The command string and `timeout` must never change; either change forces re-review. That includes the absolute path, so a different home directory means a different hash.
  - The key depends on **position**. `installHooks` currently strips Tatsu's entries and re-appends them on every boot. If the user adds a hook after Tatsu's entry for the same event, Tatsu's entry moves to a new index and becomes `untrusted`, and the user's hook shifts into Tatsu's old slot and shows as `modified`.
  - Moving from the old inline `bash -c` command to the script command forces one re-approval on upgrade.
- **Where trust is stored.** In `~/.codex/config.toml` as `[hooks.state."<key>"] trusted_hash = "sha256:…"` (the same table can hold `enabled = false`). `/hooks` writes it through `config/batchWrite` (`tui/src/hooks_rpc.rs:58-91`). Only the user and session-flag config layers are read (`hooks/src/config_rules.rs:15-65`). No `codex` subcommand reports trust; the only official query is the app-server JSON-RPC method `hooks/list`, which returns `key`, `currentHash` and `trustStatus` (`app-server-protocol/src/protocol/common.rs:890`).
- **Ways to pre-trust**, none suitable as a default:
  - Writing `trusted_hash` into `config.toml`. It works, but it self-approves Tatsu's hooks and skips the review Codex intends, so it is only acceptable as an explicit opt-in.
  - A per-launch `-c 'hooks.state={"<key>"={trusted_hash="sha256:…"}}'` inline-table override. Session-flag config is honored for hook state, but `-c` splits keys on `.`, so it has to be an inline table. It only covers Codex processes Tatsu launches. Untested.
  - Managed hooks from the System layer (`/etc/codex/config.toml`, `/etc/codex/hooks.json`, or `managed_hooks` in `/etc/codex/requirements.toml`) skip trust (`discovery.rs:827-830`). This needs root or MDM and applies to the whole machine.
  - `--dangerously-bypass-hook-trust` is CLI-only (`bypass_hook_trust` is not a config key) and bypasses trust for every hook, including the user's own.
- **Decision:** guided one-time approval in `/hooks` with a byte-stable command. Never write `trusted_hash` without an explicit opt-in.

Sources:
- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/hooks
- https://learn.chatgpt.com/docs/non-interactive-mode
- https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- https://learn.chatgpt.com/docs/hooks
- https://learn.chatgpt.com/docs/app-server
- https://opencode.ai/docs/cli/
- https://opencode.ai/docs/mcp-servers/
- https://opencode.ai/docs/plugins/
- https://agentclientprotocol.com/llms.txt

### Approaches considered

1. **Per-harness headless modes**: rejected for v1. Claude is strong and Codex is fine, but opencode lacks a final event and schema support. It would mean three parsers and no human steering.
2. **ACP for all three**: rejected for v1. It gives a uniform transport, but no structured output, extra npx adapters for Claude/Codex, and v2 changes turn-completion semantics. Tatsu chat tabs already use the Agent SDK directly. It's the candidate path for generic harness support later.
3. **Interactive PTY tabs + `complete_step` MCP tool + existing hooks**: chosen. MCP tool arguments are schema-validated, so a tool call gives portable structured output across all three harnesses without per-harness schema flags. It reuses the tabs and hooks Tatsu already has. The `StepDriver` seam keeps option 1/2 open as a second driver.

## Step output contract

Every step ends in one shape, whatever the harness:

```ts
interface StepResult {
  status: 'done' | 'failed' | 'needs-input'
  summary: string
  data?: Record<string, unknown>
  baseSnapshot: string
  headSnapshot: string
  sessionId?: string
  exitCode?: number
  costUsd?: number
  durationMs: number
  completedBy: 'tool' | 'fallback' | 'user' | 'exit'
}
```

### Step identity

There is no `HARNESS_STEP_ID` env var. The runner keys everything on a runner-generated **`attemptId`**; each `StepDriver` returns an `executionId` for the attempt it started (the terminal id for the PTY and shell drivers; a process or ACP session id for a later headless driver) and the runner keeps `executionId → attemptId`. The control server already resolves the caller's terminal id from `X-Harness-Terminal-Id`; `GET /workflow/step` asks the runner for the attempt behind that execution id. If the terminal belongs to a step, the bridge advertises `complete_step` with that step's schema at `tools/list`; otherwise the tool isn't listed. `POST /workflow/complete` becomes `runner.complete(attemptId, result)`, the same entry point "Mark done" uses, so completion never depends on the driver. A loop iteration or gate rework continues the same execution, so the mapping stays valid. Retry-from-clean and `fresh` loops start a new execution.

### How it gets filled

1. **`complete_step({status, summary, ...fields})`** is authoritative. `status` defaults to `done`; `needs-input` lets the agent explicitly say it's blocked and why (including when a tool it needed was denied). The server re-validates against the step schema, and an invalid call returns a tool error so the agent retries.
2. **Turn ended without `complete_step`** (`Stop` / `session.idle`):
   - First time: **harness-native continuation**, not keystrokes. For Claude and Codex, a workflow Stop hook asks the control server and returns `{"decision":"block","reason":"Call complete_step with your result, or with status needs-input and what you need."}`. Gate this with `stop_hook_active` plus the runner's own counter so it fires once per turn. For opencode, the plugin calls `client.session.promptAsync` with the same text and an explicit `agent`. Typing into the PTY is the last-resort fallback only.
   - The Stop hook (and the opencode plugin's check) does nothing for terminals that don't belong to a step, calls `POST /workflow/stop-check` with a ~2 s timeout, and **fails open**: if the control server is down or slow it exits 0 with no output, so the user's session is never blocked.
   - **Channel back to Tatsu** (decided 2026-10-24; review 2 item 1). The hook today only appends NDJSON, and `HARNESS_PORT` / `HARNESS_TOKEN` are not in the PTY env. The fix reuses ticket 05's per-terminal `0600` file: `agentEnv` (ticket 05 REQ-009) puts `HARNESS_MCP_CONFIG=<userData>/mcp-configs/<terminalId>.json` in the PTY env (a path, no secret). The runner writes a marker `<userData>/mcp-configs/<terminalId>.step` when it starts an attempt and removes it when the attempt ends. The shared `harness-hook.sh` (Codex) and the Claude Stop hook command do, on `Stop` only: if `$HARNESS_MCP_CONFIG` is unset, the marker is absent, or `curl` is missing, exit 0 with no output (every non-step terminal pays one `test -f`); otherwise read port and token from the JSON with the same POSIX `sed` the bridge-free hook already uses, `curl --max-time 2` the stop-check, and print its JSON reply (`{"decision":"block","reason":…}` or nothing) to stdout. The Codex command string `bash '<home>/harness-hook.sh' <Event>` is unchanged, so `/hooks` trust survives; only the script body changes. The opencode plugin reads the same file through `process.env.HARNESS_MCP_CONFIG`. Measured by the `completedBy` mix (see "Rollout and observability"): if continuation rarely fires, it can be removed without touching the hook entries.
   - Second time: if the step declares no required output fields, the `last_assistant_message` becomes `summary` (`completedBy: 'fallback'`). Otherwise the run pauses with `pausedReason: needs-input`.
3. **`needs-approval` status** (permission prompt) → run pauses, with "Jump to tab". With the permission mapping below this should only happen for unexpected prompts.
4. **Process exit without `complete_step`** → `failed` (`completedBy: 'exit'`), with Retry / Retry from clean / Skip / Swap harness or model.
5. **User action**: "Mark done" with a typed summary/fields (`completedBy: 'user'`).

### Snapshots

`baseSha`/`headSha` aren't enough: agents often don't commit, and then the head equals the base on a dirty tree. At each step boundary the runner records the **full working tree**, including untracked files, without touching the user's index, branch or stash:

```
GIT_INDEX_FILE=<tmp> git add -A && git write-tree → git commit-tree <tree> -p <prev>
git update-ref refs/harness/runs/<runId>/<stepId>/<attempt> <sha>
```

This gives per-step diffs in run detail, "Retry from clean" (restore the worktree to the step's `baseSnapshot` tree, behind a confirmation) and no gc loss. Refs are removed when the run record is deleted.

### Handoff to the next step

- **Code**: shared worktree; `baseSnapshot..headSnapshot` records what the step changed
- **Prompt**: templates reference `{{steps.<id>.summary}}` / `{{steps.<id>.data.*}}`. A rendered prompt over ~8 KB is written to `.harness/runs/<runId>/<stepId>.prompt.md`, and the CLI receives a short "Read <path> and follow it" prompt instead (this avoids argv limits and `ps` exposure).
- **History**: the runner appends each step result to `.harness/runs/<runId>/context.md`, exposed as `{{run.contextPath}}`

The same contract holds for a future headless driver, since the MCP tool works the same way there.

## Run and step states

| | States |
|---|---|
| Run | `queued` · `running` · `paused` · `done` · `failed` · `cancelled` |
| Run `pausedReason` | `gate` · `step-failed` · `needs-approval` · `needs-input` · `budget` · `loop-cap` · `timeout` · `interrupted` · `trust` · `restack-conflict` |
| Step | `pending` · `queued` · `running` · `awaiting-gate` · `done` · `failed` · `skipped` · `cancelled` · `interrupted` |

"Needs you" is every `paused` run. A chain has a record (so `chainStarted` / `chainFinished` are real events) but its **status is derived** from its child runs, never stored: it's `done` when every child is `done` or `skipped`, and shows the first paused child otherwise. `chainFinished` fires when the scheduler has nothing left to start and carries the derived status for the recent index.

## Permissions & trust

- Per-step `permissions: read-only | edit | full` (default `edit`). Every level is built so that a tool outside the step's allowance is **denied without a prompt**; the agent then reports `needs-input` through `complete_step` instead of stalling the tab:

  | Level | Claude | Codex | opencode (`harness-step` agent, `tools.task: false`) |
  |---|---|---|---|
  | `read-only` | `dontAsk` + Read, Grep, Glob, `Edit(.harness/runs/**)` | `--sandbox read-only` | edit and bash denied, except the run folder |
  | `edit` | `dontAsk` + read tools + Edit, Write + `Bash(<allow>)` for each `allow:` pattern | `--sandbox workspace-write --ask-for-approval never` | edit allowed, bash allowed for `allow:` patterns only |
  | `full` | `bypassPermissions` | `--sandbox danger-full-access` | everything allowed |

  - Claude's allowlist always includes `mcp__harness-control__complete_step`, or `dontAsk` would deny the completion call itself. Pass the list comma-separated: `--allowedTools` is variadic and swallows a following positional prompt.
  - The opencode agent is defined per terminal through `OPENCODE_CONFIG_CONTENT`, launched with `--agent harness-step`, and carries the step's `model`. Disabling `task` is what stops subagents from bypassing the step's permissions.
  - Codex's sandbox handles `allow:` on its own; the list is ignored there.
- `full` needs an explicit per-run confirmation in the launch sheet and is never implied by autopilot.
- **Autopilot** only auto-approves gates. It doesn't change permission modes.
- **Codex hook trust**: the launch sheet's readiness checks include "Codex hooks trusted" for any definition with a Codex step. It is computed read-only from `~/.codex/config.toml` (see "Codex hook trust" under Harness research). When the hooks aren't trusted, the check shows "Open a Codex tab and run /hooks" instead of launching, since an untrusted Stop hook means the step can never complete through the Stop path.
- **Claude folder trust**: before spawning a Claude step, the runner checks whether the worktree path or one of its parents is trusted. If not, the run pauses with `pausedReason: trust` and a "Trust folder" action that jumps to the tab. Tatsu never edits `~/.claude.json` itself. Codex gets the same check against its `trust_level`.
- **Repo-scoped definitions are untrusted code.** On first run, and whenever the file's hash changes, show the definition and its permission levels and ask for trust. Store trust per `(repoRoot, path, hash)` in config. This mirrors the hooks-consent rule: never act on repo-supplied files without permission.
- **Untrusted inputs**: GitHub issue/PR bodies interpolated into prompts are prompt-injection vectors. If a run has an `issue`/`pr` input from a non-collaborator, cap `permissions` at `edit` and disable autopilot by default.

## Concurrency, budgets, recovery

- **Concurrency**: a global `workflows.maxConcurrentAgents` setting (default 4), shipped with the linear runner in **phase 2** because several runs can already overlap there. Excess steps sit in `queued`. Shell steps don't count toward the cap. A stacked chain runs one item at a time; an independent chain's items count against the global cap like any other runs.
- **Budgets (best-effort, phase 4)**: an optional per-run/per-chain USD cap. `CostTracker` short-circuits while no client has the cost panel open, so the runner registers its own interest for the terminals it owns (`costTracker.holdInterest(terminalId)` / `release`, a main-side equivalent of `costs:setInterest` that is independent of any panel) and reads the per-session usage the tracker dispatches. Exceeding the cap pauses the run (`pausedReason: budget`). opencode steps report no cost, and the UI shows "—", not $0; a chain whose steps are all opencode can never trip its budget, which the launch sheet says next to the field.
- **Restart recovery**: runs are persisted. On boot the runner reconciles each `running` attempt. If the PTY is gone, the step goes to `interrupted` and the run pauses, with **Resume** (relaunch with the stored `sessionId`; Codex/opencode IDs come from the hook discovery path) or Retry. Gates and queued steps simply resume.
- **Timeouts**: optional per-step `timeout` (wall clock). On expiry the run pauses (`pausedReason: timeout`), never auto-kill.

## Rollout and observability

- **Labs flag**: `settings.labs.workflows` (default off) gates the Workflows section, its entry points, the `complete_step` tool listing and the Stop-hook stop-check (the hook short-circuits when no `.step` marker exists, so an off flag costs nothing). Shipped in phase 2 with the thin slice.
- **Log channel**: `log('workflow', …)` lines in `debug.log` for every run/step/attempt transition, every `complete_step`, every continuation, and every pause, each carrying `runId`, `stepId`, `attemptId`. Never the prompt text or the summary.
- **Metrics in the run record** (`userData/workflow-runs/<id>.json`): per attempt `completedBy`, `continuations`, `pauses` with reasons, wall time, cost; per run time-to-first-`done`. Command Center can roll these up later; v1 only records them.
- **Revisit criteria**: if across the first 50 runs more than 25% of agent attempts end by `fallback`, `user` or `exit`, revisit the output contract before phase 4. If continuations fire in fewer than 5% of attempts, drop the Stop-hook channel.

## Design decisions

| Decision | Choice |
|---|---|
| Step completion | `complete_step` → harness-native Stop continuation (fail-open) → final-message fallback → exit = failed; user can Mark done |
| Step identity | runner-generated `attemptId`; drivers return an `executionId` (terminal id for PTY/shell); the control server maps the caller's terminal id to the attempt; no step env var |
| Stop-hook channel | `HARNESS_MCP_CONFIG` path in the PTY env + `<id>.step` marker; hook script reads port/token from the 0600 file, fails open; Codex command string unchanged |
| Rollout | `settings.labs.workflows` flag, `workflow` log channel, `completedBy` / pauses metrics in run records, revisit thresholds |
| Handoff | shared worktree + snapshots + `summary`/`data` templates + `context.md` |
| Graph | `needs:` DAG, structured conditions, `on_loop` continues the same session; gate rework uses the same mechanism |
| Step kinds | `agent`, `shell` in v1; `foreach` then `orchestrator` later |
| Harness support | Claude Code, Codex, opencode only; generic harnesses later (likely ACP via a second `StepDriver`) |
| Visible vs headless | visible terminal tabs labelled `⚙ <step> · <agent>`, spawned main-side; autopilot only skips gates |
| Worktrees | one per run; chain children each get their own; parallel steps within a run must not write (enforced) |
| Chain | one concept for batch and `foreach`; `independent` by default (items off base, parallel up to the cap), `stacked` by explicit toggle (one linear stack, one at a time); every item gets its own PR; restack/retarget only on demand |
| Concurrency | global `maxConcurrentAgents` default 4, shipped in phase 2; one item at a time inside a stacked chain |
| Loops and gates | continue the same session by default; `fresh: true` / "fresh session" starts a new one with the previous summary |
| Step tabs | created via `PanesFSM.addTab(..., { fromMain: true })` with `tab.workflow`; closing cancels after confirmation; typing steers; no respawn on remount |
| Permissions | every level denies without prompting (`dontAsk` + allowlist / sandbox / dedicated opencode agent); `full` needs explicit confirmation; repo definitions need hash-based trust; Claude folder trust checked before spawn |
| Failure | run pauses; Retry / Retry from clean / Skip / Swap harness or model |
| Editor | YAML-first in Monaco + live graph; form editor later |

## Architecture

- **`src/shared/workflow-def/`**: schema types, YAML parser/validator (cycles, refs, templates, unsupported-feature errors), template interpolation, condition evaluation. Pure, tested.
- **`src/shared/state/workflows/`**: new slice, kept **small** (review 2 item 6): the wire snapshot carries status, not content.
  - `definitions` (personal + per-repo, keyed by scope: `{ id, name, scope, path, hash, stepIds }`, no YAML body), `trust`
  - `runs: Record<runId, { defId, defHash, chainId?, itemId?, worktreePath, status, pausedReason?, startedAt, finishedAt?, costUsd?, steps: Record<stepId, { status, attemptIds: string[] }> }>` (active + capped recent)
  - `attempts: Record<attemptId, { runId, stepId, n, status, completedBy?, summaryPreview (≤ 200 chars), costUsd?, startedAt, endedAt? }>`. **No** `defSnapshot`, full `summary`, `data`, rendered prompts or snapshot shas in the slice.
  - `chains: Record<chainId, { defId, mode: 'independent' | 'stacked', items: Item[], draftPrs, childRunIds }>`
  - events: `definitionsLoaded`, `definitionSaved`, `definitionDeleted`, `trustGranted`, `runStarted`, `runPaused`, `runResumed`, `runCancelled`, `runFinished`, `stepQueued`, `stepStarted`, `attemptStarted`, `attemptEnded`, `stepStatusChanged`, `stepSkipped`, `gateResolved`, `prRecorded`, `chainStarted`, `chainItemsChanged`, `chainFinished`
  - `findIndex` + `slice` patches; add to `mergeWireSnapshot`; renderer gets `useWorkflowRun(id)` / `useWorkflowAttempt(id)` per-id selectors (anti-pattern #4)
  - Full content lives on disk in `userData/workflow-runs/<runId>.json` (definition snapshot, every attempt's `StepResult`, snapshot refs, metrics) and is fetched by request: `workflows:getRun(runId)` and `workflows:getAttemptResult(attemptId)`. Run detail reads those; cards read the slice.
- **`src/main/workflow-runner/`**: FSM + scheduler (queue, concurrency cap, chain order; budgets in phase 4). Owns the `executionId → attemptId` map and the `.step` markers. Reacts only to `terminals/*` events for mapped ids (anti-pattern #1) and dedups derived status (anti-pattern #2). Takes snapshots, renders prompts, persists run records, reconciles on boot, holds `CostTracker` interest for its terminals.
- **`src/main/workflow-runner/drivers/`**: `StepDriver` interface; `pty-agent` and `shell` drivers.
- **Main-side spawn**: `src/main/agent-spawn/` (`createAgentSpawner`): `spawnAgentTerminal` / `spawnShellTerminal` for main callers (the runner, later `create_worktree`), `createOrAttach` / `attach` behind `pty:createOrAttach` / `terminal:attach` for clients. A running PTY always wins: the client joins and replays its history. Main spawns at a sibling tab's size or 120×30 and the tab resizes when it mounts. Permission levels plug into `AgentSpawnRequest.permissionLevel`.
- **Control server + MCP bridge**: `GET /workflow/step`, `POST /workflow/complete`, `POST /workflow/stop-check` (used by the Stop hook script and the opencode plugin through `HARNESS_MCP_CONFIG`); later `run_step` / `await_step` / `run_workflow`. All gated on the Labs flag.
- **Agents**: Codex and opencode get per-terminal MCP; permission levels in `AgentSpawnOpts` mapped per the table above; the opencode plugin rewritten to the documented ESM format (status events, final message, `promptAsync` continuation); `hooks.ts` parses `last_assistant_message`. Pi keeps its existing branches in every moved spawn path (no MCP, no permission level) and is not a step harness.
- **Renderer**: `Workflows` view (Runs / Library), run + chain detail, launch sheet, YAML editor. Smart/dumb split per `plans/smart-dumb.md`.

## Testing

- `workflow-def`: parser/validator/template/condition table tests.
- Slice: one reducer test per event, plus wire-merge.
- Runner: FSM tests against a fake `StepDriver` (scripted turn-ends, completes, exits, restarts, gate rework, loop re-entry, chain scheduling).
- **Scripted harness for e2e**: a tiny `scripts/fake-agent.mjs` that reads its prompt, writes its own Stop line, and calls `complete_step` through the real bridge. The smoke test points `settings.claudeCommand` at it, so no test-only agent kind is needed. Add it to `scripts/smoke-headless.sh` so CI exercises spawn → MCP → complete → next step without any LLM.

## Phases

0. **Prerequisites**, each shipping independently and improving today's tabs too:
   1. Rewrite the opencode plugin to the documented ESM format (fixes opencode status detection today).
   2. Main-side agent spawn with create-or-attach.
   3. Parse `last_assistant_message` in `hooks.ts` (and emit it from the opencode plugin).
   4. MCP parity: opencode via `OPENCODE_CONFIG_CONTENT`; Codex via `-c mcp_servers.harness-control.*`; see Item 9 if the gate fails.
   5. Permission levels per the mapping table, including the `harness-step` opencode agent.
   6. Claude/Codex folder-trust check helper.
   7. Bridge `agentKind` fix (enum and the check at `mcp-bridge.js:468-473`).
   8. Codex hook trust:
      - `installHooks` keeps each Tatsu entry at its existing index when an identical entry (same command and timeout) is already present. It only replaces legacy or mismatched entries, and skips writing `hooks.json` when nothing changed.
      - A read-only trust-status helper computes each entry's key and hash and compares them against `~/.codex/config.toml`. It drives Settings ("Codex hooks need review: run /hooks") and the launch-sheet readiness check, with a unit test pinned to a known hash.
   **Order for the first usable slice** (both reviews): the Claude + shell runner in phase 2 needs only 03 (final message), 04 (main-side spawn), 06 (the Claude mapping) and 07 (folder trust). 01, 05, 08 and 09 can land in parallel or after, and phase 3 waits for them.
1. **Definitions**: `workflow-def` package (full schema, unsupported-feature errors), loader for the **personal** scope only, `workflows` slice (slim shape above). Repo scope and repo trust move to phase 3.
2. **Runner (linear) + thin UI, behind the Labs flag** (the first thing a user can run): FSM, `agent` driver for **Claude** and the `shell` driver, `complete_step`, the Stop-hook channel and fail-open continuation, snapshots, Retry / Retry from clean (with its confirmation) / Skip, restart recovery, the global concurrency cap, `workflow` log channel and run-record metrics, fake-agent e2e in `smoke-headless.sh`. UI: "Run workflow here…" on the worktree context menu with a minimal launch sheet (definition picker, typed inputs, hooks-consent requirement), a step strip on the worktree card, a Needs-you list in the sidebar, step tabs per "Step tabs". Mark done from the tab's exited overlay.
3. **Harness breadth + Workflows section + YAML editor**: Codex and opencode step drivers (after 01, 05, 06, 08), repo-scoped definitions with hash-based trust, Runs view, run detail (attempt timeline, per-step diff from snapshots, actions), Library, Monaco editor with validation and graph preview, full launch sheet + remaining entry points, per-step agent/model swap.
4. **Control flow**: `needs:` DAG, gates (Approve / Request changes, fresh-session option), loops with `on_loop` and `fresh`, `when:`, non-writing parallel steps, best-effort budgets with runner-held `CostTracker` interest, timeouts.
5. **Chains** (follow-up plan, written once phase 3 has users; everything below is the current intent):
   - 5a. Item sources, ordered item list, `independent` mode (default) and `stacked` mode (toggle), chain board, automatic PRs.
   - 5b. Restack (with conflict handling) and retarget on merge, only if stacked chains see use.
6. **`foreach` over step output + join**, children as a chain in the declared mode.
7. **Form editor**.
8. **Orchestrator step type**: `run_step` / `await_step` (async start + await to avoid MCP timeouts).

## Open items

- Verify Codex `-c mcp_servers.*` per-run override (Codex isn't installed on the dev machine yet)
- Confirm whether Codex hooks fire under `codex exec` (matters only for headless mode)
- Verify the computed Codex hook hash against a real binary (≥ 0.129.0), e.g. via `codex app-server` `hooks/list`; the algorithm is read from source only
- Decide whether to offer an opt-in "Trust automatically" button that writes `trusted_hash`, and test the `-c hooks.state={…}` per-launch override
- Confirm that `--` terminates Claude's option list so a positional prompt can follow `--mcp-config <path>` safely (ticket 04 REQ-018; fallback is to generate a session id so `--session-id` always sits between them)
- Confirm `curl` availability on the Linux headless targets for the Stop-hook channel (macOS ships it); the hook fails open without it
- Decide, once phase 3 has users, whether chains need a separate plan file before phase 5 starts
- Resolved 2026-10-24: `foreach` children run in the mode the step declares (`independent` by default), the same as launch-sheet chains; the opencode permission event is `permission.asked`

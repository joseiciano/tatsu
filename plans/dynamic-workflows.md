# Dynamic workflows plan

## Summary

### Goal

Users define, inside Tatsu, a workflow made of steps. Each step can run on a different harness (e.g. Claude Code plans, Codex implements, opencode reviews, a shell step runs the tests). They then run that workflow against a **body of work**: one task, a worktree, or a set of items (issues, PRs, a task list, or tasks produced by an earlier step). Each item gets its own isolated run. Every step returns a uniform, machine-readable result, whichever harness produced it.

### Why

- Each harness/model has strengths; workflows let users pick the best one per step
- Tatsu already owns the primitives (agent tabs, status hooks, MCP control server, worktree creation). Workflows are an orchestration layer on top of them.
- A uniform step output contract makes handoff between harnesses deterministic
- Fanning one definition out over many items is the swarm part: N worktrees, N agents and one board, instead of N hand-started sessions

### What "dynamic" means here

Dynamism comes in rungs. Each one builds on the previous, and each ships on its own:

| Rung | What changes at runtime | Phase |
|---|---|---|
| 1. User-defined | Graph is data (YAML) authored in Tatsu, not code | 2 |
| 2. Conditional | Gates, loops, `when:` conditions driven by step `data` / shell exit codes | 4 |
| 3. Fan-out over input | One definition × N items → N child runs (batch) | 5 |
| 4. Fan-out over output | A step emits a list (`data.tasks`), and a `foreach` step spawns a child run per entry | 6 |
| 5. Agent-orchestrated | An orchestrator step calls `run_step` / `await_step` and decides the graph itself | 8 |

Rung 4 delivers most of the "swarm" value (a planner splits the work, a fleet executes it) while the graph stays inspectable and deterministic. Rung 5 is deliberately last.

## Scope

Included:
- Harnesses Tatsu currently supports: Claude Code, Codex, opencode
- Step kinds: `agent` (PTY tab) and `shell` (deterministic command, exit code = result)
- Workflows section UI (runs + batches + definitions library + editor + launch sheet)
- `workflows` slice, workflow runner FSM, `complete_step` MCP tool
- Prerequisites: main-side agent spawn, MCP parity for Codex and opencode, per-step permission modes

Explicitly out of scope (for now):
- Generic / arbitrary harness support (revisit later, likely via ACP)
- Headless step execution (later, a second `StepDriver`)
- Event triggers (PR opened, issue labeled)
- Merging parallel writers back into one branch (fan-out items each produce their own branch/PR, stacked when dependent; see "Isolation")
- Items with more than one stacking parent (diamond dependencies); ordering-only edges cover them in v1

## Existing primitives

| Need | Already in Tatsu |
|---|---|
| Spawn harness X with a prompt | `AgentModule.buildSpawnArgs({initialPrompt, model, mcpConfigPath, systemPrompt})` in `src/main/agents/` |
| Know when an agent's turn ends | Hook NDJSON → `Stop` (Claude, Codex) / `session.idle` (opencode) → terminal status |
| Final assistant message | Hook command already appends the **entire** stdin payload, so Claude/Codex `last_assistant_message` is already in the NDJSON. Only `src/main/hooks/hooks.ts` parsing is missing. |
| Agents calling back into Tatsu | `harness-control` MCP bridge (`resources/mcp-bridge.js`) + control server; scope is resolved from `X-Harness-Terminal-Id` on every call |
| Fan out to new worktrees | `create_worktree` MCP tool, `runPendingPRWorktree` (accepts `agentKind`, `model`) |
| Deterministic commands | Shell tabs + `createShell` / `readShellOutput` (`ShellQueries`) |
| Visible, steerable sessions | Agent tabs via `PanesFSM`; spectators attach via `terminal:join` |
| Cost | `CostTracker` (Claude + Codex jsonl only) |

### Gaps found (verified against code, 2026-10-01)

1. **Agent spawn is renderer-driven (blocker).** `XTerminal.tsx:456-501` calls `agent:buildSpawnArgs` and then `pty:create`, and **defers the spawn until the tab has layout** (≥20px). A step tab created in a background worktree doesn't start until someone opens it, and on headless with no client attached it never starts. The runner needs a main-side spawn path: main creates the PTY at 120×30, and the xterm attaches later via the existing `terminal:join` + `getHistory` route and resizes.
2. **MCP only reaches Claude.** Claude gets `--mcp-config <per-terminal file>`. Codex's `buildSpawnArgs` comment claims a global `~/.codex/config.toml` registration, but nothing in `src/main` writes it. opencode has no MCP wiring at all.
3. **opencode plugin probably doesn't load.** `makePluginContent()` in `src/main/agents/opencode.ts` emits a CommonJS `module.exports = { onEvent }` that reads `ev.payload.session.id`. The documented format is an ESM export, `export const P = async ({ client, ... }) => ({ event: async ({ event }) => … })`, with events shaped like `{ type, properties }`. Verify by hand. If it's broken, opencode status detection is already broken today, independently of workflows.
4. **Codex hooks flag name drift.** `ensureCodexHooksEnabled` writes `codex_hooks = true`, but the current docs name the flag `[features] hooks` (default on). This is harmless while the default holds; align it during MCP parity work.
5. **No unattended permission story.** `auto-approver` only serves chat-tab approval cards. A PTY step will stall on its first permission prompt (`needs-approval`). Workflows need per-step permission modes (see "Permissions & trust").
6. **Bridge enum mismatch.** `create_worktree.agentKind` advertises `['claude', 'codex']` (`mcp-bridge.js:110`) while the server accepts `opencode`.
7. **Hook line atomicity.** The hook comment relies on writes < `PIPE_BUF` (4096 B) being atomic. Payloads that carry `last_assistant_message` will regularly exceed that. Only one agent writes per terminal file, so it's fine in practice, but the comment and the residual-line handling should acknowledge it.

## Concepts

| Term | Meaning |
|---|---|
| **Definition** | YAML graph of steps + typed inputs. Personal or repo-scoped. |
| **Run** | Definition snapshot + target worktree + inputs. Owns one worktree. |
| **Batch** | One definition launched over N items, giving N child runs plus a concurrency cap and an aggregate board |
| **Step** | Node in the graph: `agent`, `shell`, `foreach` (phase 6), `orchestrator` (phase 8) |
| **Attempt** | One execution of a step. Retries and loop iterations create attempts. |
| **StepDriver** | Runner-side adapter per step kind: `start`, `continue(prompt)`, `cancel`, emits `turnEnded` / `exited` / `completed`. The PTY agent driver and the shell driver are v1; a headless driver comes later. |

## Definition format

```yaml
name: plan-build-review
inputs:
  task: { type: text }
defaults:
  permissions: edit
steps:
  - id: plan
    agent: claude
    model: claude-opus-5-5
    permissions: read-only
    prompt: "Plan this task and write PLAN.md. Task: {{inputs.task}}"
    gate: approve
  - id: build
    agent: codex
    prompt: "Implement PLAN.md. Plan summary: {{steps.plan.summary}}"
    on_loop: "Review feedback to address:\n{{steps.review.summary}}"
  - id: test
    kind: shell
    run: pnpm typecheck && npx vitest run
  - id: review
    agent: opencode
    needs: [build, test]
    permissions: read-only
    prompt: "Review the diff against PLAN.md. Test result: {{steps.test.summary}}"
    output:
      verdict: { enum: [pass, fail] }
    loop: { back_to: build, until: { field: verdict, equals: pass }, max: 3 }
```

Rules:
- **`needs:`** (GitHub Actions style). If omitted, it means "the previous step". Steps whose needs are all satisfied start together. This replaces the "run alongside previous step" toggle, which can't express diamonds.
- **`kind: shell`** steps run in a shell tab. `status = exit code == 0 ? done : failed`, `summary` = the last N lines of output. Deterministic checks belong here, not in an LLM verdict.
- **`until` / `when` are structured** (`{field, equals | in | not}`), plus `{exit: 0}` for shell steps. There's no expression string and nothing to `eval`.
- **`on_loop`** is the prompt sent when a loop re-enters a step. The step **continues its existing session** (it keeps its context and costs less) instead of spawning a fresh one.
- **`output:`** is a JSON Schema subset (`string`, `number`, `boolean`, `enum`, `array` of those, plus `required`). It becomes `complete_step`'s input schema.
- **Template scope**: `inputs.*`, `steps.<id>.summary|data.*|status`, `run.id`, `run.worktree`, `run.contextPath`, `item.*` (batch/foreach). Unknown references fail validation at save time. Templates are not evaluated at run time.
- A run stores a **resolved snapshot** of the definition (plus a content hash). Editing or switching branches mid-run never changes a running graph.

## Isolation and the body of work

- **One run = one worktree.** All steps of a run share it. Two runs never share a worktree concurrently; launching onto a busy worktree is refused.
- **Parallel steps inside a run must be `permissions: read-only`**, enforced through each harness's read-only mode, not by convention. Parallel writers aren't allowed in v1.
- **Batch fan-out**: each item gets its own new worktree and branch, and the runner **opens a PR automatically** when the item's run finishes `done`. Nothing merges back into a shared branch.
- **Dependent items stack.** If item 5 depends on item 4, item 5's worktree branches from item 4's branch, and its PR targets item 4's branch, not the repo base. Independent items branch from the repo base as usual. See "Stacked items".
- **`foreach` over step output** (phase 6): children follow the same rules. Each entry may declare `depends_on`, and child runs without a dependency branch from the parent run's current snapshot. A `join` step afterward sees `{{steps.<foreach>.children[*].summary}}`.

Batch item sources in the launch sheet:
- GitHub issues (label / search query) or PRs (picker / query)
- Free-text list (one item per line; `4 -> 5` lines or a `depends:` column declare dependencies)
- File glob in the repo
- Later: event triggers

### Stacked items

Items form a dependency graph. Each item has at most **one parent** in v1, so the graph is a chain or a tree, which maps directly onto stacked branches and PRs.

- **Dependency sources**:
  - GitHub issues: "blocked by" / sub-issue relations
  - Free-text: explicit markers
  - `foreach`: the `depends_on` field in the step output
  - The launch sheet shows the resolved graph and lets the user edit edges before starting.
- **Validation at launch**: cycles are rejected. An item with several dependencies must pick one parent in the launch sheet; the others become ordering-only edges (wait for them, but don't stack on them).
- **Scheduling**: a child stays `blocked` until its parent's run is `done` and its PR is open. It then branches from the parent's head (the branch tip after the runner's final commit). Siblings under one parent run concurrently, within the concurrency cap.
- **Failure**: if a parent fails or is cancelled, its descendants stay `blocked` and show the reason in Needs you. Retrying the parent unblocks them; Skip on a parent offers "rebase children onto base" or "cancel children".
- **PR creation** (runner feature, via `src/main/github/`):
  1. Commit any leftover changes with the run summary as the message.
  2. Push the branch.
  3. Open the PR with its base set to the parent's branch (or the repo base). The title comes from the item, and the body holds the run summary, step results, and a "Stacked on #N" line.
  4. Record the PR on the run so `PRPoller` tracks it.

  A launch-sheet toggle (default off) opens them as drafts.
- **Parent changes after review**: when a parent branch gets new commits (review fixes), its children become stale. Run detail shows "Restack": rebase each child onto the new parent tip and force-push the child branch. Every restack needs an explicit click, because it force-pushes.
- **Parent merged**: GitHub retargets dependent PRs to the base branch when the parent's head branch is deleted on merge. If the repo doesn't auto-delete branches, the runner retargets the child PR to the repo base itself once `PRPoller` reports the parent as merged.

## UX

### Workflows section

A full-screen view alongside Activity / Cleanup / Command Center (`showWorkflows` in `App.tsx`), reachable from the sidebar, a hotkey and the command palette. Two tabs:

**Runs** (default)
- **Needs you** (pinned at the top): runs paused on a gate, a failed step, `needs-approval`, `needs-input`, a budget cap or a loop cap. Fire an OS notification on entry.
- **Active**: one card per run or batch. Run card: workflow name, repo/worktree, step strip (`plan ✓ → build ● → review ○`), current agent + status, elapsed time, cost. Batch card: progress (`7/20 done · 3 running · 1 needs you · 9 queued`) and expands to child runs.
- **Recent**: finished / cancelled
- Run detail: read-only graph, timeline of attempts, each step's result + diff (from snapshots), "Jump to tab", and actions: Approve / Request changes (gates), Retry, Retry from clean, Skip, Swap harness/model, Mark done (manual summary), Cancel

**Library** (definitions)
- Grouped by scope: **Personal** / **This repo**
- Actions: Run, Edit, Duplicate, Delete, New workflow

Worktrees with a running workflow get a small badge in the sidebar.

### Running a workflow

A run = **definition + target + inputs**. Every entry point opens the same launch sheet:

1. **Target**: repo, then **new worktree** (default), **existing worktree**, or **batch over items** (source picker + concurrency cap)
2. **Inputs**: generated from the definition's typed inputs: `text` (textarea), `issue` / `pr` (GitHub picker), `file` (file picker). In a batch, the item fills one input.
3. **Overrides** (collapsed): per-step agent/model swap, **autopilot** (auto-approves gates), and a budget cap

Entry points:
- Library → Run
- New Worktree screen → "Workflow" dropdown
- Worktree context menu → "Run workflow here…" (prefilled target)
- Command palette
- Later: `run_workflow` MCP tool; event triggers

### Definition editor

v1 is **YAML-first in Monaco** (already bundled via `monaco-setup`), with:
- schema-driven validation diagnostics (unknown step refs, template refs, cycles, invalid `needs`)
- template autocomplete for `{{inputs.*}}` / `{{steps.<id>.*}}`
- a live read-only graph preview next to it

The form editor (step cards) comes later (phase 7). Two-way form↔YAML sync is a large amount of UI work for a power-user feature, and YAML is the storage format anyway. A cheap later win: "Describe a workflow" → a chat tab drafts the YAML.

### Storage

- **Personal**: `userData/workflows/*.yaml`, the default when creating from the UI
- **Repo**: `.harness/workflows/*.yaml`, committed and shared with the team ("Save to repo" in the editor). This matches the existing `.harness.json` / `HARNESS_*` naming. Don't introduce a `.tatsu/` prefix.
- **Run artifacts**: `<worktree>/.harness/runs/<runId>/` (rendered prompts, `context.md`), excluded via `$(git rev-parse --git-common-dir)/info/exclude`. In a worktree, `.git` is a file; never edit the user's `.gitignore`.
- **Run records**: `userData/workflow-runs/<runId>.json`. The slice holds definitions + active runs + a capped recent index; full history for older runs loads on demand.
- YAML over JSON because prompts are multi-line and they're the main content
- Selected tab, editor drafts, etc. stay renderer `useState`.

## Harness research (2026-10-01)

| | Claude Code | Codex | opencode |
|---|---|---|---|
| Turn-end hook (already installed by Tatsu) | `Stop` | `Stop` | `session.idle` plugin (format suspect, see gap 3) |
| Hook carries final message | yes (`last_assistant_message`) | yes (`last_assistant_message`, nullable) | no, plugin can fetch it via `client` |
| **Hook can force continuation** | yes: `{"decision":"block","reason":…}` | yes: same shape; `reason` becomes the next user prompt; `stop_hook_active` flag | plugin can prompt the session via SDK client (unverified) |
| Read-only / edit / full permission | `--permission-mode plan` / `acceptEdits` / `bypassPermissions` | `--sandbox read-only` / `workspace-write` + `--ask-for-approval never` / `danger-full-access` | `--agent plan` / permission config via `OPENCODE_CONFIG_CONTENT` (unverified) |
| Headless | `claude -p --output-format stream-json` | `codex exec --json` | `opencode run --format json` |
| Typed headless "done" event | yes (`result`) | yes (`turn.completed` / `turn.failed`) | **no**: process exit without `error` |
| Schema-validated output | `--json-schema` → `structured_output` | `--output-schema` (JSON as final message text) | **CLI: no** (server/SDK only) |
| Per-run MCP injection | `--mcp-config` | `-c mcp_servers.*` (unverified) or `CODEX_HOME` | `OPENCODE_CONFIG_CONTENT` env var |
| Resume | `--resume <id>` | `codex resume <id>` / `codex exec resume <id>` | `--session <id>` |
| ACP | adapter `@agentclientprotocol/claude-agent-acp` | adapter `@agentclientprotocol/codex-acp` | native `opencode acp` |

Unverified: Codex `-c mcp_servers.*` per-run override; whether Codex hooks fire under `codex exec`; opencode permission config, SDK prompt call and JSON event shapes (read from source, not docs).

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

There is no `HARNESS_STEP_ID` env var. The runner maps `terminalId → (runId, stepId, attempt)`, and the control server already resolves the caller from `X-Harness-Terminal-Id`. At `tools/list` time the bridge calls `GET /workflow/step`. If the terminal belongs to a step, it advertises `complete_step` with that step's schema; otherwise the tool isn't listed. A loop iteration continues the same terminal, so the mapping stays valid. Retry-from-clean gets a new terminal.

### How it gets filled

1. **`complete_step({status, summary, ...fields})`** is authoritative. `status` defaults to `done`; `needs-input` lets the agent explicitly say it's blocked and why. The server re-validates against the step schema, and an invalid call returns a tool error so the agent retries.
2. **Turn ended without `complete_step`** (`Stop` / `session.idle`):
   - First time: **harness-native continuation**, not keystrokes. For Claude and Codex, a workflow-only Stop hook asks the control server and returns `{"decision":"block","reason":"Call complete_step with your result, or with status needs-input and what you need."}`. Gate this with `stop_hook_active` plus the runner's own counter so it fires once per turn. For opencode, the plugin prompts the session via its SDK client. Typing into the PTY is the last-resort fallback only.
   - Second time: if the step declares no required output fields, the `last_assistant_message` becomes `summary` (`completedBy: 'fallback'`). Otherwise the step moves to **Needs you**.
3. **`needs-approval` status** (permission prompt) → **Needs you**, with "Jump to tab".
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

## Permissions & trust

- Per-step `permissions: read-only | edit | full` (default `edit`), mapped to harness flags (see the research table). `full` needs an explicit per-run confirmation in the launch sheet and is never implied by autopilot.
- **Autopilot** only auto-approves gates. It doesn't change permission modes.
- **Repo-scoped definitions are untrusted code.** On first run, and whenever the file's hash changes, show the definition and its permission levels and ask for trust. Store trust per `(repoRoot, path, hash)` in config. This mirrors the hooks-consent rule: never act on repo-supplied files without permission.
- **Untrusted inputs**: GitHub issue/PR bodies interpolated into prompts are prompt-injection vectors. If a run has an `issue`/`pr` input from a non-collaborator, cap `permissions` at `edit` and disable autopilot by default.

## Concurrency, budgets, recovery

- **Concurrency**: a global `workflows.maxConcurrentAgents` setting (default 4), plus a per-batch cap. Excess steps sit in `queued`. Shell steps don't count toward the cap.
- **Budgets**: an optional per-run/per-batch USD cap, checked on each `CostTracker` update. Exceeding it pauses the run into Needs you. opencode steps report no cost, and the UI shows "—", not $0.
- **Restart recovery**: runs are persisted. On boot the runner reconciles each `running` attempt. If the PTY is gone, the step goes to `interrupted`, with **Resume** (relaunch with the stored `sessionId`; Codex/opencode IDs come from the hook discovery path) or Retry. Gates and queued steps simply resume.
- **Timeouts**: optional per-step `timeout` (wall clock). On expiry → Needs you, never auto-kill.

## Design decisions

| Decision | Choice |
|---|---|
| Step completion | `complete_step` → harness-native Stop continuation → final-message fallback → exit = failed; user can Mark done |
| Step identity | resolved from terminal id server-side; no step env var |
| Handoff | shared worktree + snapshots + `summary`/`data` templates + `context.md` |
| Graph | `needs:` DAG, structured conditions, `on_loop` continues the same session |
| Step kinds | `agent`, `shell` in v1; `foreach` then `orchestrator` later |
| Harness support | Claude Code, Codex, opencode only; generic harnesses later (likely ACP via a second `StepDriver`) |
| Visible vs headless | visible terminal tabs labelled `⚙ <step> · <agent>`, spawned main-side; autopilot only skips gates |
| Worktrees | one per run; batch/foreach children each get their own; parallel steps within a run must be read-only (enforced) |
| Batch output | runner opens a PR per item automatically; dependent items stack (branch + PR base = parent's branch); one stacking parent per item |
| Concurrency | `maxConcurrentAgents` default 4 |
| Permissions | per-step mode mapped to harness flags; `full` needs explicit confirmation; repo definitions need hash-based trust |
| Failure | run pauses; Retry / Retry from clean / Skip / Swap harness or model |
| Editor | YAML-first in Monaco + live graph; form editor later |

## Architecture

- **`src/shared/workflow-def/`**: schema types, YAML parser/validator (cycles, refs, templates), template interpolation, condition evaluation. Pure, tested.
- **`src/shared/state/workflows/`**: new slice
  - `definitions` (personal + per-repo, keyed by scope), `trust`
  - `runs: Record<runId, { defSnapshot, batchId?, worktreePath, status, steps: Record<stepId, { status, attempts: Attempt[] }> }>` (active + capped recent)
  - `batches: Record<batchId, { defId, items: { id, title, parentId?, after?: string[] }[], concurrency, draftPrs, childRunIds }>`
  - runs also carry `{ itemId?, parentRunId?, branch, baseBranch, prNumber? }`
  - events: `definitionsLoaded`, `definitionSaved`, `definitionDeleted`, `runStarted`, `stepQueued`, `stepStarted`, `stepStatusChanged`, `stepCompleted`, `gateResolved`, `runFinished`, `batchStarted`, `batchFinished`
  - `findIndex` + `slice` patches; add to `mergeWireSnapshot`; renderer gets `useWorkflowRun(id)` per-id selectors (anti-pattern #4)
- **`src/main/workflow-runner/`**: FSM + scheduler (queue, concurrency, budgets). Owns the `terminalId → attempt` map. Reacts only to `terminals/*` events for mapped ids (anti-pattern #1) and dedups derived status (anti-pattern #2). Takes snapshots, renders prompts, persists run records, reconciles on boot.
- **`src/main/workflow-runner/drivers/`**: `StepDriver` interface; `pty-agent` and `shell` drivers.
- **Main-side spawn**: extract the spawn path from `XTerminal.tsx` into a main helper (`buildSpawnArgs` + `ptyManager.create`) that the runner, and later `create_worktree`, can call. The renderer then attaches instead of spawning.
- **Control server + MCP bridge**: `GET /workflow/step`, `POST /workflow/complete`, `POST /workflow/stop-check` (used by the Stop hook); later `run_step` / `await_step` / `run_workflow`.
- **Agents**: Codex and opencode get per-terminal MCP; permission-mode flags in `AgentSpawnOpts`; the opencode plugin rewritten to the documented ESM format; `hooks.ts` parses `last_assistant_message`.
- **Renderer**: `Workflows` view (Runs / Library), run + batch detail, launch sheet, YAML editor. Smart/dumb split per `plans/smart-dumb.md`.

## Testing

- `workflow-def`: parser/validator/template/condition table tests.
- Slice: one reducer test per event, plus wire-merge.
- Runner: FSM tests against a fake `StepDriver` (scripted turn-ends, completes, exits, restarts).
- **Scripted harness for e2e**: a tiny `fake-agent` command that reads its prompt and calls `complete_step` through the real bridge. Add it to `scripts/smoke-headless.sh` so CI exercises spawn → MCP → complete → next step without any LLM.

## Phases

0. **Prerequisites**: main-side agent spawn; MCP parity (opencode via `OPENCODE_CONFIG_CONTENT`; Codex via `-c mcp_servers.harness-control.*`, falling back to a per-terminal `CODEX_HOME`); fix the opencode plugin format; parse `last_assistant_message`; permission-mode flags; bridge `agentKind` enum fix. Each ships independently and improves today's tabs too.
1. **Definitions**: `workflow-def` package, loader for personal + repo scopes, repo trust, `workflows` slice.
2. **Runner (linear)**: FSM, `agent` + `shell` drivers, `complete_step`, Stop-hook continuation, snapshots, Retry / Skip / swap, restart recovery, fake-agent e2e.
3. **Workflows section + YAML editor**: Runs view, run detail, Library, Monaco editor with validation and graph preview, launch sheet + entry points.
4. **Control flow**: `needs:` DAG, gates (Approve / Request changes), loops with `on_loop`, `when:`, read-only parallel steps, concurrency cap, budgets.
5. **Batches**: item sources, child runs, batch board, automatic PRs, dependency graph + stacked branches/PRs, blocked scheduling, Restack, retarget on parent merge.
6. **`foreach` over step output + join**, with `depends_on` stacking.
7. **Form editor**.
8. **Orchestrator step type**: `run_step` / `await_step` (async start + await to avoid MCP timeouts).

## Open items

- Verify Codex `-c mcp_servers.*` per-run override (Codex isn't installed on the dev machine yet)
- Confirm whether Codex hooks fire under `codex exec` (matters only for headless mode)
- Confirm the opencode plugin loads today (gap 3); confirm the opencode permission config and SDK prompt call for continuation
- Confirm GitHub REST exposes issue "blocked by" relations for dependency import (fallback: sub-issues + manual edges in the launch sheet)

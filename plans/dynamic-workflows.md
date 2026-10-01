# Dynamic workflows plan

## Summary

### Goal

Let users define multi-step workflows where each step runs on a different agent harness (e.g. Claude Code plans, Codex implements, opencode reviews), run them against a worktree, and get a uniform, machine-readable result out of every step regardless of which harness produced it.

### Why

- Each harness/model has strengths; workflows let users pick the best one per step
- Tatsu already owns the primitives (agent tabs, status hooks, MCP control server, worktree creation) — workflows are an orchestration layer on top
- A uniform step output contract makes handoff between harnesses deterministic

## Scope

Included:
- Harnesses Tatsu currently supports: Claude Code, Codex, opencode
- Workflows section UI (runs + definitions library + editor + launch sheet)
- `workflows` slice, workflow runner FSM, `complete_step` MCP tool
- MCP parity for Codex and opencode terminals (prerequisite)

Explicitly out of scope (for now):
- Generic / arbitrary harness support (revisit later, likely via ACP)
- Headless step execution (later, optional per step)
- Event triggers (PR opened, issue labeled)
- Isolated per-branch sub-worktrees with merge-back

## Existing primitives

| Need | Already in Tatsu |
|---|---|
| Spawn harness X with a prompt | `AgentModule.buildSpawnArgs({initialPrompt, model, mcpConfigPath, systemPrompt})` in `src/main/agents/` |
| Know when an agent's turn ends | Hook NDJSON → `Stop` (Claude, Codex) / `session.idle` (opencode) → terminal status |
| Agents calling back into Tatsu | `harness-control` MCP bridge (`resources/mcp-bridge.js`) + control server with per-terminal scope resolution |
| Fan out to new worktrees | `create_worktree` MCP tool, `runPendingPRWorktree` (accepts `agentKind`, `model`) |
| Visible, steerable sessions | Agent tabs via `PanesFSM` |

### Gap found: MCP only reaches Claude today

- Claude: `--mcp-config <per-terminal file>` (`src/main/agents/claude.ts`)
- Codex: `buildSpawnArgs` comment claims MCP is registered globally in `~/.codex/config.toml`, but nothing in `src/main` writes it — only the hooks flag is enabled
- opencode: no MCP wiring at all

## UX

### Workflows section

Full-screen view alongside Activity / Cleanup / Command Center (`showWorkflows` in `App.tsx`), reachable from sidebar, hotkey, and command palette. Two tabs:

**Runs** (default)
- **Needs you** (pinned top): runs paused on a gate, failed step, or agent waiting for input
- **Active**: card per run — workflow name, repo/worktree, step strip (`plan ✓ → build ● → review ○`), current agent + status, elapsed time, cost
- **Recent**: finished / cancelled
- Run detail: step graph, each step's result summary, "Jump to tab" for the live agent tab

**Library** (definitions)
- Grouped by scope: **Personal** / **This repo**
- Actions: Run, Edit, Duplicate, Delete, New workflow

The sidebar also shows a small badge on worktrees with a running workflow.

### Running a workflow

A run = **definition + target + inputs**. Every entry point opens the same launch sheet:

1. **Target**: repo, and **new worktree** (default — isolation, matches worktree = unit of work) or **existing worktree**
2. **Inputs**: generated from the definition's typed inputs — `text` (textarea), `issue` / `pr` (GitHub picker), `file` (file picker)
3. **Overrides** (collapsed): per-step agent/model swap for this run, **autopilot** toggle (skips approval gates)

Entry points:
- Library → Run
- New Worktree screen → "Workflow" dropdown
- Worktree context menu → "Run workflow here…" (prefilled target)
- Command palette
- Later: `run_workflow` MCP tool; event triggers

### Definition editor

Form-based step list (no node-graph canvas in v1). Each step card:
- name, agent (registry dropdown), model
- prompt textarea with `{{inputs.*}}` / `{{steps.<id>.summary}}` / `{{steps.<id>.data.*}}` autocomplete
- output fields (schema for `complete_step`)
- "Approve before continuing" toggle
- optional loop ("if verdict ≠ pass, go back to ___, max N")
- "run alongside previous step" (parallel)

Plus an **Edit as YAML** toggle. The graph is rendered read-only in the run view.

### Storage

- **Personal**: `userData/workflows/*.yaml` — default when creating from the UI
- **Repo**: `.harness/workflows/*.yaml` — committed, shared with the team; "Save to repo" in the editor
- YAML over JSON because prompts are multi-line and they are the main content
- Definitions and runs both live in the `workflows` slice (a second client should see them). Selected tab, editor drafts, etc. stay renderer `useState`.

### Example definition

```yaml
name: plan-build-review
inputs:
  task: { type: text }
steps:
  - id: plan
    agent: claude
    model: claude-opus-5-5
    prompt: "Plan this task and write PLAN.md. Task: {{inputs.task}}"
    gate: approve
  - id: build
    agent: codex
    prompt: "Implement PLAN.md. Plan summary: {{steps.plan.summary}}"
  - id: review
    agent: opencode
    prompt: "Review the diff against PLAN.md."
    output:
      verdict: { enum: [pass, fail] }
    loop: { until: "data.verdict == 'pass'", back_to: build, max: 3 }
```

## Harness research (2026-10-01)

| | Claude Code | Codex | opencode |
|---|---|---|---|
| Turn-end hook (already installed by Tatsu) | `Stop` | `Stop` | `session.idle` plugin |
| Hook carries final message | yes (`last_assistant_message`) | yes (`last_assistant_message`) | no, plugin can fetch it via client |
| Headless | `claude -p --output-format stream-json` | `codex exec --json` | `opencode run --format json` |
| Typed headless "done" event | yes (`result`) | yes (`turn.completed` / `turn.failed`) | **no** — process exit without `error` |
| Schema-validated output | `--json-schema` → `structured_output` | `--output-schema` (JSON as final message text) | **CLI: no** (server/SDK only) |
| Per-run MCP injection | `--mcp-config` | `-c mcp_servers.*` (unverified) or `CODEX_HOME` | `OPENCODE_CONFIG_CONTENT` env var |
| Headless resume | `--resume <id>` | `codex exec resume <id>` | `--session <id>` |
| ACP | adapter `@agentclientprotocol/claude-agent-acp` | adapter `@agentclientprotocol/codex-acp` | native `opencode acp` |

Unverified: Codex `-c mcp_servers.*` per-run override; whether Codex hooks fire under `codex exec`; opencode JSON event shapes and structured output (read from source, not docs).

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

1. **Per-harness headless modes** — rejected for v1. Claude is strong, Codex fine, opencode lacks a final event and schema support. Three parsers, no human steering.
2. **ACP for all three** — rejected for v1. Uniform transport, but no structured output, extra npx adapters for Claude/Codex, and v2 changes turn-completion semantics. Tatsu chat tabs already use the Agent SDK directly. Candidate path for generic harness support later.
3. **Interactive PTY tabs + `complete_step` MCP tool + existing hooks** — chosen. MCP tool arguments are schema-validated, so a tool call is portable structured output across all three harnesses with no per-harness schema flags. Reuses tabs and hooks Tatsu already has.

## Step output contract

Every step ends in one shape regardless of harness:

```ts
interface StepResult {
  status: 'done' | 'failed' | 'needs-input'
  summary: string
  data?: Record<string, unknown>
  baseSha: string
  headSha: string
  sessionId: string
  costUsd?: number
  durationMs: number
}
```

### How it gets filled

1. **`complete_step({summary, ...fields})`** — authoritative. The step's `output:` spec becomes the tool's input schema: the MCP bridge passes `HARNESS_STEP_ID`, fetches the schema at startup (same scope lookup it already does), and advertises `complete_step` with exactly those fields. Server re-validates; an invalid call returns an error so the agent retries.
2. **Turn-end hooks**, extended to capture the final assistant message. Turn ends without `complete_step`:
   - first time → runner types one nudge into the PTY: "If you're finished, call complete_step; otherwise state what you need."
   - second time → if the step declares no required output fields, the final message becomes `summary` and the step is done; otherwise the step goes to **Needs you**.
3. **Process exit without `complete_step`** → `failed`, with Retry / Skip / Retry with a different harness or model.

### Handoff to the next step

- **Code**: shared worktree; `baseSha..headSha` records what the step changed
- **Prompt**: templates reference `{{steps.<id>.summary}}` / `{{steps.<id>.data.*}}`
- **History**: runner appends to `.tatsu/runs/<runId>/context.md`, excluded via `.git/info/exclude` (never edit the user's `.gitignore`)

The same contract holds if headless mode is added later, since the MCP tool works identically there.

## Design decisions

| Decision | Choice |
|---|---|
| Step completion | `complete_step` → hook-triggered nudge → final-message fallback → process exit = failed |
| Handoff | shared worktree + `summary`/`data` in templates + `context.md` |
| Harness support | Claude Code, Codex, opencode only; generic harnesses later (likely ACP) |
| Visible vs headless | visible terminal tabs labelled `⚙ <step> · <agent>`; autopilot only skips gates |
| Static vs dynamic | static step graph first; later an `orchestrator` step type with `run_step` / `await_step` MCP tools (async start + await to avoid MCP timeouts) |
| Worktrees | one per run, shared by all steps; parallel steps must be read-only in v1 |
| Failure | run pauses; Retry / Skip / Retry with different harness or model |

## Architecture

- **`src/shared/workflow-def/`** — schema types, YAML parser/validator, template interpolation. Pure, tested.
- **`src/shared/state/workflows/`** — new slice:
  - `definitions` (personal + per-repo)
  - `runs: Record<runId, { defId, worktreePath, status, steps: Record<stepId, { status, tabId, attempt, result }> }>`
  - events: `definitionsLoaded`, `definitionSaved`, `definitionDeleted`, `runStarted`, `stepStarted`, `stepStatusChanged`, `stepCompleted`, `gateResolved`, `runFinished`
  - `findIndex` + `slice` patches; add to `mergeWireSnapshot`; persist runs so they survive restart
- **`src/main/workflow-runner/`** — FSM. Spawns step tabs via `PanesFSM`, maps `tabId → (runId, stepId)`, reacts only to `terminals/*` events for mapped tab ids (no sweeping — anti-pattern #1), dedups derived status (anti-pattern #2), handles `complete_step`, sends nudges, records SHAs.
- **Control server + MCP bridge** — `/workflow/step` (schema lookup), `/workflow/complete`; later `run_step` / `await_step` / `run_workflow`.
- **Agents** — Codex and opencode get per-terminal MCP; all three hooks forward the final assistant message.
- **Renderer** — `Workflows` view (Runs / Library), run detail, launch sheet, definition editor. Smart/dumb split per `plans/smart-dumb.md`.

## Phases

1. **MCP parity** — Codex and opencode terminals get `harness-control` (opencode via `OPENCODE_CONFIG_CONTENT`; Codex via `-c mcp_servers.harness-control.*`, falling back to a per-terminal `CODEX_HOME`); all three hooks forward the final assistant message.
2. **Definitions** — `workflow-def` package (schema incl. `output:`), loader for personal + repo scopes, `workflows` slice.
3. **Runner** — FSM, `complete_step` with per-step schema, nudge, Retry / Skip / swap harness.
4. **Workflows section** — Runs view + Library list.
5. **Launching** — launch sheet + entry points.
6. **Editor** — form-based with YAML mode.
7. **Control flow** — loops, gates, read-only parallel steps.
8. **Orchestrator step type** — `run_step` / `await_step`.

## Open items

- Verify Codex `-c mcp_servers.*` per-run override (Codex not installed on the dev machine yet)
- Confirm whether Codex hooks fire under `codex exec` (matters only for headless mode)

# Dynamic workflows plan: review 2

A second review of the high-level overview of `dynamic-workflows.md` (2026-10-02), with key claims checked against the code.

None of the changes recommended in `review-1-iteration.md` have been applied yet: the phases are unchanged, there is no Labs flag, `PanesFSM` ownership of step tabs isn't stated, and "why stack by default" is still open. Findings below that repeat review 1 are marked "(also review 1)".

## Critical

### 1. Stop-hook continuation has no way to talk back to Tatsu

The hook command in `src/main/hooks/hooks.ts:42-50` only appends one NDJSON line and exits, so it can't return `{"decision":"block"}`. `HARNESS_PORT` / `HARNESS_TOKEN` are only set in the MCP bridge's env (`src/main/mcp-config/mcp-config.ts:48-49`), not in the PTY env (`src/main/pty-manager/pty-manager.ts:144-149`). For the hook to call `POST /workflow/stop-check`, one of these has to happen, and each has a cost the plan doesn't mention:
- Put the token in the agent's env. Every Bash child process inherits it, sandboxed or not.
- Add a new Codex `hooks.json` entry. That's a new trust key and forces users to approve hooks again.
- Add a synchronous HTTP call to the shared `harness-hook.sh`. Every Tatsu-spawned turn pays for it.

**Recommendation:** Either make an explicit Phase 0 decision (read the token from a 0600 file, short-circuit locally when no step marker file exists for the terminal, keep the Codex command string byte-identical), or drop continuation from v1. v1 would then rely on `complete_step`, the `last_assistant_message` fallback and Mark done. Measure the `completedBy` mix before deciding whether continuation is worth building.

### 2. Budgets would never trigger

`CostTracker` does nothing while no client has the cost panel open (`src/main/cost-tracker/cost-tracker.ts:73-81, 110-113`). On a headless server with no client attached, that's all the time.

**Recommendation:** Have the runner track usage itself for the terminals it owns (always on, independent of panel interest), or defer budgets. Either way, call them best-effort, since opencode reports no cost.

### 3. Nothing is usable until Phases 0–3 are all done (also review 1)

Phase 0 alone has 8 sub-items across three harnesses, and Codex hasn't been verified. Rung 1 is labelled Phase 2, but it can't be launched until Phase 3.

**Recommendation:** Ship a thin vertical slice first:
- Claude and shell steps only, in a linear chain, from personal YAML files
- launched from "Run workflow here…"
- a step strip, a basic Needs-you list and the fake-agent e2e
- prerequisites limited to 0.2 (main-side spawn) and 0.3 (`last_assistant_message`)

Then add opencode (0.1, 0.4, 0.5), and Codex only after a spike on a real install. The Library, Monaco editor and graph preview follow. Batches and stacked PRs (Phase 5) and Phases 6–8 move to a separate plan.

## Important

### 4. Main-side spawn is more than "a small renderer change" (partly review 1)

- Building the args and creating the PTY are two separate IPC calls (`XTerminal.tsx:444-494`), and the PTY env is only `claudeEnvVars` (`src/main/index.ts:2469`).
- `AgentModule.buildSpawnArgs` returns a plain string (`src/main/agents/index.ts:43`), so it can't carry `OPENCODE_CONFIG_CONTENT` or `CODEX_HOME`. Change it to return `{command, env}`.
- Step tabs must be created through `PanesFSM.addTab` (`src/main/panes-fsm/panes-fsm.ts:289`); the plan doesn't say so.
- When a step tab mounts, `XTerminal` still calls `buildAgentSpawnArgs`, which rewrites the MCP config before `create` no-ops (`pty-manager.ts:131-142`). Mark runner-owned tabs as attach-only.
- Define what closing or typing into a step tab does.
- The deferred spawn exists to avoid a wrong-width flash (comment at `XTerminal.tsx:458-464`). Keep the 120×30 spawn limited to runner tabs.

### 5. The StepDriver seam still depends on terminals

Step identity is the `terminalId` (via `X-Harness-Terminal-Id`), and completion arrives through the control server, not the driver. A headless or ACP driver has no terminal.

**Recommendation:** Key everything on an `executionId` the driver supplies. Make "completed" a runner input independent of the driver. Drivers then emit only lifecycle events (`turnEnded`, `exited`).

### 6. Run records would make the shared state too large

`runs[].defSnapshot`, plus attempts carrying full `summary` / `data` (plans run to several KB), grows the wire snapshot and every `mergeWireSnapshot`.

**Recommendation:**
- Slice: snapshot hash and truncated summary previews only.
- Disk: full snapshot and results in `workflow-runs/<id>.json`, fetched by request.
- Keep the `terminalId → attempt` map runner-private, as planned.
- Dedup `stepStatusChanged` against terminal status flips (anti-pattern #2).

### 7. Batch and `foreach` are the same concept

Both are "an ordered chain of child runs, one worktree each, stacked".

**Recommendation:** Introduce one **Chain** concept with an **Item** entity (id, title, branch, PR) whose items come from the launch sheet or from step output. Batch becomes a launch mode, not a separate concept. Also settle the contradiction: the plan says a batch has no status of its own, but defines `batchStarted` / `batchFinished` events.

### 8. Stacking items by default is risky (also review 1)

Independent issues usually belong off base. Stacking ties every item to unreviewed earlier work, and one failure blocks the whole chain.

**Recommendation:** Default 5a to independent branches off base, with stacking as an option. Defer restack and retarget (5b).

### 9. Open questions

- Context-window growth when `on_loop` or gate rework keeps continuing one session. Add a `fresh: true` option per loop. (also review 1)
- Where the hooks-consent check falls in the spawn order.
- How the user's own keystrokes mid-step interact with the once-per-turn continuation counter. (also review 1)

## Minor

- The concurrency cap lands in Phase 4, but Phase 2 already allows several runs at once. Move a simple cap into Phase 2. (also review 1)
- `needs-input` is both a `StepResult.status` and a `pausedReason`, but the step states have no matching state.
- `{{steps.<foreach>.children[*].summary}}` uses a wildcard the template grammar doesn't define.
- "Retry from clean" lands in Phase 2; its confirmation dialog and the snapshots must ship together. (also review 1)
- The bridge `agentKind` fix (`resources/mcp-bridge.js:108, 468-473`) and the `PIPE_BUF` comment (`src/main/hooks/hooks.ts:40`) don't depend on workflows. Ship both now.
- No rollout gate (Labs flag), no metrics (`completedBy` mix, pauses per run) and no `workflow` log channel. (also review 1)

## Verdict

The core bet is sound: visible PTY tabs, a schema-validated `complete_step` MCP tool, and the existing hooks. It reuses Tatsu's primitives and fits the store and FSM model. But the plan is over-scoped for v1, and two parts are weaker than the text implies: Stop-hook continuation has no channel back to Tatsu, and budgets depend on a tracker that is off unless a client has the cost panel open.

Cut v1 to a Claude-plus-shell linear runner with a minimal UI and resolve items 1–3. Make identity and completion independent of the driver, then add harnesses one at a time. Batches belong in their own plan.

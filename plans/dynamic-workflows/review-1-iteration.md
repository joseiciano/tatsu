# Dynamic workflows plan: review 1

An engineering-manager review of the high-level overview of `dynamic-workflows.md` (2026-10-01).

## Concerns (most important first)

### 1. Users get value too late; phases 1 and 2 ship nothing visible

Phase 0 has 7 items, and a user gets value only after phases 0, 1, 2 and 3. The plan says "each rung ships on its own", but rung 1 (Phase 2) can't be authored or launched until the Phase 3 UI exists.

**Recommendation:** Define a minimal first version:
- a linear `agent` + `shell` chain from a YAML file
- launched from "Run workflow here…"
- a step strip on the worktree and a basic "Needs you" list

Defer the Library, Monaco editor and graph preview. Ship Phase 2 and a thin slice of Phase 3 together.

### 2. The headline pitch depends on Codex, the least-verified harness

"Claude plans, Codex implements" is the pitch, but Codex isn't installed on the dev machine. Its per-run MCP (`-c mcp_servers.*`), trust check and hook behaviour are all unverified, and the `CODEX_HOME` fallback (copying `auth.json`) is fragile.

**Recommendation:** Run a one-day Codex spike before Phase 1, with a clear criterion: if per-terminal MCP doesn't work cleanly, v1 ships with Claude and opencode, and Codex follows later.

### 3. Batches and stacked PRs are a second product

Auto-commit, push, PR creation, restack with force-push, conflict pauses and retarget-on-merge make up the riskiest git work in the plan, and they aren't about multi-harness orchestration. Stacking each item on the previous one is also a strong default that many users won't want, since independent issues usually belong off base.

**Recommendation:** Split batches into their own plan. If they stay:
- 5a should ship with independent branches off base, or with stacking as an option.
- 5b (restack) should wait until there's demand.

Move `foreach` (Phase 6), the form editor (Phase 7) and the orchestrator (Phase 8) into a follow-up plan as well. Reserving their names in the validator is enough for now.

### 4. The permission model is load-bearing but untested in practice

With `dontAsk` plus allowlists, every Bash command nobody anticipated becomes a `needs-input` pause. Unattended runs could turn into runs where someone has to keep clearing the "Needs you" list, which undercuts the value.

**Recommendation:** Try the Phase 0.5 permission mappings on 5–10 real tasks per harness before building the runner, and count pauses per run. Consider a broader default `allow:` set for `edit`.

### 5. Tab and pane ownership is unspecified

The runner spawns tabs from main, but the plan doesn't say that step tabs are created through `PanesFSM`, which owns every tab mutation. It also doesn't say what happens when a user closes a step tab or types into it mid-step.

**Recommendation:**
- State that the runner calls `PanesFSM` to add the tab.
- Define closing a step tab as cancelling the step, or ask for confirmation first.
- Define how typing into the tab interacts with the counter that limits Stop-hook continuations to once per turn.

### 6. Prerequisite 0.2 is partly done already, and has a regression risk

`ptyManager.create` already treats an existing id as an attach (`src/main/pty-manager/pty-manager.ts:131-142`). The real work is moving `buildSpawnArgs` into main and replaying history. The renderer defers the spawn to avoid a brief wrong-width flash at 120×30, described in a code comment there. Spawning from main brings that flash back, possibly for every background tab if normal tabs also move to main-side spawn.

**Recommendation:** Re-scope the item. Limit the 120×30 spawn to tabs the runner owns, or explicitly accept the flash there.

### 7. Success criteria, rollout and observability are missing

**Recommendation:** Add:
- a settings flag (Labs) gating the Workflows section and the global Stop hook
- success metrics: runs completed without intervention, how steps completed (the `completedBy` mix of tool, fallback and user), pauses per run, time to the first completed run
- a `workflow` log channel that fits the existing perf/cascade logging
- criteria for revisiting the design, e.g. if more than X% of steps need the fallback or Mark done, revisit the output contract

### 8. Internal consistency

- The concurrency cap lands in Phase 4, but Phase 2 already allows several linear runs at once. Move a simple cap into Phase 2.
- Budgets rely on `CostTracker`, which has no opencode cost data. That's acceptable, but say budgets are best-effort.
- Phase 2 includes "Retry from clean", which overwrites the worktree. Ship its confirmation and the snapshots together.

## Questions for the author

1. Who is the first user, and what concrete workflow would they run every week? Is the core value mixing harnesses per step, or running many items as a batch? The answer should decide what stays in v1.
2. The Stop hook is installed globally. For a terminal that isn't a step, does it exit straight away without an HTTP call, or does every normal Claude/Codex turn make a round trip to the control server?
3. When a gate or loop keeps continuing the same session over many iterations, how is context-window growth handled? Should there be a "fresh session" option per loop?
4. Is requiring hooks consent acceptable for first-time users, or should the launch sheet offer to install hooks inline? (The plan already has an "Install hooks" button in the launch sheet.)
5. Why stack batch items by default instead of branching each one from base?

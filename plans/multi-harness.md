# Implementation Plan: Multi-Harness Workflow

## Ideal End-Goal

A user is able to setup a workflow having different harnesses and agents for each step.

Think of it as a workflow diagram

```
Opencode (GPT 5.5) for planning -> Claude Code (Claude) for implementation -> Opencode (GPT 5.5) for revisions
```

Users have a new page in the app called "Workflows". In it, they are able to see the different workflows they created and have a button to create a new one.

Within the workflow creation scene they are able to select, in order, the kind of operation they want to run (for example the one given above).

We can then run the workflow by clicking on it and providing it whatever input/prompt is needed for the initial.

Think of this as an orchestrator around the different agents in the swarm.

---

## Feasibility & MVP boundary

The app already owns the three building blocks this needs:

1. **Multiple agent CLIs** via `AgentKind = 'claude' | 'codex' | 'opencode'` (`src/shared/state/terminals/types.ts`) and `AGENT_REGISTRY` in `src/shared/agent-registry/agent-registry.ts`.
2. **Per-worktree execution contexts** — `WorktreesFSM` spawns worktrees, `PanesFSM` owns the tab tree, `PtyManager` owns `node-pty` lifecycle, and the `jsonClaude` slice + `ChatRuntimeRegistry`/`ClaudeAcpRuntime` already run a non-terminal, state-driven agent session.
3. **A main-owned FSM pattern** to copy (`WorktreesFSM`, `WorktreeDeletionFSM`, `PanesFSM`) that dispatches typed slice events the renderer mirrors.

**MVP boundary (what ships first):** a single linear workflow of 2–3 steps, all steps run against **one leased worktree**, each step runs **one agent session in sequence** (never concurrently), steps are linked by **unstructured prompt-passing** — step *N+1*'s initial prompt is rendered from an **agent-neutral handoff artifact file** that step *N* is required to write (context + a file-path manifest of its artifacts). We **never hand off raw terminal transcripts** and **never claim a terminal session's final text is reliable**. Completion requires an **explicit validation signal** per step. Excluded from MVP (non-goals below): branching/parallel steps, per-step worktree creation, structured JSON artifact transfer between steps, automatic PR creation, arbitrary control flow.

**MVP feasibility risks:** non-Claude agents (codex/opencode) do not have a `ClaudeAcpRuntime`-style programmatic session API in the repo today — only the terminal hook-status path. MVP therefore drives **all** steps through the **same terminal hooks** used by terminal tabs (status via `/tmp/harness-status/<id>.ndjson`), reusing `PtyManager` for launch and the hook NDJSON for progress. **ACP is explicitly post-MVP** (see non-goals) and needs real work before parity: durable transcript/output capture, artifact surfacing, permissions, and recovery. Because terminal sessions give no reliable final-message text, the handoff contract (below) is **artifact-file based**. A small **agent capability matrix/probe** (per `AgentKind`: does it expose a programmatic session API, reliable final output, structured tool events?) drives the adapter choice; in MVP the probe only ever resolves to the terminal path. Treat the adapter (below) as the abstraction that hides this difference.

## User flows

1. **Workflows list** — "Workflows" page shows created workflows (name, step count, last run status, updated-at). Empty-state with a "Create workflow" call to action.
2. **Workflow creation** — a multi-row builder. Each row selects `AgentKind`, a model picker (reusing `CLAUDE_MODELS`/`CODEX_MODELS`), an optional step label, an optional **validation command** (shell), and an optional per-step prompt template (with `{{artifacts}}` / `{{previous}}` substitution). Steps are reorderable. Saved via `workflows:save`.
3. **Workflow run** — user clicks Run on a saved workflow, is prompted for: target repo root, target worktree (existing worktree or "create fresh"), and the initial step prompt. Confirmation shows the worktree that will be **leased** and the step sequence. **Run acceptance policy:** an existing **dirty** worktree (uncommitted changes) requires explicit confirmation before the run may start; the **main worktree is excluded by default** from lease targets. A `createFresh` run spawns via `WorktreesFSM` with its **default pane creation and prompt propagation suppressed** — the fresh worktree is owned by the run, not the normal worktree-creation UX — and **fails the run cleanly if worktree setup fails**. Confirming starts a `WorkflowRun`.
4. **Run detail / live view** — per-step status (queued → running → needs-validation → validating → interrupted → passed → failed/cancelled), live step log tail (reusing `useTailLineBuffer`), artifact list, and the current step's terminal/session (read-only for non-active steps). Controls: cancel current step, cancel whole run, retry failed step.
5. **Validation flow** — when a step settles its agent turn, run shows a **needs-validation** state with the step's captured validation output and proposed artifacts. User can Approve (mark passed), Approve-and-advance (pass + auto-start next step), Re-run agent, or Fail. This is the explicit non-idle success signal.
6. **Recovery after relaunch** — a run in flight when the app quits/relaunches is recovered by a **single synchronous journal loader** (see Persistence) that hydrates slice state **before the `Store` is constructed**. The recovered run appears in the Workflows page with an explicit **Resume** affordance. A step that was `running` at shutdown is recovered as **`interrupted`** (its agent turn never settled) — never `needs-validation`. Resuming **verifies the worktree/git identity** against the run's recorded checkpoint; only then does it restart the stored rendered prompt for an `interrupted` step, or route to **manual validation** for an already-settled step. There is **no automatic continuation** — a mid-flight `running` step is never silently re-run.

## Contracts

Proposed shapes — plan only, not yet implemented.

### `Workflow` (definition, persisted)
```ts
interface WorkflowStepDef {
  id: string
  label?: string
  agentKind: AgentKind
  model?: string                    // override; empty = settings default
  promptTemplate?: string           // supports {{previous}} and {{artifacts}}
  validationCommand?: string        // shell; run against the leased worktree cwd
  validationTimeoutMs?: number      // default from settings, e.g. 120_000
}
interface Workflow {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  repoRoot?: string                 // optional repo pin
  steps: WorkflowStepDef[]
}
```

### `WorkflowRun` (execution state)
```ts
type RunStatus = 'pending' | 'running' | 'needs-validation' | 'validating' | 'succeeded' | 'failed' | 'cancelled'
type StepStatus = 'queued' | 'running' | 'needs-validation' | 'validating' | 'interrupted' | 'passed' | 'failed' | 'cancelled'

interface WorkflowRunStep {
  defId: string
  /** Attempt counter; increments on each retry. Persisted. */
  attemptId: string
  status: StepStatus
  startedAt?: number
  endedAt?: number
  /** Rendered prompt actually sent for this step's current attempt. Persisted for resume/retry. */
  renderedPrompt?: string
  /** Required agent-neutral handoff file (worktree-relative) the step must write; feeds the next step's prompt. */
  handoffFile?: string
  /** Paths (relative to worktree) of files the step produced/modified — per-step delta. */
  artifacts: string[]
  /** Validation command output + result. Persisted. */
  validation?: { output: string; result: 'passed' | 'failed' | 'timeout' | 'cancelled'; ranAt?: number }
  /** Adapter terminal/session id for this step (control + live log routing). Persisted. */
  sessionId?: string
  /** Exit code/reason/timestamp when the agent process ended non-zero or was interrupted. Persisted. */
  exit?: { code: number | null; reason: 'clean' | 'error' | 'interrupt' | 'cancel'; ts: number }
  /** Stable identity of the pre-start checkpoint captured for this step. Persisted. */
  checkpointId?: string
  error?: string
}
interface WorkflowRun {
  id: string
  workflowId: string
  status: RunStatus
  worktreePath: string
  repoRoot: string
  startedAt: number
  endedAt?: number
  currentStepIndex: number          // -1 when idle/done
  steps: WorkflowRunStep[]
  /** Human-readable cancel/error reason. */
  failure?: string
  /** Identity of the run's initial git baseline (HEAD + state) for lease/identity verification. */
  checkpointIdentity?: string
  /** Position in the persisted journal file this run last wrote. */
  journalOffset?: number
}
```

### `Artifact`
An artifact is any file/dir path **relative to the leased worktree** that a step produced or modified. Captured as a **per-step delta** against that step's **pre-start checkpoint** (see worktree lease/checkpoints), so artifacts reflect what this step changed, not cumulative run state. Capture uses `git status --porcelain -uall` (tracked **and** untracked, including untracked directories' contents) plus `git diff`/`git diff --staged` for content. Paths are **normalized under the worktree root** (never absolute, never `../` escapes). **Ignored files** (per `.gitignore` / `.git/info/exclude`) are **excluded** from artifact capture unless a step explicitly opts into them via its `promptTemplate`/validation config. The artifact set drives `{{artifacts}}` substitution in the handoff file.

### `Validation`
A step passes only when the user (or an explicit validation command, if configured) confirms. Validation output/result is **persisted** on the step. Two modes, same "passed" terminal:
- **Manual:** step reaches `needs-validation`; user Approve / Approve-and-advance / Re-run / Fail. In headless, manual approval requires an **authorized viewer** attached to the run (no global auto-validation).
- **Commanded:** after the agent turn, the workflow runs `validationCommand` (cwd = worktree). Exit code 0 → auto `passed`; non-zero → `needs-validation` with captured output for manual decision; timeout → `needs-validation` with a timeout note. A **cancelled/failed validation never auto-advances.** Automated advancement (headless or otherwise) is only ever driven by a **successful fixed validation command** under an **explicit per-run server-side policy** — never a blanket global switch.

## Completion semantics (explicit)

**Terminal idle is never success.** A step's agent session reaching `PtyStatus = 'idle'` or an ACP `exited` state only transitions the step from `running` to `needs-validation`. A **clean turn settle** is the adapter's signal that the agent finished its turn without an error/interrupt (a terminal hook `idle` status, or a clean exit) — it moves `running → needs-validation` only; it is never success by itself. `succeeded` for the run is reached only when every step is `passed` and the last step's validation resolves. Rationale: an agent stopping on a question, a permission prompt, or an internal pause is a non-event; treating idle as done would silently advance a half-finished workflow. The only auto-advance is a successful **commanded validation** or the user's explicit **Approve-and-advance**.

## Main-owned `WorkflowRunner` FSM

New package `src/main/workflow-runner/` following the `WorktreesFSM` pattern: constructed in `main/index.ts` after `worktreesFSM`/`panesFSM`, owns one live `WorkflowRun` at a time (a queue is a post-MVP extension), subscribes to store events (worktree lease revoked, step validation result, cancel) and to the agent adapter's per-step terminal events.

States (per run): `pending → running → (per-step: queued → running → needs-validation | interrupted) → validating → passed/failed → … → succeeded | failed | cancelled`. Per-step lifecycle: `queued → running → (needs-validation | interrupted)`, with `validating` entered while a commanded validation executes and `interrupted` marking a step halted by user/run cancel or process shutdown before its turn settled (it is never a settled step; `needs-validation` is reserved for steps whose agent turn settled). Transitions are driven by adapter callbacks and by explicit `workflows:*` transport requests (`workflows:approveStep`, `workflows:retryStep`, `workflows:cancel`, `workflows:resume`). On each transition the runner **dispatches a slice event** and **writes a journal line** (below). **Stale adapter callbacks** (for an old `attemptId`, or arriving after the run moved past that step) are ignored by the runner. The runner holds no timers that gate success — timers only guard validation/step timeouts. **Recovery authority:** the runner rehydrates **only leases** at boot; all other recovered run state is hydrated by the synchronous journal loader **before `Store` construction** (single recovery authority — see Persistence).

## `WorkflowAgentAdapter` — separate from terminal launching

New package `src/main/workflow-agent-adapter/`. Its job is to take a `{ agentKind, model, worktreePath, prompt, sessionId }` and expose a uniform per-step surface, **isolating the runner from how the agent actually runs**:

```ts
interface WorkflowAgentAdapter {
  /** Starts a step attempt; returns the attempt handle/id, or throws on launch failure. */
  startStep(run: WorkflowRun, step: WorkflowRunStep, prompt: string): { attemptId: string; sessionId: string }
  interruptStep(runId: string, stepDefId: string, attemptId: string): void
  cancelStep(runId: string, stepDefId: string, attemptId: string): void
  /** Detach; runner must call before discard so no stale callbacks leak. */
  unsubscribe(): void
  /** Emitted once a step attempt reaches a terminal agent state. */
  onStepSettled(cb: (e: { runId: string; stepDefId: string; attemptId: string; sessionId: string; exitCode: number | null; reason: 'clean' | 'error' | 'interrupt' | 'cancel'; ts: number }) => void): void
  onStepOutput(cb: (e: { runId: string; stepDefId: string; attemptId: string; sessionId: string; data: string }) => void): void
  onStepArtifacts(cb: (e: { runId: string; stepDefId: string; attemptId: string; sessionId: string; paths: string[] }) => void): void
}
```

Two implementations behind the interface:
- **TerminalAdapter** (MVP default for **all** agent kinds, including claude — ACP is post-MVP): reuses `PtyManager` to spawn the CLI (`/bin/zsh -ilc <cmd>`), reads status from the hook NDJSON (`$HARNESS_TERMINAL_ID`) already produced by `src/main/agents/`, and derives artifacts from the worktree diff vs. the step's **per-step checkpoint**. It does **not** provide reliable final-message text from terminal output — the handoff is the **agent-neutral handoff artifact file** the step is required to write (see Artifact/Validation), never a raw terminal transcript. Deliberately **does not** reuse `PanesFSM` tab creation — the runner owns the session id, not a UI tab (a mirror tab may be surfaced for visibility, but the adapter does not depend on it).
- **AcpAdapter** (**post-MVP**, claude only): wraps `ClaudeAcpRuntime` through `ChatRuntimeRegistry.start/send` for a state-driven turn. Explicitly not part of MVP; before it can reach parity with the terminal path it needs durable transcript/output capture, artifact surfacing, permissions, and recovery that match the persisted step contract.

The adapter owns the mapping `runId+stepDefId → terminal/session id` and the reverse, so the runner and the renderer talk only in run/step ids. This separation keeps the FSM deterministic and unit-testable independent of `node-pty`.

## Workflows state slice

New package `src/shared/state/workflows/` (`index.ts` barrel, `workflows.ts` reducer, `types.ts`, `workflows.test.ts`) following the existing slice checklist in `AGENTS.md`:

- `State`: `definitions: Workflow[]` + `runs: WorkflowRun[]` (latest-first) + `activeRunId: string | null`.
- `Event` variants (reducer cases, one per mutation): `workflows/definitionsChanged`, `workflows/runCreated`, `workflows/runUpdated` (scoped patch per entity — use `findIndex + slice`, never `map` realloc on every step event), `workflows/stepUpdated` (per `defId` patch), `workflows/activeRunChanged`, `workflows/runsPruned`.
- Wire into `src/shared/state/index.ts`: add slice to `AppState`, `StateEvent`, `initialState`, `rootReducer`, and **`mergeWireSnapshot`** (the checklist + `wire-merge.test.ts` covers the old-server/new-renderer skew).

## Persistence & journal work

- **Definitions** persist through the existing `src/main/persistence/` config shape (`Config` gains `workflows?: Workflow[]`), read at boot in `src/main/build-initial-state/build-initial-state.ts`, written on save (mirror `repoConfigs`/`scratchpad` write path).
- **Runs** use an **append-only journal** (mirrors `perf.log`/`debug.log` model and the `jsonl-fold`-style per-session file) at `userData/workflow-runs/<runId>.ndjson` under `src/main/workflow-runner/`. Each event is one NDJSON line: `{ seq, type, ts, payload }`. **Writes are atomic appends + `fsync`** so a crash cannot half-write a line; a journal line is only acknowledged once durably on disk. Persisted per step: `renderedPrompt`, `attemptId`, `checkpointId` (pre-start checkpoint identity), `validation` output/result, `sessionId`, and `exit` code/reason/ts.
- **Single recovery authority.** A **synchronous journal loader** (`src/main/workflow-runner/journal-loader.ts`) runs **before `Store` construction** (inside `buildInitialAppState`, mirroring existing boot hydration in `src/main/build-initial-state/`) and reconstructs all non-terminal runs' `steps[]`, `currentStepIndex`, `worktreePath`, and persisted fields. The loader is the **only** code that rebuilds run state; `WorkflowRunner` rehydrates **only leases** at boot and never rebuilds steps. The loader handles a **malformed/truncated tail line** by stopping at the last valid `seq` (dropping the torn line) and recording a warning on the run rather than failing boot; runs whose **worktree is missing** on disk are surfaced as `failed` with a clear reason, never auto-resumed.
- **Pruning:** journal files for runs in a terminal state are eligible for deletion per the run-history retention policy (same setting as run-history pruning); pruned runs keep a compact summary line so list views don't lose history.
- Journal offsets on the slice keep the renderer's live log replay bounded (mirror the `jsonClaude:getEntries` lazy-load pattern, not unbounded streaming).

## Worktree lease & checkpoints

- **Lease:** a run records `worktreePath` at start and holds a `workflows/lease` on that worktree for its duration. **Enforcement boundaries:** main rejects attempts to **remove** a leased worktree, **continue**/resume a different run on it, or **snooze** it, and rejects starting a **second workflow run** on the same worktree while a live lease exists (`worktree:remove`, cleanup, snooze, `workflows:run`). The lease **does not** prohibit ordinary filesystem edits — the user may edit the worktree freely; the lease only governs workflow/cleanup operations. On relaunch, `WorkflowRunner` re-asserts leases for recovered runs until each is resolved. `WorktreesFSM`/cleanup code checks `workflow-runner.hasActiveLease(path)`.
- **Active-terminal control policy:** while a step is `running`, the run controls the adapter-owned terminal/session (interrupt/cancel are routed to that `sessionId`). Once a step settles, its terminal is read-only for the run; the lease grants no control over the user's own manual terminals in that worktree.
- **Per-step pre-start checkpoints:** before each step starts, `WorkflowRunner` captures a git baseline of the leased worktree (current `HEAD` + full tracked/untracked state via `git status --porcelain -uall` + `git diff`) and records its **checkpoint identity** on the step. Each step's artifact set is the **delta against its own pre-start checkpoint** — artifacts are per-step, not cumulative against run start. `src/main/worktree/` already has the git primitives.
- **Run acceptance:** before the first step, an existing **dirty** worktree requires explicit user confirmation; the **main worktree is excluded by default** from lease targets. A `createFresh` run is created via `WorktreesFSM` with default pane creation/prompt propagation suppressed and fails the run cleanly on setup failure.
- **Retry:** MVP retry continues the **current tree** (no revert). Restoring a step's checkpoint (`git checkout` of the baseline) is a **future, destructive, user-confirmed** operation, not part of MVP.

## Transport APIs

New request handlers on `transport.onRequest` in `src/main/index.ts` (auto-exposed to the renderer via `build-backend`/`LocalTransportHandle` — no preload wiring), plus matching signatures on `ElectronAPI` in `src/renderer/types/types.ts`:

All workflow requests use the `workflows:*` namespace:

- `workflows:list` → `Workflow[]`
- `workflows:save` (def) → saved `Workflow`
- `workflows:delete` (id) → ok
- `workflows:run` ({ workflowId, repoRoot, worktreePath | { createFresh: true }, initialPrompt }) → `runId` (worktree creation routes through `WorktreesFSM` when `createFresh`, with default pane creation/prompt propagation suppressed; setup failure fails the run cleanly)
- `workflows:getRun` (runId) → `WorkflowRun`
- `workflows:resume` (runId) → ok (verifies worktree/git identity against the recorded checkpoint, then restarts the stored rendered prompt for an `interrupted` step or routes to manual validation for an already-settled `needs-validation` step; never auto-continues)
- `workflows:approveStep` ({ runId, stepDefId, advance }) → ok
- `workflows:retryStep` ({ runId, stepDefId }) → ok
- `workflows:cancel` (runId) → ok
- `workflows:getStepLog` ({ runId, stepDefId, offset }) → `{ data, nextOffset }` (lazy, journal-backed)
- `workflows:getRunWorktrees` (repoRoot) → candidates for the lease picker (excludes main worktree by default)

State events flow over the existing `state:event` channel (no new transport surface) since they ride the shared `rootReducer` mirror.

## Workflows page UX

New renderer view reached from the sidebar (a top-level "Workflows" entry alongside the worktrees list; it is a per-client **view**, so a `useState` in `App.tsx` toggles it — the *data* it renders comes from the slice). Layouts:

- **List view:** cards per `Workflow` (name, step count, last run status chip), Create button, per-run history list.
- **Builder view:** step-row editor (agent picker from `AGENT_REGISTRY`, model picker, label, prompt template, validation command), drag reorder, Save/Cancel. Smart/dumb split: a dumb `WorkflowBuilderForm` presentational component + a smart controller hook (`src/renderer/hooks/useWorkflowHandlers.ts`, mirroring `useWorktreeHandlers`) that calls the backend.
- **Run detail view:** step timeline, current step live log via `useTailLineBuffer` fed by `workflows:getStepLog` + streaming signal, artifacts panel, and the **validation prompt** (captured validation output + artifacts + Approve / Approve-and-advance / Re-run / Fail). Cancel + retry affordances.
- Icons/typography per canonical `text-*` / `icon-*` ladder in `AGENTS.md`.

## Permissions / cancel / retry / recovery / headless

- **Permissions:** MVP requires **hooks consent** (the existing consent gate) before a workflow may run steps that write status. When the agent emits a `needs-approval` hook status, the **workflow pauses** the current step and requires the user to **resolve the approval in the interactive terminal** — there is **no generic approval card** and **no compatibility with the JSON-Claude auto-approver** promised for workflow steps. A future step-level `permissionMode` field may force `plan`/`acceptEdits`. A per-agent **capability matrix/probe** determines which agents can run as workflow steps at all; **ACP is post-MVP**.
- **Cancel:** cancel current step = adapter `interruptStep`/`cancelStep` (kill that terminal/session, not the whole pty farm); cancel whole run = step cancel + lease release + `workflows:cancel` event + journal terminal line. Idempotent — a second cancel is a no-op.
- **Retry:** `workflows:retryStep` re-runs a `failed`/`cancelled`/`interrupted` step from its original def with the same stored `renderedPrompt`, bumps `attemptId`, resets `status` to `running`, and appends a journal segment (old segments retained for audit). MVP retry continues the **current tree**; restoring a step's checkpoint is a future destructive confirmed operation.
- **Recovery:** see journal replay + single recovery authority above. On boot, unresolved runs surface as `pending`/`needs-validation`/`interrupted` with an explicit **Resume** button; `running` steps on relaunch are recovered as **`interrupted`** (the agent turn never settled — it is demoted to `interrupted`, never to `needs-validation`), and **never silently re-run a mid-flight agent**. `needs-validation` remains reserved for steps that had **already settled** (clean turn settle at shutdown). Resume verifies worktree/git identity before restarting the stored rendered prompt for an `interrupted` step, or routing to manual validation for an already-settled step.
- **Headless:** the control server + `transport-websocket` already push `state:event` to web clients, so runs/validation land in headless clients automatically. There is **no global headless auto-validation** and no `WORKFLOW_VALIDATION=auto` style flag. **Manual approval in headless requires an authorized viewer** attached to the run. Any optional automated advancement is a **later** feature and only ever via a **successful fixed validation command** under an **explicit per-run server-side policy** — never a blanket global switch. `pnpm build:headless && bash scripts/smoke-headless.sh` must keep passing.

## Phased delivery

1. **P0 — contracts + slice + persistence:** `workflows` slice, reducer, events, `mergeWireSnapshot`; definitions in `Config`; empty Workflows list page + builder (save/list only). Tests.
2. **P1 — runner + terminal adapter + validation:** `WorkflowRunner` FSM, `WorkflowAgentAdapter`/TerminalAdapter on `PtyManager` + hook status, validation states + approve/retry/cancel, live log, lease + checkpoint. Claude + one non-Claude (codex or opencode) end-to-end.
3. **P2 — journaling + recovery:** append-only run journal (atomic append + fsync), single synchronous journal loader hydrating run state before `Store` construction, `workflows:resume` with identity verification, resume affordance, headless `state:event` polish, `workflows:run` with `createFresh` via `WorktreesFSM` (default panes/prompts suppressed).
4. **P3 — polish + AcpAdapter (post-MVP, claude only):** `ClaudeAcpRuntime`-backed Claude steps once durable transcript/output/artifacts/permissions/recovery reach parity with the terminal path, artifact diff refinement, prompt templating (`{{previous}}`/`{{artifacts}}`), run history pruning.

## Tests

- **Reducer** (`workflows.test.ts`): one test per event variant; identity-preserving patch assertions for `runUpdated`/`stepUpdated` (no realloc when nothing matched).
- **Wire-merge** (`src/shared/state/wire-merge.test.ts`): new slice + persisted fields.
- **Runner FSM** (`workflow-runner.test.ts`): injected fake adapter — asserts state transitions including `validating` and `interrupted`, that a clean turn settle moves `running → needs-validation` not `passed`, that a non-zero spawn/exit maps to step `failed`, that validation failure/cancel/timeout route correctly, cancel idempotency, retry resets with a fresh `attemptId`, stale-callback ignoring, journal writes per transition, lease release on terminal states.
- **Journal loader** (`journal-loader.test.ts`): malformed/truncated tail line handling, atomic append + fsync order, pruning of terminal runs, missing-worktree → `failed` run, **a step that was `running` at shutdown recovered as `interrupted` (not `needs-validation`)**, an already-settled step recovered as `needs-validation`, identity verification on resume.
- **Adapter**: terminal adapter integration against the hook NDJSON + `worktree` diff primitives; AcpAdapter against the `ChatRuntime` contract (mocked). Tests verify `startStep` returns `{ attemptId, sessionId }` or throws, `unsubscribe()` detaches callbacks, events carry `attemptId`/`sessionId`/exit code.
- **Transport**: `workflows:*` handlers round-trip through a test transport (including `workflows:resume`); `ElectronAPI` signature parity.
- Full `pnpm typecheck` + `pnpm build` + `npx vitest run` before any commit; `pnpm build:headless && bash scripts/smoke-headless.sh` for the headless path.

## Risks

- **No reliable final text from terminals** — handoff is artifact-file based, not transcript-based; the required handoff-file contract is the mitigation but depends on the agent actually writing it, so runs should surface a clear error when a step settles without producing its handoff file.
- **Agent capability gaps** — the capability matrix/probe determines which agents can run as workflow steps; non-Claude and claude steps in MVP both ride the coarser terminal path (no structured tool/artifact events), and artifact inference from diff is heuristic. **ACP stays post-MVP** until transcript/output/artifacts/permissions/recovery parity is reached.
- **Idle ≠ done** ambiguity — mitigated by mandatory explicit validation; risk is UX friction (extra clicks) vs. correctness.
- **Lease collisions** — a workflow second-run or cleanup path ignoring the lease; lease checks must live in every governed destructive path (remove/continue/snooze/second-run), and the lease deliberately does **not** block ordinary filesystem edits, so a user editing mid-run can change what a step sees.
- **Journal/state skew** — boot replay vs. in-memory slice on relaunch; mitigated by a single synchronous journal loader before `Store` construction, atomic append + fsync, malformed/truncated-tail handling, and resume-only-on-demand with identity verification.
- **One-run-at-a-time limitation** — concurrent runs need a runner queue + per-run isolation; deferred.

## Non-goals (post-MVP)

- Branching/parallel/fan-out steps and conditional edges.
- Per-step worktree creation or per-step environment switching (single leased worktree only).
- Structured JSON artifact contract between steps (prompt-passing only).
- Automatic PR/commit creation; multi-repo workflows.
- Concurrent runs, workflow templates/library, shareable runs, throttling/cost-gating per workflow.
- A first-class `PanesFSM` tab per workflow step (mirror tabs may surface, but the runner does not depend on them).
- ACP-driven steps (post-MVP, claude only) until durable transcript/output/artifacts/permissions/recovery parity with the terminal path is reached.
- Destructive checkpoint restore on retry (checkpoint restore is future, user-confirmed).

## Likely file/package targets

- `src/shared/state/workflows/{index.ts,workflows.ts,types.ts,workflows.test.ts}` — new slice.
- `src/shared/state/index.ts` — wire slice into `AppState`/`StateEvent`/`initialState`/`rootReducer`/`mergeWireSnapshot`.
- `src/shared/state/wire-merge.test.ts` — add slice coverage.
- `src/main/workflow-runner/{index.ts,workflow-runner.ts,journal-loader.ts,types.ts,workflow-runner.test.ts,journal-loader.test.ts}` — new FSM + journal + single recovery-authority loader.
- `src/main/workflow-agent-adapter/{index.ts,types.ts,terminal-adapter.ts,acp-adapter.ts,workflow-agent-adapter.test.ts}` — new adapter package.
- `src/main/index.ts` — construct `WorkflowRunner` + adapters, register `workflows:*` transport handlers, lease guards on remove/continue/snooze/second-run.
- `src/main/persistence/{types.ts,persistence.ts}` — `Config.workflows` read/write.
- `src/main/build-initial-state/build-initial-state.ts` — seed `workflows.definitions` from config; run the synchronous journal loader to hydrate recovered runs before `Store` construction.
- `src/main/pty-manager/` — expose terminal-id mapping helpers for the TerminalAdapter (no pty rewrite).
- `src/main/worktree/` — reuse git baseline/diff primitives for checkpoints/artifacts.
- `src/renderer/types/types.ts` — `ElectronAPI` workflow method signatures.
- `src/renderer/App/App.tsx` — Workflows view toggle (per-client `useState`).
- `src/renderer/hooks/useWorkflowHandlers.ts` — smart handler controller.
- `src/renderer/components/` — `WorkflowList`, `WorkflowBuilder`, `WorkflowRunDetail` (+ dumb subcomponents).

_Plan — none of the above is implemented yet; all contracts/shapes are proposed, not shipped._

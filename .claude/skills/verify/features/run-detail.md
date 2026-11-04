# Run detail

Clicking a run card in the Workflows section's Runs tab opens that run's
detail in place of the run lists: the step graph with live statuses, the
actions the run allows right now, a timeline of every attempt, the
selected attempt's full result and the files that attempt changed.

## Sub-features

- **Opening it**: each run card (`article` named `<workflow> on <worktree>`)
  holds a button `Open run: <workflow> on <worktree>`; the whole card is its
  click target. The detail replaces Needs you, Active and Recent inside the
  `Runs` tabpanel. `All runs` goes back to the lists; switching tabs or
  closing the section also drops the selection. The detail heading (h2, the
  workflow name) takes focus on open.
- **Header**: region named after the workflow, run status (`Paused · <reason>`,
  `Done`, …), `<repo> / <worktree>`, `Elapsed` and `Cost`.
- **Step graph**: `role="group"` `Workflow graph` (311's `WorkflowGraph`),
  steps from the run record's definition snapshot, one `listitem` per step
  named `<id>: <status label>` from the live slice. Edges are an
  `aria-hidden` SVG; each `path` carries `data-edge="<from>-><to>"` for
  tests. A `needs:` graph (branches and joins) lays out in columns.
- **Actions**: section `Actions · step <cursor step>`. Only what the run
  allows now: `Resume`, `Retry`, `Retry from clean` (only when the cursor
  step's latest attempt has a base snapshot; confirm dialog), `Mark done`
  (opens the inline Mark done form), `Skip`, `Cancel step` (confirm dialog,
  running attempt only), `Cancel run`, `Jump to tab` (when the selected
  attempt's tab is open), `Swap harness/model` (agent step whose latest
  attempt is failed, cancelled or interrupted on a paused run). Step actions
  are named `<label>: <step id>`. No gate actions.
- **Swap harness/model**: modal `dialog` `Swap harness or model for
  “<step>”` (focus trap, Escape closes): select `Agent` (Claude Code,
  Codex, Opencode; current one marked `(current)`), text field `Model`
  (empty = agent default; picking another agent clears it), an `Allow full
  access for <agent>` checkbox only for a `full` step (required), button
  `Swap and retry` (disabled until something changes). It calls
  `workflows:swapStep(runId, stepId, {agent, model?, allowFull?})`: the
  runner swaps only the agent and model in the run's definition snapshot
  (prompt, `permissions` and `allow` stay), keeps the original in the
  record's `overriddenFrom`, records `agent`/`model` on each attempt, flips
  the slice step agent (`workflows/stepAgentChanged`) and retries the step
  as attempt n+1. Refusals (Codex hooks untrusted, consent, full access not
  confirmed, unsupported agent, not paused, …) show as an alert inside the
  dialog, which stays open.
- **Attempt timeline**: list `Attempt timeline`, one `aria-pressed` button
  per attempt in definition step order then attempt number, named
  `<step> #<n>: <status>, completed by <who>, <duration>, cost <cost>`.
  The latest attempt is selected by default.
- **Attempt result**: region `Attempt result`: step and attempt, status,
  `Completed by`, exit code, the summary as plain text in a `pre`
  (`Attempt summary`), and one `pre` per output field (strings as is,
  everything else as JSON). Fetched with `getWorkflowAttemptResult` when an
  attempt is selected and again when it ends.
- **Attempt changes**: region `Changed files` below the timeline. It diffs
  the attempt's base and head snapshots, so it also covers work the agent
  never committed. Each changed file is an `aria-pressed` button named
  `<path>, <added|modified|deleted>, +<a> −<d>` (`binary` in place of the
  counts). The first file is selected by default. The selected file's diff
  is a read-only side-by-side Monaco diff in region `File diff · <path>`.
  States: `Loading changed files…`; `No snapshot for this attempt` (running,
  interrupted or Mark-done attempts with no base or head snapshot; nothing
  is fetched); `No changes in this attempt`; an alert with the server error
  (`snapshot missing` after the snapshot refs are deleted, `File too large
  to show` past 1 MiB, `Binary file; no text diff to show`). The list stops
  at 500 files and says so. Backed by `workflows:getAttemptChangedFiles` and
  `workflows:getAttemptFileDiff`. Main resolves the commits and the worktree
  from the run record and only diffs a path from that attempt's list.

## How to get to it (user POV)

1. Turn on Labs workflows in Settings (seeded by `launch.sh`).
2. Open the Workflows section (sidebar `Workflows` button, Cmd+Alt+W or the
   palette).
3. Click a card under Active or Recent; click timeline rows to read each
   attempt; use the actions; press `All runs`.

## Driving it with Playwright

- `journeys/workflow-flows.sh <state>` (runs `scripts/browser-smoke.mjs`):
  - `run-detail` (right after `exit-mark-done`): sidebar button `Workflows`
    -> `Recent runs` -> first `article` `browser-exit on repo` -> button
    `Open run: browser-exit on repo` -> region `browser-exit` -> group
    `Workflow graph` with listitem `exit: done` -> list `Attempt timeline`
    with exactly two rows: `exit #1: failed, completed by process
    exit, …` then `exit #2: done, completed by you (Mark done), …` ->
    click row 1 (Completed by `process exit`) -> click row 2 -> `Attempt
    summary` reads `Marked done from the browser smoke` -> region `Changed
    files` reads `No snapshot for this attempt` -> `All runs` -> `Back`.
    Then the diamond: launch sheet -> `smoke-diamond` -> Start -> wait for
    the new run to be `done` -> sidebar `Workflows` -> `Recent runs` ->
    first `article` `smoke-diamond on repo` -> `Open run: smoke-diamond on repo`
    -> region `smoke-diamond` -> graph listitems `plan: done`, `left:
    done`, `right: done`, `join: done` -> `path[data-edge]` set is exactly
    `left->join`, `plan->left`, `plan->right`, `right->join` -> `All runs`
    -> `Back` closes the section.
  - `attempt-diff` (right after `run-detail`, before `repo-trust`): launch
    sheet -> `browser-diff` -> Start -> wait for the run to be `done` ->
    sidebar `Workflows` -> `Recent runs` -> first `article` `browser-diff on
    repo` -> `Open run: browser-diff on repo` -> region `Changed files` ->
    button `smoke.txt, added, +1 −0` -> click it (`aria-pressed=true`) ->
    region `File diff · smoke.txt` holds `.monaco-diff-editor` whose
    modified side shows `smoke` -> `All runs` -> `Back`. Deletes
    `smoke.txt` from the worktree afterwards.
  - `swap-step` (right after `attempt-diff`, before `repo-trust`; needs
    curl): launch sheet -> `browser-swap` -> Start -> Needs-you row
    `Step failed · swap` -> sidebar `Workflows` -> `Active runs` ->
    `Open run: browser-swap on repo` -> button `Swap harness/model: swap`
    -> dialog `Swap harness or model for “swap”` (focus inside) -> `Agent`
    = `codex`, `Model` = `fake-codex-model` -> `Swap and retry` -> dialog
    closes -> run `done`; record step `swap` is codex /
    `fake-codex-model` / `read-only`, `overriddenFrom.swap.agent` is
    `claude`, attempts `1:claude:failed,2:codex:done` -> graph `swap: done`
    and two timeline rows -> `All runs` -> `Back`.

End state that proves it: `run-detail-01-detail-timeline.png`,
`run-detail-02-detail-summary.png`, `run-detail-05-diamond-graph.png`,
`attempt-diff-03-changed-files.png` and
`attempt-diff-04-file-diff.png`, `swap-step-04-swap-dialog.png` and
`swap-step-05-detail-done.png` in `$EVIDENCE/workflow-flows/`, and the
`run-detail: timeline [...]`, `run-detail: diamond graph edges [...]`,
`attempt-diff: changed files [...]`,
`attempt-diff: smoke.txt diff renders side by side…` and `swap-step: run
<id> done after swapping Claude to Codex (1:claude:failed, 2:codex:done)`
lines in the journal.

## Gotchas

- Several `browser-exit on repo` / `browser-hang on repo` cards can sit
  under Recent runs; pick by order (`.first()` is the newest finish) and
  scope locators to the `Workflows` region.
- Use `exact: true` for `Back`: the section's `Back` and the detail's
  `All runs` are different buttons, but other names may contain "Back".
- Mark done records a new attempt, so the Mark-done step has two timeline
  rows, not one updated row.
- The fake agent reports no cost and finishes in well under a second:
  rows read `0s` and `cost —`.
- The run record is refetched only when the run status, a step status or
  the attempt id/status set changes (`workflowRunRecordKey`), not per
  streamed summary update.
- The head snapshot is written just after the attempt ends, so a freshly
  ended attempt briefly reads `Loading changed files…` while the detail
  refetches the attempt record (up to about 8 s in total) before it shows
  the list or `No snapshot for this attempt`.
- The fake codex only runs its default mode and needs `--model` and a
  `read-only` sandbox, so the swap must name a model and the swapped step
  must be `read-only`; the `browser-swap` prompt uses the Claude-scoped
  marker `FAKE_AGENT_MODE_CLAUDE=` so the Codex attempt completes.
- Leaving `smoke.txt` in the worktree puts it in every later attempt's base
  snapshot; the attempt-diff scenario removes it in a `finally`.

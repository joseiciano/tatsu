# Run detail

Clicking a run card in the Workflows section's Runs tab opens that run's
detail in place of the run lists: the step graph with live statuses, the
actions the run allows right now, a timeline of every attempt and the
selected attempt's full result.

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
  named `<id>: <status label>` from the live slice.
- **Actions**: section `Actions · step <cursor step>`. Only what the run
  allows now: `Resume`, `Retry`, `Retry from clean` (only when the cursor
  step's latest attempt has a base snapshot; confirm dialog), `Mark done`
  (opens the inline Mark done form), `Skip`, `Cancel step` (confirm dialog,
  running attempt only), `Cancel run`, `Jump to tab` (when the selected
  attempt's tab is open). Step actions are named `<label>: <step id>`. No
  gate actions.
- **Attempt timeline**: list `Attempt timeline`, one `aria-pressed` button
  per attempt in definition step order then attempt number, named
  `<step> #<n>: <status>, completed by <who>, <duration>, cost <cost>`.
  The latest attempt is selected by default.
- **Attempt result**: region `Attempt result`: step and attempt, status,
  `Completed by`, exit code, the summary as plain text in a `pre`
  (`Attempt summary`), and one `pre` per output field (strings as is,
  everything else as JSON). Fetched with `getWorkflowAttemptResult` when an
  attempt is selected and again when it ends.

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
    summary` reads `Marked done from the browser smoke` -> `All runs` ->
    `Back` closes the section.

End state that proves it: `run-detail-01-detail-timeline.png` and
`run-detail-02-detail-summary.png` in `$EVIDENCE/workflow-flows/`, and the
`run-detail: timeline [...]` line in the journal.

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

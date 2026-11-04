# Workflow gates

A step with `gate: approve` stops for a human once it is done: the step is
`awaiting-gate` and the run pauses with reason `gate`. The user approves it
(the run moves on to the next step) or requests changes (the agent gets the
feedback and runs the step again as a new attempt, which stops at the gate
again). Both actions are offered in the sidebar's Needs you row and in run
detail.

## Sub-features

- **Needs you row**: `<worktree> · Waiting at gate · <step>`, buttons
  `Approve`, `Request changes` (agent steps only; a gated shell step cannot
  take feedback) and `Cancel run`, plus `Jump to tab` when the step tab is
  open. The gate buttons are named `Approve: <step>, <workflow> on
  <worktree>` and `Request changes: <step>, <workflow> on <worktree>`.
- **Run detail**: `Actions · step <step>` lists `Approve`, `Request
  changes` and `Cancel run` (named `Approve: <step>`, `Request changes:
  <step>`). No `Mark done` or `Swap harness/model`, because the latest
  attempt is `done`. The graph node of the paused step reads `<step>:
  waiting at gate, needs you` and has a warning ring.
- **Request changes dialog**: modal `dialog` `Request changes to “<step>”`
  opened from either place. It has a focus trap with focus starting in the
  textarea `Feedback` (max `GATE_FEEDBACK_MAX_CHARS` = 16384 chars) and an
  unchecked `Start a fresh session` checkbox. The submit button `Request
  changes` is disabled while the feedback is blank or the request is in
  flight (`Sending…`). Escape, `Cancel` and the backdrop close the dialog
  and return focus to the button that opened it, but do nothing while the
  request is in flight. It calls `workflows:requestChanges(runId, stepId,
  { feedback, fresh })` with the trimmed feedback; `fresh` is always sent
  (`false` when unchecked). A refusal (such as `This step is not waiting
  at its gate` when another client resolved the gate first) shows as an
  alert inside the dialog, which stays open. On success the dialog closes and the run leaves
  `paused`.
- **Approve**: `workflows:approveGate(runId, stepId)`. The step becomes
  `done` and the next step starts.
- **Cancelled at a gate**: `Cancel run` leaves the step `awaiting-gate`
  inside a cancelled run. The UI shows that step as `cancelled` (strip,
  graph) and never marks it `needs you`.

## How to get to it (user POV)

1. Turn on Labs workflows in Settings (seeded by `launch.sh`).
2. Run a definition with a gated step (`browser-gate`) from the worktree's
   `Run workflow here…`.
3. When the step is done, the NEEDS YOU row reads `Waiting at gate ·
   draft`. Open the run from the Workflows section to see the paused step
   in the graph, then use `Request changes` or `Approve`.

## Driving it with Playwright

- `journeys/workflow-flows.sh <state>` (runs `scripts/browser-smoke.mjs`):
  - `gate` (right after `swap-step`, before `repo-trust`): launch sheet ->
    `browser-gate` -> Start -> Needs-you row `Waiting at gate · draft`, and
    the run record is paused `gate` with one settled `draft` attempt ->
    sidebar `Workflows` -> `Active runs` -> `Open run: browser-gate on
    repo` -> region `browser-gate` -> graph listitem `draft: waiting at
    gate, needs you` -> button `Request changes: draft` -> dialog `Request
    changes to “draft”` (focus inside, `Request changes` disabled while
    blank) -> Escape closes it and focus is back on `Request changes:
    draft` -> open again, fill `Feedback`, submit -> the dialog closes ->
    the record is paused `gate` again with `draft` attempts `1:done,2:done`
    -> two timeline rows and the graph still reads `needs you` -> `All
    runs` -> `Back` -> sidebar Needs-you row -> `Approve: draft,
    browser-gate on repo` -> the run is `done` with `draft` done and one
    `publish` attempt done -> the row detaches. A `finally` cancels the run
    if it is still live and closes the `⚙ draft · Claude` tab, so the
    multi-turn fake agent exits before later scenarios.

End state that proves it: `gate-03-needs-you-gate.png`,
`gate-04-detail-gate.png`, `gate-05-request-changes-dialog.png`,
`gate-06-detail-attempt-2.png`, `gate-07-needs-you-approve.png` and
`gate-08-run-done.png` in `$EVIDENCE/workflow-flows/`, and these journal
lines: `gate: dialog submit disabled while blank; Escape closed it…`,
`gate: run <id> paused at the gate again after Request changes (1:done,
2:done)`, `gate: run <id> done after Approve from Needs you; publish ran
once` and `gate OK`.

## Gotchas

- The multi-turn fake stays alive after each turn and reads its next
  prompt from the tab, for up to 5 min. Leaving it running leaves a live
  PTY in the worktree, so always close its step tab when the scenario ends.
- Request changes continues in the same terminal, so the step tab stays the
  same (`⚙ draft · Claude`) while its attempt id moves to attempt 2.
- While the Workflows section is open, the page has two `NEEDS YOU`
  regions. Close the section, or scope locators to it, before you click a
  Needs-you button.
- The scenario waits on the run record (paused `gate`, latest `draft`
  attempt not `running`) before it counts attempts, so the attempt list it
  asserts on is settled.

# Workflow run

Labs workflows let a user run a personal definition on a worktree. Agent and
shell steps run in step tabs; the worktree row shows a step strip while the
run is live, and paused runs appear under NEEDS YOU in the sidebar.

## Sub-features

- **Launch sheet**: right-click a worktree row -> `Run workflow here…` ->
  dialog `Run workflow` with a `Workflow` select and `Start`. Shown only with
  Labs workflows on and no live (queued, running, paused) run on that path.
- **Step strip**: `role="img"` under the branch name, `aria-label`
  `Workflow steps: <id> <status>, …`. Only for a live run; it disappears when
  the run is done, failed or cancelled.
- **Needs you**: sidebar section `NEEDS YOU` with one row per paused run:
  workflow name, `<worktree> · <reason> · <stepId>`, and action buttons
  (`Jump to tab`, `Resume`, `Retry`, `Retry from clean`, `Skip`, `Cancel run`).
- **Step tab close**: closing a step tab whose attempt is running asks
  `Cancel step “<id>”?` (`alertdialog`); `Cancel step and close tab` cancels
  the step (run pauses step-failed, step cancelled), then closes the tab.
- **Step result overlay**: when a step tab's process exits, the tab shows
  `<Agent> exited.` with Step, Status, Completed by and Summary; for a paused
  run whose cursor is on that step, a `Mark step done` form completes it.

## How to get to it (user POV)

1. Turn on Labs workflows in Settings and accept hooks (seeded by `launch.sh`).
2. Put a definition in the personal workflows folder (seeded).
3. Right-click the worktree in the sidebar, choose `Run workflow here…`, pick
   the definition, press Start.
4. Watch the strip; open the step tab in the tab bar; act on NEEDS YOU rows.

## Driving it with Playwright

- `journeys/workflow-run.mjs <state> smoke`: launch sheet -> Start ->
  strip shows `plan running, echo pending` -> strip disappears -> run record
  `status: done`.
- `journeys/workflow-flows.sh <state>` (runs `scripts/browser-smoke.mjs`):
  - `hang-cancel`: start `browser-hang` -> strip `hang running` -> close tab
    `⚙ hang · Claude` -> `Cancel step and close tab` -> Needs-you row
    `repo · Cancelled by user · hang`, strip `hang paused` -> run record paused
    step-failed with a cancelled attempt -> `cancelRun` over WS -> row and strip
    gone.
  - `exit-mark-done`: start `browser-exit` -> Needs-you row
    `repo · Step failed · exit` -> `Jump to tab` -> overlay `Claude Code
    exited.` with Status `failed`, Completed by `process exit` -> Mark step done
    with a summary -> overlay shows Status `done`, Completed by
    `you (Mark done)` and the summary; form, row and strip gone -> run record
    `done`, last `exit` attempt completed by `user`.

End state that proves it: the screenshots in order, the strip `aria-label`
lines in `journal.log`, and the run record in `workflow-runs/`.

## Gotchas

- The menu item is hidden while the worktree has a live run; finish or cancel
  the previous run before starting another on the same path.
- The context menu is portalled and only opens when the row is visible:
  scroll the row into view, then wait for `role="menu"`.
- Right after boot the runner can answer start with "Tatsu is still starting"
  (seen by `scripts/workflow-smoke.mjs`, not yet in a browser drive); the
  launch sheet would show it as an error. Retry Start rather than sleeping.
- A done run has no strip; prove the done state from the strip and Needs-you
  row going away plus the run record.
- Mark done records a new attempt. The step tab's badge stays `failed` (it
  tracks the exited attempt); the overlay switches to the Mark done result.
- `exit-mark-done` needs curl: without it the Stop hook fails open and the
  step completes by fallback instead of failing.

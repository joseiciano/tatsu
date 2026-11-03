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
- Hang and exit-no-complete flows (cancel via close-tab confirm; Mark done on
  an exited step) are driven by `scripts/browser-smoke.mjs` once it exists:
  `node scripts/browser-smoke.mjs <token> <port> <worktree> <evidenceDir>`.

End state that proves it: the screenshots in order, the strip `aria-label`
lines in `journal.log`, and the run record in `workflow-runs/`.

## Gotchas

- The menu item is hidden while the worktree has a live run; finish or cancel
  the previous run before starting another on the same path.
- The context menu is portalled and only opens when the row is visible:
  scroll the row into view, then wait for `role="menu"`.
- Right after boot the runner answers start with "Tatsu is still starting";
  the launch sheet shows it as an error. Retry Start rather than sleeping.
- A done run has no strip; prove the done state from the run record or the
  step tab overlay, not from the strip.

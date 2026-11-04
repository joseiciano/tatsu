# Workflow loops

A step with `loop: {back_to, until, max}` sends the run back to `back_to`
while its `until` condition is unmet. Every step of the loop span (from
`back_to` up to the looping step) runs again, agent steps continuing their
session with the loop feedback. When the looping step has run `max` times
(all of its attempts count) and `until` is still unmet, the step stays
`done` and the run pauses with reason `loop-cap`. The user then chooses
`Loop again` or `Continue anyway`, from the sidebar's Needs you row or from
run detail.

## Sub-features

- **Needs you row**: `<worktree> · Loop limit reached · <looping step>`,
  buttons `Loop again`, `Continue anyway` and `Cancel run`, plus `Jump to
  tab` when the step tab is open. The loop buttons are named `Loop again:
  <step>, <workflow> on <worktree>` and `Continue anyway: <step>,
  <workflow> on <worktree>`.
- **Run detail**: `Actions · step <step>` lists `Loop again`, `Continue
  anyway` and `Cancel run` (named `Loop again: <step>`, `Continue anyway:
  <step>`). No `Mark done` or `Swap harness/model`. The graph node of the
  looping step reads `<step>: done, needs you`; the step strip marks it `!`.
- **Loop again**: `workflows:resolveLoopCap(runId, stepId, 'again')`. The
  span goes back to `pending` and runs one more pass. If `until` is still
  unmet after it, the run pauses `loop-cap` again (the cap applies again).
- **Continue anyway**: `workflows:resolveLoopCap(runId, stepId,
  'continue')`. The last result stands and the dependent steps start.
- **Refusal**: any other state (not paused at the cap, another step, a
  finished run, Labs off) answers a fixed error, such as `This step is not
  waiting at its loop cap`, shown as an alert under the row.

## How to get to it (user POV)

1. Turn on Labs workflows in Settings (seeded by `launch.sh`).
2. Run `browser-loop-cap` from the worktree's `Run workflow here…`.
3. After the single `review` pass the NEEDS YOU row reads `Loop limit
   reached · review`. Open the run from the Workflows section to see the
   paused step in the graph, then use `Loop again` or `Continue anyway`.

## Driving it with Playwright

- `journeys/workflow-flows.sh <state>` (runs `scripts/browser-smoke.mjs`):
  - `loop-cap` (right after `gate`, before `repo-trust`): launch sheet ->
    `browser-loop-cap` -> Start -> Needs-you row `Loop limit reached ·
    review` with `Loop again: review, browser-loop-cap on repo`, `Continue
    anyway: review, browser-loop-cap on repo` and `Cancel run:
    browser-loop-cap on repo`; the run record is paused `loop-cap` with no
    running `review` attempt -> sidebar `Workflows` -> `Active runs` ->
    `Open run: browser-loop-cap on repo` -> graph listitem `review: done,
    needs you` and buttons `Loop again: review`, `Continue anyway: review`
    -> `All runs` -> `Back` -> Needs-you `Continue anyway: review,
    browser-loop-cap on repo` -> the run is `done` with one `build`, one
    `review` and one done `publish` attempt -> the row detaches. A
    `finally` cancels a live run and closes the `⚙ review` tab.
  - The browser leg does not click `Loop again`; runner, reconcile and
    jsdom tests cover it.

End state that proves it: `loop-cap-03-needs-you-loop-cap.png`,
`loop-cap-04-detail-loop-cap.png` and `loop-cap-05-run-done.png` in
`$EVIDENCE/workflow-flows/`, and these journal lines: `loop-cap: run <id>
done after Continue anyway from Needs you; review ran once, publish ran
once` and `loop-cap OK`. `debug.log` has `loop cap reached` then `loop cap
continued` for the run.

## Gotchas

- `max: 1` means the first failing pass already hits the cap: there is no
  loop back before the pause.
- The pass count is every attempt of the looping step (retries and request
  changes included), so `Loop again` simply allows one more attempt.
- `review` runs the fake agent in its default mode (no `FAKE_AGENT_MODE`
  marker), so it exits after its turn; only the `FAKE_AGENT_DATA` marker
  sets the verdict.
- While the Workflows section is open the page has two `NEEDS YOU`
  regions. Close the section before you click a Needs-you button.
- `Continue anyway` on a gated looping step skips its gate: the user's
  click is the acceptance.

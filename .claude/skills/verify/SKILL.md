---
name: verify
description: Launch Tatsu's headless server in a scratch sandbox (fake HOME, fake-agent `claude`, `codex` and `opencode` shims), drive its web client in headless system Chrome with playwright-core, and capture screenshot and on-disk evidence that a workflow feature works the way a user sees it. Reach for it to prove a change to the Labs workflow UI (Run workflow here…, launch sheet, step strip, Needs you, step tabs, Workflows section) or the workflow runner it drives. Never runs a real agent, the user's login shell rc files, or touches the user's ~/.claude, ~/.codex or ~/.config/opencode.
---

# Verify Tatsu by driving the real app

Drive the headless server (`dist-headless/main/index.js`). It serves the same
React renderer as the desktop app over WebSocket, takes an ephemeral port and
a scratch data dir, so runs can coexist. Do not drive `pnpm dev`: Electron dev
mode uses the real HOME and the shared `Harness (Dev)` userData.

Helpers live in `.claude/skills/verify/scripts/` and run from the repo root.
They are macOS scripts (`ps eww`, `lsof`, `dscl`, `stat -f`).

## Isolation

`launch.sh` sources `scripts/smoke-sandbox.sh`, the same isolation
`scripts/smoke-headless.sh` uses. Step tabs
are terminal tabs, and the PTY manager wraps every tab in `$SHELL -ilc`, so
this matters:

- `HOME`, `ZDOTDIR`, `XDG_CONFIG_HOME` and `CODEX_HOME` point into
  `$TMPDIR/tatsu-verify/<run>/home`. `SHELL=/bin/bash`, so no zsh rc runs.
  `CLAUDE_CONFIG_DIR`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG` and
  `OPENCODE_CONFIG_CONTENT` are unset.
- `config.json` sets `claudeCommand`, `codexCommand` and `opencodeCommand` to
  shims that exec `scripts/fake-agent.mjs` (the `codex` shim adds
  `FAKE_AGENT_KIND=codex`, the `opencode` shim `FAKE_AGENT_KIND=opencode`), so
  no real `claude`, `codex` or `opencode` runs. Consent `accepted` makes the
  server install Tatsu's opencode plugin into the scratch
  `$XDG_CONFIG_HOME/opencode/plugins/harness-status.js`; the fake opencode
  imports that file with a fake client. `scripts/codex-trust-fixture.mjs` seeds the
  scratch `CODEX_HOME/config.toml` with `trusted_hash` entries for Tatsu's
  hooks and `trust_level` for the repo, as if `/hooks` had been run; it
  refuses a `CODEX_HOME` outside the scratch dir. The fake agent reads a
  `FAKE_AGENT_MODE=<mode>` marker from the step prompt (`hang`,
  `exit-no-complete`, `multi-turn`; no marker = complete the step);
  `FAKE_AGENT_MODE_<KIND>=<mode>` (`CLAUDE`, `CODEX`, `OPENCODE`) applies to
  that kind only and wins over the plain marker.
- Not isolated: `/tmp/harness-status` (status NDJSON) is shared with any
  running Tatsu.
- `home-guard.sh` fingerprints the real `~/.claude/settings.json`,
  `~/.codex/hooks.json` and the Pi/Opencode hook files before launch and
  checks them at cleanup. Other Claude sessions also write `settings.json`;
  read the diff before blaming the run.

## Launch

```bash
export VERIFY_EVIDENCE_ROOT=<session scratchpad>/verify-evidence   # optional
STATE=$(.claude/skills/verify/scripts/launch.sh --build my-run | tail -1)
```

- `--build` runs `pnpm build:headless` first. Pass it whenever `src/` changed
  since the last build; `doctor.sh` reports a stale build. Run `pnpm install`
  once on a fresh worktree.
- Seeds (from `smoke_sandbox`): a git repo `<scratch>/repo` on branch `main`
  (in `repoRoots`, so it is the sidebar's only worktree), hooks consent
  `accepted`, Labs workflows on, the smoke's personal definitions in
  `<data>/workflows/` and two untrusted repo definitions committed in
  `<scratch>/repo/.harness/workflows/`:

| Definition | Steps | Fake agent |
|---|---|---|
| `smoke` | `plan` (claude) then `echo` (shell) | default: calls `complete_step` |
| `smoke-codex` | `plan` (codex, `read-only`, `model: fake-codex-model`) then `echo` (shell) | codex mode: SessionStart + Stop through `$CODEX_HOME/harness-hook.sh`, calls `complete_step` |
| `smoke-opencode` | `plan` (opencode, `read-only`, `model: fake/opencode-model`) then `echo` (shell) | opencode mode: needs `--agent harness-step`, loads the installed plugin, root `session.idle` -> `promptAsync` to `harness-step`, calls `complete_step` through the bridge in `OPENCODE_CONFIG_CONTENT` |
| `smoke-diamond` | `plan` (claude, `read-only`) -> `left` and `right` (claude, `read-only`, both `needs: [plan]`) -> `join` (shell, `needs: [left, right]`, echoes both summaries) | default: calls `complete_step`; the branches run one at a time in definition order |
| `smoke-gate` | `plan` (claude, `read-only`, `gate: approve`) then `echo` (shell) | `FAKE_AGENT_MODE=multi-turn`: stays alive after each turn and reads the next prompt (Request changes feedback) from the tab; the run pauses `gate` after every `plan` done |
| `smoke-retry` | `check` (shell `test -f flag`) | none |
| `smoke-full` | `plan` (claude, `permissions: full`) | needs Allow full access |
| `browser-hang` | `hang` (claude) | `FAKE_AGENT_MODE=hang`: stays alive, never completes |
| `browser-exit` | `exit` (claude) | `FAKE_AGENT_MODE=exit-no-complete`: exits non-zero |
| `browser-diff` | `write` (shell `echo smoke > smoke.txt`) | none; the attempt-diff scenario deletes `smoke.txt` afterwards |
| `browser-file` | inputs `target` (file), `ticket` (issue); `check` (shell `test -f {{inputs.target}}`) | none; the input-pickers scenario picks the committed `docs/picker-target.md` |
| `browser-swap` | `swap` (claude, `read-only`) | `FAKE_AGENT_MODE_CLAUDE=exit-no-complete`: fails on Claude; after a swap to Codex (`fake-codex-model`) the codex mode ignores the Claude-scoped marker and completes |
| `smoke-repo` (repo) | `check` (shell `echo REPO-TRUSTED`) | none; needs trust before Start |
| `browser-repo` (repo) | `check` (shell `sleep 3`) | none; needs trust before Start (launch sheet label `browser-repo (repo)`) |

- Ready means the `[web-client] open http://127.0.0.1:<port>/?token=<hex>`
  line printed and `doctor.sh` passes. The last stdout line is the state file
  (`PID URL PORT SCRATCH SANDBOX_HOME DATA_DIR WORKTREE EVIDENCE LOG
  FAKE_AGENT_LOG`). Every other script takes it.
- On boot the worktree opens a default `Claude Code` tab; it runs the shim
  without a workflow, prints `FAIL: Stop hook did not return a block` and
  exits. That is expected and harmless.

## Doctor

```bash
.claude/skills/verify/scripts/doctor.sh "$STATE"
```

Read-only. Checks: PID alive; server env has the sandbox `HOME`, `ZDOTDIR`,
`XDG_CONFIG_HOME`, `CODEX_HOME`, `HARNESS_DATA_DIR` and `SHELL=/bin/bash`;
`CLAUDE_CONFIG_DIR` unset; `claudeCommand`, `codexCommand` and `opencodeCommand` are the shims; the port belongs to
the PID; the tokenized URL answers 200; `scripts/ws-smoke.mjs` round-trips a
snapshot; `dist-headless` is newer than `src/`; launch commit is HEAD. Any
`FAIL` line: do not drive; clean up and relaunch.

## Drive

```bash
node .claude/skills/verify/scripts/journeys/workflow-run.mjs "$STATE" [smoke|smoke-codex|smoke-opencode]
.claude/skills/verify/scripts/journeys/workflow-flows.sh "$STATE"
```

`workflow-flows.sh` runs `scripts/browser-smoke.mjs`, the smoke's browser leg,
against this instance, so the verify drive and CI share one flow file. It
passes the instance's `DATA_DIR` as `HARNESS_DATA_DIR` so the last scenario
(`launch-target`) can read its run record from disk; that scenario creates a
`wf/browser-hang/<hex>` worktree next to the scratch repo, cancels its run and
reselects the scratch repo. The `entry-points` scenario before it leaves a
`wf-entry-<base36>` worktree with only a Shell tab and no run. Both
flows leave the worktree free (cancelled / done runs), but `workflow-run.mjs`
and `workflow-flows.sh` each need the worktree without a live run when they
start.

Journeys sit on `scripts/browser.mjs`: `withApp(stateFile, name, fn)` runs
`fn({ page, state, shot, log })` in a fresh headless Chrome page
(`chromium.launch`, never a persistent context), logs console errors and page
errors, numbers screenshots, and on failure saves `<journey>-FAIL.png` and an
ARIA snapshot. Browser: `HARNESS_PLAYWRIGHT_BROWSER=<executable>` if set, else
`channel: 'chrome'` (system Chrome). `VERIFY_HEADED=1` shows the window.

Stable handles (no `data-testid` convention in this repo):

- Worktree row: `getByText('<parent>/repo', { exact: true })` (the row is a
  `div`; right-click its text), then `getByRole('menu')` and
  `getByRole('menuitem', { name: 'Run workflow here…' })`.
- Launch sheet: `getByRole('dialog', { name: 'Run workflow' })`,
  `getByLabel('Workflow')` select, `getByRole('button', { name: 'Start' })`.
- Step strip: `getByRole('img', { name: /^Workflow steps:/ })`; its
  `aria-label` reads `Workflow steps: plan running, echo pending`.
- Needs you: `getByRole('region', { name: /^NEEDS YOU/ })`, rows are
  `listitem`s reading `<worktree> · <reason> · <stepId>` (`Step failed`,
  `Cancelled by user`, …); action buttons are named
  `<Action>: <workflow> on <worktree>` (`Jump to tab: browser-exit on repo`).
- Step tab: label `⚙ <stepId> · Claude` (`⚙ <stepId> · Codex` for a codex
  step, `⚙ <stepId> · opencode` for an opencode step); close button
  `getByRole('button', { name: 'Close tab ⚙ hang · Claude' })`. Closing a
  running step opens `getByRole('alertdialog', { name: 'Cancel step “hang”?' })`
  with `Cancel step and close tab`.
- Step result overlay: `getByRole('region', { name: 'Claude Code exited.' })`
  with `Step`, `Status`, `Completed by`, `Summary` rows (`dt`/`dd`); Mark done
  form `getByRole('form', { name: 'Mark step done' })`, `Summary` textarea,
  `Mark done` button.

## Evidence

Goes to `$VERIFY_EVIDENCE_ROOT/<run>/` (default
`$TMPDIR/tatsu-verify-evidence/<run>/`), never into the repo. It survives
cleanup:

- `journal.log`: timestamped steps, strip labels, console errors, PASS/FAIL.
- `<journey>-NN-<step>.png`: a screenshot after each user action.
- `workflow-runs/<runId>.json`: run records copied by cleanup (the side
  effect: the journey also asserts the record's `status`).
- `server.log`, `debug.log`, `fake-agent.log`, `git-rev.txt`,
  `real-home-before.txt`, `real-home-check.txt`.

Proof standards: act through the UI the user clicks; never call `window.api`
from the page to set state. Assert UI state through ARIA labels, not colours.
Back each visible end state with the on-disk run record. If the seed lacks a
precondition, fail and record it in the feature's Gotchas; never weaken the
journey.

## Cleanup

```bash
.claude/skills/verify/scripts/cleanup.sh "$STATE"
```

Stops only this run's server (after checking its `HOME` is the sandbox),
SIGKILLs it after 5 s, then kills any process whose environment still carries
the sandbox `HOME` (step-tab shells, fake agents). It copies logs and run
records into evidence, runs the real-home guard, and deletes the scratch dir.
Run it after every failed attempt too. Non-zero exit = the guard saw changes.

## Helpers

| Helper | Invocation | Does |
|---|---|---|
| `scripts/launch.sh` | `launch.sh [--build] [run-id]` | Builds if asked, seeds the sandbox, starts the server, prints the state file |
| `scripts/doctor.sh` | `doctor.sh <state.env>` | Read-only readiness and isolation check; exit 1 on FAIL |
| `scripts/home-guard.sh` | `home-guard.sh snapshot > f` / `home-guard.sh check f` | Fingerprint of the real agent config files |
| `scripts/cleanup.sh` | `cleanup.sh <state.env>` | Stops the run's processes, saves evidence, deletes scratch |
| `scripts/browser.mjs` | `import { withApp, readState, launchOptions } from '../browser.mjs'` | Shared Playwright session |
| `scripts/journeys/workflow-run.mjs` | `node workflow-run.mjs <state.env> [defName]` | Launch sheet -> strip -> run record -> step tab per agent step; exit 0 on PASS |
| `scripts/journeys/workflow-flows.sh` | `workflow-flows.sh <state.env>` | Every browser-smoke scenario (cancel-via-close-tab, Mark done, Workflows section, run detail, diff, swap, repo trust, input pickers, launch overrides, library, definition editor, launch target); exit 0 on PASS |

## Not covered

The Electron shell (native menus, browser panes, updater), real agent CLIs,
and Linux (helpers are macOS-only; `scripts/smoke-headless.sh` covers Linux in
CI).

## Feature map

See `features/README.md`. When a proof drives one entry point and the map
lists others, the proof is incomplete.

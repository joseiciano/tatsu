# Verify the code diff tool

Drive a real, isolated Tatsu instance the way a user does and leave proof on disk. The stand-in for the desktop app is the **headless server + web client**: same renderer (`DesktopApp` at a 1600x1000 viewport), same request handlers in `src/main/index.ts`, reached over WebSocket instead of Electron IPC.

Every step takes one **run root**: a fresh directory owned by this run, for example `RUN=/tmp/tatsu-verify-$(date +%s)` or a directory in your scratchpad. All helpers live in `.claude/skills/verify/scripts/code-diff/`; the commands below run from the repo root.

## Launch

1. Build what you are about to prove. Run `pnpm install` once in a fresh worktree, then:
   ```bash
   pnpm build:headless
   ```
2. Create the fixture repo. It has a bare `origin`, a `main` worktree, and a `feature/diff-demo` worktree that differs from `main` in every classified way (added, modified, deleted, renamed, binary, untracked, uncommitted), plus a tag `v0.1.0`, an orphan branch `unrelated`, and one `origin/main` commit the local repo has not fetched.
   ```bash
   .claude/skills/verify/scripts/code-diff/fixture.sh "$RUN"
   ```
3. Start the server. It writes `$RUN/data/config.json` (fixture repo as the only project, hooks consent declined, quest done, agent command `true`), launches `dist-headless/main/index.js` on an ephemeral port bound to 127.0.0.1, and waits for the `[web-client] open http://127.0.0.1:<port>/?token=<hex>` line.
   ```bash
   .claude/skills/verify/scripts/code-diff/launch.sh "$RUN"
   ```
   Ready means it printed `ready <url>` and wrote `$RUN/url`. The drive harness adds the usable check: it waits for the `feature/diff-demo` worktree in the sidebar before any journey step.

## Doctor

Run first, and again whenever anything looks off. Read-only.

```bash
.claude/skills/verify/scripts/code-diff/doctor.sh "$RUN"
```

All lines must be `ok`: server PID alive, port in `$RUN/url` owned by that PID, web client answers 200 with the token, `dist-headless` newer than every file in `src/`, web client bundle contains the code diff tool (`ENABLE_CODE_DIFF` compiled in), fixture worktree present. A stale-build `FAIL` means rebuild, then `cleanup.sh` and relaunch from Launch step 2; the running server holds the old bundle.

## Drive

```bash
node .claude/skills/verify/scripts/code-diff/drive.mjs "$RUN" .claude/skills/verify/scripts/code-diff/journeys/<journey>.mjs [--headed]
```

`drive.mjs` opens the web client in system Chrome through `playwright-core` (`HARNESS_PLAYWRIGHT_BROWSER=/path/to/chromium` overrides), waits for the fixture, runs the journey's default export with `{ page, shot, log, fixture, evidence }`, and exits `0` on `PASS`, `1` on `FAIL` (with a `failure` screenshot). Shared handles live in `scripts/code-diff/journeys/lib.mjs`.

The [feature map](features/README.md#code-diff-features) is the verification source: one file per feature with its entry points, journey, and proof. Drive every entry point the map lists for the feature under change. To write a new journey, copy an existing one and keep to roles, accessible names, visible text, and `title` attributes.

Journeys mutate the fixture (`fetch` moves `origin/main`; `live-refresh` edits and restores files). Run order: `open-close`, `base-ref`, `file-navigation`, `fetch`, `live-refresh`. For a clean slate, run `cleanup.sh` and start again from Launch step 2.

## Evidence

Each journey writes to `$RUN/evidence/<journey>/`:

- `steps.log`: one line per user action with its observed result, tagged with the sub-feature ID from the map, ending in `PASS` or `FAIL`.
- `NN-<label>.png` and `NN-<label>.aria.txt`: screenshot and ARIA snapshot after each key action, so the action and its resulting state are both on disk.

Proof standards:

- Exercise the user path: click, type, press the hotkey. Calling backend methods or setting React state is not proof.
- Prove side effects outside the UI too: `fetch` reads `refs/remotes/origin/main` with `git`; `live-refresh` writes real files in the worktree.
- Report each entry point separately. One that could not be driven is reported with the attempted command and the unmet precondition, never as verified through a different path.
- Open the screenshots you cite. A `PASS` line proves only what the journey asserts.

## Cleanup

```bash
.claude/skills/verify/scripts/code-diff/cleanup.sh "$RUN"
```

It stops only the PID in `$RUN/server.pid` and that PID's direct children (the terminal-tab shells), then deletes `$RUN/data`, `$RUN/fixture`, and the run files. `$RUN/evidence` survives. Run it after every failed attempt as well. Other `dist-headless` servers on the machine (other worktrees, the user's own) belong to someone else; leave them running.

## Isolation

- Several runs can run side by side: each has its own data dir (`HARNESS_DATA_DIR`), ephemeral port, and fixture.
- Agent sessions get MCP config under `$RUN/data/mcp-configs/`; a checked run wrote nothing to `~/.claude` or `~/.claude.json`.
- Shared with the user's real Tatsu: `/tmp/harness-status/`. The server watches it and deletes only `<terminal-id>.ndjson` files for its own terminals. Cleanup never touches it.

## What this stand-in does not cover

These stay unverified until a run in the packaged or `pnpm dev` Electron app covers them:

- The Electron IPC transport path (`src/preload`, `src/main/transport-electron`).
- macOS window chrome: the summary bar's drag region and `no-drag` buttons.
- Native menu accelerators, if any are added for `toggleCodeDiff`.

---
name: verify
description: Launch Tatsu (the Electron agent-harness app) headless with a sandboxed HOME, drive its web client with Playwright, and capture evidence that a feature works the way a user sees it. Reach for it to prove a change to the renderer, the Config page (skills, agents, commands, templates, sync, import), Settings, or any main-process behavior visible in the UI. Never touches the user's real ~/.claude, ~/.codex, ~/.agents or ~/.config/opencode.
---

# Verify Tatsu by driving the real app

Tatsu has two shells around one React renderer: the Electron desktop app and
the headless server (`dist-headless/main/index.js`), which serves the same
renderer as a web client over WebSocket. **Drive the headless server.** It
takes an ephemeral port and an isolated data dir, so many runs can coexist,
and Playwright drives the web client with real ARIA handles.

Do not drive `pnpm dev`. Electron dev mode always uses the shared
`Harness (Dev)` userData folder and the real HOME, so a drive would edit the
user's own dev session and their real harness config.

All helpers live in `.claude/skills/verify/scripts/` and run from the repo
root. They are macOS scripts (`stat -f`, `dscl`, `ps eww`, `lsof`).

## Isolation: what the sandbox covers

- **`HOME` is the only thing that moves the harness roots.** The main process
  builds the harness-config service without `env` (`src/main/index.ts`), so
  every default root comes from `os.homedir()`, which reads `$HOME`.
  `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `OPENCODE_CONFIG_DIR` have no effect
  on this process. Do not rely on them.
- `HARNESS_DATA_DIR` holds `config.json`, auth tokens, and the template
  source folder (`<data>/harness-config-source` by default).
- **Not isolated:** `/tmp/harness-status` (status-hook NDJSON) is hardcoded
  and shared with any running Tatsu. Do not click **Install hooks** and do
  not open terminal tabs during a drive.
- `home-guard.sh` fingerprints the real harness roots before launch and
  checks them at cleanup. A changed fingerprint fails cleanup.

## Launch

```bash
STATE=$(.claude/skills/verify/scripts/launch.sh --build my-run | tail -1)
```

- `--build` runs `pnpm build:headless` first. Pass it whenever `src/` changed
  since the last build; `doctor.sh` tells you when the build is stale. On a
  fresh worktree run `pnpm install` once before that.
- The run id (`my-run`) is optional; the default is timestamp plus PID.
- `launch.sh` creates `$TMPDIR/tatsu-verify/<run>/{home,data}`, seeds all
  eight harness roots plus fixtures (`scripts/seed.sh`), starts the server on
  `127.0.0.1:<ephemeral>`, and waits up to 15 s for the
  `[web-client] open http://127.0.0.1:<port>/?token=<hex>` line.
- **Ready** means that line printed **and** `doctor.sh` passes. The web client
  then answers 200, and the Config page lists the seeded resources.
- The last stdout line is the state file. It holds `PID URL PORT SCRATCH
  SANDBOX_HOME DATA_DIR EVIDENCE LOG`. Every other script takes it.

Seed fixtures (`scripts/seed.sh`):

| Fixture | Path under sandbox HOME |
|---|---|
| Claude skill `hello` | `.claude/skills/hello/SKILL.md` |
| Claude skill `linked-skill` (symlink) | `.claude/skills/linked-skill` → `<scratch>/dotfiles/skills/linked-skill` |
| Claude command `run-tests` | `.claude/commands/run-tests.md` |
| Claude agent `reviewer` | `.claude/agents/reviewer.md` |
| Codex skill `hello` | `.agents/skills/hello/SKILL.md` |
| Opencode skill `release-notes` | `.config/opencode/skills/release-notes/SKILL.md` |
| Opencode command `run-tests` | `.config/opencode/commands/run-tests.md` |
| Import source for Step 22 | `<scratch>/import-source/{skills,commands}` |

## Doctor

```bash
.claude/skills/verify/scripts/doctor.sh "$STATE"
```

Read-only. Run it after launch, and again whenever anything looks off. It
checks these things:

- The PID is alive.
- The process environment has `HOME=<sandbox>` and `HARNESS_DATA_DIR=<sandbox>`.
- `lsof` shows the port owned by that PID.
- The tokenized URL returns 200.
- `dist-headless` is newer than `src/`, and the launch commit is still HEAD.
- All sandbox roots exist.

Any `FAIL` line means do not drive this instance. Clean it up and relaunch.

## Drive

Journeys are Node scripts on top of `scripts/browser.mjs`. It launches
system Chrome through the repo's `playwright-core`, auto-accepts
`window.confirm` dialogs and logs each one, records console errors, and
numbers screenshots.

```bash
node .claude/skills/verify/scripts/journeys/convert-skill-to-command.mjs "$STATE"
```

- `VERIFY_HEADED=1` shows the browser.
- `HARNESS_PLAYWRIGHT_BROWSER=/path/to/chrome` overrides the system Chrome.
- A journey prints `PASS` and exits 0, or prints `FAIL <reason>` and exits 1.

Writing a new journey:

```js
import { openConfig, withApp } from '../browser.mjs'
await withApp(process.argv[2], 'my-journey', async ({ page, state, shot, log }) => {
  await openConfig(page)                       // fresh data dir -> onboarding "Open Config…" button
  await page.getByRole('tab', { name: 'Skills' }).click()
  await shot('before')
  // act through the UI, then assert on disk under state.SANDBOX_HOME / state.DATA_DIR
})
```

Prefer these stable handles; `features/` lists them per feature:

- `getByRole('tab', { name })` on the `Resource type` tablist.
- `aria-label`s such as `Sync <Harness>`, `Create in <Harness>`,
  `Create command from <name>`, `Edit template <ref>`, and `Open Config`.
- Element ids such as `#config-create-name`, `#config-agent-filter`,
  `#config-folder-<rootKey>`, and `#import-folder-<key>`.

## Evidence

Everything goes to `.verify-evidence/<run>/` at the repo root. The folder is
gitignored and survives cleanup:

- `journal.log` holds timestamped steps, dialogs, console errors, and PASS or FAIL.
- `<journey>-NN-<step>.png` holds before and after screenshots of each action.
- Copies of every file a journey wrote, such as `release-notes.command.md`.
- `sandbox-home/` and `sandbox-home-tree.txt` hold the final sandbox harness roots, copied by cleanup.
- `real-home-before.txt` and `real-home-check.txt` hold the proof that real roots were untouched.
- `server.log` and `git-rev.txt` record the server output and the commit that was tested.

Proof standards:

- Act through the UI the user clicks. Never call `window.api` or transport
  requests from the page to set state.
- Capture the action and the resulting state: a screenshot before, one after,
  and the on-disk result. A screenshot alone proves nothing for a feature
  that writes files.
- Assert side effects on disk under `SANDBOX_HOME` or `DATA_DIR`. A file must
  be created, changed, or left alone exactly as the feature promises.
- Assert state through ARIA (`aria-selected`, `aria-busy`), not colors.
  Tab buttons use `transition-colors`, so a screenshot taken right after a
  click can show the old tab still highlighted.
- If the seed lacks a precondition a journey needs, fail and record why in
  that feature's Gotchas. Never weaken the journey.

## Cleanup

```bash
.claude/skills/verify/scripts/cleanup.sh "$STATE"
```

It stops only this run's PID, after re-checking that the process `HOME` is
the sandbox. It never kills by name. It copies the server log and the sandbox
harness roots into evidence, runs the real-home check, and deletes
`$TMPDIR/tatsu-verify/<run>`. Evidence stays. A non-zero exit means the
real-home check found changes; read `real-home-check.txt`.

Run cleanup after every failed attempt too, so no server or port is left behind.

## Not covered by this harness

- The Electron shell: native menus, `WebContentsView` browser panes, the
  auto-updater, and native folder pickers. **Choose…** buttons in Config
  folders and the import wizard open the native picker, which the web client
  cannot drive, so type absolute paths into the inputs instead. The picker
  itself stays unverified.
- Agent CLIs and terminal tabs, which need real `claude`/`codex` binaries and
  write to `/tmp/harness-status`.
- Linux. The helper scripts are macOS-only.

## Feature map

See `features/README.md`. When a proof drives one entry point and the map
lists others, the proof is incomplete.

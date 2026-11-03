# CLI worktrees

`tatsu worktrees` reads one state snapshot from the running backend and prints every worktree of the open repos, the same picture as the sidebar: branch, the most urgent agent status, PR number, state and checks, and the path. Worktrees still being created are listed with their pending status. `--repo <path>` narrows the list to the repo containing that path. `--json` prints the rows as one array on stdout.

`tatsu new <branch>` creates a worktree through `worktrees:runPending` (the GUI's FSM: git worktree add, setup script, default agent + shell panes with the prompt embedded), waits for the outcome, then reads a fresh snapshot for the agent tab type.

## Sub-features

- `list-json` `worktrees --json` prints `[{path, branch, repo, isMain, pr, agent, pending?}]`; `pr` is `{number, state, checks, url}` or `null`; `agent` is `needs-approval|waiting|processing|idle` or `null`; `pending` is present only on rows still being created or whose setup failed.
- `list-human` without `--json`, prints a `BRANCH  AGENT  PR  CHECKS  PATH` table (paths under `$HOME` shortened to `~`, the pending status shown in the AGENT column), a repo header above each group when more than one repo is shown, or `No worktrees.`
- `list-order` rows follow `worktrees.repoRoots` order, then the main worktree, then branch name; unmatched pending entries come last in their repo group.
- `list-repo` `--repo <path>` accepts a repo root, a worktree path, or any path under either, compared by realpath when it exists locally (so `/var/...` matches the `/private/var/...` in state).
- `list-repo-usage` a `--repo` path no open repo contains exits 2 with code `usage` and `details.repoRoots`.
- `new-json` `new <branch> [--prompt] [--agent claude|codex|opencode|pi] [--model] [--repo] --json` prints `{outcome:"success", path, branch, repo, tab:"agent"|"json-claude"|null}`, exit 0.
- `new-human` prints `Created <path> (<branch>)`; with a prompt, a second line: `Agent started with your prompt.` (json-claude) or `Agent tab ready with your prompt — it starts when the tab is opened in Tatsu.` (agent).
- `new-repo` repo is `--repo`, else the open repo containing cwd, else the only open repo; otherwise exit 2, `usage`, `details.repoRoots`.
- `new-errors` git failure (`outcome: error`) dismisses its pending entry (`worktrees:dismissPending`, best-effort), then exits 1 `command-failed` with git's message; `setup-failed` exits 1 with `details.path`; bad `--agent` or missing branch exits 2 before connecting; a request timeout (default 10 min for `new`, `--timeout` overrides) exits 3 and says creation continues on the server.

## How to get to it (user POV)

- From a shell in the repo: `pnpm tatsu worktrees [--repo <path>] [--json]` (runs `node dist-headless/cli/index.js`).
- It finds the backend the same way as `tatsu status` (see [cli-status.md](cli-status.md)).

## Driving it

Preconditions:

- `pnpm build:headless` ran after the last source change (it builds the CLI too).
- `STATE=$(.claude/skills/verify/scripts/launch.sh --build cliwt1 | tail -1)`, then `.claude/skills/verify/scripts/doctor.sh "$STATE"` prints only `ok` lines.
- Register `trap '.claude/skills/verify/scripts/cleanup.sh "$STATE"' EXIT` so cleanup runs after a failure too.
- `. "$STATE"; TOKEN="${URL##*token=}"; ROOT="$PWD"` and
  `CLI() { env -u TATSU_ENDPOINT_FILE -u TATSU_URL -u TATSU_TOKEN HARNESS_DATA_DIR="$DATA_DIR" HOME="$SANDBOX_HOME" node "$ROOT/dist-headless/cli/index.js" "$@"; }`
  (absolute path, so `CLI` still works from `cd /` or a fixture repo).

### Fixture repo (shared with the `new` recipe)

`control.mjs` drives any instance whose run dir holds an `instance.json` with `port` and `token`. Point it at the `launch.sh` server with a shim under `$SCRATCH`, so cleanup removes the shim and its token too:

```bash
mkdir -p "$SCRATCH/ctl"
node -e 'const [pid,port,token,url,data,log,out]=process.argv.slice(1);require("fs").writeFileSync(out,JSON.stringify({pid:+pid,port:+port,token,url,data,log}))' \
  "$PID" "$PORT" "$TOKEN" "$URL" "$DATA_DIR" "$LOG" "$SCRATCH/ctl/instance.json"
export TATSU_VERIFY_RUN="$SCRATCH/ctl"; C="$ROOT/.claude/skills/verify/scripts/control.mjs"

REPO="$SCRATCH/fixture-repo"
git init -q -b main "$REPO" && echo hello > "$REPO/README.md" \
  && git -C "$REPO" -c user.email=v@example.com -c user.name=verify add . \
  && git -C "$REPO" -c user.email=v@example.com -c user.name=verify commit -qm init
node $C req repo:addAtPath "$REPO"          # {"kind":"added","repoRoot":"/private/var/.../fixture-repo"}
node $C wait worktrees.list 'v.length > 0'
```

Never run `control.mjs stop` against the shim; teardown is `cleanup.sh`.

### Steps

- **Empty.** Before adding the repo: `CLI worktrees --json` prints `[]`, exit 0; `CLI worktrees` prints `No worktrees.`, exit 0.
- **List JSON.** After the fixture repo: `CLI worktrees --json` exits 0 and prints one row: `{"path":"/private/var/.../fixture-repo","branch":"main","repo":"/private/var/.../fixture-repo","isMain":true,"pr":null,"agent":null}`.
- **List human.** `CLI worktrees` exits 0 and prints the `BRANCH  AGENT  PR  CHECKS  PATH` header and `main    -      -   -       /private/var/.../fixture-repo`.
- **Repo filter by the unresolved spelling.** `CLI worktrees --repo "$REPO" --json` (`$REPO` is `/var/...`) exits 0 with the same row.
- **Unmatched repo.** `CLI worktrees --repo /nonexistent --json` exits 2; stderr is `{"error":{"code":"usage","message":"no open repo contains /nonexistent","details":{"repoRoots":[...]}}}`. Human form prints `tatsu: no open repo contains /nonexistent`, exit 2.
- **Extra argument.** `CLI worktrees extra` exits 2 with a usage message.
- **Teardown.** `cleanup.sh "$STATE"` (the trap does it).

### `new` steps

Safety first (never start a real agent): the drive must only create xterm `agent` tabs, and nothing may send `pty:create` (no web client attached; `launch.sh` attaches none).

- **Guard.** `node $C get settings.defaultClaudeTabType` must print `"xterm"`; if not, `node $C req config:setDefaultClaudeTabType xterm` and re-check, abort otherwise. Pass `--agent claude` on every `new` that reaches the server (the guard covers Claude only; codex/opencode have their own tab-type settings). Note `settings.worktreeSetupCommand` (sandbox default `null`).
- **Success.** `CLI new feat/cli-demo --prompt "hello" --agent claude --json` exits 0 with `tab: "agent"` and `path` = `<realpath $SCRATCH>/fixture-repo-worktrees/feat/cli-demo` (inside the sandbox). Abort if `tab` is not `agent`.
- **Listed.** `CLI worktrees --json` has a `feat/cli-demo` row. `node $C get terminals.panes` at that path holds `[agent:claude, shell]` tabs.
- **Git error.** The same `new feat/cli-demo --agent claude` again exits 1 `command-failed` with git's `fatal: '<path>' already exists`; afterwards `node $C get worktrees.pending` is `[]` and `CLI worktrees --json` has no `error` row.
- **Bad agent.** `CLI new x --agent nope` exits 2 (`--agent must be one of claude, codex, opencode, pi`).
- **Ambiguous repo.** Add `$SCRATCH/fixture-repo-2` the same way; `(cd / && CLI new x --agent claude --json)` exits 2, `usage`, `details.repoRoots` lists both.
- **cwd default.** `(cd "$REPO" && CLI new feat/cli-cwd --agent claude --json)` (no `--prompt`) exits 0 with `repo` = repo 1 and `tab: "agent"`.
- **Human.** `(cd "$REPO" && CLI new feat/cli-human --agent claude)` prints `Created <path> (feat/cli-human)`, exit 0.
- **No agent ran.** `node $C get terminals.statuses` is `{}`.

Last run (new): ticket wt-02 (tatsu-cli/wt-02-new-worktree), every `new` step passed. After the git-error step, `worktrees.pending` is `[]` and `worktrees --json` has no `error` row (rerun after the dismiss change, ticket wt-02).

Last run: ticket wt-01 (tatsu-cli/wt-01-worktrees-list), every step above passed. Agent status, PR and pending rows are covered by unit tests on fixture states only; the sandbox has no GitHub token and no agent tabs.

## Gotchas

- `new` dismisses a pending entry only on `outcome: error`. A `setup-failed` worktree exists on disk, so its entry stays, and `worktrees` shows it as `setup-failed` on the created path's row. Errors from `runPending` calls made outside the CLI (the GUI, MCP) still leave `error` entries until someone dismisses them.

- Run the binary with `node`, not `pnpm -s tatsu`: `pnpm -s` collapses every non-zero exit to 1.
- The human table shows full `/private/var/...` paths in the sandbox: `$SANDBOX_HOME` is spelled `/var/...` and the fixture repo is outside it, so nothing is shortened to `~`. That is expected; the renderer does no fs reads.
- The sandbox HOME has no git identity, so the fixture commit passes `-c user.email/-c user.name`.
- Redact the 64-hex token before saving a transcript (`sed -E 's/[a-f0-9]{64}/<redacted>/g'`).
- Inside a Tatsu terminal `TATSU_ENDPOINT_FILE` points at your real backend; `CLI` unsets it.

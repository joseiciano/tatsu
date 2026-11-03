# CLI worktrees

`tatsu worktrees` reads one state snapshot from the running backend and prints every worktree of the open repos, the same picture as the sidebar: branch, the most urgent agent status, PR number, state and checks, and the path. Worktrees still being created are listed with their pending status. `--repo <path>` narrows the list to the repo containing that path. `--json` prints the rows as one array on stdout.

## Sub-features

- `list-json` `worktrees --json` prints `[{path, branch, repo, isMain, pr, agent, pending?}]`; `pr` is `{number, state, checks, url}` or `null`; `agent` is `needs-approval|waiting|processing|idle` or `null`; `pending` is present only on rows still being created or whose setup failed.
- `list-human` without `--json`, prints a `BRANCH  AGENT  PR  CHECKS  PATH` table (paths under `$HOME` shortened to `~`, the pending status shown in the AGENT column), a repo header above each group when more than one repo is shown, or `No worktrees.`
- `list-order` rows follow `worktrees.repoRoots` order, then the main worktree, then branch name; unmatched pending entries come last in their repo group.
- `list-repo` `--repo <path>` accepts a repo root, a worktree path, or any path under either, compared by realpath when it exists locally (so `/var/...` matches the `/private/var/...` in state).
- `list-repo-usage` a `--repo` path no open repo contains exits 2 with code `usage` and `details.repoRoots`.

## How to get to it (user POV)

- From a shell in the repo: `pnpm tatsu worktrees [--repo <path>] [--json]` (runs `node dist-headless/cli/index.js`).
- It finds the backend the same way as `tatsu status` (see [cli-status.md](cli-status.md)).

## Driving it

Preconditions:

- `pnpm build:headless` ran after the last source change (it builds the CLI too).
- `STATE=$(.claude/skills/verify/scripts/launch.sh --build cliwt1 | tail -1)`, then `.claude/skills/verify/scripts/doctor.sh "$STATE"` prints only `ok` lines.
- Register `trap '.claude/skills/verify/scripts/cleanup.sh "$STATE"' EXIT` so cleanup runs after a failure too.
- `. "$STATE"; TOKEN="${URL##*token=}"` and
  `CLI() { env -u TATSU_ENDPOINT_FILE -u TATSU_URL -u TATSU_TOKEN HARNESS_DATA_DIR="$DATA_DIR" HOME="$SANDBOX_HOME" node dist-headless/cli/index.js "$@"; }`

### Fixture repo (shared with the `new` recipe)

`control.mjs` drives any instance whose run dir holds an `instance.json` with `port` and `token`. Point it at the `launch.sh` server with a shim under `$SCRATCH`, so cleanup removes the shim and its token too:

```bash
mkdir -p "$SCRATCH/ctl"
node -e 'const [pid,port,token,url,data,log,out]=process.argv.slice(1);require("fs").writeFileSync(out,JSON.stringify({pid:+pid,port:+port,token,url,data,log}))' \
  "$PID" "$PORT" "$TOKEN" "$URL" "$DATA_DIR" "$LOG" "$SCRATCH/ctl/instance.json"
export TATSU_VERIFY_RUN="$SCRATCH/ctl"; C=.claude/skills/verify/scripts/control.mjs

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

Last run: ticket wt-01 (tatsu-cli/wt-01-worktrees-list), every step above passed. Agent status, PR and pending rows are covered by unit tests on fixture states only; the sandbox has no GitHub token and no agent tabs.

## Gotchas

- Run the binary with `node`, not `pnpm -s tatsu`: `pnpm -s` collapses every non-zero exit to 1.
- The human table shows full `/private/var/...` paths in the sandbox: `$SANDBOX_HOME` is spelled `/var/...` and the fixture repo is outside it, so nothing is shortened to `~`. That is expected; the renderer does no fs reads.
- The sandbox HOME has no git identity, so the fixture commit passes `-c user.email/-c user.name`.
- Redact the 64-hex token before saving a transcript (`sed -E 's/[a-f0-9]{64}/<redacted>/g'`).
- Inside a Tatsu terminal `TATSU_ENDPOINT_FILE` points at your real backend; `CLI` unsets it.

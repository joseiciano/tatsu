# CLI status

`tatsu status` connects to a running backend over the WebSocket transport and prints the URL it reached, how it found the endpoint, and each open repo with its worktree count. `--json` prints the same as one object on stdout. Failures go to stderr (JSON with a stable `code` under `--json`) and exit with a code a script can branch on. The token never appears in output.

## Sub-features

- `status-flag` `--url` plus `--token` connects; `source` is `"flag"`.
- `status-env` `TATSU_URL` plus `TATSU_TOKEN` connects; `source` is `"env"`.
- `status-human` without `--json`, prints `Connected to <url> (via <source>)` and a `REPO  WORKTREES` table, or `No repos open.`
- `status-unauthorized` a wrong token exits 4 with code `unauthorized`.
- `status-unreachable` a closed port exits 3 with code `unreachable`.
- `status-usage` `--url` without `--token` exits 2 with code `usage`.
- `status-not-running` no flags, no env vars and no live endpoint file exits 3 with code `not-running`; the message says how to start `harness-server` or enable the desktop WS transport.
- `discovery-file` the server writes `<data dir>/cli-endpoint.json` (mode 600, `{version,url,token,pid,startedAt}`) when WS listens; `HARNESS_DATA_DIR=<dir> tatsu status --json` exits 0 with `source` set to that path.
- `discovery-pty` a terminal the server spawns has `TATSU_ENDPOINT_FILE` set to that file, so `tatsu status` inside it exits 0 with no flags, no `HARNESS_DATA_DIR` and any `HOME`.
- `discovery-stale` after `kill -9` of the server, `tatsu status` exits 3 and names the stale file (also in `details.staleFiles`).
- `discovery-sigterm` SIGTERM removes the file (only if its `pid` is the server's).

## How to get to it (user POV)

- From a shell in the repo: `pnpm tatsu status [--json]` (runs `node dist-headless/cli/index.js`).
- Against a headless server: the WS transport shares the web-client port, so the endpoint is `ws://127.0.0.1:<port>` and the token is the web-client URL's `?token=` value.

## Driving it

Preconditions:

- `pnpm build:headless` ran after the last source change (it builds the CLI too).
- `STATE=$(.claude/skills/verify/scripts/launch.sh --build cli03 | tail -1)`, then `.claude/skills/verify/scripts/doctor.sh "$STATE"` prints only `ok` lines.
- `. "$STATE"; TOKEN="${URL##*token=}"; CLI="env -u TATSU_ENDPOINT_FILE node dist-headless/cli/index.js"; unset TATSU_URL TATSU_TOKEN`.
- Register `trap '.claude/skills/verify/scripts/cleanup.sh "$STATE"' EXIT` so cleanup runs after a failure too.

- **Flag form.** `$CLI status --url ws://127.0.0.1:$PORT --token "$TOKEN" --json` prints `{"url":"ws://127.0.0.1:<port>","source":"flag","repos":[]}` and exits 0. A fresh sandbox has no repos.
- **Env form.** `TATSU_URL=ws://127.0.0.1:$PORT TATSU_TOKEN="$TOKEN" $CLI status --json` prints the same with `"source":"env"`, exit 0.
- **Human form.** Drop `--json`: `Connected to ws://127.0.0.1:<port> (via --url/--token)` then `No repos open.`
- **Wrong token.** `--token wrong --json` exits 4; stderr is `{"error":{"code":"unauthorized",...}}`.
- **Closed port.** Pick a free port (`node -e` listen on 0, read, close; confirm with `lsof -iTCP:<p> -sTCP:LISTEN`), then `--url ws://127.0.0.1:<p>` exits 3 with code `unreachable`.
- **URL without token.** `--url ws://127.0.0.1:$PORT --json` exits 2 with code `usage`.
- **Endpoint file.** `ls -l $DATA_DIR/cli-endpoint.json` shows `-rw-------`; `stat -f %Lp` prints `600`; its `pid` equals `$PID`.
- **Discovery by data dir.** `HARNESS_DATA_DIR=$DATA_DIR HOME=$SANDBOX_HOME $CLI status --json` exits 0 with `"source":"$DATA_DIR/cli-endpoint.json"`. Human output says `(via <that path>)`.
- **Discovery inside a PTY.** Send the `pty:create` signal over WS (frame `{t:'send',name:'pty:create',args:[id,cwd,'/bin/zsh',['-c',cmd],undefined,120,30]}`; a ten-line node script that loads `ws` with `createRequire('<repo>/package.json')`). Use a plain shell, not an agent. `cmd` writes `$TATSU_ENDPOINT_FILE` to a file, then runs `env -u HARNESS_DATA_DIR HOME=/nonexistent node <repo>/dist-headless/cli/index.js status --json > <scratch>/out; echo $? > <scratch>/code`. Expect the env var to equal the endpoint file, `out` to hold the status JSON, and `code` to be 0. Stripping `HARNESS_DATA_DIR` and `HOME` makes `TATSU_ENDPOINT_FILE` the only source that can hit.
- **Stale file.** `kill -9 $PID`, then the data-dir command exits 3 with code `not-running` and a message naming the file. Cleanup still removes the scratch dir.
- **SIGTERM removal.** Launch a second sandbox, `kill -TERM` its `PID`, wait for exit; the file is gone.
- **Teardown.** `.claude/skills/verify/scripts/cleanup.sh "$STATE"` (the trap does it).

Last run: ticket 03 (tatsu-cli/03-zero-config-discovery), every step above passed.

## Gotchas

- Run the binary with `node`, not `pnpm -s tatsu`: `pnpm -s` collapses every non-zero exit to 1, and plain `pnpm` prints a banner to stdout.
- The token is a 64-char hex string and the launch output and `server.log` both print it. Redact it before saving a transcript (`sed -E 's/[a-f0-9]{64}/<redacted>/g'`).
- Inside a Tatsu terminal your shell already has `TATSU_ENDPOINT_FILE` pointing at your real backend, and it outranks `HARNESS_DATA_DIR` and `HOME`. `$CLI` unsets it, and the preconditions unset any exported `TATSU_URL`/`TATSU_TOKEN`, so discovery steps hit the sandbox.
- Every host-side CLI run needs `HOME=$SANDBOX_HOME`; otherwise discovery falls through to your real `~/.harness` or `~/Library/Application Support/Harness` and may reach a real backend.
- `launch.sh`'s `PID` is the node server itself, so `kill -9 $PID` leaves a stale file and `kill -TERM $PID` runs the clean shutdown.
- To see a non-empty repo table, add a fixture repo with `control.mjs req repo:addAtPath` first; otherwise `repos` is `[]`.
- The CLI bundle requires `ws` at runtime from `node_modules`; it works from the repo checkout. The headless tarball must ship `ws` beside `lib/cli`.

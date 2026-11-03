# CLI status

`tatsu status` connects to a running backend over the WebSocket transport and prints the URL it reached, how it found the endpoint, and each open repo with its worktree count. `--json` prints the same as one object on stdout. Failures go to stderr (JSON with a stable `code` under `--json`) and exit with a code a script can branch on. The token never appears in output.

## Sub-features

- `status-flag` `--url` plus `--token` connects; `source` is `"flag"`.
- `status-env` `TATSU_URL` plus `TATSU_TOKEN` connects; `source` is `"env"`.
- `status-human` without `--json`, prints `Connected to <url> (via <source>)` and a `REPO  WORKTREES` table, or `No repos open.`
- `status-unauthorized` a wrong token exits 4 with code `unauthorized`.
- `status-unreachable` a closed port exits 3 with code `unreachable`.
- `status-usage` `--url` without `--token` exits 2 with code `usage`.
- `status-not-running` no flags and no env vars exits 3 with code `not-running` (endpoint files arrive in a later ticket).

## How to get to it (user POV)

- From a shell in the repo: `pnpm tatsu status [--json]` (runs `node dist-headless/cli/index.js`).
- Against a headless server: the WS transport shares the web-client port, so the endpoint is `ws://127.0.0.1:<port>` and the token is the web-client URL's `?token=` value.

## Driving it

Preconditions:

- `pnpm build:headless` ran after the last source change (it builds the CLI too).
- `STATE=$(.claude/skills/verify/scripts/launch.sh --build cli02 | tail -1)`, then `.claude/skills/verify/scripts/doctor.sh "$STATE"` prints only `ok` lines.
- `. "$STATE"; TOKEN="${URL##*token=}"; CLI="node dist-headless/cli/index.js"`.
- Register `trap '.claude/skills/verify/scripts/cleanup.sh "$STATE"' EXIT` so cleanup runs after a failure too.

- **Flag form.** `$CLI status --url ws://127.0.0.1:$PORT --token "$TOKEN" --json` prints `{"url":"ws://127.0.0.1:<port>","source":"flag","repos":[]}` and exits 0. A fresh sandbox has no repos.
- **Env form.** `TATSU_URL=ws://127.0.0.1:$PORT TATSU_TOKEN="$TOKEN" $CLI status --json` prints the same with `"source":"env"`, exit 0.
- **Human form.** Drop `--json`: `Connected to ws://127.0.0.1:<port> (via --url/--token)` then `No repos open.`
- **Wrong token.** `--token wrong --json` exits 4; stderr is `{"error":{"code":"unauthorized",...}}`.
- **Closed port.** Pick a free port (`node -e` listen on 0, read, close; confirm with `lsof -iTCP:<p> -sTCP:LISTEN`), then `--url ws://127.0.0.1:<p>` exits 3 with code `unreachable`.
- **URL without token.** `--url ws://127.0.0.1:$PORT --json` exits 2 with code `usage`.
- **Teardown.** `.claude/skills/verify/scripts/cleanup.sh "$STATE"` (the trap does it).

Last run: ticket 02 (tatsu-cli/02-status-explicit-endpoint), every step above passed.

## Gotchas

- Run the binary with `node`, not `pnpm -s tatsu`: `pnpm -s` collapses every non-zero exit to 1, and plain `pnpm` prints a banner to stdout.
- The token is a 64-char hex string and the launch output and `server.log` both print it. Redact it before saving a transcript (`sed -E 's/[a-f0-9]{64}/<redacted>/g'`).
- To see a non-empty repo table, add a fixture repo with `control.mjs req repo:addAtPath` first; otherwise `repos` is `[]`.
- The CLI bundle requires `ws` at runtime from `node_modules`; it works from the repo checkout. The headless tarball must ship `ws` beside `lib/cli`.

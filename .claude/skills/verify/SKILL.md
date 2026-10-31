---
name: verify
description: Drive a real Tatsu instance to prove the OpenCode and Codex chat-agent work (ACP runtimes, experimental chat-agents flag, login, session continuity, tool approvals, bundled runtime packaging and first-use download). Headless server over its WebSocket transport, plus the packaged-app smokes.
disable-model-invocation: true
---

# Verify Tatsu chat agents

Tatsu is an Electron app, but every chat-agent behavior lives in the main process and is reachable over the same WebSocket transport the web client uses. So the driver is the **headless server** (`dist-headless/main/index.js`) on an ephemeral port with its own data dir, and the harness is `scripts/control.mjs`. Packaging is the one layer the headless server cannot prove, so it has its own stage.

The feature map in [`features/README.md`](features/README.md) is the maintained list of journeys. Read it, pick the features the change touches, and run their recipes. A proof that skips a mapped entry point is incomplete.

Unless the user asks otherwise, run the full set: the static gate, then every mapped feature, then the packaging stage when the change touched `scripts/` or `package.json`.

## Static gate

```bash
bash .claude/skills/verify/scripts/gate.sh            # invariants, typecheck, build, unit tests
bash .claude/skills/verify/scripts/gate.sh --pack     # + unsigned arm64 app + bundled-runtime smoke (~5 min, 2 GB)
bash .claude/skills/verify/scripts/gate.sh --all      # + first-use download smoke (network, ~160 MB)
```

One PASS/FAIL line per stage, full logs in the temp dir it names. The invariants are the rules packaging and gating depend on (flag default off, every chat entry point gated, no runtime natives in `asarUnpack`, manifest regenerates from the lockfile, CI runs both smokes). Fix a FAIL in the code, not in the check, unless the check itself is wrong.

## Launch

```bash
pnpm build:headless                                   # once per code change; control.mjs refuses a missing bundle
RUN=$(node .claude/skills/verify/scripts/control.mjs start)
```

`start` launches the server with `HARNESS_DATA_DIR=$RUN/data` on `--port 0`, waits for the `[web-client] open http://127.0.0.1:<port>/?token=…` line, and records pid, port and token in `$RUN/instance.json`. Ready means the first `doctor` returns `problems: []`. Later commands find the newest run automatically; set `TATSU_VERIFY_RUN=$RUN` when two runs exist.

A fresh data dir has no repos. Give the run its own fixture repo so no user repo is touched:

```bash
REPO=$RUN/fixture-repo
git init -q -b main "$REPO" && echo hello > "$REPO/README.md" \
  && git -C "$REPO" -c user.email=v@example.com -c user.name=verify add . \
  && git -C "$REPO" -c user.email=v@example.com -c user.name=verify commit -qm init
node .claude/skills/verify/scripts/control.mjs req repo:addAtPath "$REPO"
node .claude/skills/verify/scripts/control.mjs wait worktrees.list 'v.length > 0'
WT=$(node .claude/skills/verify/scripts/control.mjs get worktrees.list | node -pe 'JSON.parse(require("fs").readFileSync(0))[0].path')
node .claude/skills/verify/scripts/control.mjs req panes:ensureInitialized "$WT"
```

`$WT` is the realpath (`/private/var/...` on macOS), which is the key every panes and session call uses.

## Doctor

```bash
node .claude/skills/verify/scripts/control.mjs doctor
```

Read-only. Reports pid liveness, that `dist-headless` was not rebuilt under the running instance, a WebSocket snapshot round-trip, the flag value, repo roots, runtime statuses and open chat sessions. Exit 1 with a `problems` list means stop and relaunch; do not drive it.

## Drive

Requests are the main process's `transport.onRequest` names; signals are `transport.onSignal` names. Arguments are JSON when they parse, strings otherwise.

```bash
C=.claude/skills/verify/scripts/control.mjs
node $C req config:setExperimentalChatAgentsEnabled true
node $C req panes:addTab "$WT" '{"id":"oc-1","type":"json-claude","label":"Chat","sessionId":"oc-1","agentKind":"opencode"}'
node $C req jsonClaude:start oc-1 "$WT"
node $C signal jsonClaude:send oc-1 "Reply with the single word pong."
node $C wait jsonClaude.sessions.oc-1 'v && !v.busy && v.state === "idle"' --timeout 60000
node $C req jsonClaude:getEntries oc-1 --save oc-1-entries
```

Two facts shape every recipe:

- **Snapshots omit chat entries.** `get jsonClaude.sessions.<id>` shows `entries: []` and `entriesHydrated: false` even after turns completed. Entries come from `req jsonClaude:getEntries <id>`, the same call the renderer makes.
- **Panes hydrate per worktree.** After a restart, `terminals.panes` is empty until `wait worktrees.list` succeeds and `panes:ensureInitialized $WT` runs. A `jsonClaude:start` before that fails with "No agent kind".

`wait <dot.path> <jsExpr>` polls the snapshot every 500 ms and evaluates the expression over `v`. Keep expressions to the fields the recipe names.

## Evidence

Artifacts live in `$RUN/artifacts/` and survive `stop`. Capture:

- the state that proves the action (`--save` on `req`/`get`, or `save <dot.path> <name>`), both before and after the action when the recipe is a transition;
- side effects outside the store: files the agent wrote in `$REPO`, `config.json` in the data dir for persistence claims, `server.log` lines (`control.mjs log 40`);
- for the packaging stage, the gate's log dir and the `release/mac-arm64/...app/Contents/Resources/runtimes` listing.

Drive the user path: `jsonClaude:send`, `jsonClaude:resolveApproval`, `panes:convertTabType`, never a reducer event or a test-only setter. A reply from the agent counts only when it comes from the agent's own session; this machine's credentials decide how far the agent gets, and a journey the credentials block is reported as a failure with that reason, not as passed.

## Cleanup

```bash
node .claude/skills/verify/scripts/control.mjs stop              # SIGTERM our pid, delete $RUN/data, keep artifacts
node .claude/skills/verify/scripts/control.mjs stop --keep-data  # for restart-based recipes
```

`stop` only signals the pid in `instance.json`. Other `dist-headless` processes on the machine belong to other runs; leave them. `$RUN/fixture-repo` stays with the artifacts because entries and approvals reference its paths. Delete the whole `$RUN` by hand when the evidence has been read.

## Report

```
Gate: PASS (typecheck, build, N tests) / FAIL <stage> <log>
<feature id>: pass / fail <one line> / not run <reason>   (one line per driven feature)
Packaging: PASS / FAIL / not run <reason>
Artifacts: $RUN/artifacts
```

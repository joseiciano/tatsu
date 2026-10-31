# Experimental chat-agents flag

OpenCode and Codex chat tabs are hidden behind `experimentalChatAgentsEnabled`, which is off for every user until they turn it on under Settings → Experimental → Chat agents. With the flag off, Claude chat keeps working and the two agents are terminal-only.

## Sub-features

- `flag-default-off` a fresh data dir starts with the flag off.
- `flag-blocks-start` a chat session for OpenCode or Codex is refused while the flag is off.
- `flag-enables` turning the flag on lets the same session start.
- `flag-persists` the flag survives a restart of the server.

## How to get to it (user POV)

- Settings → Experimental → "Chat agents" checkbox.
- The + tab menu and the tab-type switcher, which offer Chat for OpenCode and Codex only when the flag is on.
- The OpenCode and Codex "Interface" toggles in Settings, disabled until the flag is on.

## Driving it with control.mjs

Preconditions:

- Baseline state; no chat tab exists yet.

- **Default.** Read the flag on a fresh data dir. Run `node $C get settings.experimentalChatAgentsEnabled --save flag-default`. The value is `false`.
- **Refused start.** Add an OpenCode chat tab and start it with the flag off. Run `node $C req panes:addTab "$WT" '{"id":"flag-oc","type":"json-claude","label":"Chat","sessionId":"flag-oc","agentKind":"opencode"}'` then `node $C req jsonClaude:start flag-oc "$WT"`. The second command exits 1 with `Agent kind opencode has no chat runtime enabled`, and `node $C get jsonClaude.sessions.flag-oc` prints `null`.
- **Enable.** Turn the flag on and start again. Run `node $C req config:setExperimentalChatAgentsEnabled true` then `node $C req jsonClaude:start flag-oc "$WT"`. The start returns `true` and `node $C wait jsonClaude.sessions.flag-oc 'v && v.state === "idle"' --save flag-session` shows `agentKind: "opencode"` and `runtimeId: "opencode"`.
- **Persist.** Restart on the same data dir. Run `node $C stop --keep-data`, then `TATSU_VERIFY_RUN=$RUN-b node $C start --data $RUN/data`, then `TATSU_VERIFY_RUN=$RUN-b node $C doctor`. The doctor report shows `experimentalChatAgentsEnabled: true`.
- **Proof.** `flag-default.json`, `flag-session.json`, and the second doctor output saved as `flag-after-restart.json`.

## Gotchas

- `jsonClaude:start` throws instead of returning false when the flag is off; `control.mjs` prints the error and exits 1. That exit is the expected result, not a harness failure.
- The flag is persisted only when true; a `config.json` without the key means off, not missing.
- Claude chat tabs ignore the flag. A Claude tab that starts with the flag off proves nothing about the gate.

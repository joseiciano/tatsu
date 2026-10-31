# Session continuity

A chat tab remembers the agent's own session id, so quitting and relaunching Tatsu, or converting between a terminal tab and a chat tab, continues the same agent conversation instead of starting a new one. When the agent no longer knows the session, the chat says so once and starts fresh.

## Sub-features

- `continuity-persist` the tab's `agentSessionId` is written to the data dir after the first start.
- `continuity-resume` after a restart, starting the tab resumes with the same `agentSessionId` and no `session-load-failed` entry.
- `continuity-convert` converting a chat tab to a terminal and back keeps the agent session id across both new tab ids.
- `continuity-fallback` an unknown session id produces one `session-load-failed` system entry and a new agent session on the first prompt.

## How to get to it (user POV)

- Quit and relaunch Tatsu with a chat tab open, then type in that tab.
- The tab-type switcher: Chat → Terminal → Chat on the same tab.

## Driving it with control.mjs

Preconditions:

- An OpenCode chat tab `oc-1` has received one prompt (see [ACP chat session](./acp-chat-session.md), Open and Prompt steps) and `node $C get jsonClaude.sessions.oc-1.agentSessionId` is non-null.

- **Persist.** Read the tab from the pane tree and from disk. Run `node $C get terminals.panes --save panes-before-restart`; the tab with id `oc-1` carries the same `agentSessionId`. `grep -c "$(node $C get jsonClaude.sessions.oc-1.agentSessionId | tr -d '"')" $RUN/data/config.json` prints at least `1`.
- **Restart.** Stop keeping data and start a second instance on it. Run `node $C stop --keep-data`, `export TATSU_VERIFY_RUN=$RUN-b`, `node $C start --data $RUN/data`, `node $C wait worktrees.list 'v.length > 0'`, `node $C req panes:ensureInitialized "$WT"`. `node $C get terminals.panes --save panes-after-restart` shows tab `oc-1` with `mode: "asleep"` and the same `agentSessionId`.
- **Resume.** Start the tab again and send one prompt, which is what makes the agent `session/load`. Run `node $C req jsonClaude:start oc-1 "$WT"`, `node $C signal jsonClaude:send oc-1 "Reply with the single word pong."`, then `node $C wait jsonClaude.sessions.oc-1 'v && v.state === "idle" && !v.busy' --timeout 60000 --save oc-1-resumed`. `agentSessionId` equals the pre-restart value and `node $C req jsonClaude:getEntries oc-1 --save oc-1-resumed-entries` has no entry with `errorKind: "session-load-failed"`.
- **Convert.** Convert to a terminal and back. Run `node $C req panes:convertTabType "$WT" oc-1 agent`; the tab is replaced by an `agent` tab with a new id of the form `agent-<worktree>-<timestamp>` whose `sessionId` is the agent session id. Find that id in `node $C get terminals.panes` and run `node $C req panes:convertTabType "$WT" <new id> json-claude`, then `node $C get terminals.panes --save panes-after-convert`. The `json-claude` tab now has the agent session id as both its `id` and its `agentSessionId`.
- **Fallback.** Add a tab whose id the agent cannot know and prompt it. Run `node $C req panes:addTab "$WT" '{"id":"oc-stale","type":"json-claude","label":"Chat","sessionId":"oc-stale","agentKind":"opencode","agentSessionId":"ses_doesnotexist"}'`, `node $C req jsonClaude:start oc-stale "$WT"`, `node $C signal jsonClaude:send oc-stale "Reply with the single word pong."`, `node $C wait jsonClaude.sessions.oc-stale 'v && !v.busy && v.state === "idle" && v.agentSessionId !== "ses_doesnotexist"' --timeout 60000 --save oc-stale-session`. `node $C req jsonClaude:getEntries oc-stale --save oc-stale-entries` starts with one `system` entry with `errorKind: "session-load-failed"`, then the user entry, then the agent's reply or auth-failure, and the saved session's `agentSessionId` is a new `ses_` id.
- **Proof.** The five saved artifacts plus the `grep` count.

## Gotchas

- After a restart `terminals.panes` is empty until `wait worktrees.list` succeeds and `panes:ensureInitialized` runs; a `jsonClaude:start` before that fails with `No agent kind`, which is the harness being early, not a continuity bug.
- Replay of earlier turns depends on the agent having stored them. Turns the agent rejected for auth may replay as nothing; the proof is the preserved id and the absence of `session-load-failed`, not a replayed transcript.
- Every `convertTabType` gives the tab a new id. Locate it by `sessionId` (agent tab) or `agentSessionId` (chat tab), never by the id you added it with.
- A `jsonClaude:start` alone never contacts the agent; `session/load` and the fallback both happen on the first `jsonClaude:send` after start.

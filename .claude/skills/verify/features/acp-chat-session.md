# ACP chat session and login

With the flag on, a user opens a Chat tab for OpenCode or Codex, sends a prompt, and either gets the agent's reply or an auth-failure card that offers the agent's own login methods. OpenCode logs in from a terminal tab that Tatsu opens; Codex logs in from the card (API key or ChatGPT).

## Sub-features

- `chat-open` a chat tab registers the session; the agent process starts on the first prompt and reports its session id and slash commands.
- `chat-prompt` a prompt produces a user entry followed by the agent's reply.
- `chat-auth-failure` an unauthenticated agent produces an `auth-failure` error entry with `authMethods`.
- `chat-login-terminal` "Open terminal" for OpenCode adds a shell tab running `opencode auth login`.
- `chat-login-card` Codex API-key login stores the key and retries the parked prompt.

## How to get to it (user POV)

- + tab menu → Chat → OpenCode or Codex, in any worktree.
- Tab-type switcher on an existing OpenCode or Codex terminal tab → Chat.
- The auth-failure card's buttons inside the chat.

## Driving it with control.mjs

Preconditions:

- Baseline state and `req config:setExperimentalChatAgentsEnabled true`.
- Decide which agent is authenticated on this machine (`~/.local/share/opencode/auth.json`, `~/.codex/auth.json`); the reply shape depends on it.

- **Open.** Add and start an OpenCode chat tab. Run `node $C req panes:addTab "$WT" '{"id":"oc-1","type":"json-claude","label":"Chat","sessionId":"oc-1","agentKind":"opencode"}'` then `node $C req jsonClaude:start oc-1 "$WT"`. The start returns `true` and `node $C get jsonClaude.sessions.oc-1` shows `agentKind: "opencode"`, `state: "idle"`, `capabilities.canOpenAuthLogin: true`, and no `agentSessionId` yet.
- **Prompt.** Send one prompt and wait for the turn. Run `node $C signal jsonClaude:send oc-1 "Reply with the single word pong."` then `node $C wait jsonClaude.sessions.oc-1 'v.agentSessionId && !v.busy && v.state === "idle"' --timeout 60000 --save oc-1-open`. The saved session has an `agentSessionId` starting with `ses_` and a non-empty `slashCommands`. `node $C req jsonClaude:getEntries oc-1 --save oc-1-entries` lists the user entry followed by either an `assistant` entry whose text contains `pong`, or an `error` entry with `errorKind: "auth-failure"` and `authMethods: [{id: "opencode-login", type: "terminal"}]`.
- **Login terminal.** From the auth-failure state, open the login terminal. Run `node $C req jsonClaude:openAuthLoginTab "$WT" oc-1 --save oc-1-login-tab`. The result is `{ok: true, tabId: "shell-…"}` and `node $C get terminals.panes --save panes-after-login` contains a `shell` tab labeled `OpenCode login` whose `command` ends in `auth login`.
- **Codex.** Repeat Open and Prompt with `"agentKind":"codex"` and id `cx-1`. The session id is a UUID. With a working Codex login the reply is an `assistant` entry containing `pong`; with an API-key auth method offered, `node $C req jsonClaude:authenticate cx-1 <methodId> <apiKey>` must return `{ok: true}` and the parked prompt then completes.
- **Proof.** `oc-1-open.json`, `oc-1-entries.json`, `oc-1-login-tab.json`, `panes-after-login.json`, and the Codex equivalents.

## Gotchas

- `jsonClaude:openAuthLoginTab` takes `(worktreePath, sessionId)`, in that order. Passing only the session id returns `missing worktree or session`.
- Codex on a machine whose `~/.codex/config.toml` points at a custom provider returns the provider's error as a normal `assistant` entry (seen: `Missing environment variable: CODEX_LB_API_KEY`). That is a Codex configuration failure, not an auth-failure card; report `chat-prompt` for Codex as not run with that reason.
- Agent credentials come from the real home directory, not the run's data dir. Two runs share them.
- The user entry appears even when the prompt fails. Only the following `assistant` or `error` entry proves the turn.
- `jsonClaude:start` only registers the session. Nothing is spawned, and `agentSessionId` stays empty, until the first `jsonClaude:send`.

# Harness vs Superset: CLI-Agent Integration Design

Both Harness and Superset orchestrate CLI coding agents across isolated git worktrees, but they differ materially in how they integrate with those agents, spawn terminals, and transport status back to the UI.

## Comparison

| Concern | Harness | Superset | Same / Different |
|---|---|---|---|
| Top-level agent abstraction | `AgentModule` in `src/main/agents/index.ts` — defines hook install/uninstall, spawn args, and session behavior per agent | Agent setup spread across `apps/desktop/src/main/lib/agent-setup/*` with per-agent modules | Different — Harness centralizes; Superset distributes |
| Supported first-class agents | Claude, Codex, OpenCode | Claude, Codex, OpenCode, Cursor, Gemini, Copilot, Amp, Droid, Mastra, Pi, plus generic terminal agents | Different — Superset supports more agents out of the box |
| Default execution model | PTY spawning via `src/main/pty-manager.ts` | PTY host/daemon architecture under `packages/pty-daemon` and `apps/desktop/src/main/terminal-host/*` | Different — Superset uses a daemon model |
| Claude integration | Terminal tabs use PATH `claude`; JSON/chat mode uses a bundled pinned Claude binary via `src/main/json-claude-manager.ts` | Appears terminal-first; no verified equivalent to Harness's dedicated JSON Claude chat manager | Different — Harness has a dedicated non-terminal chat path |
| Bundled agent runtime | Bundled `@anthropic-ai/claude-code` native binary for JSON/chat mode | Bundled Superset CLI shim in `apps/desktop/src/main/lib/bundled-cli.ts` | Different |
| Terminal spawning | Direct PTY spawn with env injection (`CLAUDE_HARNESS_ID`, `HARNESS_TERMINAL_ID`) | PTY daemon + terminal host abstraction | Different — Superset's daemon adds a layer |
| Shell wrapping | Login shell (`/bin/zsh -ilc <command>`) for full PATH loading | Shell integration and PATH prepend in `apps/desktop/src/main/lib/agent-setup/shell-wrappers.ts` | Different — Superset uses managed wrappers; Harness uses login shell |
| PATH handling | Boot-time PATH capture/merge in `src/main/path-fix.ts` | PATH-first with managed wrapper binaries/scripts in a Superset-owned `BIN_DIR` | Different — Superset prepends a managed bin directory |
| Hook install location: Claude | `~/.claude/settings.json` (`src/main/agents/claude.ts`) | Installs agent-specific hooks/plugins for Claude | Same concept, different implementation details |
| Hook install location: Codex | `~/.codex/hooks.json` + enables hooks in `~/.codex/config.toml` (`src/main/agents/codex.ts`) | Installs agent-specific hooks/plugins for Codex | Same concept, different implementation details |
| Hook install location: OpenCode | `~/.config/opencode/plugins/harness-status.js` (`src/main/agents/opencode.ts`) | Installs agent-specific hooks/plugins for OpenCode | Same concept, different implementation details |
| Hook output transport | Hooks emit NDJSON to `/tmp/harness-status/<terminalId>.ndjson`; main process tails NDJSON (`src/main/hooks.ts`) | Uses a local notify/backchannel approach rather than NDJSON tailing | Different — transport mechanism differs |
| Status derivation | Main process tails NDJSON and derives `processing / waiting / needs-approval` | Derives status via local backchannel/notify | Same goal, different mechanism |
| Session ID ownership | Harness sets `CLAUDE_HARNESS_ID` / `HARNESS_TERMINAL_ID` env vars per terminal | Not verified in available sources | Likely different |
| Resume/session discovery | Not explicitly described in available sources | Not explicitly described in available sources | Unknown |
| Structured non-terminal chat mode | Yes — JSON Claude chat manager (`src/main/json-claude-manager.ts`) | No verified equivalent | Different |
| Renderer/state transport | Main-process store mirrored to renderer via IPC state events | Not verified in available sources | Likely different |
| Raw terminal output path | Raw terminal bytes go through a side-effect `terminal:data` signal, not reducer state | Not verified in available sources | Likely different |
| Agent philosophy | Thin integration: hooks write status files, main tails them, renderer mirrors state | Managed wrappers + daemon: Superset owns more of the agent lifecycle | Different — Superset is more prescriptive; Harness is more transparent |

## Practical summary

### Where they match
- Both install per-agent hooks/plugins for Claude, Codex, and OpenCode.
- Both spawn PTY-based terminals to run agents in isolated git worktrees.
- Both derive agent status (`processing`, `waiting`, etc.) from hook output.
- Both aim to give the user a unified view of many parallel agent sessions.

### Where they differ most
- **Agent breadth**: Superset supports 10+ first-class agents plus generic terminals; Harness focuses on Claude, Codex, and OpenCode.
- **Execution architecture**: Superset uses a PTY daemon + terminal host; Harness spawns PTYs directly.
- **PATH strategy**: Superset prepends a managed `BIN_DIR` with wrapper scripts; Harness captures and merges the user's login-shell PATH at boot.
- **Chat mode**: Harness has a dedicated JSON/chat mode with a bundled Claude binary; Superset appears terminal-first with no verified equivalent.
- **Hook transport**: Harness uses NDJSON file tailing (`/tmp/harness-status/*.ndjson`); Superset uses a local notify/backchannel.
- **Integration style**: Harness is thin and transparent (hooks write files, main tails them); Superset is more managed (daemon, wrappers, bundled CLI shim).

## Closest file-to-file analogs

| Harness file | Rough Superset analog |
|---|---|
| `src/main/agents/index.ts` | `apps/desktop/src/main/lib/agent-setup/*` |
| `src/main/pty-manager.ts` | `packages/pty-daemon/*` + `apps/desktop/src/main/terminal-host/*` |
| `src/main/agents/claude.ts` | `apps/desktop/src/main/lib/agent-setup/*` (Claude-specific setup) |
| `src/main/agents/codex.ts` | `apps/desktop/src/main/lib/agent-setup/*` (Codex-specific setup) |
| `src/main/agents/opencode.ts` | `apps/desktop/src/main/lib/agent-setup/*` (OpenCode-specific setup) |
| `src/main/hooks.ts` | Superset backchannel/notify implementation (not file-mapped) |
| `src/main/json-claude-manager.ts` | No verified equivalent |
| `src/main/path-fix.ts` | `apps/desktop/src/main/lib/agent-setup/shell-wrappers.ts` |
| `src/main/store.ts` + IPC transport | Not verified in available sources |

---
goal: Give Codex and opencode terminal tabs the per-terminal harness-control MCP server (Codex through -c mcp_servers overrides behind a Phase 0 gate, opencode through OPENCODE_CONFIG_CONTENT) and fix the stale Codex MCP comment
date_created: 2026-10-02
status: 'Planned' # 'Completed' only per TASK-001's rule: if Phase 0 (d) can't run, stays 'In progress'; a failed gate hands Codex to ticket 09
tags: [feature, mcp, codex, opencode, agents, milestone-1, dynamic-workflows]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Milestone 1, Item 5 (closes gap 2 in `plans/dynamic-workflows/dynamic-workflows.md` "Gaps found"). Size M. Goal table dependency: Items 1 and 4. **Ticket 04 must be merged first** (`src/main/agent-spawn/` is where REQ-004 lands, see DEP-002). Only the Phase 0 spikes (TASK-001, TASK-002) may run in parallel with ticket 04; they change no code.

The workflow runner's step contract is the `complete_step` MCP tool (plan, "Step output contract"). A step can only finish through it if the agent can reach `harness-control`. Today only Claude can:

| Location | Today | Problem |
|---|---|---|
| `src/main/agents/claude.ts:172` | `--mcp-config <file>` from `opts.mcpConfigPath` | Works. The file comes from `writeMcpConfigForTerminal` (`src/main/mcp-config/mcp-config.ts:36-74`), called by the `agent:buildSpawnArgs` handler (`src/main/index.ts:2223-2226`). |
| `src/main/agents/codex.ts:236-239` | Comment: "Codex MCP is configured globally via ~/.codex/config.toml ... registered by the prepareMcpForTerminal IPC call." `opts.mcpConfigPath` is ignored. | Nothing in `src/main` writes `mcp_servers` into `~/.codex/config.toml`, and `mcp:prepareForTerminal` (`index.ts:1724-1728`) only writes the Claude-format JSON file. Codex tabs have no `harness-control`. |
| `src/main/agents/opencode.ts:150-173` | `buildSpawnArgs` ignores `opts.mcpConfigPath`. | opencode tabs have no `harness-control`. |
| `src/main/mcp-config/mcp-config.ts:46-66` | The per-terminal JSON carries `HARNESS_TOKEN` in an `env` block. Written with the default mode (`0644`). | Any wiring that puts this env on a command line (Codex `-c ...env=...`) exposes the token in `ps` and in the `pty` debug log line (`src/main/pty-manager/pty-manager.ts:131` logs `args`). |
| `resources/mcp-bridge.js:9-26` | Reads `HARNESS_PORT`, `HARNESS_TOKEN`, `HARNESS_TERMINAL_ID`, scope vars only from `process.env`. | Codex launches MCP servers with a filtered environment (only its default whitelist plus the server's `env` table), so the PTY's `HARNESS_TERMINAL_ID` does not reach the bridge. |

This ticket:

1. Teaches the bridge to load its env from the per-terminal JSON file (`--config <path>`), so no harness that launches it has to carry the token on a command line or rely on env inheritance. The file is written `0600`.
2. Adds a structured `mcpServer` spec (`command`, `args`, `env`) next to `mcpConfigPath` in `AgentSpawnOpts`, built once per spawn in `src/main/agent-spawn/`.
3. Codex: `buildSpawnArgs` emits `-c mcp_servers.harness-control.{command,args,env}` overrides. A Phase 0 gate verifies this against a real Codex binary. If the gate fails, Codex MCP is left to ticket 09 (`09-codex-home-fallback.md`).
4. opencode: a new optional `AgentModule.spawnEnv(opts, baseEnv)` returns `OPENCODE_CONFIG_CONTENT`, produced by one composed builder `buildOpencodeConfig(opts, base)` that Item 6 extends with the `harness-step` agent. `agent-spawn`'s `agentEnv` merges it.
5. Replaces the stale `codex.ts` comment.
6. Records gap 2 as closed in the plan in a separate commit.

This ticket completes Item 5. `complete_step` itself and the runner are Phase 2 and out of scope.

### Where each agent's MCP wiring lives (after ticket 04)

| Agent | Mechanism | Built in | Reaches the PTY through |
|---|---|---|---|
| Claude | `--mcp-config <mcpConfigPath>` | `claude.ts` `buildSpawnArgs` (unchanged) | command line (`buildAgentLaunch(...).command`) |
| Codex | `-c mcp_servers.harness-control.command=...`, `.args=[bridge,"--config",<mcpConfigPath>]`, `.env={ELECTRON_RUN_AS_NODE="1"}` | `codex.ts` `buildSpawnArgs` from `opts.mcpServer` | command line |
| opencode | `OPENCODE_CONFIG_CONTENT={...,"mcp":{"harness-control":{...}}}` | `opencode.ts` `spawnEnv` → `buildOpencodeConfig` | env (`agentEnv`) |

`src/main/agent-spawn/agent-spawn.ts` is the only caller of `buildSpawnArgs` and `spawnEnv` for new renderers and main callers. It computes `AgentSpawnOpts` once (`buildAgentSpawnOpts`) so `writeMcpConfig` runs once per spawn, and feeds the same opts to both.

## 1. Requirements & Constraints

- **REQ-001**: Bridge config file loading (`resources/mcp-bridge.js`). Before the `const PORT = ...` line (`:9`), add:
  ```js
  const CONFIG_FLAG = process.argv.indexOf('--config')
  if (CONFIG_FLAG !== -1) {
    const file = process.argv[CONFIG_FLAG + 1]
    try {
      const parsed = JSON.parse(require('fs').readFileSync(file, 'utf-8'))
      const env = parsed && parsed.mcpServers && parsed.mcpServers['harness-control'] && parsed.mcpServers['harness-control'].env
      if (!env || typeof env !== 'object') throw new Error('no mcpServers.harness-control.env')
      for (const [k, v] of Object.entries(env)) if (typeof v === 'string') process.env[k] = v
    } catch (e) {
      process.stderr.write('harness-mcp: cannot read --config ' + file + ': ' + (e && e.message ? e.message : e) + '\n')
      process.exit(1)
    }
  }
  ```
  Values from the file overwrite inherited env (the file is written per terminal and is authoritative). Without `--config`, behaviour is unchanged, so Claude's existing launch (`mcpServers.harness-control.env` passed by Claude) keeps working. The bridge stays dependency-free CommonJS (ticket 02 CON-002). Update the header comment at `:4` to `// Spawned by an agent CLI via \`ELECTRON_RUN_AS_NODE=1 <electron-binary> <this> [--config <per-terminal json>]\`.`
- **REQ-002**: `src/main/mcp-config/mcp-config.ts`:
  - `writeMcpConfigForTerminal` writes with `{ mode: 0o600 }` and, because `writeFileSync`'s mode only applies on create, then runs `try { chmodSync(configPath, 0o600) } catch (err) { log('mcp', 'failed to chmod config', ...); return null }` (same guard shape as `src/main/secrets/secrets.ts:179`, but failing closed: a file that may still be `0644` is not handed to an agent). Move the `getConfigDir()` / `configPath` computation inside the existing `try` so a `mkdirSync` error also logs and returns `null`. `writeMcpConfigForTerminal` must never throw out of the spawn path. File content is unchanged.
  - `getConfigDir` today calls `mkdirSync(dir, { recursive: true })` with no mode, so `<userData>/mcp-configs/` is created `0777 & ~umask` (normally `0755`), not `0700`. (Headless `userDataDir()` itself is `0700` via `ensureDir`, `paths.ts:41-46`; Electron's `userData` is whatever Electron creates.) Pass `mode: 0o700` to that `mkdirSync`. It only applies to newly created dirs; existing dirs are not chmodded. The `0600` file mode is the actual protection.
  - New pure export:
    ```ts
    export interface HarnessMcpServerSpec {
      command: string
      args: string[]
      env: Record<string, string>
    }
    export function harnessMcpServerSpec(
      configPath: string,
      execPath: string = process.execPath,
      bridgePath: string = getBridgeScriptPath()
    ): HarnessMcpServerSpec
    ```
    Returns `{ command: execPath, args: [bridgePath, '--config', configPath], env: { ELECTRON_RUN_AS_NODE: '1' } }`. The env holds no secret. `index.ts` barrel exports both. `agent-spawn` must not import this function (see REQ-004); only `src/main/index.ts` does. `HarnessMcpServerSpec` is re-exported from `src/main/agents/index.ts` as a type so agent modules don't import `mcp-config` (it pulls in `control-server`, see the note at `src/main/paths/paths.ts:84-89`): define the interface in `src/main/agents/index.ts` and have `mcp-config.ts` import the type from `'../agents'`. Check for an import cycle (`agents` must not import `mcp-config`); if one appears, put the interface in a new `src/shared/mcp-server-spec/` package instead.
- **REQ-003**: `AgentSpawnOpts` (`src/main/agents/index.ts:8-19`) gains `mcpServer?: HarnessMcpServerSpec | null`. `AgentModule` gains:
  ```ts
  /** Extra env for this agent's PTY, given the user's configured env vars. */
  spawnEnv?(
    opts: AgentSpawnOpts,
    baseEnv: Record<string, string>,
    inheritedEnv: Readonly<Record<string, string | undefined>>
  ): Record<string, string>
  ```
  `baseEnv` is the configured per-agent env vars; `inheritedEnv` is the env the PTY inherits (`process.env`, `pty-manager.ts:145-147`), passed in by `agent-spawn`. Agent modules never read `process.env` in `spawnEnv`, so it stays a pure function of its arguments (ALT-004).
  Claude and Codex don't implement it. opencode implements it (REQ-006).
- **REQ-004**: `src/main/agent-spawn/agent-spawn.ts` (ticket 04, REQ-003/REQ-004 there):
  - Extract the opts construction from `buildAgentCommand` into a private `buildAgentSpawnOpts(req): { agent: AgentModule; kind: AgentKind; opts: AgentSpawnOpts }`. It calls `deps.writeMcpConfig(req.terminalId)` once and sets `mcpConfigPath` and `mcpServer = mcpConfigPath ? deps.mcpServerSpec(mcpConfigPath) : null`.
  - New **required** `AgentSpawnerDeps` field `mcpServerSpec: (configPath: string) => HarnessMcpServerSpec`. No default. `agent-spawn` must not import anything from `'../mcp-config'` (value or barrel): that pulls in `control-server` and its `worktree.ts` → `git-ops-state.ts` chain (the warning at `src/main/paths/paths.ts:84-89`) and breaks ticket 04's injected-deps unit tests. It imports the `HarnessMcpServerSpec` type from `'../agents'` only.
  - New optional `AgentSpawnerDeps` field `inheritedEnv?: Readonly<Record<string, string | undefined>>`, defaulting to `process.env` inside `agent-spawn` (the side-effect module). Tests pass `{}` or a fixed object.
  - Wire both in `src/main/index.ts` in the ticket 04 `createAgentSpawner({...})` call (ticket 04 REQ-010), next to `writeMcpConfig`:
    ```ts
    mcpServerSpec: (configPath) => harnessMcpServerSpec(configPath),
    ```
    `harnessMcpServerSpec` is imported in `index.ts` from `'./mcp-config'` alongside `writeMcpConfigForTerminal`. `inheritedEnv` is left at its default.
  - New method on `AgentSpawner`: `buildAgentLaunch(req: AgentSpawnRequest): { command: string; env: Record<string, string> }`. `command = agent.buildSpawnArgs(opts)`. `env = agentEnv(kind, opts)`.
  - `agentEnv(kind, opts)` becomes: `const base = { ...(claudeEnvVars | codexEnvVars | opencodeEnvVars by kind) }; return { ...base, ...(agent.spawnEnv?.(opts, base, deps.inheritedEnv ?? process.env) ?? {}) }`.
  - `buildAgentCommand(req)` stays, returning `buildAgentLaunch(req).command`, for the legacy `agent:buildSpawnArgs` handler.
  - The spawn branch of `spawnAgentTerminal` calls `buildAgentLaunch` once and passes `command` and `env` to `pty.create`.
- **REQ-005**: Codex command (`src/main/agents/codex.ts` `buildSpawnArgs`):
  - Replace the comment at `:237-239` with exactly one line, which is required (the token-in-file design is a non-obvious "why", so AGENTS.md allows it): `// Token stays in the 0600 per-terminal file; argv only carries its path.`
  - New exported pure helpers in `codex.ts`:
    ```ts
    export function tomlValue(v: string | string[] | Record<string, string>): string
    export function codexMcpOverrides(server: HarnessMcpServerSpec): string
    ```
    `tomlValue`: a string → `JSON.stringify(v)` with any U+007F replaced by `\u007f` (a valid TOML basic string; TOML forbids a raw DEL, which `JSON.stringify` leaves unescaped. If a value fails to parse as TOML, Codex silently takes the raw text as a string, so `args`/`env` would then fail config deserialization). An array → `[` + items joined by `,` + `]`. An object → `{` + `k=v` pairs joined by `,` + `}`, where `k` is bare if it matches `/^[A-Za-z0-9_-]+$/`, else `JSON.stringify(k)`.
    `codexMcpOverrides` returns ` -c 'mcp_servers.harness-control.command=<tomlValue>' -c '...args=<tomlValue>' -c '...env=<tomlValue>'`, each `key=value` pair passed through `shellQuote`, with a leading space.
  - `cmd = opts.command + (opts.mcpServer ? codexMcpOverrides(opts.mcpServer) : '')`, then the existing `--model` and `resume` logic. Overrides go before `resume <id>` so they apply to the resumed session. Source confirms this position works: `-c` is `global = true`, and `finalize_resume_interactive` prepends root-level `-c` to the resume overrides (`codex-rs/cli/src/main.rs`, `utils/cli/src/config_override.rs`, at `rust-v0.129.0` and `rust-v0.160.0`). Phase 0 (c) still checks the installed binary.
  - Skip the overrides when `opts.command` already contains `mcp_servers.harness-control` (user customised the command), mirroring the `--model` guard.
- **REQ-006**: opencode env (`src/main/agents/opencode.ts`). One composed builder that Item 6 extends:
  ```ts
  export function buildOpencodeConfig(
    opts: AgentSpawnOpts,
    base: Record<string, unknown>
  ): Record<string, unknown>

  export function spawnEnv(
    opts: AgentSpawnOpts,
    baseEnv: Record<string, string>,
    inheritedEnv: Readonly<Record<string, string | undefined>>
  ): Record<string, string>
  ```
  - `buildOpencodeConfig` starts from `base` and applies section builders in order. This ticket adds one: if `opts.mcpServer`, set `mcp = { ...(base.mcp as object ?? {}), 'harness-control': { type: 'local', command: [server.command, ...server.args], environment: server.env, enabled: true } }`. Every other key of `base` is kept as is. Item 6 adds a second section (`agent['harness-step']`, keyed off `opts.permissionLevel`) inside this same function, merged the same way (`{ ...base.agent, 'harness-step': ... }`). There is no second writer of `OPENCODE_CONFIG_CONTENT`.
  - `spawnEnv`: `raw = baseEnv.OPENCODE_CONFIG_CONTENT ?? inheritedEnv.OPENCODE_CONFIG_CONTENT`. No `process.env` read in `opencode.ts`'s `spawnEnv`. `base = raw` parsed as JSON when it is a JSON object, else `{}` (log `log('mcp', 'ignoring non-object OPENCODE_CONFIG_CONTENT')` when `raw` was set but unusable). `config = buildOpencodeConfig(opts, base)`. Return `{}` when `config` deep-equals `base` and `raw` is unset (nothing to add), else `{ OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }`.
  - Do not add `$schema`. Do not touch `makePluginContent`; MCP never goes into the plugin file (ticket 01 keeps one export and the `// harness-opencode-plugin` first line).
- **REQ-007**: `mcp:prepareForTerminal` (`index.ts:1724-1728`) and `prepareMcpForTerminal` in the renderer are unchanged. `pruneMcpConfigs` (`index.ts:3222`) is unchanged.
- **REQ-008 (decision gate, Codex)**: TASK-001 runs TEST-014 (a)–(d). All pass → proceed with the primary path (REQ-005). Otherwise stop the Codex part of this ticket: record the Codex version and the failing check in the plan edit (TASK-017) and activate ticket 09 (`09-codex-home-fallback.md`). Source check (2026-10-02, `rust-v0.129.0` and `rust-v0.160.0`) expects (a)–(c) to pass:
  - Each `-c` value is parsed as TOML via `_x_ = <value>`, so inline arrays and tables work.
  - The key path is split naively on `.` (`config/src/overrides.rs` `apply_toml_override`), so `harness-control` is fine as a segment. A segment containing `.` can't be addressed this way.
  - The three keys merge into one `mcp_servers.harness-control` table in the session-flags layer. Nothing restricts `mcp_servers` from that layer.
  - `codex mcp get --json` prints `command`, `args`, `env`, `env_vars` and `cwd` (`cli/src/mcp_cmd.rs`).
- **SEC-001**: `HARNESS_TOKEN` never appears in a command line or in a `log()` line. Codex argv carries only the config file path. The `pty` debug log line (`pty-manager.ts:131`) logs args, which is acceptable because args carry no token.
- **SEC-002**: Per-terminal MCP JSON files are `0600` (REQ-002).
- **CON-001**: Do not change Claude's wiring (`claude.ts:172`) or the content shape of the per-terminal JSON.
- **CON-002**: Do not write `~/.codex/config.toml`, `~/.config/opencode/opencode.json(c)` or any other user config file for MCP. Wiring is per terminal only.
- **CON-003**: Legacy path: an old renderer on a new server calls `agent:buildSpawnArgs` + `pty:create` (ticket 04 REQ-011). Codex gets MCP there (it is in the command). opencode does not (env is not built on that path), as ticket 04 RISK-006 accepts. Do not extend legacy `pty:create`.
- **CON-004**: The flag-name half of gap 4 (`codex_hooks` → `[features] hooks`) belongs to Item 8 (`ticket 08`). Do not touch `ensureCodexHooksEnabled` here.
- **CON-005**: No store slice, event, or transport channel changes.
- **GUD-001**: AGENTS.md: package-style dirs with barrels, imports through barrels, no new comments beyond REQ-003's JSDoc and the required one-liner in REQ-005. Before every commit run `pnpm typecheck`, `pnpm build`, `npx vitest run`. One commit per phase, push after each. The gap-2 plan edit is its own final commit.
- **PAT-001**: Agent module tests follow `src/main/agents/codex.test.ts` / `opencode.test.ts` (`vi.mock('fs')`, `vi.mock('../debug')`). Pure helpers (`tomlValue`, `codexMcpOverrides`, `buildOpencodeConfig`) need no mocks. Bridge tests reuse `startStub` from `resources/mcp-bridge.test.js:11-40`; spawn the bridge directly with `spawn(process.execPath, [BRIDGE, '--config', file], { env })` where needed.

## 2. Implementation Steps

### Implementation Phase 0: Verify harness behaviour

- GOAL-001: The Codex decision gate (REQ-008) is decided with evidence, and opencode MCP via `OPENCODE_CONFIG_CONTENT` is confirmed on 1.18.30. No code changes.

- [ ] **TASK-001**: Codex gate. Codex is not installed on the dev machine.
  - Install: `brew install codex` (or `npm i -g @openai/codex`). Require `codex --version` ≥ 0.129.0 (the version range Item 8 targets). Log in with `codex login` for (d).
  - Make a stub config: `node -e` or a hand-written `$SCRATCH/h.json` in the REQ-001 shape, pointing at a running Tatsu dev instance's control server (port and token from `writeMcpConfigForTerminal` output under `<userData>/mcp-configs/`, any existing file). Do not paste the token into any committed file or log.
  - (a) `codex -c 'mcp_servers.harness-control.command="<node or electron path>"' -c 'mcp_servers.harness-control.args=["<repo>/resources/mcp-bridge.js","--config","<h.json>"]' -c 'mcp_servers.harness-control.env={ELECTRON_RUN_AS_NODE="1"}' mcp list` lists `harness-control`. (Run (a) after Phase 1 so the bridge accepts `--config`; until then pass `HARNESS_PORT`/`HARNESS_TOKEN` in the `env` table for this local check only.)
  - (b) Same overrides with `codex mcp get harness-control --json`: command, args, env as given (confirms dotted key with `-` and inline array/table parsing).
  - (c) `codex <overrides> resume --help` (or `codex resume <overrides> ...`) accepts the flags before `resume`; note the working position.
  - (d) Start the TUI with the overrides, run `/mcp`: `harness-control` is connected and lists its tools. Ask "call the harness-control list_repos tool"; it returns the repo list (approve the tool call if Codex prompts; unattended approval is Item 6).
  - Record the result (version, which of (a)–(d) passed) for TASK-017. All pass → primary path (Phase 2). Any fail → skip the Codex half of Phase 2 (TASK-006 and the Codex cases of TEST-006 to TEST-008; TASK-007 still lands because opencode needs it), record the failing check, and activate ticket 09 (`09-codex-home-fallback.md`); opencode (Phase 3) goes ahead.
  - **Status rule:** if Codex cannot be installed or logged in, run (a)–(c) without login (they don't need auth), implement the primary path, mark (d) and TEST-013 as pending in the plan edit, and withhold `Completed`: the ticket status stays `In progress` (front matter, TASK-016).
- [ ] **TASK-002**: opencode check (1.18.30 is at `/opt/homebrew/bin/opencode`):
  - `OPENCODE_CONFIG_CONTENT='{"mcp":{"harness-control":{"type":"local","command":["<node>","<repo>/resources/mcp-bridge.js","--config","<h.json>"],"environment":{"ELECTRON_RUN_AS_NODE":"1"},"enabled":true}}}' opencode mcp list` shows `harness-control` connected **and** the MCP servers from `~/.config/opencode/opencode.json(c)` (merge, not replace).
  - In the TUI with the same env, ask it to call `list_repos`; it succeeds. Note the tool name opencode shows (expected `harness-control_list_repos`).
  - Confirm `OPENCODE_CONFIG_CONTENT` set in the user's `~/.zshrc` would override ours (login shell, `zsh -ilc`); record as RISK-003 evidence only.

### Implementation Phase 1: Bridge and shared spec

- GOAL-002: The bridge runs from `--config`, the per-terminal file is `0600`, and `AgentSpawnOpts` carries `mcpServer`.

- [ ] **TASK-003**: Implement REQ-001 in `resources/mcp-bridge.js`.
- [ ] **TASK-004**: Implement REQ-002 in `src/main/mcp-config/mcp-config.ts` and its barrel; add `HarnessMcpServerSpec`, `mcpServer` and `spawnEnv?` to `src/main/agents/index.ts` (REQ-003).
- [ ] **TASK-005**: Add TEST-001 to TEST-003 (bridge) and TEST-004 (mcp-config). Verify, commit (`Let the MCP bridge load its env from the per-terminal config file`), push.

### Implementation Phase 2: Codex via -c overrides (primary path)

- GOAL-003: A Codex tab started through `agent-spawn` launches with `harness-control`.

- [ ] **TASK-006**: Implement REQ-005 in `src/main/agents/codex.ts`, including the comment fix.
- [ ] **TASK-007**: Implement REQ-004 in `src/main/agent-spawn/agent-spawn.ts` (`buildAgentSpawnOpts`, `buildAgentLaunch`, `agentEnv`, required `mcpServerSpec` dep, `inheritedEnv` dep) and add the `mcpServerSpec` wiring line to the `createAgentSpawner({...})` call in `src/main/index.ts`. Requires ticket 04 merged.
- [ ] **TASK-008**: Add TEST-005 to TEST-008 and TEST-012. Run TEST-013 (Codex manual). Verify, commit (`Wire harness-control MCP into Codex tabs via -c overrides`), push.

### Implementation Phase 3: opencode via OPENCODE_CONFIG_CONTENT

- GOAL-004: An opencode tab started through `agent-spawn` has `harness-control` and keeps the user's global MCP servers.

- [ ] **TASK-009**: Implement REQ-006 in `src/main/agents/opencode.ts` (`buildOpencodeConfig`, `spawnEnv`) and export `spawnEnv` so the module satisfies `AgentModule.spawnEnv`.
- [ ] **TASK-010**: Add TEST-009 to TEST-011. Run TEST-013 (opencode manual).
- [ ] **TASK-011**: Verify, commit (`Wire harness-control MCP into opencode tabs via OPENCODE_CONFIG_CONTENT`), push.

### Implementation Phase 4: Close gap 2 in the plan

- GOAL-006: The plan records gap 2 as closed (for opencode only if the Codex gate failed) and the Codex research row as verified or failed.

- [ ] **TASK-015**: Run TEST-018 (regressions) and TEST-019.
- [ ] **TASK-016**: Set this ticket's front matter `status` per TASK-001's status rule: `'Completed'` if Phase 0 (d) and TEST-013 ran, or if the gate failed and ticket 09 was activated; `'In progress'` while (d) is pending. Same commit as TASK-017.
- [ ] **TASK-017**: Edit `plans/dynamic-workflows/dynamic-workflows.md`:
  - Gap 2 (line starting `2. **MCP only reaches Claude.**`): append `Closed in <Phase 2 hash>..<Phase 3 hash>: Codex gets \`harness-control\` through \`-c mcp_servers.harness-control.*\`, opencode through \`OPENCODE_CONFIG_CONTENT\` merged with the user's config. The bridge reads its token from the 0600 per-terminal file (\`--config\`), never from argv.` If the gate failed, close gap 2 for opencode only and append `Codex: gate failed at <check> (codex <ver>), see ticket 09.`
  - "Harness research" table, row "Per-run MCP injection", Codex cell: replace the `-c mcp_servers.*` entry with the gate result and Codex version, e.g. `` `-c mcp_servers.*` (**verified**, codex <ver>) `` or `` `-c mcp_servers.*` (failed at <check>, codex <ver>; see ticket 09) ``.
  - "Unverified:" line under the table: remove `Codex \`-c mcp_servers.*\` per-run override;` (or replace with what is still pending).
  - Gap 4 is not edited here (Item 8).
  - Commit separately (`Mark workflows gap 2 closed`), push.

## 3. Alternatives

- **ALT-001**: Register `harness-control` globally in `~/.codex/config.toml` (what the stale comment claims). Rejected: one global entry can't carry a per-terminal id or scope, and it writes a user file (CON-002).
- **ALT-002**: Put `HARNESS_PORT`/`HARNESS_TOKEN`/`HARNESS_TERMINAL_ID` in the Codex `-c ...env={...}` table. Rejected: the token would be in argv (visible in `ps`) and in the pty debug log (SEC-001). `--config` keeps one source of truth.
- **ALT-003**: Codex `env_vars = [...]` whitelist so the bridge inherits the PTY env. Rejected: it still needs the token in the PTY env, depends on a Codex version that supports `env_vars`, and the per-terminal file already exists.
- **ALT-004**: Have each agent module call `writeMcpConfigForTerminal` itself. Rejected: agent modules stay pure functions of their arguments (`AgentSpawnOpts`, `baseEnv`, `inheritedEnv`; no `process.env` reads, no control-server import chain); `agent-spawn` owns side effects (ticket 04), and `index.ts` injects the `mcp-config` functions into it.
- **ALT-005**: A separate env builder for Item 6's `harness-step` agent. Rejected: two writers of `OPENCODE_CONFIG_CONTENT` would overwrite each other. `buildOpencodeConfig` is the single composition point.
- **ALT-006**: Inject opencode MCP from the status plugin. Rejected: plugins can't register MCP servers before startup, and ticket 01 constrains the plugin file's shape.

## 4. Dependencies

- **DEP-001**: Item 1 (ticket 01, opencode plugin ESM rewrite) for the opencode manual check: without it, opencode status detection is broken and TEST-013's status column can't be checked. MCP wiring itself doesn't depend on the plugin.
- **DEP-002**: Ticket 04 (`src/main/agent-spawn/`, `agentEnv`, the `createAgentSpawner` call in `index.ts`) must be merged before Phases 1–4 start. Only the Phase 0 spikes may run in parallel with ticket 04.
- **DEP-003**: A Codex binary ≥ 0.129.0 and a Codex login for TASK-001 (d) and TEST-013. opencode 1.18.30 (installed).
- **DEP-004**: Item 6 extends `buildOpencodeConfig` (REQ-006) with the `harness-step` agent and must not add another `OPENCODE_CONFIG_CONTENT` writer. Item 6's Codex sandbox flags are appended in `codex.ts` `buildSpawnArgs` after this ticket's overrides.
- **DEP-005**: Item 8 owns the gap-4 flag name (`[features] hooks`) and the Codex hook-trust helper. If the gate fails, ticket 09 (Item 9) takes over Codex MCP.

## 5. Files

- **FILE-001**: `resources/mcp-bridge.js`. `--config` loading and header comment (REQ-001).
- **FILE-002**: `resources/mcp-bridge.test.js`. TEST-001 to TEST-003.
- **FILE-003**: `src/main/mcp-config/mcp-config.ts`, `index.ts`. `0600` write, `harnessMcpServerSpec` (REQ-002).
- **FILE-004**: `src/main/mcp-config/mcp-config.test.ts` (new). TEST-004.
- **FILE-005**: `src/main/agents/index.ts`. `HarnessMcpServerSpec`, `mcpServer`, `spawnEnv?` (REQ-003).
- **FILE-006**: `src/main/agents/codex.ts`, `codex.test.ts`. Overrides, helpers, comment fix (REQ-005).
- **FILE-007**: `src/main/agents/opencode.ts`, `opencode.test.ts`. `buildOpencodeConfig`, `spawnEnv` (REQ-006).
- **FILE-008**: `src/main/agent-spawn/agent-spawn.ts`, `types.ts`, `agent-spawn.test.ts`. `buildAgentSpawnOpts`, `buildAgentLaunch`, `agentEnv`, `mcpServerSpec` and `inheritedEnv` deps (REQ-004).
- **FILE-009**: `src/main/index.ts`. `mcpServerSpec: (configPath) => harnessMcpServerSpec(configPath)` in `createAgentSpawner({...})` (REQ-004).
- **FILE-011**: `plans/dynamic-workflows/dynamic-workflows.md`. Gap 2, research row, "Unverified" line (separate commit).
- **FILE-012**: `plans/dynamic-workflows/milestones/milestone-1-prerequisites/tickets/05-mcp-codex-opencode.md`. Status update.

## 6. Testing

- **TEST-001** (bridge `--config`): write a temp JSON `{ mcpServers: { 'harness-control': { env: { HARNESS_PORT: <stub port>, HARNESS_TOKEN: 'file-tok', HARNESS_TERMINAL_ID: 'file-term' } } } }`. Spawn the bridge with `--config <file>` and an env **without** `HARNESS_*`. `initialize`, then `tools/call list_repos`. The stub saw `Authorization: Bearer file-tok` and `X-Harness-Terminal-Id: file-term`.
- **TEST-002** (bridge `--config` wins): same, but the spawn env also has `HARNESS_TOKEN=env-tok`. The stub sees `file-tok`.
- **TEST-003** (bridge bad config): `--config /nonexistent.json` → process exits with code 1 and stderr contains `cannot read --config`. A file without `mcpServers.harness-control.env` → same.
- **TEST-004** (`mcp-config`): `harnessMcpServerSpec('/c.json', '/bin/el', '/r/b.js')` → `{ command: '/bin/el', args: ['/r/b.js', '--config', '/c.json'], env: { ELECTRON_RUN_AS_NODE: '1' } }`. With `vi.mock('../control-server')` returning port/token and `paths.userDataDir` pointed at a temp dir, `writeMcpConfigForTerminal` creates a file with mode `0o600` (`statSync(p).mode & 0o777`), also when the file pre-existed with `0o644`. With `chmodSync` mocked to throw, it returns `null`, logs, and does not throw; same for `mkdirSync` throwing. A newly created `mcp-configs` dir has mode `0o700`.
- **TEST-005** (`tomlValue`): `'a"b\\c'` → `"a\"b\\c"`; `['x','y']` → `["x","y"]`; `{ ELECTRON_RUN_AS_NODE: '1', 'a.b': 'c' }` → `{ELECTRON_RUN_AS_NODE="1","a.b"="c"}`.
- **TEST-006** (Codex `buildSpawnArgs`): with `mcpServer` set and no session: output starts with `codex -c 'mcp_servers.harness-control.command="/bin/el"' -c 'mcp_servers.harness-control.args=["/r/b.js","--config","/c.json"]' -c 'mcp_servers.harness-control.env={ELECTRON_RUN_AS_NODE="1"}'`, followed by `--model` (when set) and the quoted initial prompt. A path containing `'` is shell-escaped correctly (round-trip through `sh -c 'printf %s "$1"'` in the test, or assert the `'\''` sequence). Argv assertion: split the output into argv (same `sh` round-trip); the only argument mentioning the per-terminal file is the `args=[...]` override, it contains the config path `/c.json`, and no argument contains `HARNESS_TOKEN`, `HARNESS_PORT` or a token value (use a spec whose config file would hold a sentinel token like `tok-sentinel` and assert that string is absent).
- **TEST-007** (Codex resume): with an existing session file (mocked `readdirSync`), output is `<command><overrides>[ --model ...] resume <id>`.
- **TEST-008** (Codex, no MCP): `mcpServer: null` → output identical to today's (snapshot of the pre-change strings for the existing cases in `codex.test.ts`). A command already containing `mcp_servers.harness-control` gets no overrides. No output ever contains a `HARNESS_TOKEN` value.
- **TEST-009** (`buildOpencodeConfig`): `base = { mcp: { other: { type: 'remote', url: 'u' } }, theme: 'x' }` → result keeps `theme` and `mcp.other`, adds `mcp['harness-control'] = { type: 'local', command: ['/bin/el', '/r/b.js', '--config', '/c.json'], environment: { ELECTRON_RUN_AS_NODE: '1' }, enabled: true }`. `mcpServer: null` → returns `base` contents unchanged.
- **TEST-010** (opencode `spawnEnv`): no user value → `{ OPENCODE_CONFIG_CONTENT: <json with only mcp.harness-control> }`. User value `'{"model":"m"}'` in `baseEnv` → output keeps `model`. Invalid JSON in `baseEnv` → output has only our section and `log` was called. `mcpServer: null` and no user value → `{}`.
- **TEST-011** (opencode `buildSpawnArgs`): unchanged output for all existing cases; never contains `harness-control`.
- **TEST-012** (`agent-spawn`): fake `writeMcpConfig` returns `'/c.json'`, fake `mcpServerSpec` returns a fixed spec. `buildAgentLaunch` for opencode → `env` has `opencodeEnvVars` entries plus `OPENCODE_CONFIG_CONTENT`; `writeMcpConfig` called once. With `inheritedEnv: { OPENCODE_CONFIG_CONTENT: '{"model":"m"}' }` the result keeps `model`; with `inheritedEnv: {}` it doesn't, regardless of the test process's real env. For Codex → `command` contains `-c 'mcp_servers.harness-control.command=`, `env` equals `codexEnvVars`. For Claude → `command` contains `--mcp-config '/c.json'`, `env` equals `claudeEnvVars`. `writeMcpConfig` returning `null` → no overrides, no `OPENCODE_CONFIG_CONTENT`. `spawnAgentTerminal` passes `env` from `buildAgentLaunch` to `pty.create` (extends ticket 04 TEST-004).
- **TEST-013** (manual, `pnpm log:clear`, `pnpm dev`, harness-control enabled):
  - (a) Codex tab in a feature worktree: ask "use the harness-control list_worktrees tool". It succeeds and returns only that worktree's scope (proves `X-Harness-Terminal-Id` reached the server). `ps -ww -o args= -p <codex pid>` shows `--config <userData>/mcp-configs/<id>.json` and no token. `ls -l` on that file shows `-rw-------`.
  - (b) opencode tab in a feature worktree, two separate checks:
    - (i) Env: in that tab's PTY shell (exit or suspend opencode, or open a shell that inherits the PTY env), `env | grep OPENCODE_CONFIG_CONTENT` shows a value containing `"harness-control"` with the bridge `--config <userData>/mcp-configs/<id>.json` and no token. `opencode mcp list` from that shell lists `harness-control` and the user's own MCP servers.
    - (ii) Tool call: in the opencode TUI, ask it to use `harness-control_list_worktrees`. It succeeds with the same scoped result as (a).
  - (c) Claude tab: `list_worktrees` still works (regression).
  - (d) Restart a Codex tab with a session (resume): `/mcp` still shows `harness-control`.
  - (e) Status detection still works in the Codex and opencode tabs (working → idle), so hook trust and the plugin are unaffected.
- **TEST-014** (gate, from TASK-001): (a) `mcp list` shows the server, (b) `mcp get --json` shows exact fields, (c) flags accepted with `resume`, (d) TUI tool call succeeds.
- **TEST-018**: existing `claude.test.ts`, `codex.test.ts`, `opencode.test.ts`, `opencode-plugin.test.ts` (ticket 01), `mcp-bridge.test.js` and `agent-spawn.test.ts` pass.
- **TEST-019**: `pnpm typecheck`, `pnpm build`, `npx vitest run` pass; `pnpm build:headless && bash scripts/smoke-headless.sh` passes (`build:headless` is in `package.json`; the script boots `node dist-headless/main/index.js`, so it covers headless boot only, not an MCP spawn). The bridge path resolution in headless is unchanged (`paths.ts:90-94`).

## 7. Risks & Assumptions

- **RISK-001**: Codex `-c` parsing of a dotted key containing `-` (`harness-control`) or of inline tables may differ by version. Mitigation: TASK-001 (b) on the installed version; `tomlValue` emits only JSON-compatible TOML. Source shows the same naive `.` split and TOML value parse at `rust-v0.129.0` and `rust-v0.160.0` (REQ-008).
- **RISK-002**: Codex may prompt before each MCP tool call under its default approval policy (`on-request`). That is acceptable for interactive tabs. Under `--ask-for-approval never` (Item 6), any MCP tool without `readOnlyHint: true` that would need approval is **denied**, not prompted, when the sandbox is `read-only` or `workspace-write` (`core/src/mcp_tool_call.rs`: "MCP tool call requires approval, but approval policy is never", `rust-v0.160.0`). Tools with no annotations count as needing approval. `danger-full-access` + `never` auto-approves (`codex-mcp/src/mcp/mod.rs` `mcp_permission_prompt_is_auto_approved`). `complete_step` would therefore fail at the `read-only`/`edit` levels unless `mcp_servers.harness-control.default_tools_approval_mode = "approve"` is set (exists at 0.129.0 and 0.160.0). Item 6 adds that override (ticket 06 REQ-005).
- **RISK-003**: A user who exports `OPENCODE_CONFIG_CONTENT` in `~/.zshrc` overrides ours, because the PTY runs `zsh -ilc`. Values set in Tatsu's `opencodeEnvVars` are merged (REQ-006). Not mitigated beyond that.
- **RISK-005**: Old renderer + new server: opencode tabs on the legacy path don't get MCP (CON-003, ticket 04 RISK-006).
- **RISK-006**: `process.execPath` is Node, not Electron, in headless builds (`node dist-headless/main/index.js`, or the pinned Node in the headless tarball). `harnessMcpServerSpec` then makes Codex and opencode launch the `.js` bridge directly with Node (`<node> <lib/mcp/mcp-bridge.js> --config <file>`), and `ELECTRON_RUN_AS_NODE=1` is a harmless no-op, as for Claude today.
- **ASSUMPTION-001**: opencode 1.18.30 merges `OPENCODE_CONFIG_CONTENT` over the global config (plan, "Harness research", verified) including the `mcp` map; TASK-002 confirms for `mcp` specifically.
- **ASSUMPTION-002** (confirmed from source, `rust-v0.129.0` and `rust-v0.160.0`): Codex spawns stdio MCP servers with `env_clear()` plus a whitelist. The whitelist is `HOME LOGNAME PATH SHELL USER __CF_USER_TEXT_ENCODING LANG LC_ALL TERM TMPDIR TZ`, the CA-bundle vars, names listed in the server's `env_vars`, then the server's `env` table (`rmcp-client/src/utils.rs` `create_env_for_mcp_server`, `utils/pty/src/child_command.rs`). The PTY's `HARNESS_TERMINAL_ID` is not inherited; the `--config` file supplies it.
- **ASSUMPTION-003**: The per-terminal JSON is rewritten on every spawn (`writeMcpConfigForTerminal` is called from `buildAgentSpawnOpts`), so a token or port change after a Tatsu restart reaches a restarted tab.

## 8. Related Specifications / Further Reading

- `plans/dynamic-workflows/milestones/milestone-1-prerequisites/goal.md`, Item 5 (and Items 1, 6, 8, 9)
- `plans/dynamic-workflows/dynamic-workflows.md`: "Gaps found" (gaps 2 and 4), "Harness research (2026-10-01)" (row "Per-run MCP injection", "Unverified" line), "Codex hook trust", "Permissions & trust", "Architecture" (Agents bullet)
- `plans/dynamic-workflows/milestones/milestone-1-prerequisites/tickets/01-opencode-plugin-esm.md` (plugin shape constraints), `02-bridge-agentkind.md` (bridge stays dependency-free; test helpers), `04-main-side-agent-spawn.md` (`agentEnv`, `buildAgentCommand`, RISK-006), `09-codex-home-fallback.md` (contingent Codex fallback if the gate fails)
- https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- https://opencode.ai/docs/mcp-servers/
- https://opencode.ai/docs/config/

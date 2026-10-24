---
goal: Move agent terminal spawning into a main-side helper, make terminal creation create-or-attach with ordered history replay, and let main start the agent tabs it creates (opt-in `fromMain`) so background and headless tabs run without being opened
date_created: 2026-10-02
status: 'Completed'
tags: [feature, architecture, pty, terminals, headless, milestone-1, dynamic-workflows]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Milestone 1, Item 4 (closes gap 1 in `plans/dynamic-workflows/dynamic-workflows.md` "Gaps found"). Size L. No dependencies. Item 6 (permission levels) depends on this ticket.

Today the renderer decides when an agent starts and with which arguments:

| Location | Today | Problem |
|---|---|---|
| `src/renderer/components/XTerminal/XTerminal.tsx:444-454` (`buildAgentArg`) | Calls `backend.buildAgentSpawnArgs` (request `agent:buildSpawnArgs`, `src/main/index.ts:2273-2323`) on every mount, including mounts that attach to a live PTY. | The agent's command line is assembled by a renderer round trip. Main can't start an agent on its own. |
| `XTerminal.tsx:456-468` (`spawnPty`) | Returns early and parks itself in `pendingSpawnRef` while the container is smaller than 20×20 px (`:465`). The visible effect (`:656-697`, deferred-spawn branch of `doFit` at `:668-673`) runs it once the tab has layout. | A tab in a background worktree doesn't start until someone opens it. On headless with no client attached, it never starts. `create_worktree` with `initialPrompt` in a worktree nobody is looking at sits idle. |
| `XTerminal.tsx:501` | `backend.createTerminal(...)` sends the fire-and-forget signal `pty:create` (`src/main/index.ts:2540-2572`). | No reply, so the renderer can't learn whether it spawned or attached. |
| `XTerminal.tsx:503-516` | `terminal.onData` and `backend.onTerminalData` are wired **inside** `spawnPty`, so only after the 20px gate passes. | For a PTY that is already running in a hidden tab, every byte between the `getTerminalHistory` snapshot (`:529`) and the tab becoming visible is never written to xterm. Once main spawns background tabs this is the common case, not an edge case. |
| `XTerminal.tsx:529-561` | Treats a non-empty history as "attach": replays it, then writes `RESET_MODES` (focus, mouse, bracketed paste off) and `── session restored ──`, then calls `spawnPty`. | History is also non-empty for a PTY that **exited** in this process (`PtyManager.kill` and `onExit` keep the buffer). The renderer can't tell live from dead. For a live agent, `RESET_MODES` turns off bracketed paste and focus reporting in the local xterm while the agent still expects them, so a multi-line paste is submitted line by line. |
| `src/main/pty-manager/pty-manager.ts:132-143` | `create()` on an existing id logs "treating as attach" and returns. | Already idempotent, which this ticket builds on. `create()` returns `void`, so callers can't tell spawned, attached and failed apart (`:165-174` swallows spawn errors). |

This ticket:

1. Extracts the spawn path into a new main package `src/main/agent-spawn/` (`createAgentSpawner`). It builds the agent command from config + `AgentModule.buildSpawnArgs`, spawns through `ptyManager.create`, and sets up the session roster. It works with no renderer at a default 120×30. The runner (Phase 2), and later `create_worktree`, call it directly. Item 6 plugs permission levels into it.
2. Adds a create-or-attach transport surface: request `terminal:attach` (join + live/dead + history) and request `pty:createOrAttach` (spawn if not running, otherwise attach). The renderer subscribes to data **before** attaching and uses an ordering buffer so the history replay and the live stream neither drop nor duplicate bytes.
3. Rewrites the XTerminal mount flow: attach first, always. Spawn only when the PTY isn't running, and only then wait for layout. A live PTY gets no banner and no `RESET_MODES`.
4. Lets main callers opt in to a main-side start with `fromMain: true` on `PanesFSM.ensureInitialized` / `addTab`. This ticket uses it for a new worktree's default agent tab when the creation carries an `initialPrompt` or `teleportSessionId` (`create_worktree`, PR review, teleport); the Phase 2 runner will use it for step tabs. Every UI-initiated tab (the "+" menu, focusing a worktree with no tabs, restart, chat→terminal conversion, a prompt-less new worktree) stays renderer-spawned at its fitted size, and tabs restored from disk keep today's start-on-first-view behaviour.
5. Passes the session name for a main-spawned tab explicitly instead of looking the worktree up in `state.worktrees.list`, which doesn't contain a just-created worktree yet (REQ-017).

Existing tab behaviour is unchanged: control-taken / spectators, resize, restart, chat↔terminal conversion, sleeping shell and chat tabs, reload, and old-server/new-renderer skew.

This ticket completes Item 4. The runner that calls `spawnAgentTerminal` is Phase 2 and out of scope. Two deliberate readings of the goal's "Done when": create-or-attach lives on the new `pty:createOrAttach` / `terminal:attach` requests while `pty:create` stays as a legacy signal (ALT-003), and "background and headless tabs start without being opened" covers agent tabs main creates with `fromMain` only (prompted/teleported new worktrees now, runner steps later); UI-initiated tabs keep the renderer spawn and tabs restored from disk still start on first view (CON-003).

### Create-or-attach semantics

Main is single-threaded and every path below is synchronous, so "check `hasTerminal`, then create" can't interleave with another request. Exactly one PTY ever exists per terminal id.

| Situation | Main (`AgentSpawner`) | Renderer |
|---|---|---|
| PTY running, client attaches | `attach(id, clientId)` returns `{ alive: true, history }` and dispatches `terminals/clientJoined` (first joiner of a session with no controller becomes controller, others become spectators, as the reducer does today, `src/shared/state/terminals/terminals.ts:177-228`). | Drops data chunks received before the reply, writes `history` (no banner, no `RESET_MODES`), then flushes chunks received after the reply and goes live. If it is controller and visible, it resizes to its layout. |
| PTY not running, client spawns | `createOrAttach(spec, clientId, cols, rows)` builds the command and spawns at the client's fitted size, then dispatches `terminals/controlTaken` for that client (today's `pty:create` behaviour, `index.ts:2549-2563`). Returns `{ outcome: 'spawned', history: '' }`. | Same as today: old history (if any) was already replayed with the banner and `RESET_MODES`. Chunks received before the reply (the new PTY's first output) are flushed in order, then live data follows. |
| PTY not running at attach time, but running by the time the client calls `createOrAttach` (main or another client spawned it in between) | `createOrAttach` attaches instead: `terminals/clientJoined`, returns `{ outcome: 'attached', history }`. The client's spec is ignored. | `terminal.reset()`, then the same replay as the first row, using the returned `history`. |
| Main spawns with no client (`spawnAgentTerminal` / `spawnShellTerminal` without `clientId`) | Spawns at `resolveSpawnSize(...)` (default 120×30) and dispatches `terminals/sizeChanged`, which creates a session entry with `controllerClientId: null` (`terminals.ts:349-363`). | The first client to mount joins and becomes controller through `clientJoined` (the `controllerClientId === null` branch, `terminals.ts:206-216`), then resizes to its layout. |
| Spec differs from the running PTY (different `agentKind`, model, prompt, later permission level) | **Attach wins.** The running PTY is never restarted or re-argumented. The outcome is `'attached'` so a main caller can see its spec wasn't applied. A caller that needs a different spec uses a new terminal id; `restartAgentTab` already does. | Nothing to do. |
| PTY exited earlier in this process (buffer kept) | `attach` returns `{ alive: false, history }`. | Same as today: replay with banner + `RESET_MODES`, wait for layout, `createOrAttach`. For an agent tab with a `sessionId`, `buildSpawnArgs` resumes it (`src/main/agents/claude.ts:189-190`). |
| Spawn throws | `ptyManager.create` writes the red error line and dispatches `idle` as today, and now returns `false`. Outcome `'failed'`. No roster dispatch. | Shows the error line. It arrives as `terminal:data` synchronously **before** the reply (`pty-manager.ts:165-173`), so it sits in the attach stream's buffer and is flushed by `beginLive(false)` (REQ-013). A later mount retries. |

## 1. Requirements & Constraints

- **REQ-001**: New shared types package `src/shared/terminal-spawn-types/` (`index.ts` barrel + `terminal-spawn-types.ts`). It holds the wire contract shared by main and renderer:
  ```ts
  import type { AgentKind } from '../state/terminals'

  export type TerminalSpawnSpec =
    | {
        kind: 'agent'
        terminalId: string
        cwd: string
        agentKind: AgentKind
        sessionId?: string
        initialPrompt?: string
        teleportSessionId?: string
        sessionName?: string
        modelOverride?: string
      }
    | { kind: 'shell'; terminalId: string; cwd: string; command?: string }

  export type SpawnOutcome = 'spawned' | 'attached' | 'failed'

  export interface TerminalAttachResult { alive: boolean; history: string }
  export interface TerminalCreateResult { outcome: SpawnOutcome; history: string }
  ```
  `history` in `TerminalCreateResult` is `''` unless `outcome === 'attached'`. For a shell spec, `cwd` is already resolved (the renderer resolves `shellCwd` against the worktree as `XTerminal.tsx:482-486` does today). `TerminalSpawnSpec` deliberately has **no** permission field: permission levels (Item 6) are set only by main callers, never by a client.
- **REQ-002**: New main package `src/main/agent-spawn/` with `index.ts`, `agent-spawn.ts`, `types.ts`, `constants.ts` and `agent-spawn.test.ts`. Public API:
  ```ts
  // constants.ts
  export const DEFAULT_SPAWN_COLS = 120
  export const DEFAULT_SPAWN_ROWS = 30

  // types.ts
  export interface AgentSpawnRequest {
    terminalId: string
    cwd: string
    agentKind: AgentKind
    sessionId?: string
    initialPrompt?: string
    teleportSessionId?: string
    sessionName?: string
    modelOverride?: string
    cols?: number
    rows?: number
    // Item 6 adds: permissionLevel?: PermissionLevel
  }

  export interface ShellSpawnRequest {
    terminalId: string
    cwd: string
    command?: string
    cols?: number
    rows?: number
  }

  export interface AgentSpawnConfig extends ClaudeLaunchConfig {
    claudeCommand?: string
    codexCommand?: string
    opencodeCommand?: string
    piCommand?: string
    codexModel?: string | null
    opencodeModel?: string | null
    piModel?: string | null
    claudeEnvVars?: Record<string, string>
    codexEnvVars?: Record<string, string>
    opencodeEnvVars?: Record<string, string>
    piEnvVars?: Record<string, string>
  }

  export interface AgentSpawnerDeps {
    pty: Pick<PtyManager, 'hasTerminal' | 'create' | 'getHistory'>
    store: Pick<Store, 'dispatch' | 'getSnapshot'>
    getConfig: () => AgentSpawnConfig
    writeMcpConfig: (terminalId: string) => string | null
    getAgent?: (kind: AgentKind) => AgentModule
  }

  export interface AgentSpawner {
    buildAgentCommand(req: AgentSpawnRequest): string
    spawnAgentTerminal(req: AgentSpawnRequest, clientId?: string): SpawnOutcome
    spawnShellTerminal(req: ShellSpawnRequest, clientId?: string): SpawnOutcome
    attach(terminalId: string, clientId?: string): TerminalAttachResult
    createOrAttach(spec: TerminalSpawnSpec, clientId: string, cols?: number, rows?: number): TerminalCreateResult
  }

  // agent-spawn.ts
  export function createAgentSpawner(deps: AgentSpawnerDeps): AgentSpawner
  export function resolveSpawnSize(state: TerminalsState, worktreePath: string, terminalId: string): { cols: number; rows: number }
  export function agentSessionName(worktree: { repoRoot: string; branch: string } | undefined, enabled: boolean): string | undefined
  export function parseSpawnSpec(raw: unknown): TerminalSpawnSpec | null
  ```
  Check the exact field names and types of `AgentSpawnConfig` against `Config` in `src/main/persistence/types.ts:24` and `ClaudeLaunchConfig` in `src/main/claude-launch/claude-launch.ts:7`. `Config` must be assignable to `AgentSpawnConfig` so `index.ts` can pass `() => config`.
- **REQ-003**: `buildAgentCommand(req)` is the body of today's `agent:buildSpawnArgs` handler (`index.ts:2281-2321`), moved without behaviour change:
  - Command: `claudeCommand` / `codexCommand` / `opencodeCommand` / `piCommand`, falling back to `agent.defaultCommand`. The `kind ===` chain ends in `assertNeverAgentKind(kind)` (move that helper from `index.ts:106` into `src/main/agent-kind` if it is not already exported there), so adding a fifth `AgentKind` fails `pnpm typecheck` here.
  - `mcpConfigPath = kind === 'pi' ? null : deps.writeMcpConfig(req.terminalId)` (today's handler skips the MCP file for Pi, `index.ts:2292-2297`; keep that).
  - Claude: `buildClaudeLaunchSettings({ cwd, worktrees: store.getSnapshot().state.worktrees.list, config, modelOverride })` → `systemPrompt`, `tuiFullscreen`, `model`. Codex: `override || codexModel || null`. opencode: `override || opencodeModel || null`. Pi: `override || piModel || null`. `override` is `modelOverride.trim()` when non-empty.
  - Returns `agent.buildSpawnArgs({ terminalId, cwd, sessionId, initialPrompt, teleportSessionId, sessionName, command, mcpConfigPath, model, systemPrompt, tuiFullscreen })`. The spread of the old `opts` object also passed `terminalId` and `modelOverride` (ignored by every agent module); pass only the fields `AgentSpawnOpts` declares.
  - **Item 6 plug-in point:** this is the single place `AgentSpawnOpts` is built. Item 6 adds `permissionLevel?: PermissionLevel` to `AgentSpawnRequest` and to `AgentSpawnOpts` (`src/main/agents/index.ts:8-19`) and passes `permissionLevel: req.permissionLevel` here. Nothing else in this ticket needs to change for it.
- **REQ-004**: Spawning (`spawnAgentTerminal`, `spawnShellTerminal`, and the spawn branch of `createOrAttach`):
  - If `pty.hasTerminal(terminalId)`: no spawn. If `clientId` is given, dispatch `terminals/clientJoined { terminalId, clientId }`. Return `'attached'`.
  - Otherwise compute `cols`/`rows`: the given value when it is a positive integer, else `DEFAULT_SPAWN_COLS` / `DEFAULT_SPAWN_ROWS`.
  - Agent: `pty.create(terminalId, cwd, '', ['-ilc', buildAgentCommand(req)], agentEnv(kind), false, cols, rows)`, where `agentEnv` returns `claudeEnvVars` / `codexEnvVars` / `opencodeEnvVars` / `piEnvVars` (today's `index.ts:2543-2547`), again ending in `assertNeverAgentKind`. The empty command makes `PtyManager` use `$SHELL`, as `XTerminal.tsx:471-473` does today. **Items 5 and 6 extend `agentEnv`** (for example `OPENCODE_CONFIG_CONTENT`); it is the single place spawn env is composed.
  - Shell: `pty.create(terminalId, cwd, '', command ? ['-ilc', command] : ['-il'], undefined, true, cols, rows)` (today's `XTerminal.tsx:476-481`).
  - If `create` returns `false`: return `'failed'` with no roster dispatch.
  - If spawned and `clientId` is given: dispatch `terminals/controlTaken { terminalId, clientId, cols, rows }`. If no `clientId`: dispatch `terminals/sizeChanged { terminalId, cols, rows }`. Return `'spawned'`.
  - Log one line per call: `log('agent-spawn', \`${outcome} id=${terminalId} kind=${kind} cols=${cols} rows=${rows} client=${clientId ?? 'main'}\`)`. Never log the command line (it can carry the initial prompt).
- **REQ-005**: `attach(terminalId, clientId?)` returns `{ alive: pty.hasTerminal(terminalId), history: pty.getHistory(terminalId) }`. When `alive` and `clientId` is given, it dispatches `terminals/clientJoined`. It never spawns. XTerminal's existing `joinTerminal` effect (`XTerminal.tsx:622-624`, `terminal:join`) already sends `clientJoined` on every mount; the reducer is idempotent for a client already in the roster (`terminals.ts:196-201`), so the second dispatch is harmless.
- **REQ-006**: `createOrAttach(spec, clientId, cols, rows)` maps the spec to `spawnAgentTerminal` / `spawnShellTerminal` with `clientId`, and returns `{ outcome, history: outcome === 'attached' ? pty.getHistory(id) : '' }`.
- **REQ-007**: `resolveSpawnSize(state, worktreePath, terminalId)`: look at `state.panes[worktreePath]`. First, tabs in the leaf that contains `terminalId`, in tab order, skipping `terminalId` itself: return the first `state.sessions[tab.id]?.size` that is non-null. Then the same over all leaves (`getLeaves` order). Otherwise `{ cols: DEFAULT_SPAWN_COLS, rows: DEFAULT_SPAWN_ROWS }`. This puts a main-spawned tab at its sibling's real grid size when a client has already sized one, which cuts the resize flash the 20px deferral was added for.
- **REQ-008**: `agentSessionName(wt, enabled)` returns `\`${repoLabel}/${wt.branch}\`` with `repoLabel = wt.repoRoot.split('/').pop() || wt.repoRoot` when `enabled && wt`, else `undefined`. This is the formula the renderer uses (`src/renderer/App/App.tsx:1399`, `src/renderer/components/WorkspaceView/WorkspaceView.tsx:608`). `enabled` is `state.settings.nameClaudeSessions`.
- **REQ-009**: `PtyManager.create` (`src/main/pty-manager/pty-manager.ts:121-245`) returns `boolean`: `true` when a PTY for `id` is running after the call (spawned now, or already running at `:132-143`), `false` when `pty.spawn` threw (`:165-174`). Nothing else in `create` changes.
- **REQ-010**: Transport handlers in `src/main/index.ts`, next to the existing `pty:create` handler (`:2540`). They use the spawner constructed once in `bootLocal` immediately after `ptyManager.setStore(store)` (`:570`):
  ```ts
  const agentSpawner = createAgentSpawner({
    pty: ptyManager,
    store,
    getConfig: () => config,
    writeMcpConfig: (terminalId) => writeMcpConfigForTerminal(terminalId, resolveCallerScope(terminalId))
  })
  ```
  - `transport.onRequest('terminal:attach', (ctx, id: string) => agentSpawner.attach(id, ctx.clientId))`
  - `transport.onRequest('pty:createOrAttach', (ctx, raw: unknown, cols?: number, rows?: number) => { const spec = parseSpawnSpec(raw); return spec ? agentSpawner.createOrAttach(spec, ctx.clientId, cols, rows) : { outcome: 'failed', history: '' } })`. `parseSpawnSpec(raw: unknown): TerminalSpawnSpec | null` is a pure function exported from `src/main/agent-spawn/agent-spawn.ts` so the validation is unit-testable (TEST-012b). It returns `null` for a spec whose `kind` is neither `'agent'` nor `'shell'`, or whose `terminalId`/`cwd` is not a non-empty string, and passes `agentKind` through `toAgentKind` (`src/main/agent-kind`). The handler stays a one-liner with no logic of its own.
- **REQ-011**: The legacy channels stay registered for old renderers connecting to a new server (remote backends): `agent:buildSpawnArgs` becomes `(ctx, agentKind, opts) => agentSpawner.buildAgentCommand({ ...opts, agentKind: toAgentKind(agentKind) })`. `pty:create` keeps its signature and calls `ptyManager.create` plus the same roster dispatches as today (`:2542-2570`). Its comment block (`:2532-2538`) is kept. Both are marked `/** @deprecated legacy renderer path; use pty:createOrAttach */` on the `ElectronAPI` methods only.
- **REQ-012**: `ElectronAPI` (`src/renderer/types/types.ts`) gains, next to `createTerminal` (`:492`):
  ```ts
  attachTerminal(id: string): Promise<TerminalAttachResult>
  createOrAttachTerminal(spec: TerminalSpawnSpec, cols?: number, rows?: number): Promise<TerminalCreateResult>
  ```
  `src/renderer/build-backend/build-backend.ts` (next to `createTerminal`, `:474-482`) adds `attachTerminal: (id) => req('terminal:attach', id)` and `createOrAttachTerminal: (spec, cols, rows) => req('pty:createOrAttach', spec, cols, rows)`. The preload needs no change.
- **REQ-013**: New renderer package `src/renderer/terminal-attach/` (`index.ts` + `terminal-attach.ts` + `terminal-attach.test.ts`). It holds the ordering logic so it is testable without a DOM:
  ```ts
  export interface AttachStream {
    /** Called for every terminal:data chunk for this id from mount onward. */
    push(data: string): void
    /** The attach/create reply arrived. When `discardBuffered` is true,
     *  drop everything pushed so far (the reply's history already contains
     *  it); otherwise write the buffered chunks in order. Then go live. */
    beginLive(discardBuffered: boolean): void
  }
  export function createAttachStream(write: (data: string) => void): AttachStream
  ```
  Before the first `beginLive()`, `push` stores chunks. `beginLive(true)` discards them; `beginLive(false)` writes them in push order. From then on `push` calls `write` directly. Once live, further `beginLive()` calls are no-ops whatever their argument. The caller discards only when the reply is an attach (`alive: true` from `terminal:attach`, or `outcome: 'attached'` from `pty:createOrAttach`), because only then does the returned `history` already contain the buffered chunks. For `'spawned'` and `'failed'` it calls `beginLive(false)`: the buffer holds output the reply doesn't carry, notably the red error line `PtyManager.create` sends as `terminal:data` before the reply when spawn throws. The flow never needs to go back to buffering: the dead path (REQ-014 step 4) stays un-live until the `createOrAttach` reply, so that reply makes the first `beginLive()`.
- **REQ-014**: XTerminal mount flow (`XTerminal.tsx:432-564` replaced; the rest of the effect is unchanged):
  1. Create the attach stream with `write = (d) => { terminal.write(sanitizeTerminalData(d)); setLoading(false) }`. Subscribe `backend.onTerminalData` **immediately** and route this id's chunks to `stream.push`. Wire `terminal.onData` (controller-gated input, today's `:503-509`) immediately too. `cleanupData` is set here, not in `spawnPty`.
  2. `const res = await attachWithFallback()`, where `attachWithFallback` calls `backend.attachTerminal(terminalId)` and, if the request rejects (old server without the channel), falls back to `{ alive: false, history: await backend.getTerminalHistory(terminalId) }` and sets a local `legacy = true`.
  3. If `res.alive`, in one synchronous block right after the reply: `terminal.write(sanitizeTerminalData(res.history))`, then `stream.beginLive(true)`, then `setLoading(false)`. Do not wait for the `terminal.write` callback before `beginLive(true)`: chunks arriving in the meantime would be stored and then discarded. xterm's write queue keeps history ahead of the live chunks. No banner, no `RESET_MODES`. Do not spawn. If visible and controller, fit and `resizeTerminal` (the visible effect also does this).
  4. If not alive: keep today's dead-history replay (`:540-561`, banner + `RESET_MODES`) when `res.history` is non-empty, then call `spawnPty()`. `stream.beginLive()` is called when `createOrAttach` replies (step 5), not before.
  5. `spawnPty` keeps the 20px layout gate (`:464-468`) and `pendingSpawnRef`, and keeps fitting for `spawnCols`/`spawnRows` (`:489-500`). Instead of `buildAgentArg` + `createTerminal` it sends `backend.createOrAttachTerminal(spec, spawnCols, spawnRows)`, where `spec` is built from props (`agentKind || 'claude'`, `sessionId`, `initialPrompt`, `teleportSessionId`, `sessionName`, `modelOverride` for agents; resolved `shellCwd` and `shellCommand` for shells). On reply: if `outcome === 'attached'`, `terminal.reset()`, write `history`, then `stream.beginLive(true)`; for `'spawned'` and `'failed'`, `stream.beginLive(false)` so the chunks buffered before the reply (the new PTY's first output, or the spawn-failure error line) are written in order. When `legacy` is true, `spawnPty` uses the old `buildAgentArg` + `createTerminal` code and calls `stream.beginLive(false)` right after `createTerminal` (the legacy signal returns no history, so nothing buffered may be dropped).
  6. The 800 ms loading safety net (`:518-526`) stays, started after the attach reply.
  - `disposed` checks stay after every `await`. The cleanup block (`:596-615`) is unchanged except that `cleanupData` now always exists.
  - For the dead-history replay in step 4, the existing `terminal.write(history, callback)` chaining stays: nothing is live yet, so stored chunks are only those of a PTY spawned in between (the `'attached'` branch of step 5 resets and replays them from the returned history) or of the PTY this client's own `createOrAttach` spawned or failed to spawn (flushed by `beginLive(false)` after the replay).
- **REQ-015**: Main-side start is **opt-in**. `PanesFSMOptions` (`src/main/panes-fsm/panes-fsm.ts:22-65`) gains:
  ```ts
  /** Start the PTY for an agent tab main created with `fromMain`, so it
   *  runs whether or not any client has it open. Never called for
   *  UI-initiated or restored tabs. */
  startAgentTab?: (wtPath: string, tab: TerminalTab, worktree?: { repoRoot: string; branch: string }) => void
  ```
  - `ensureInitialized`'s `opts` (`:207-215`) gain `fromMain?: boolean` and `worktree?: { repoRoot: string; branch: string }` (REQ-017).
  - `addTab(wtPath, tab, paneId?)` (`:289`) becomes `addTab(wtPath, tab, paneId?, opts?: { fromMain?: boolean })`.
  `PanesFSM` calls `startAgentTab` only when `fromMain === true` and the tab's `type === 'agent'`, after the commit that puts the tab in the slice, from exactly two places:
  - `ensureInitialized` new-pane branch (`:226-273`), for `agentTab`, after `this.commit(wtPath, pane)`, passing `opts.worktree`. Not reached when the tree already has tabs (`:216-217`) or a sleeping tree is promoted (`:219-224`).
  - `addTab` (`:289-332`), for `normalizedTab`, after either commit (new leaf `:317` or appended `:331`). `worktree` is `undefined`; `startAgentTab` falls back to the list lookup (REQ-016). This ticket has no `addTab(..., { fromMain: true })` caller; it is the entry point for the Phase 2 runner's step tabs.
  It is **not** called from `restartAgentTab`, `convertTabType`, `restoreFromConfig`, the sleeping-tree promotion in `ensureInitialized` (`:219-224`) or `addTab` (`:300-309`), `splitPane`, `moveTabToPane`, `wakeShellTab`, `wakeJsonClaudeTab`, or any `ensureInitialized` / `addTab` call without `fromMain`. That covers the boot drain (`drainBootInit`, `index.ts:914`), the post-boot `worktrees/listChanged` subscriber (`index.ts:958`), and the renderer-facing handlers.
  - The wire handlers never forward `fromMain`: `panes:addTab` (`index.ts:2119-2125`) keeps calling `panesFSM.addTab(wtPath, tab, paneId)` with exactly those three arguments, and `panes:ensureInitialized` (`:2226-2229`) keeps calling `panesFSM.ensureInitialized(wtPath)` with no opts. A remote client can't trigger a main spawn by sending extra arguments.
  - Why opt-in: the renderer spawns UI-initiated tabs (`panes:ensureInitialized` from `App.tsx:542` / `MobileApp.tsx:77`, the "+" menu, restart, conversion) through a visible, fitted XTerminal. A main spawn at a guessed size would bring back the wrong-width flash the 20px gate prevents (ALT-007).
  A second `ensureInitialized` for the same worktree (for example the `worktrees/listChanged` subscriber after `onWorktreeCreated`, or the renderer's activation call) returns early once the tree has tabs and doesn't spawn (TEST-022). If `startAgentTab` does run again for a tab id whose PTY exists, `spawnAgentTerminal` returns `'attached'` without calling `pty.create` (REQ-004). TEST-015b covers it.
  The tab must be in the slice before the call: `resolveCallerScope` (`index.ts:146-169`) finds the worktree through the panes tree to write the MCP scope env.
- **REQ-016**: `index.ts` wires `startAgentTab` in the `PanesFSM` options (`:725-756`). Construct the spawner immediately after `ptyManager.setStore(store)` at `src/main/index.ts:570` (before `PanesFSM` at ~`:725`), so the option closes over an initialized `agentSpawner`. Body:
  ```ts
  startAgentTab: (wtPath, tab, worktree) => {
    const state = store.getSnapshot().state
    const wt = worktree ?? state.worktrees.list.find((w) => w.path === wtPath)
    const size = resolveSpawnSize(state.terminals, wtPath, tab.id)
    agentSpawner.spawnAgentTerminal({
      terminalId: tab.id,
      cwd: wtPath,
      agentKind: tab.agentKind ?? 'claude',
      sessionId: tab.sessionId,
      initialPrompt: tab.initialPrompt,
      teleportSessionId: tab.teleportSessionId,
      sessionName: agentSessionName(wt, state.settings.nameClaudeSessions),
      modelOverride: tab.model,
      cols: size.cols,
      rows: size.rows
    })
  }
  ```
  `tab.agentKind ?? 'claude'` matches the renderer's `agentKind || 'claude'` (`XTerminal.tsx:445`).
  Pass `fromMain` at exactly two `ensureInitialized` calls, and only when the creation carries a prompt or a teleport session (`const fromMain = !!(initialPrompt || teleportSessionId)`):
  - `WorktreesFSM` `onWorktreeCreated` (`index.ts:808-810`): `panesFSM.ensureInitialized(createdPath, { initialPrompt, teleportSessionId, agentKind, model, fromMain, worktree: { repoRoot, branch } })`. Covers UI "new worktree" with a prompt, PR-review worktrees (`runPendingPR`) and teleport.
  - `worktrees:externalCreate` in the control-server `broadcast` dep (`index.ts:3472-3490`, MCP `create_worktree` with a branch name): `panesFSM.ensureInitialized(p.worktree.path, { initialPrompt, agentKind, model, fromMain: !!p.initialPrompt, worktree: { repoRoot: p.repoRoot, branch: p.worktree.branch } })`. Add `branch: string` to the payload's inline type; `control-server.ts:198-204` already sends the full `WorktreeInfo` as `worktree`.
  A prompt-less default tab of a new worktree stays renderer-spawned: whichever client focuses the worktree mounts the tab and spawns it at its fitted size.
  Both calls must stay ahead of `refreshList` / `worktrees/listChanged`. Today they are: `onWorktreeCreated` runs before `await this.refreshList()` (`worktrees-fsm.ts:258-265`), and the broadcast handler calls `ensureInitialized` before `worktreesFSM.refreshList()` (`:3486-3492`). The first `ensureInitialized` for a worktree builds its tree; later calls return the existing tree. So if a refresh that already includes the new path (for example a concurrent `worktreesFSM.refreshList()` from another `index.ts` caller such as `:1145` / `:1171`) dispatches `listChanged` first, the subscriber at `:918-922` initializes the worktree without opts: the prompt is lost and nothing main-spawns. That race exists today for the prompt; this ticket doesn't widen it. Don't reorder these calls.
- **REQ-017**: Session name for a main-spawned tab. `startAgentTab` can't rely on `state.worktrees.list`: `onWorktreeCreated` fires before `await this.refreshList()` (`worktrees-fsm.ts:258-265`), and `control-server.ts:198` broadcasts before the list is refreshed, so a just-created worktree usually isn't in the list, `agentSessionName(undefined, …)` returns `undefined` and the session name is silently dropped. Fix: carry `repoRoot` and `branch` from the creator to `startAgentTab`.
  - `WorktreesFSMOptions.onWorktreeCreated` params (`worktrees-fsm.ts:61-67`) gain `repoRoot: string` and `branch: string`. `finishCreate` passes `repoRoot` (its argument, `:226`) and `created.branch`.
  - `ensureInitialized` forwards `opts.worktree` as the third argument of `startAgentTab` (REQ-015); `startAgentTab` prefers it over the list lookup (REQ-016).
  - Not chosen: moving `onWorktreeCreated` after `await this.refreshList()`. `refreshList` dispatches `worktrees/listChanged`, whose subscriber (`index.ts:955-960`) calls `ensureInitialized(path)` with no opts first, so the initial prompt (and the main spawn) would be lost. Using `created.repoRoot` is also not chosen: `repoRoot` is set only after a cross-repo list merge (`src/shared/state/worktrees/types.ts:9-10`), so take it from the caller.
- **REQ-018**: Claude's `--mcp-config` is variadic (`claude --help`: `--mcp-config <configs...>`), so in `src/main/agents/claude.ts` `buildSpawnArgs` a positional `initialPrompt` that directly follows `--mcp-config <path>` is read as a second config file ("MCP config file not found: …/<prompt>", verified 2026-10-02 on 2.1.286 in `-p`). Today it is latent because every Claude tab has a `sessionId`, so `--session-id <id>` sits in between; this ticket's main-side spawns can pass an `initialPrompt` without one (`create_worktree` with `initialPrompt` for a Claude tab that panes-fsm did not assign an id to, and later runner steps). Fix in `claude.ts`, as the one exception to CON-005: when `initialPrompt` is set, emit it after `--` (`${cmd} -- ${shellQuote(prompt)}` and `${base} -- ${shellQuote(prompt)}`). Phase 0 of this ticket verifies that `claude -p --mcp-config <file> -- 'say PONG'` answers on the installed Claude (2.1.302 as of 2026-10-24); if `--` is rejected, fall back to generating `sessionId = randomUUID()` in `buildAgentSpawnOpts` for Claude requests that have an `initialPrompt` and no `sessionId`, so `--session-id` always separates the two (the hook's `sessionIdDiscovered` keeps the slice in sync either way). Record which fix shipped in the gap-1 plan edit (TASK-016).
- **CON-001**: No new store slice, `StateEvent` variant or reducer case. The roster events used (`controlTaken`, `clientJoined`, `sizeChanged`) already exist. Which client spawned a PTY is per-call information, not shared state.
- **CON-002**: Do not change `TerminalSession` semantics, the `pty:write` / `pty:resize` controller gates (`index.ts:2575-2595`), `terminal:join` / `terminal:leave` / `terminal:takeControl` (`:3036-3060`), or the XTerminal take-control handler (`:736-757`).
- **CON-003**: Do not spawn restored tabs at boot. Persisted agent tabs keep starting on first view, as today. This avoids starting one agent per non-merged worktree at boot, the same reason as sleep-on-boot (`index.ts:879-903`). The Phase 2 runner owns recovery of its own steps.
- **CON-004**: Do not change `PtyManager`'s history buffer, its persistence, or `getHistory`. Note: `getHistory` only returns bytes after `create()` seeded the buffer from disk (`pty-manager.ts:200-206`), so a first mount after an app restart sees `''`. That is today's behaviour and stays.
- **CON-005**: Do not change `AgentModule.buildSpawnArgs` or any agent module, except the prompt placement in `claude.ts` required by REQ-018. Items 5, 6 and 8 own the rest.
- **GUD-001**: Follow AGENTS.md: package-style directories with `index.ts` barrels, imports through barrels, no new comments except the JSDoc in REQ-015 and the deprecation tags in REQ-011. Run `pnpm typecheck`, `pnpm build` and `npx vitest run` before every commit. One commit per phase, push after each. The gap-1 edit to the plan is a separate final commit (TASK-016).
- **PAT-001**: Main tests follow `src/main/panes-fsm/panes-fsm.test.ts`: real `Store`, `vi.mock('../debug', () => ({ log: vi.fn() }))`, `vi.mock('../perf-log', ...)`. `AgentSpawner` tests use a fake `pty` (`Map`-backed `hasTerminal` / `create` / `getHistory`) and a fake `getAgent` that returns a module whose `buildSpawnArgs` records its opts and returns `'AGENT_CMD'`. No real PTYs.

## 2. Implementation Steps

### Implementation Phase 0: Verify the Claude positional prompt

- GOAL-000: REQ-018's fix is chosen from evidence on the installed Claude.

- [x] **TASK-000**: In a Claude-trusted scratch repo, run `claude -p --mcp-config /dev/null -- 'say PONG'` and `claude -p --mcp-config /dev/null 'say PONG'` (any readable JSON file works in place of `/dev/null`; use `echo '{"mcpServers":{}}' > m.json`). Record whether `--` makes the first form answer PONG while the second fails with "MCP config file not found". Choose the REQ-018 fix accordingly and note the Claude version in the Phase 1 commit message.
  Result (2026-10-24, Claude 2.1.302, `command claude`): `claude -p --mcp-config m.json -- 'say PONG'` printed `PONG`; `claude -p --mcp-config m.json 'say PONG'` failed with `MCP config file not found: …/say PONG`. REQ-018 ships the `--` form.

### Implementation Phase 1: Main spawn helper (behaviour-preserving)

- GOAL-001: `src/main/agent-spawn/` exists and is tested. The existing `agent:buildSpawnArgs` and `pty:create` handlers produce the same commands and roster events as before, for all four agent kinds. No user-visible change except REQ-018's prompt placement.

- [x] **TASK-000b**: Apply REQ-018 in `src/main/agents/claude.ts` (`--` form, or the generated-session-id fallback in `buildAgentSpawnOpts` during TASK-003) and update `claude.test.ts` (TEST-024).
- [x] **TASK-001**: Create `src/shared/terminal-spawn-types/` with the types in REQ-001.
- [x] **TASK-002**: Change `PtyManager.create` to return `boolean` (REQ-009): `return true` at the attach early-return (`:142`) and just before the method's closing brace (`:245`), `return false` in the spawn `catch` (`:173`). Grep tests for typed `PtyManager` fakes (`grep -rn "PtyManager" src --include='*.test.ts*'`) and update any whose `create` is typed or implemented as returning `void`.
- [x] **TASK-003**: Create `src/main/agent-spawn/` with `constants.ts`, `types.ts`, `agent-spawn.ts`, `index.ts` per REQ-002 to REQ-008. `index.ts` exports `createAgentSpawner`, `resolveSpawnSize`, `agentSessionName`, `parseSpawnSpec`, `DEFAULT_SPAWN_COLS`, `DEFAULT_SPAWN_ROWS`, and the types.
- [x] **TASK-004**: In `src/main/index.ts`, construct `agentSpawner` (REQ-010) and replace the body of the `agent:buildSpawnArgs` handler (`:2273-2323`) with a call to `agentSpawner.buildAgentCommand` (REQ-011). Leave `pty:create` as is for now. Remove imports from `index.ts` that become unused (`buildClaudeLaunchSettings` if nothing else uses it).
- [x] **TASK-005**: Write `src/main/agent-spawn/agent-spawn.test.ts`, TEST-001 to TEST-008. Run `pnpm typecheck`, `pnpm build`, `npx vitest run`. Commit (`Extract agent terminal spawning into a main-side agent-spawn helper`) and push.

### Implementation Phase 2: Create-or-attach transport surface

- GOAL-002: Clients can attach (live/dead + history) and create-or-attach through requests. Old renderers keep working.

- [x] **TASK-006**: Add the `terminal:attach` and `pty:createOrAttach` request handlers (REQ-010). Leave the legacy `pty:create` signal handler's behaviour as it is (REQ-011).
- [x] **TASK-007**: Add `attachTerminal` and `createOrAttachTerminal` to `ElectronAPI` and `build-backend.ts` (REQ-012). Add the `@deprecated` JSDoc to `createTerminal` and `buildAgentSpawnArgs` in `types.ts`.
- [x] **TASK-008**: Extend `agent-spawn.test.ts` with TEST-009 to TEST-012 and TEST-012b. Verify, commit (`Add terminal:attach and pty:createOrAttach requests`), push.

### Implementation Phase 3: Renderer attach-first mount flow

- GOAL-003: XTerminal attaches before it ever spawns, never loses or duplicates bytes around the history replay, never shows "session restored" or resets modes on a live PTY, and only spawns through `pty:createOrAttach`.

- [x] **TASK-009**: Create `src/renderer/terminal-attach/` (REQ-013) with TEST-013, TEST-013b and TEST-014.
- [x] **TASK-010**: Rewrite the XTerminal mount flow (REQ-014). Keep `pendingSpawnRef` and the visible effect's deferred-spawn branch (`:665-673`); they now only matter for PTYs that aren't running. Keep the `exited` overlay wiring (`:438-442`).
- [x] **TASK-011**: Run the manual checks TEST-019 (a)–(f) on desktop. Verify, commit (`Attach to running terminals before spawning and replay history in order`), push.

### Implementation Phase 4: Start main-created agent tabs from main

- GOAL-004: An agent tab main creates with `fromMain` (a new worktree with an `initialPrompt` or teleport session) starts in main the moment it enters the slice, with or without a client, and gets its session name. UI-initiated tabs stay renderer-spawned. Restored tabs don't start.

- [x] **TASK-012**: Add `startAgentTab` to `PanesFSMOptions`, add `fromMain` / `worktree` to the `ensureInitialized` opts and `opts.fromMain` to `addTab`, and call `startAgentTab` from the two places in REQ-015.
- [x] **TASK-012b**: Add `repoRoot` and `branch` to the `onWorktreeCreated` params and pass them from `finishCreate` (REQ-017). Update any `onWorktreeCreated` fake in `src/main/worktrees-fsm/*.test.ts`.
- [x] **TASK-013**: Wire `startAgentTab` in `src/main/index.ts` and pass `fromMain` + `worktree` at the `onWorktreeCreated` and `worktrees:externalCreate` `ensureInitialized` calls (REQ-016). Leave `drainBootInit`, the `listChanged` subscriber, `panes:addTab` and `panes:ensureInitialized` unchanged.
- [x] **TASK-014**: Extend `src/main/panes-fsm/panes-fsm.test.ts` with TEST-015 to TEST-018, TEST-015b and TEST-022, and the worktrees-fsm test with TEST-023.
- [x] **TASK-015**: Run TEST-019 (g)–(l) and TEST-020 (headless). Verify, commit (`Start main-created agent tabs from main so background and headless tabs run unopened`), push.

### Implementation Phase 5: Close gap 1 in the plan

- GOAL-005: The plan records gap 1 as closed.

- [x] **TASK-016**: Edit `plans/dynamic-workflows/dynamic-workflows.md`:
  - Gap 1 ("Gaps found", the line starting `1. **Agent spawn is renderer-driven (blocker).**`): append `Closed in <Phase 1 hash>..<Phase 4 hash>: \`src/main/agent-spawn/\` builds and spawns agent terminals with no renderer (default 120×30, or a sibling tab's size), \`pty:createOrAttach\` / \`terminal:attach\` make terminal creation create-or-attach with ordered history replay, and agent tabs main creates with \`fromMain\` (prompted or teleported new worktrees) start from main. UI-initiated tabs are still spawned by the renderer at their fitted size, and tabs restored from disk still start on first view.`
  - "Architecture", bullet "**Main-side spawn**": replace its text after the bold label with `\`src/main/agent-spawn/\` (\`createAgentSpawner\`): \`spawnAgentTerminal\` / \`spawnShellTerminal\` for main callers (the runner, later \`create_worktree\`), \`createOrAttach\` / \`attach\` behind \`pty:createOrAttach\` / \`terminal:attach\` for clients. A running PTY always wins: the client joins and replays its history. Main spawns at a sibling tab's size or 120×30 and the tab resizes when it mounts. Permission levels plug into \`AgentSpawnRequest.permissionLevel\`.`
  - Commit that edit separately (`Mark workflows gap 1 closed`) and push.

## 3. Alternatives

- **ALT-001**: Remove the 20px gate and keep spawning from the renderer. Rejected: headless with no client still never spawns, and the runner still can't start a step without a renderer.
- **ALT-002**: A main store subscriber that spawns any agent tab id it sees in `terminals/panesForWorktreeChanged` without a PTY. Rejected: it sweeps every tab of the worktree on every pane event (AGENTS.md anti-pattern #1), and it can't tell new tabs from restored ones, so boot would start every restored agent (CON-003). Explicit `startAgentTab` calls at the two `fromMain` creation points are scoped and self-documenting, like `startJsonClaudeWithPrompt` already is.
- **ALT-003**: Make `pty:create` itself a request with a new signature. Rejected: an old renderer connected to a new remote server sends the old signal, and changing the channel's shape breaks it. New channel names let both sides detect skew (a missing request handler rejects, `transport-websocket.ts:235`).
- **ALT-004**: One `pty:createOrAttach` call on mount with no separate `terminal:attach`. Rejected: for a dead PTY with history the renderer must replay the old history before the new process prints, and must wait for layout before spawning, so it needs live/dead before it decides to spawn.
- **ALT-005**: Compare the incoming spec with the running PTY and restart on mismatch. Rejected: two clients with slightly different props (for example `sessionName` toggled) would kill each other's agent. Restart is an explicit user or runner action with a new id.
- **ALT-006**: Track "spawned by main" in a slice so the renderer never re-spawns a main-owned tab after it exits. Deferred to Phase 2: the runner decides what an exited step tab means. Today's respawn-on-remount for exited tabs is kept (see RISK-004).
- **ALT-007**: Main-spawn every new agent tab (`ensureInitialized`, `addTab`, `restartAgentTab`, `convertTabType` unconditionally). Rejected: (1) UI-initiated tabs have a visible XTerminal that can spawn at its fitted size; a main spawn at a sibling's size or 120×30 brings back the wrong-width start and resize flash the 20px gate was added to prevent. (2) The boot drain (`index.ts:914`) and the post-boot `worktrees/listChanged` subscriber (`:921`) call `ensureInitialized(path)` for every worktree, so every worktree with no persisted tree would start an agent at boot or on repo add, breaking CON-003 and TEST-019 (j). Opt-in `fromMain` keeps main spawns to tabs no client is guaranteed to be looking at.

## 4. Dependencies

- **DEP-001**: None blocking. Items 1–3 touch different files (`agents/opencode.ts`, `mcp-bridge.js`, `hooks/hooks.ts`, `cost-tracker`).
- **DEP-002**: Item 6 (permission levels) depends on this ticket: it adds `permissionLevel` to `AgentSpawnRequest` and `AgentSpawnOpts` and passes it in `buildAgentCommand` (REQ-003). Items 5 and 6 extend `agentEnv` (REQ-004) for per-terminal env such as `OPENCODE_CONFIG_CONTENT`.
- **DEP-003**: Transport ordering: replies to requests and `terminal:data` signals reach a client in the order main sent them. True for WebSocket (one socket). For Electron, `ipcMain.handle` replies and `webContents.send` share the renderer's IPC channel; see RISK-001.

## 5. Files

- **FILE-001**: `src/shared/terminal-spawn-types/index.ts`, `terminal-spawn-types.ts` (new). Wire types (REQ-001).
- **FILE-002**: `src/main/agent-spawn/index.ts`, `agent-spawn.ts`, `types.ts`, `constants.ts`, `agent-spawn.test.ts` (new). Spawner, `resolveSpawnSize`, `agentSessionName` (REQ-002 to REQ-008).
- **FILE-003**: `src/main/pty-manager/pty-manager.ts`. `create` returns `boolean` (REQ-009).
- **FILE-004**: `src/main/index.ts`. Construct the spawner; `agent:buildSpawnArgs` delegates (`:2273-2323`); new `terminal:attach` and `pty:createOrAttach` handlers near `:2540`; `startAgentTab` option in `PanesFSM` construction (`:725-756`); `fromMain` + `worktree` at `onWorktreeCreated` (`:808-810`) and `worktrees:externalCreate` (`:3486`).
- **FILE-005**: `src/main/panes-fsm/panes-fsm.ts`. `startAgentTab` option, `fromMain` / `worktree` opts, and its two call sites (REQ-015).
- **FILE-005b**: `src/main/worktrees-fsm/worktrees-fsm.ts` (+ its test). `onWorktreeCreated` params gain `repoRoot` and `branch` (REQ-017).
- **FILE-006**: `src/main/panes-fsm/panes-fsm.test.ts`. TEST-015 to TEST-018, TEST-022.
- **FILE-007**: `src/renderer/types/types.ts`. `attachTerminal`, `createOrAttachTerminal`, deprecation tags (`:414-418`, `:492-500`).
- **FILE-008**: `src/renderer/build-backend/build-backend.ts`. Two new methods (`:474-482`).
- **FILE-009**: `src/renderer/terminal-attach/index.ts`, `terminal-attach.ts`, `terminal-attach.test.ts` (new). Ordering buffer (REQ-013).
- **FILE-010**: `src/renderer/components/XTerminal/XTerminal.tsx`. Attach-first mount flow (`:432-564`, REQ-014).
- **FILE-011**: `plans/dynamic-workflows/dynamic-workflows.md`. Gap 1 closed and the "Main-side spawn" bullet updated (separate commit).

## 6. Testing

- **TEST-001** (`buildAgentCommand`, Claude): with `claudeCommand: 'claude-beta'`, `modelOverride: ' opus '`, a worktree list containing the cwd, the fake module's recorded opts have `command: 'claude-beta'`, `model` from `buildClaudeLaunchSettings` with override `'opus'`, `mcpConfigPath` equal to what `writeMcpConfig` returned, and `systemPrompt` / `tuiFullscreen` set. Snapshot the opts object so the Phase 1 extraction is pinned.
- **TEST-002** (`buildAgentCommand`, Codex, opencode and Pi): `model` is `override || codexModel || null` / `override || opencodeModel || null` / `override || piModel || null`. Commands fall back to `defaultCommand` when the config command is empty. For Pi, `writeMcpConfig` is **not** called and `mcpConfigPath` is `null`; `spawnAgentTerminal` for Pi passes `piEnvVars` to `pty.create`.
- **TEST-024** (`claude.test.ts`, REQ-018): with `mcpConfigPath: '/c.json'`, `initialPrompt: 'say hi'` and no `sessionId`, the output ends with `--mcp-config '/c.json' -- 'say hi'` (or, with the fallback fix, contains `--session-id <uuid> 'say hi'` and never `--mcp-config '/c.json' 'say hi'`). With a `sessionId`, the same placement holds after `--session-id`. Existing `claude.test.ts` cases are updated for the `--` only where a prompt is present.
- **TEST-003** (`buildAgentCommand`): `writeMcpConfig` returning `null` gives `mcpConfigPath: null`, and the call doesn't throw.
- **TEST-004** (`spawnAgentTerminal`, main spawn): no `clientId`, no size. `pty.create` called once with the full `PtyManager.create(id, cwd, command, args, extraEnv, isShell, cols, rows)` tuple (`pty-manager.ts:121-130`): `(id, cwd, '', ['-ilc', 'AGENT_CMD'], claudeEnvVars, false, 120, 30)`. Store has `sessions[id] = { controllerClientId: null, spectatorClientIds: [], size: { cols: 120, rows: 30 } }`. Returns `'spawned'`.
- **TEST-005** (`spawnAgentTerminal`, client spawn): `clientId: 'c1'`, `cols: 90, rows: 40`. `controlTaken` gives `controllerClientId: 'c1'`, size 90×40.
- **TEST-006** (`spawnAgentTerminal`, already running): second call for the same id does not call `pty.create` or `buildSpawnArgs`, returns `'attached'`, and with `clientId: 'c2'` adds `'c2'` as a spectator.
- **TEST-007** (`spawnAgentTerminal`, failure): fake `create` returns `false`. Outcome `'failed'`, `sessions[id]` undefined.
- **TEST-008** (`spawnShellTerminal`): with `command: 'npm test'` → args `['-ilc', 'npm test']`, `isShell` true, env `undefined`. Without a command → `['-il']`.
- **TEST-009** (`attach`): not running → `{ alive: false, history: <fake history> }` and no dispatch. Running with no session and `clientId: 'c1'` → `alive: true`, `c1` is controller. Running, main-spawned (`controllerClientId: null`), `c1` attaches → controller; `c2` attaches → spectator.
- **TEST-010** (`createOrAttach`): not running → `{ outcome: 'spawned', history: '' }`. Running → `{ outcome: 'attached', history: <buffer> }` and the spec's different `agentKind` / `initialPrompt` are not used (fake `buildSpawnArgs` not called).
- **TEST-011** (`resolveSpawnSize`): sibling in the same leaf with size 100×50 wins over a tab in another leaf with 80×24. With no sized sessions → 120×30. The target id's own session is ignored.
- **TEST-012** (`agentSessionName`): `{ repoRoot: '/a/b/repo', branch: 'feat' }`, enabled → `'repo/feat'`. Disabled or no worktree → `undefined`.
- **TEST-012b** (`parseSpawnSpec`, `pty:createOrAttach` input validation): returns `null` for `kind: 'bogus'`, a missing `kind`, `terminalId: ''`, `cwd: ''`, a non-string `terminalId`/`cwd`, and non-object input (`null`, a string). A valid agent spec with an unknown `agentKind` comes back with `toAgentKind`'s fallback; a valid shell spec round-trips. The `pty:createOrAttach` handler is a one-liner over `parseSpawnSpec` + `createOrAttach` (REQ-010), so this plus TEST-010 covers it.
- **TEST-013** (`createAttachStream`): chunks pushed before `beginLive(true)` are never written. After it, pushes are written in order. With `beginLive(false)`, chunks pushed before it are written in push order at that call, then later pushes follow. A second `beginLive(...)` (either argument) is a no-op: pushes after it are still written and nothing already written is dropped or repeated.
- **TEST-013b** (`createAttachStream`, failed spawn): model the `'failed'` reply. Push the red error line `'\r\n\x1b[31mFailed to spawn "zsh": boom\x1b[0m\r\n'` before the reply (as `PtyManager.create` does synchronously), then `beginLive(false)`. The error line is written exactly once. Same for `'spawned'`: a first-output chunk pushed before the reply is written once, before any chunk pushed after.
- **TEST-014** (`createAttachStream`, replay ordering model): simulate main: history `H = 'abc'`, chunks `d1` pushed before the reply (already in `H`), reply (an attach, so `beginLive(true)`), `d2` pushed after. Written output is `'abc' + d2`, with `d1` written once (inside `H`) and never twice.
- **TEST-015** (`PanesFSM`, opt-in start): with a `startAgentTab` spy: `ensureInitialized(wt, { fromMain: true, initialPrompt: 'go', worktree: { repoRoot: '/r/repo', branch: 'feat' } })` on an empty worktree (xterm default) calls it exactly once with the agent tab (carrying `initialPrompt: 'go'`) and that `worktree`, and the tab is already in `store.getSnapshot().state.terminals.panes[wt]` at call time. `addTab(wt, agentTab, undefined, { fromMain: true })` calls it once with that tab, both for an empty worktree (new-leaf commit) and one with tabs (append commit). The same `ensureInitialized` / `addTab` calls without `fromMain` don't call it. `addTab` of a shell or browser tab with `fromMain: true` doesn't. `restartAgentTab` and `convertTabType(..., 'agent')` never call it.
- **TEST-015b** (double start is harmless): wire `startAgentTab` to a real `createAgentSpawner` over the fake `pty` from PAT-001. Call `ensureInitialized` twice for the same worktree: `pty.create` is called once (the second call returns the existing tree). Call `startAgentTab` twice for the same agent tab (simulating a repeated `addTab`/`ensureInitialized` start): the second `spawnAgentTerminal` returns `'attached'` and `pty.create` / `buildSpawnArgs` are still called once.
- **TEST-016** (`PanesFSM`, restored tabs don't start), covering both sleeping-tree promotion branches:
  - Boot-style call: `ensureInitialized(wt)` with no opts on an empty worktree (as `drainBootInit` and the `listChanged` subscriber do) creates the default agent + shell tabs and the spy is not called.
  - `ensureInitialized` branch (`panes-fsm.ts:219-224`): `restoreFromConfig` with a persisted agent tab, then `ensureInitialized(wt, { fromMain: true, initialPrompt: 'x' })` → the sleeping tree is committed to the slice (assert the agent tab is in `state.terminals.panes[wt]`) and the spy is not called.
  - `addTab` branch (`panes-fsm.ts:304-308`): `restoreFromConfig` with a persisted agent tab, then `addTab` of a shell tab → the slice holds the restored agent tab plus the new shell tab, and the spy is not called. Then `addTab` of a new agent tab with `{ fromMain: true }` to the same worktree → the spy is called once, with the new tab only (never the restored one).
- **TEST-017** (`PanesFSM`, json default): with `getDefaultClaudeTabType: () => 'json'`, `ensureInitialized(wt, { fromMain: true, initialPrompt: 'x' })` doesn't call `startAgentTab` (it calls `startJsonClaudeWithPrompt` only when there's a prompt, as today).
- **TEST-018** (`PanesFSM`, regressions): existing `panes-fsm.test.ts` passes unchanged, including `killTabPty` on `closeTab` / `restartAgentTab` / `clearForWorktree`.
- **TEST-019** (manual, desktop, `pnpm log:clear` then `pnpm dev`):
  - (a) Open a worktree with a running agent tab, reload the window (Cmd+R). The tab shows its scrollback with **no** "session restored" line. Paste two lines into Claude's prompt: they arrive as one paste, not two submits.
  - (b) Leave a worktree whose agent is printing (ask it to count to 200 slowly), switch to another worktree for 30 s, switch back. The output has no gap.
  - (c) Quit and relaunch. A restored agent tab starts only when its worktree is opened and resumes the session. On that first view there is no "session restored" line and no old scrollback, because `getHistory` is `''` until `create()` seeds the buffer from disk (CON-004), as today.
  - (d) Two clients on the same terminal (the desktop window plus a web client connected to it): the second client is a spectator, Take control on it resizes the PTY to its viewport, and the first becomes a spectator. Typing from the spectator does nothing.
  - (e) Restart agent tab: old PTY dies, new one starts once (`pnpm log | grep agent-spawn` shows one `spawned` for the new id), tab shows the fresh agent.
  - (f) Shell tabs: a new shell spawns when opened; a restored (asleep) shell wakes on focus and spawns as before.
  - Preconditions for (g) and TEST-020: a main spawn happens only through `ensureInitialized(..., { fromMain: true })` from `onWorktreeCreated` or the `worktrees:externalCreate` handler, and only when the creation carries an `initialPrompt` or `teleportSessionId` (REQ-016). `sessionName` comes from the `worktree` passed with that call (REQ-017), not from `state.worktrees.list`, so with `nameClaudeSessions` on the spawned agent gets `<repo>/<branch>` even though the list hasn't been refreshed yet. Check it (for Claude, the session name shown by `/resume` or in the process args via `ps`).
  - (g) Ask an agent to call `create_worktree` with an `initialPrompt`, don't open the new worktree. `pnpm log | grep agent-spawn` shows `spawned id=<agent tab> ... client=main` right away, and the sidebar status goes to processing without opening it. Opening it later shows the whole run with no gap and the tab sized to the window.
  - (h) Add an agent tab with the "+" menu in the visible worktree: no `client=main` line; one `spawned ... client=<renderer id>` line, and the renderer spawns at its fitted size (no resize flash).
  - (i) Convert a Claude chat tab to terminal: no `client=main` line; the renderer spawns and the agent resumes (`--resume`) once.
  - (j) Boot with several non-merged worktrees: no `client=main` spawn lines at boot (CON-003).
  - (k) Focus a worktree with no persisted tabs (for example remove its entry from `config.json` panes, or add a repo with existing worktrees): no `client=main` line; the renderer spawns the default agent tab at its fitted width.
  - (l) Create a worktree from the UI without a prompt: no `client=main` line; the default agent tab is spawned by the renderer when the worktree is focused.
- **TEST-020** (manual, headless; same preconditions as TEST-019 (g): the prompt arrives via `ensureInitialized(..., { fromMain: true, worktree })`, and `sessionName` comes from that `worktree`): `pnpm build:headless`, start `dist-headless/main/index.js` with no web client open. Trigger `create_worktree` with an `initialPrompt` through the control server (for example from an agent in a tab started earlier, or `curl` against the control server with its token). `ps` shows the agent process for the new worktree and the debug log shows `spawned ... client=main`. Then open the web client: the tab attaches with full history.
- **TEST-022** (`PanesFSM`, no double start): `ensureInitialized(wt, { fromMain: true, initialPrompt: 'go' })`, then `ensureInitialized(wt)` with no opts (the `listChanged` subscriber / renderer activation) returns the same tree, leaves the slice unchanged, and the `startAgentTab` spy is still called exactly once.
- **TEST-023** (`WorktreesFSM`, session-name inputs): the file only tests `sanitizeHeadBranchForLocal` today, so add a `describe` that `vi.mock`s `'../worktree'` (`addWorktree` returns `{ path: '/r/wt', branch: 'feat', … }`, `listWorktrees` returns `[]` until the callback has run, `runWorktreeScript` / `symlinkClaudeSettings` no-ops), `'../repo-config'` and `'../debug'`, builds a real `Store`, and drives `runPending` with an `onWorktreeCreated` spy: it receives `repoRoot` equal to the repo passed in and `branch` equal to the created worktree's branch, and at call time `state.worktrees.list` does not yet contain `createdPath`. Together with TEST-015 (the `worktree` reaches `startAgentTab`) and TEST-012 (`agentSessionName`), this pins the session-name fix.
- **TEST-021**: `pnpm typecheck`, `pnpm build` and `npx vitest run` pass. `bash scripts/smoke-headless.sh` passes after `pnpm build:headless`.

## 7. Risks & Assumptions

- **RISK-001**: The ordering buffer (REQ-013) assumes a request's reply and the `terminal:data` signals sent around it reach the client in send order. For WebSocket this holds (one socket). For Electron, `ipcMain.handle` replies and `webContents.send` messages travel the same renderer IPC pipe and arrive in order in practice, but Electron doesn't document a guarantee. If it is violated, a few bytes around attach are duplicated or dropped, which is no worse than today's `getTerminalHistory`/subscribe gap. TEST-019 (a) and (b) are the check.
- **RISK-002**: A main-spawned tab (`fromMain` only) starts at a sibling's size or 120×30, then resizes when a client mounts, and its history recorded at that size can wrap oddly until the agent redraws on `SIGWINCH`. This only affects tabs no client was guaranteed to be viewing (prompted/teleported new worktrees, later runner steps); every UI-initiated tab is still spawned by the renderer at its fitted size, so the 20px gate's protection is kept where a user is looking. Accepted.
- **RISK-003**: Main now spawns the default agent tab of a prompted or teleported new worktree immediately, whether or not the user opens it. That is the point of the ticket, but it means `create_worktree` fan-out runs agents right away. The workflow runner's concurrency cap (Phase 4 of the plan) bounds this for workflow steps. MCP `create_worktree` was always meant to start the agent.
- **RISK-004**: If a main-started agent exits, the next client mount still respawns it (today's behaviour for any exited agent tab). For a workflow step this would re-run a finished agent when the user opens its tab. Phase 2 must handle it, for example a tab flag that tells XTerminal not to respawn (ALT-006).
- **RISK-005**: Version skew. New renderer + old server: `terminal:attach` rejects, the renderer falls back to `getTerminalHistory` + the legacy spawn path (REQ-014 step 2), which is today's behaviour. Old renderer + new server: the legacy handlers stay (REQ-011); a main-spawned PTY looks to that renderer like a history-bearing attach, so it shows "session restored" and may miss bytes while the tab is hidden, as before this ticket.
- **RISK-006**: Items 5 and 6 add per-terminal env (for example `OPENCODE_CONFIG_CONTENT`) in `agentEnv`. The legacy `pty:create` path only receives an `agentKind` and builds env from config, so an old renderer on a new server won't get that env. Acceptable for skew; note it in Items 5 and 6.
- **ASSUMPTION-001**: `buildAgentCommand`, `writeMcpConfigForTerminal`, `buildClaudeLaunchSettings` and `PtyManager.create` are synchronous (they are today), so a main spawn finishes in the same task as the commit that adds the tab. Any client request about that tab is handled after it. `agentSpawner` is constructed immediately after `ptyManager.setStore(store)` (`index.ts:570`), before `PanesFSM` (~`:725`) and before any transport handler or `ensureInitialized` call can run, so `startAgentTab` never sees it uninitialized.
- **ASSUMPTION-002**: `XTerminal` is keyed by tab id in `WorkspaceView` (the `createPortal(…, slot, tab.id)` key at `:630`; `terminalId={tab.id}` at `:603`), and its mount effect depends on `[terminalId, cwd, type]` (`XTerminal.tsx:616`), so a restarted or converted tab remounts and attaches to the new id.
- **ASSUMPTION-003**: Agent tabs never have `mode: 'asleep'`; only json-claude and shell tabs do (`panes-fsm.ts:184-191`, `terminals.ts:300`). Sleeping logic is therefore untouched by `startAgentTab`.

## 8. Related Specifications / Further Reading

- `plans/dynamic-workflows/milestones/milestone-1-prerequisites/goal.md`, Item 4 (and Item 6, which builds on `AgentSpawnRequest`)
- `plans/dynamic-workflows/dynamic-workflows.md`: "Gaps found" (gap 1), "Architecture" ("Main-side spawn"), "Existing primitives" (row "Visible, steerable sessions"), "Permissions & trust"
- `plans/dynamic-workflows/milestones/milestone-1-prerequisites/tickets/03-hook-payloads-last-message.md`: the runner reads turn ends through `onStopEvent`, keyed by the same terminal id this ticket spawns
- AGENTS.md: "Architecture", "Anti-patterns to avoid in slices and derivers" (#1), "High-frequency streams (terminal data)"

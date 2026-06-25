# Tatsu - Agentic Harness Swarm AGENTS.md

This is the project-wide AGENTS.md for Tatsu - the agentic harness swarm controller.

It documents the project structure and coding conventions.

## What this app is

Tatsu is an Electron App that manages multiple Agentic CLI instances across git worktrees. The user is able to run multiple harness sessions in parallel sessions. Tatsu gives the user a single window to control multiple worktrees. Tatsu also supports the following: sidebar showing worktrees, terminal tabs per worktree, changed-files panel, PR status, hotkey navigation.

**Currently Supported Operating Systems**:
- macOS desktop
- Linux headless / packaged release artifacts

**Currently Supported Agent Harnesses**:
- Claude Code
- Opencode
- Codex
- Pi

## Stack

- **Electron** main process + **React 19 / TypeScript** renderer
- **electron-vite** for the dev/build pipeline
- **xterm.js** + **node-pty** for terminals
- **Tailwind CSS v4** (CSS-imported, no PostCSS plugin) for styling
- **lucide-react** v1.x for icons (note: brand icons like `Github` are NOT exported in this version — use `GitPullRequest` etc.)
- **electron-builder** for packaging, signed with the user's personal Developer ID, notarized
- **electron-updater** for OTA updates from GitHub releases
- **`@anthropic-ai/claude-agent-sdk`** powers Chat tabs through `ClaudeAcpRuntime`, resolving bundled platform-specific native `claude` executable at runtime. Terminal tabs (internally xterm-hosted) still spawn the user's PATH `claude` so power users on bleeding-edge / beta builds keep that experience. Both share `~/.claude/` for auth + MCP config.

## Architecture (read this before touching state)

Currently the app is structured as follows:
- **Main process owns all shared state**
- Renderer is a thin view layer
- A shared transport abstraction carries requests, state events, and side-effect signals over Electron IPC or WebSocket.

**Note**: If you find yourself adding a `useState` to
hold a value that any other client of this workspace would also want,
you're doing it wrong — that value belongs in a slice.

### The store + slice pattern

State is partitioned into **slice packages** under `src/shared/state/`.
Each slice package has:
- An `index.ts` barrel for public exports
- A `<slice>.ts` reducer module
- Optional `types.ts` / `constants.ts` helpers when the slice is large enough
- A `<slice>.test.ts` file with one test per event variant

Current slices: `settings`, `prs`, `onboarding`, `hooks`, `worktrees`,
`terminals` (which also owns `panes` and `lastActive`), `updater`,
`repoConfigs`, `costs`, `browser`, `snooze`, `announcements`,
`scratchpad`, and `json-claude`. `json-claude-todos` lives nearby as a
TodoWrite helper package, not an `AppState` slice. Adding a new piece of
shared state means picking the right slice (or making a new one) and
editing the reducer + event union.

### How a state mutation flows end-to-end

1. **Renderer**: user clicks something. The handler calls a thin backend
   method like `useBackend().setTheme('solarized')`.
2. **Renderer / transport**: `src/renderer/build-backend/build-backend.ts`
   routes the request through the active backend transport from
   `BackendsRegistry`: local Electron preload handle, or remote
   `WebSocketClientTransport`. `connections:*` requests always route to
   the local backend.
3. **Main / transport**: the Electron IPC transport, WebSocket transport,
   or `TransportCompound` receives the request via its generic
   `onRequest` handler, routes it to the registered request processor in
   `src/main/index.ts`, which does the side effect (validation, writing to
   disk, etc.) and **dispatches a typed event** through the store:
   `store.dispatch({type: 'settings/themeChanged', payload: 'solarized'})`.
4. **Main / store**: `src/main/store/store.ts` runs the dispatched event
   through the shared `rootReducer`, updates its in-memory `AppState`,
   bumps a monotonic `seq`, and notifies subscribers.
5. **Main / transport**: each transport forwards the event over its own
   event channel: Electron `state:event` IPC for desktop windows, or WS
   frames for headless/web/remote clients.
6. **Renderer / client store**: `src/renderer/store/store.ts` wires each
   transport's `onStateEvent` directly to that backend's `ClientStore`,
   which applies the **same** shared `rootReducer` to its local mirror.
7. **Renderer / hooks**: `useSyncExternalStore` notifies any component
   reading via `useSettings()` (or the slice-specific hook). React
   re-renders.

The key property: **main and renderer apply the exact same reducer
function** from `src/shared/state/`, so they're guaranteed to stay in
sync with no glue code. The renderer's "client store" is just a passive
mirror.

### Where each kind of state lives

| Kind | Lives in | Why |
|---|---|---|
| Worktree list, panes, terminal status, PR status, settings, hooks consent, onboarding quest, updater status, repo configs, lastActive timestamps | **Main store slices** | Shared world state — every viewer of this workspace needs the same value |
| `activeWorktreeId`, `activePaneId`, modal visibility (`showSettings` etc.), sidebar widths, tree expansion (`collapsedGroups`), form drafts | **Renderer `useState`** | Per-client UI focus / layout — different viewers can validly differ |
| `hooksChecked` Sets, `prevStatusesRef`, debounce refs | **Renderer `useRef`** | Per-session bookkeeping that doesn't survive reload |
| Background polling clocks, dedup state | **Main FSM/poller classes** | Lives wherever the loop runs (PRPoller, ActivityDeriver) |

The test for "is this slice or renderer state": **would a second client
connecting to the same workspace want to see the same value?** If yes,
slice. If no, renderer.

### Package layout and import surface

Most of the `src/` tree uses package-style directories. A moved module
lives in a folder with the same stem as its implementation file:

```
src/main/store/
├── index.ts          # public exports
├── store.ts          # implementation
└── store.test.ts     # tests, when present
```

Package rules:
- Every package-style directory has an `index.ts` barrel and a same-stem implementation file.
- `types.ts` and `constants.ts` exist only when the package has real shared
  types or constants worth extracting.
- Tests move with their package; don't create empty test/type/constants files.
- Imports outside a package should use the package barrel (`./store`,
  `../store`, `../../shared/state/prs`), not deep implementation paths like
  `./store/store` or `../../shared/state/prs/prs`.
- Tests inside a package should prefer the barrel when practical. Use local
  relative imports only when clearly simpler and still inside the package.
- Behavior-preserving package moves should stay mechanical: move files, add
  barrels, update imports, then verify typecheck/build/tests and audit for
  stale deep imports.

### Key files

```
src/
├── shared/state/                  # Slice packages imported by BOTH main and renderer
│   ├── index.ts                   # Root reducer + AppState + StateEvent union
│   ├── settings/                  # Theme, hotkeys, claudeCommand, fonts, …
│   │   ├── index.ts               # Public exports
│   │   ├── settings.ts            # Reducer + initial state
│   │   ├── types.ts               # State/Event types
│   │   ├── constants.ts           # Shared constants
│   │   └── settings.test.ts       # Reducer tests
│   ├── prs/                       # byPath PRStatus, mergedByPath, loading
│   ├── worktrees/                 # list, repoRoots, pending FSM entries
│   ├── terminals/                 # statuses, pendingTools, shellActivity, panes, lastActive
│   ├── onboarding/                # quest step
│   ├── hooks/                     # consent + justInstalled
│   ├── updater/                   # status (checking/available/downloading/…)
│   ├── repo-configs/              # byRepo: per-repo .harness.json contents
│   ├── costs/                     # session usage + cost rollups
│   ├── browser/                   # browser pane state
│   ├── snooze/                    # snoozed worktree/session timers
│   ├── announcements/             # fetched announcement state
│   ├── scratchpad/                # per-worktree notes
│   ├── json-claude/               # ACP/chat sessions, turns, approvals
│   └── json-claude-todos/         # TodoWrite helper package; not an AppState slice
│
├── shared/                        # Shared packages imported by main/preload/renderer
│   ├── state/                     # Root state + slice packages
│   ├── transport/                 # Transport contracts and client helpers
│   │   ├── transport/             # Shared LocalTransportHandle contracts
│   │   ├── transport-websocket/   # Browser/remote WS client transport
│   │   └── parse-connection-url/  # Backend connection URL parser
│   ├── agent-registry/            # Agent metadata helpers
│   ├── cost-summary/              # Cost summary types/helpers
│   ├── github-types/              # GitHub-facing shared types
│   ├── perf-types/                # Perf sample/metric types
│   ├── pricing/                   # Model pricing helpers
│   ├── repo-pick/                 # Repository picker contracts
│   ├── weekly-stats/              # Weekly stats contracts
│   ├── constants/                  # Shared runtime constants
│   └── permission-patterns/        # Permission pattern definitions
│
├── main/
│   ├── index.ts                   # IPC handlers, menu, autoUpdater, store init
│   ├── build-initial-state/       # Hydrates initial AppState from config/runtime inputs
│   ├── store/                     # The authoritative Store class
│   │   ├── index.ts               # Public exports
│   │   ├── store.ts               # Implementation
│   │   └── store.test.ts          # Tests, when present
│   ├── transport-electron/        # Forwards store events to all windows via state:event IPC
│   ├── transport-websocket/       # Headless/websocket transport
│   ├── transport-compound/        # Composes transport surfaces
│   ├── pr-poller/                 # Background PR polling, focus refresh, dedup
│   ├── worktrees-fsm/             # Pending-creation FSM (addWorktree → setup script → outcome)
│   ├── worktree-deletion-fsm/     # Pending-deletion FSM
│   ├── panes-fsm/                 # Every pane/tab mutation (addTab, closeTab, splitPane, …)
│   ├── activity-deriver/          # Subscribes to store, derives + records activity transitions
│   ├── json-claude-status-deriver/# Derives chat status from PTY/tool state
│   ├── pty-manager/               # node-pty lifecycle, dispatches statuses to store
│   ├── hooks/                     # Installs Claude Code hooks, dispatches statuses to store
│   ├── chat-runtimes/             # Chat runtime registry and ACP implementation
│   │   ├── index.ts               # Public exports
│   │   ├── types.ts               # ChatRuntime interface shared by runtime implementations
│   │   └── claude-acp.ts          # ACP chat runtime built on @anthropic-ai/claude-agent-sdk
│   ├── worktree/                  # git worktree CRUD primitives
│   ├── github/                    # GitHub REST API calls
│   ├── github-auth/               # GitHub token resolution
│   ├── repo-config/               # Per-repo .harness.json read/write
│   ├── persistence/               # JSON config at userData/config.json
│   ├── secrets/                   # safeStorage-encrypted secrets
│   ├── control-server/            # Headless control server
│   ├── web-client-server/         # Web client serving for headless mode
│   ├── browser-manager/           # Desktop browser pane manager
│   ├── browser-manager-playwright/# Headless browser manager
│   ├── perf-monitor/              # Event-loop/render/store perf aggregation
│   ├── perf-log/                  # File-based perf trace logger
│   ├── path-fix/                  # macOS login-shell PATH capture
│   ├── debug/                     # File-based debug logger
│   ├── agents/                    # Agent-specific hook installation (Claude, Opencode, Codex, Pi)
│   ├── editor/                    # External editor integration
│   ├── git-ops-state/             # Pending git operations per worktree
│   ├── github-recorder/           # GitHub API response recording for offline access
│   ├── claude-launch/             # Claude process launch utilities
│   ├── claude-auth/               # Claude authentication state
│   ├── agent-kind/                # Agent kind detection
│   ├── fs-listing/                # Filesystem listing helpers
│   ├── repo-resolve/              # Repository resolution logic
│   ├── repo-roots/                # Repository root management
│   ├── repo-create/               # Repository creation
│   ├── worktree-watcher/          # Watches worktree directories
│   ├── snooze-timer/              # Snoozed worktree/session timer management
│   ├── cli-args/                  # CLI argument parsing for headless mode
│   ├── cost-tracker/              # Per-session cost tracking
│   ├── cost-aggregator/           # Cost aggregation
│   ├── mcp-config/                # MCP server configuration injection
│   ├── shell-quote/               # Shell quoting utilities
│   ├── auto-approver/             # Auto-approval of agent actions
│   ├── json-claude-attachments/   # Chat attachment handling
│   ├── jsonl-fold/                # JSONL fold/wrap utilities
│   ├── user-shell/                # User shell management
│   ├── weekly-stats/              # Weekly statistics computation
│   ├── manual-update/             # Manual app update trigger
│   ├── browser-manager-types/     # Browser manager type contracts
│   ├── auto-sleep-monitor/        # User inactivity monitoring
│   ├── announcements-poller/      # Announcements fetching
│   ├── ws-token/                  # WebSocket token management
│   ├── activity/                  # Activity recording primitives
│   ├── window-controls/           # Native window control IPC
│   ├── desktop-shell/             # Desktop shell integration
│   ├── themes-loader/             # Theme file loading
│   ├── persistence-migrations/    # Config migration utilities
│   ├── browser-screenshot/        # Browser screenshot capture
│   └── paths/                     # Platform path utilities
│
├── preload/
│   ├── index.ts                   # contextBridge shell helpers + local transport handle
│   ├── constants.ts               # Preload channel constants
│   └── transport-electron/        # Electron IPC client transport
│
├── web-client/                    # Browser client entrypoint for headless/WebSocket mode
│   ├── main.tsx                   # Wires WS transport into the shared renderer App
│   ├── index.html                 # Web client HTML shell
│   └── public/                    # PWA icons + manifest
│
└── renderer/
    ├── App/                       # Root component, per-client UI focus + JSX
    ├── main/                      # Renderer entrypoint
    ├── store/                     # Client mirror + useSettings/usePrs/usePanes/etc. hooks
    ├── build-backend/             # Builds active backend API from transport registry
    ├── backend/                   # getBackend() / useBackend()
    ├── types/                     # ElectronAPI interface (re-exports shared types)
    ├── hotkeys/                   # Hotkey definitions, parsing, formatting
    ├── worktree-sort/             # Group worktrees by PR status
    ├── themes/                    # Renderer theme definitions
    ├── theme-apply/               # Applies selected theme to document
    ├── syntax/                    # Highlight.js syntax helpers
    ├── worktree-detail-override/  # Per-view worktree detail override helpers
    ├── pending-tool/              # Pending tool display helpers
    ├── branch-name/               # Branch name formatting helpers
    ├── fuzzy/                     # Fuzzy matching helpers
    ├── monaco-setup/              # Monaco worker/config setup
    ├── render-metrics/            # React render performance reporting
    ├── components/                # React components
    └── hooks/
        ├── useHotkeys/            # Keyboard event subscription
        ├── useMetaHeld/           # Meta key detection
        ├── useActiveTheme/        # Active theme resolution
        ├── useSystemColorScheme/  # OS color-scheme subscription
        ├── useViewport/           # Viewport size subscription
        ├── useWatchedQuery/       # Polled async query helper
        ├── useJsonClaudeApprovals/# Json Claude approval helpers
        ├── useTailLineBuffer/     # Rolling tail-line cache for CommandCenter
        ├── useTabHandlers/        # All pane/tab mutation handlers (addTab, splitPane, …)
        ├── useWorktreeHandlers/   # All worktree+repo+pending-creation handlers
        └── useHotkeyHandlers/     # Sidebar-aware hotkey action map + keystroke binding
```

### Adding a new piece of shared state — the checklist

This is more ceremony than just adding a `useState`, but the payoff is
that any future client (web/mobile/another window) gets the value for
free. Pattern is the same for every slice:

1. **Add to the slice package** (`src/shared/state/<slice>/<slice>.ts`):
   - Add the field to the `State` interface
   - Add an `Event` variant for mutations
   - Add a reducer case
   - Update `initial<Slice>`
2. **Wire the root state** (`src/shared/state/index.ts`):
   - Add the slice to `AppState`
   - Add the event type to `StateEvent`
   - Add the slice to `initialState`
   - Add the `rootReducer` routing case
   - Add the slice to `mergeWireSnapshot` so old-server/new-renderer skew is safe
3. **Seed persisted/config-backed values** in
   `src/main/build-initial-state/build-initial-state.ts` when the slice needs
   boot-time config. `src/main/index.ts` constructs `new Store(buildInitialAppState(...))`.
4. **Add the transport mutation handler** (usually in `main/index.ts`):
   ```ts
   transport.onRequest('myslice:setX', async (_ctx, value) => {
     // …validation, persist…
     store.dispatch({type: 'myslice/xChanged', payload: value})
     return true
   })
   ```
5. **Expose in renderer types** — add the method signature to the `ElectronAPI`
   interface in `src/renderer/types/types.ts`. The preload (`src/preload/index.ts`) no longer
   needs per-method wiring — it exposes a single generic `LocalTransportHandle`, and
   `src/renderer/build-backend/build-backend.ts` auto-builds the full `window.api` surface
   from the transport's `request()` method.
6. **Add reducer and wire-merge tests** in `src/shared/state/<slice>/<slice>.test.ts`
   (one per new event variant) and `src/shared/state/wire-merge.test.ts` (new slices or persisted fields).

The renderer reads the value via the existing `useSettings()` /
`usePrs()` / etc. hook automatically — no new subscription code.

### High-frequency streams (terminal data)

State events are for **mutations**. They go through the reducer and
trigger React re-renders. This is fine for events that fire a few times
per second.

PTY data is **not** a state event — it's a side-effect signal. It flows
through its own `terminal:data` signal channel directly to xterm.js via
`backend.onTerminalData`. If we put it through the reducer, every
byte from a noisy build would re-render the world. The same conceptual
distinction applies for any future high-frequency stream.

### How the FSMs / pollers / derivers interact with the store

Some main-side modules subscribe to the store and react to events:

- **`PRPoller`** — owns background polling cadence + dedup. Dispatches
  `prs/*` events. Doesn't subscribe to anything; called externally on
  events that should kick a refresh (focus, worktree add, manual
  refresh button).
- **`WorktreesFSM`** — runs the pending-creation state machine
  (addWorktree → setup script → outcome). Dispatches `worktrees/*`
  events. On success, fires an `onWorktreeCreated` callback that the
  host wires to (a) PR poller refresh and (b) `panesFSM.ensureInitialized`.
- **`PanesFSM`** — owns every pane/tab mutation. Dispatches
  `terminals/panes*` events. Auto-persists panes to disk after each
  mutation.
- **`ActivityDeriver`** — actively *subscribes* to the store. Watches
  `terminals/*` and `prs/*` events, computes per-worktree effective
  state, debounces `lastActive` updates, dedups `recordActivity` calls
  to `activity/activity.ts`.
- **`installHooksForAcceptedWorktrees`** — small subscriber in
  `main/index.ts` that listens for `worktrees/listChanged` and
  `hooks/consentChanged`, installs hooks into any new worktree if
  consent is `'accepted'`.
- **`WorktreeDeletionFSM`** — runs the pending-deletion state machine.
  Dispatches `worktrees/*` events.
- **`JsonClaudeStatusDeriver`** — derives chat status from PTY/tool state.
- **`AnnouncementsPoller`** — fetches and dispatches announcement state.
- **`AutoSleepMonitor`** — monitors user inactivity and dispatches sleep events.
- **`SnoozeTimer`** — manages snoozed worktree/session timers.
- **`CostTracker`** — tracks per-session usage costs.
- **`WorktreeWatcher`** — watches worktree directories for changes.
- **`GitOpsState`** — tracks pending git operations (fetch/push/etc.) per worktree.
- **`GithubRecorder`** — records GitHub API responses for offline access.
- **`ClaudeAuth`** — manages claude authentication state.
- **`AutoApprover`** — manages auto-approval of agent actions.
- **`McpConfig`** — manages MCP server configuration injection.

Construction order in `main/index.ts` matters: `PanesFSM` is constructed
**before** `WorktreesFSM` because the latter's `onWorktreeCreated`
callback closes over `panesFSM`. Don't reorder without thinking.

### Anti-patterns to avoid in slices and derivers

The store-and-slice architecture is sharp. Four common mistakes turn it
into a quadratic CPU sink. All four are caught either at code review or
by the cascade detector in `src/main/store/store.ts`, which logs a `[cascade]`
line to `perf.log` whenever one root event triggers more than 5 nested
dispatches.

**1. Subscribers that sweep all entities on every event.** A
`store.subscribe(...)` listener that loops over every session / worktree
/ PR on each event is the most common form of this bug. Streaming
events fire 30+ times per second; with N entities, that's `N × token_rate`
dispatches per stream. Always pull the affected entity id out of the
event payload and re-derive only that one. If the event genuinely
affects everything (e.g. the whole tree was replaced), say so in a
comment so the sweep is self-documenting.

**2. Derivers that dispatch identity events.** Even when scoped to a
single entity, a deriver should cache its last-derived value per entity
and skip the dispatch when nothing changed. Most "status" derivations
don't change between adjacent streaming tokens — the dedup is the
difference between "once per turn" and "once per token."

**3. Reducers that lose reference identity on single-item patches.**
`collection.map((x) => x.id === target ? patch(x) : x)` always allocates
a new array, even when nothing matched. Downstream `useSyncExternalStore`
selectors that hold a reference to the array see "changed" and
re-evaluate. Use `findIndex + slice` instead: `return state` when no
match, otherwise build the new array as
`[...arr.slice(0, i), patched, ...arr.slice(i + 1)]`. Untouched entries
keep their reference; downstream selectors don't fire.

**4. Renderer hooks that read whole maps then filter in JS.** A hook
like `useJsonClaude()` that returns the entire slice causes every
consumer to re-evaluate on any change to any entity. Add a per-id
selector (`useJsonClaudeSession(id)`) and use that in components that
care about one entity. The whole-slice hook is only correct in the few
places that genuinely need the full map (sidebar grouping, etc.).

**Diagnosing in production.** The HUD at Cmd+Shift+D shows live event
rates and a stacked bar of which event types are firing most. The
`perf.log` file (see "How performance debugging works" below) captures
per-event detail including `[cascade]` lines when these anti-patterns
fire. If you see a `[cascade]` line for a streaming event type, suspect
anti-pattern #1 first.

### How the renderer reads + mutates state

```tsx
// Read — re-renders this component when the slice changes.
const settings = useSettings()
const theme = settings.theme

// Mutate — calls through the active backend transport. The store dispatches
// and the read above re-renders automatically.
const backend = useBackend()
backend.setTheme('solarized')
```

The renderer **never holds a local copy of shared state**. There's no
"I'll keep my own `themeState` and re-fetch" pattern anywhere. If you
catch yourself writing `useState` for a value that came from the store,
delete it and read via the hook.

Per-client UI state (active worktree, modal visibility, sidebar width)
**stays as `useState` in `src/renderer/App/App.tsx`** — those are inherently per-viewer.

### Why "where does this live" can take a few file hops to answer

A `useSettings().theme` read traces through:
1. `src/renderer/App/App.tsx` calls the hook
2. `src/renderer/store/store.ts` defines the hook (`useAppState((s) => s.settings)`)
3. `useSyncExternalStore` reads from the client mirror in `src/renderer/store/store.ts`
4. The mirror was populated by a `state:event` IPC message
5. Main dispatched that event from an IPC handler in `main/index.ts`
6. The handler ran the reducer in `src/shared/state/settings/settings.ts`

Six files for one value. The mitigation: **the structure is the same
for every slice**. Once you understand it once, every other slice
follows the same path. Search for "settingsReducer" or grep for the
event type if you're trying to find where something happens.

## How status detection works

**agent-specific hooks** (per agent in `src/main/agents/`) that we install into each worktree's
configuration (`.claude/settings.local.json` for Claude, `~/.config/opencode/plugins/` for
Opencode, `~/.pi/agent/extensions/harness-status.ts` for Pi, `~/.codex/hooks.json` for
Codex). The hooks write status events as NDJSON to
`/tmp/harness-status/<terminal-id>.ndjson` and the main process watches that
directory via `fs.watch`. The hook scripts use `$HARNESS_TERMINAL_ID` env var
(set by the PtyManager) with `$CLAUDE_HARNESS_ID` as a legacy fallback.

## How performance debugging works

Two log files in `userData`:

- **`debug.log`** — categorical events. **Append-only across sessions**
  (same persistence model as `perf.log`) so crash forensics from before
  the most recent restart are still inspectable. Rotated at 10MB into
  `debug.log.1` (one archive only). Tail with `pnpm log` (uses
  `tail -F` so it survives rotation). Manual clear via `pnpm log:clear`
  (removes both `debug.log` and `debug.log.1`).
- **`perf.log`** — perf trace. **Append-only across sessions** so lag
  that happened earlier (possibly before the most recent restart) is
  still inspectable. Tail with `pnpm log:perf`. Clear before a fresh
  repro with `pnpm log:perf:clear`.

What gets written to `perf.log` (and where the threshold lives):

- `[store-slow]` — any `store.dispatch` whose reducer + listener fan-out
  totals ≥ `SLOW_DISPATCH_MS` (5 ms; `src/main/store/store.ts`).
- `[ipc-slow]` — any IPC request or fire-and-forget signal handler that
  takes ≥ `SLOW_IPC_MS` (50 ms; `src/main/transport-electron/transport-electron.ts` and
  `src/main/transport-websocket/transport-websocket.ts` — both transports are wrapped so
  headless gets the same trace).
- `[eventloop-spike]` — main-process event-loop lag (timer drift on a
  500 ms interval) ≥ `LAG_SPIKE_THRESHOLD_MS` (100 ms;
  `src/main/perf-monitor/perf-monitor.ts`).
- `[snapshot]` — one summary line every `SNAPSHOT_INTERVAL_MS` (30 s)
  with current rates, lag, RSS, active PTYs, and top event types. Cheap
  continuous trace for "what was happening at <timestamp>".
- `[render-slow]` — React commits ≥ `SLOW_COMMIT_MS` (16 ms = one frame
  at 60 fps; `src/renderer/main/main.tsx`). Forwarded from the renderer over
  the `perf:logSlowRender` fire-and-forget signal — telemetry must not
  block the render.
- `[changed-files]` — every `getChangedFiles` / `getCommitChangedFiles`
  call (these are infrequent and a complete trace is invaluable).
- `[git-op]` — per-call timing breakdown for slow git functions, capturing exec/post/bytes split.
- `[microtask-drift]` — main-thread blocks ≥50ms (higher resolution than the 500ms event-loop sampler).

The HUD at **Cmd+Shift+D** shows live aggregates (rates, history sparkline,
React commits per second, top event types). `perf.log` captures the
per-event detail the HUD can't display. They're complementary —
`PerfMonitor` aggregates for the HUD, `perfLog` writes discrete
slow-event lines.

For AI agents debugging perf: ask the user to `pnpm log:perf:clear`,
reproduce, then tail `perf.log` and look for the slow-* lines around the
reported timestamp.

## How GitHub integration works

The user pastes a GitHub personal access token into Settings. It's encrypted
via `safeStorage` and stored in `userData/secrets.enc`. All GitHub data
(PR status, check runs, statuses) goes through the `src/main/github/` package using
`fetch()` against the REST API.

Token resolution lives in the `src/main/github-auth/` package and runs once at boot
(re-runs on a 401): an explicit PAT in `secrets.enc` or `GITHUB_TOKEN` wins,
then `gh auth token` (spawned through a login zsh so Homebrew's `gh` is on
PATH), then nothing. The `gh` CLI is an **optional** auto-detect convenience
— if it's installed and authenticated, Harness uses its token automatically;
if not, the PAT paste flow in Settings is still the fallback. Harness has no
hard dependency on `gh`.

## Important quirks

- **Worktree dep installs** — For fresh git worktrees, always run `pnpm install` once before building. 
- **node-pty rebuild** — `node-pty` compiles against a specific Electron version. 
  After running `pnpm pack` or `pnpm dist*`, the postdist hook runs `electron-rebuild -f -w node-pty` to 
  keep dev mode working. If dev mode ever errors with `posix_spawnp failed`, run
  `pnpm rebuild:dev` manually.
- **Hooks consent** — The first time a user activates a worktree, we show a banner 
  asking for permission to install hooks. Never write to user files without permission. 
- **Login shell wrapping** — the PtyManager spawns `/bin/zsh -ilc <command>`
  instead of running the command directly, so the user's full PATH is loaded
  (homebrew binaries, nvm, etc.).
- **Login-shell PATH fix at boot** — at boot we run the user's login shell once
  via the `src/main/path-fix/` package to capture its PATH and **merge** into `process.env.PATH`.
  Without this, the bundled claude (spawned directly, not via shell) inherits
  whatever stripped PATH Harness was launched with and can't find homebrew/
  nvm/pyenv tools. The fix runs in both Electron-local boots (Finder/Dock
  launches with `/usr/bin:/bin:/usr/sbin:/sbin`) and headless boots
  (`ssh host 'harness-server'` / systemd / launchd run non-interactive
  non-login = same stripped PATH). Merge order: existing entries that aren't
  already in captured come first, then the full captured list — preserves
  launcher-prepended entries like pnpm's `node_modules/.bin` in `pnpm dev`
  while still appending Homebrew/nvm. The probe uses sentinel-wrapped output
  so rc-file noise (starship init, nvm welcome) is discarded cleanly. Gated
  to macOS only; linux can be added if anyone reports the same problem.
- **Auto-updater is dev-mode no-op** — `setupAutoUpdater()` returns early
  unless `app.isPackaged`.
- **Dual browser-controller** — Browser tabs are backed by Electron's
  `WebContentsView` in desktop mode and by `playwright-core` in headless
  mode. Both implement the `BrowserManagerLike` contract so MCP tools,
  the control server, and the pane reconciler call the same surface.
  `playwright-core` is a runtime dep but **doesn't bundle Chromium** —
  the user provides one. Resolution: `HARNESS_PLAYWRIGHT_BROWSER`
  env var first (path to a Chromium executable), else Playwright's
  `channel: 'chrome'` (system Chrome on macOS/Win/Linux). If neither
  resolves, the first `create_browser_tab` MCP call throws a clear
  message. The headless renderer (web client) renders a polled JPEG
  via `RemoteBrowserView` instead of a native overlay — live screencast
  is a follow-up.
- **Multi-backend (Tier 1)** — 1 Electron instance can connect to 
  to N backends (the in-process local one + remote `harness-server`
  instances), with a button at the end of the sidebar to swap. 
    - Full design is at `plans/tier-1-multi-backend-ux.md`. 
- **Terminal tabs vs ACP chat tabs** — **Terminal tabs** (internally
  xterm-hosted) spawn `/bin/zsh -ilc (cli)` so the user's PATH is what runs.
    - This allows multiple CLI agents (`claude`, `opencode`, etc.) to be integrated.
  **Chat tabs** still use the `jsonClaude:*` transport surface,
  but main routes those calls through `ChatRuntimeRegistry` into
  `ClaudeAcpRuntime`, which uses `@anthropic-ai/claude-agent-sdk`'s
  `query()` API. 
- **External Name vs Internal Name**: Externally, the app is to be shown as "Tatsu" (External Readme, App components). 
  Internally, there are parts that mention the old name "Harness". These parts are more critical and changing it can break things. 
  For now, refer to these parts as Harness if you see it, but keep any customer facing parts showing the new name. 

## Workflow conventions

This is how you are to behave when working on this repo. 

### General Guidelines

1. **Commit as you go.** All changes are to use a descriptive commit message. Do not batch multiple feature in one commit. 

2. **Push after every commit.** Always run `git push origin <branch>`
   immediately after a commit succeeds. 

3. **Verify before committing.** After any TS/TSX change, run both:
   - `pnpm typecheck` — catch type errors across main + renderer via
     project references. `electron-vite build` does NOT run `tsc`, so the
     build alone will miss type errors.
   - `pnpm build` — catches missing imports, asset resolution, desktop bundle,
     renderer bundle, and web-client bundle issues.
   Run `npx vitest run` too if the change could affect reducer/FSM behavior.
   Catch issues before the PR-time CI check (`.github/workflows/ci.yml`) does.

4. **Don't add comments unless asked.** Code should explain itself; comments
   are reserved for non-obvious "why" notes. The exception is the comment
   blocks already present in:
    - `src/main/store/store.ts`
    - `src/main/index.ts` (around the panesFSM/worktreesFSM construction)
    - `src/shared/state/index.ts` 
    - `src/renderer/store/store.ts`
    - `src/main/activity-deriver/activity-deriver.ts`
   These sections document architectural decisions and should be preserved.

5. **State changes go through slices, not `useState`.** Do not add `const [x, setX] = useState(...)` 
   in the renderer for a value that should survive a reload or be visible to other clients.
   Add it to a slice instead — see "Adding a new piece of shared state"
   above. Per-client UI focus / modal visibility / sidebar widths stay
   as `useState` in `src/renderer/App/App.tsx`; everything else is a slice.

6. **Don't write planning/decision documents.** Work from conversation
   context. Don't create scratch markdown files or design docs.

7. **Surface secrets concerns.** Warn the user once if they paste 
    a token or password that is in now in conversation history
    and should be rotated.

8. **Don't put boxes around screenshots on the marketing site.** No
   `border`, no `border-radius` wrapper, no glow `box-shadow` framing.
   The dark background on `site/public/*.html` is already the frame;
   adding a border to an `<img>` makes it look enclosed in a card it
   isn't part of. Plain `<img>` (width 100%, `display: block`) is the
   right default. 

9. **GitHub comments use a standard signature.** You're authorized to leave
   comments on issues and PRs (via the `gh` CLI or the GitHub REST/GraphQL
   API) without re-confirming each time. Make sure these comments end
   with the following signature:

   ```
   _Comment left on behalf of @<github-username> by <agent-name> via [Harness](https://github.com/frenchie4111/harness)._
   ```

   - `<github-username>` is the user's GitHub login — run
     `gh api user --jq .login` if you don't already know it from context.
   - `<agent-name>` is the agent identity from the harness session (Claude,
     Codex, etc.).
   - Markdown italics (`_..._`) so the signature renders subtly without
     dominating the comment body.

   This authorization covers commenting and reacting. **Destructive GitHub
   actions still need confirmation**: closing/reopening issues, merging or
   closing PRs, force-pushing, deleting branches or releases, etc. When in
   doubt, ask.

10. **Use the canonical text and icon sizes so the UI scales together.**
    The renderer's root `html` font-size is driven by the `uiScale`
    setting, so every `rem`-based size (Tailwind `text-*` and the `w-N` /
    `h-N` grid) shifts in lockstep. Inline pixel sizes do NOT scale and
    will look wrong at the larger rungs.

    **Text — pick from this set only:**
    `text-xs`, `text-sm`, `text-base`, `text-lg`, `text-2xl`, `text-3xl`.
    No `text-[Npx]`, no inline `style={{ fontSize: ... }}`, no `text-xl` /
    `text-4xl` / `text-5xl`. If the design seems to call for an
    in-between size, snap to the nearest canonical step — the per-px
    hierarchy doesn't earn its keep against the visual noise.

    **Icons — use the `icon-*` aliases, not the lucide `size={N}` prop
    or raw `w-N h-N` classes.** The lucide `size` prop bakes pixel
    literals into the SVG `width` / `height` attributes, so icons stay
    fixed regardless of root font-size. `icon-*` is a rem-based alias
    defined in `src/renderer/styles.css` via Tailwind v4's `@utility`,
    and mirrors the `text-*` ladder. Pick from this set only:

    | utility    | px   |
    |---         |---   |
    | `icon-2xs` | 10px |
    | `icon-xs`  | 12px |
    | `icon-sm`  | 14px |
    | `icon-base`| 16px |
    | `icon-lg`  | 20px |
    | `icon-xl`  | 32px |

    Example: `<Loader2 className="icon-sm animate-spin" />`. If a
    design genuinely wants 18px or 26px (one-offs), use
    `w-[1.125rem] h-[1.125rem]` / `w-[1.625rem] h-[1.625rem]`. If the
    rung you need would be the third callsite of that one-off, add a
    new `@utility` entry in `styles.css` and use that instead.

    Note: `w-N h-N` literals are still correct for *non-icon* fixed-size
    boxes that the design doesn't want growing with `uiScale` — color
    swatches, decorative dots, avatar circles. Checkboxes are NOT in
    this set; treat them as icons (use `icon-base`) so the hit target
    scales with the rest of the UI.

    Exceptions where pixel literals are correct (because the consumer
    isn't part of the rem grid): Monaco/XTerminal font sizes, the
    PerfMonitor HUD's SVG numerics, JsonModeChat's
    `--chat-{body,chrome,meta}-text` CSS variable system, ReviewDiffPane
    inline styles inside Monaco view zones, and non-icon components
    that legitimately take a pixel size (e.g. `<QRCodeSVG size={128} />`).


## Releasing

End-to-end release is automated via `pnpm release <version>`:

```
pnpm release 1.0.1
```

The script handles preflight checks, version bump, README link updates,
build/sign/notarize, tag/push, release notes from `git log`, and
`gh release create` with all artifacts attached. Notarization needs
`.env` with `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

Linux release builds now produce both `.deb` (Ubuntu/Debian) and
`.AppImage` (every distro) — both attached to the GitHub release
automatically by `.github/workflows/build-linux.yml` on tag push.
macOS release builds are handled by `.github/workflows/build-mac.yml`.
`.github/workflows/release.yml` orchestrates the full release flow.
`.github/workflows/deploy-site.yml` deploys the marketing site.

### Headless smoke test on every PR

PR CI (`.github/workflows/ci.yml`) runs `scripts/smoke-headless.sh`
after the typecheck / build / tests block. The script launches
`dist-headless/main/index.js` on an ephemeral port, parses the
`[web-client] open ...` URL out of its stdout, delegates HTTP
validation to `scripts/web-smoke.mjs` (auth gate + HTML + asset
reach) and WS validation to `scripts/ws-smoke.mjs` (upgrade +
snapshot round-trip), then SIGTERMs and confirms clean shutdown.
Catches tarball-layout / module-resolution / boot-time regressions
before they ride a tag push to release. Run locally:
`pnpm build:headless && bash scripts/smoke-headless.sh`.

### Headless tarballs

The `Headless Release` workflow (`.github/workflows/headless-release.yml`)
fires on the same tag push and runs a three-platform matrix
(`darwin-arm64`, `linux-x64`, `linux-arm64` — Intel Mac is omitted
because the macos-13 runner queue is too unreliable). Each runner
calls `pnpm pack:headless`, which downloads a pinned Node binary
(`NODE_VERSION` in `scripts/pack-headless.mjs`), rebuilds `node-pty`
against that ABI, and assembles a self-contained tarball at
`release/headless/harness-server-<version>-<platform>.tar.gz` plus
`.sha256`. The job uploads both as release assets — no extra step in
`scripts/release.sh` is needed. Bumping `NODE_VERSION` requires
matching the `actions/setup-node` step in the workflow.

## Common commands

| Command | What it does |
|---|---|
| `pnpm dev` | Launch in dev mode (electron-vite) |
| `pnpm log` | Tail the debug log file |
| `pnpm log:clear` | Clear the debug log |
| `pnpm log:perf` | Tail the perf trace log (append-only across sessions) |
| `pnpm log:perf:clear` | Clear the perf trace log (use before a fresh repro) |
| `pnpm build` | Build desktop bundles (main, preload, renderer) plus web client |
| `pnpm pack` | Build + package without distribution (no signing) |
| `pnpm dist:mac` | Full signed + notarized macOS build |
| `pnpm rebuild:dev` | Rebuild node-pty for dev Electron |
| `pnpm release <ver>` | Full end-to-end release |

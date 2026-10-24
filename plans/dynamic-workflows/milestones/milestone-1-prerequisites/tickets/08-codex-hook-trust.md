---
goal: Keep Tatsu's Codex hook entries at stable positions in ~/.codex/hooks.json, report their /hooks trust status read-only through the hooks slice, show "Codex hooks need review: run /hooks" in Settings, and write the Codex feature flag as [features] hooks
date_created: 2026-10-02
status: 'Planned'
tags: [feature, bug, codex, hooks, trust, milestone-1, dynamic-workflows]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Milestone 1, Item 8. Closes gap 9 ("Codex skips untrusted hooks") and gap 4 ("Codex hooks flag name drift") in `plans/dynamic-workflows/dynamic-workflows.md`, "Gaps found". Size M. No dependencies (soft dependency on ticket 07, see DEP-001).

Since rust-v0.129.0, Codex ignores user hooks until the user approves them in `/hooks`. Approval is stored in `<codex home>/config.toml` (`$CODEX_HOME`, default `~/.codex`) as `[hooks.state."<key>"] trusted_hash = "sha256:…"`. The key is `<abs path of hooks.json>:<event_snake>:<group_index>:<handler_index>`, so it depends on **position**. The hash covers the normalized entry (plan, "Harness research" → "Codex hook trust").

Today (`src/main/agents/codex.ts`):

- `installHooks()` (`:132-152`) runs on every boot when consent is `accepted` (`src/main/index.ts:3183` via `installHooksGlobally()`, `:815-822`). It strips every Tatsu entry and re-appends one per event at the end of each array, then always rewrites `hooks.json`. If the user (or another tool) adds a hook after Tatsu's entry, the next boot moves Tatsu's entry to a new index: it becomes `untrusted` and the user's hook shifts into Tatsu's old slot and shows `modified`. This machine already has a third-party tool's hooks at index 0 for `Stop`, `PostToolUse` and `UserPromptSubmit` in `~/.codex/hooks.json`, so Tatsu's entries for those events sit at index 1.
- Nothing reports trust. Settings (`src/renderer/components/Settings/Settings.tsx:1710-1715`) and the consent banner (`src/renderer/App/App.tsx:1280-1281`) only tell users to run `/hooks` once (added in `7edfc85`). A user who never did, or whose entries moved, gets no Codex status and no Stop hook with no visible cause.
- `ensureCodexHooksEnabled()` (`:96-118`) writes `codex_hooks = true` under `[features]` (placement fixed in `156d4a1`). Current Codex docs name the flag `[features] hooks` (default on). The guard is a substring test, `content.includes('codex_hooks')`.

After this ticket:

1. `installHooks` keeps each Tatsu entry at its index when an identical entry is already there, replaces only legacy or mismatched Tatsu entries **in place**, and does not write `hooks.json` when nothing changed.
2. A read-only helper computes each Tatsu entry's key and hash and compares them with `[hooks.state."<key>"]` in `config.toml`. A unit test pins the hash to a known value.
3. The summary lives in the `hooks` slice. Settings shows "Codex hooks need review: run /hooks" when any Tatsu entry isn't trusted. The Phase 3 launch-sheet readiness check will read the same field.
4. The flag is written as `[features] hooks = true`. An existing `codex_hooks` or `hooks` key (any value) is left alone.
5. Tatsu never writes `trusted_hash`. The opt-in "Trust automatically" action is out of scope.

### Slice vs request/response (AGENTS.md test)

The trust summary describes the backend machine's Codex home (`~/.codex` or `$CODEX_HOME`), not a viewer's focus. A second client on the same workspace (another window, the web client, a remote Electron connected to `harness-server`) must see the same value, and the future launch sheet reads it from any client. So it is **slice state**: a new field `codexTrust` in the existing `hooks` slice (it already holds hook consent), set by one event `hooks/codexTrustChanged`. Main keeps it fresh by watching the Codex home and dispatches only when the summary changes (anti-pattern #2). A request/response query was rejected (ALT-003). Precedent: `updater.status` is the same kind of machine-level, main-pushed value and lives in a slice. `claude:getAuthStatus` and Settings' `getAvailableEditors`/`getDefaultClaudeCommand` are requests because nothing changes them while the window is open; Codex trust changes when the user runs `/hooks` in a terminal tab. `useWatchedQuery` is per-worktree and doesn't fit a machine-level value. Version skew: an older renderer's `hooksReducer` ignores `hooks/codexTrustChanged` (no matching case), and an older server's snapshot merges to `codexTrust: null`, so Settings shows nothing.

### Hash rules (from Codex source `openai/codex@c5d242f`, to be verified in TASK-001)

For handler `h` at `hooks[<Event>][g].hooks[i]` in the file at absolute path `P`:

- **Key**: `` `${P}:${snake(Event)}:${g}:${i}` ``, where `snake('SessionStart') = 'session_start'`, `PreToolUse → pre_tool_use`, `PostToolUse → post_tool_use`, `UserPromptSubmit → user_prompt_submit`, `Stop → stop`.
- **Identity**: `{ event_name, matcher?, hooks: [ { type, command, timeout, async, statusMessage? } ] }` for that single handler. `matcher` is omitted when absent and always dropped for `UserPromptSubmit` and `Stop`. `timeout` is always present as `Math.max(1, h.timeout ?? 600)` (Tatsu's events only; the `SessionEnd`/`Interrupt` defaults below are not modelled). `async` defaults to `false`. `statusMessage` is omitted when absent. `command` is the raw string. `event_name` is assumed to be the same snake string as the key; TASK-001 settles it.
- **Hash**: `'sha256:' + sha256hex(canonicalJson(identity))`. `canonicalJson` sorts object keys recursively (arrays keep their order) and uses no whitespace (`JSON.stringify` with no indent after sorting).
- **Status**: `[hooks.state."<key>"].enabled === false` → `disabled`. `trusted_hash === hash` → `trusted`. `trusted_hash` is another string → `modified`. No entry or no `trusted_hash` → `untrusted`.

Worked identity for Tatsu's Stop entry with home `/h`:

```json
{"event_name":"stop","hooks":[{"async":false,"command":"bash '/h/.codex/harness-hook.sh' Stop","timeout":5,"type":"command"}]}
```

**Source check (2026-10-02, `openai/codex` tags `rust-v0.129.0` and `rust-v0.160.0`).** The rules above are confirmed.
- Key: `hooks/src/lib.rs` `hook_key`, `{key_source}:{event}:{group}:{handler}`, where `key_source = <hooks.json path>.display()`.
- Event name: the same snake label in both key and identity (`hook_event_key_label`).
- Identity: `hooks/src/engine/discovery.rs` `NormalizedHookIdentity { event_name, #[serde(flatten)] MatcherGroup }`, with `hooks` = the single normalized handler. It is converted to `toml::Value`, so `None` fields are dropped, then hashed by `config/src/fingerprint.rs` `version_for_toml`: serde_json value, keys sorted recursively, compact `serde_json::to_vec`, SHA-256, `sha256:` + lowercase hex.

Details the rules above leave out:
- `timeout` is always present, normalized. A missing value hashes as `600` (min `1`). `SessionEnd`/`Interrupt` default to `1`, clamped to `1..3`.
- `commandWindows` is never hashed.
- `additionalContextLimit` (0.160) is hashed only when set, ≠ 2500, and on PreToolUse/PostToolUse/SessionStart/UserPromptSubmit/SubagentStart.
- `matcher` is also dropped for `Interrupt`, and is otherwise kept verbatim (e.g. `"*"`).
- `command` is hashed before `${VAR}` substitution.
- Path: the `hooks.json` path is not realpath'd, but `find_codex_home` **canonicalizes `$CODEX_HOME` when it is set** (`utils/home-dir/src/lib.rs`). The default `~/.codex` is built from the home dir without canonicalizing. So a `mktemp -d` `CODEX_HOME` probe on macOS yields `/private/var/…` keys. Tatsu's `~/.codex` keys use the `$HOME` spelling as is. Tatsu mirrors this with one rule, `resolveCodexHome` (ticket 07 REQ-004), used as `codexHomeDir()` (REQ-010).
- Today `codex.ts` ignores `CODEX_HOME`: `globalHooksPath` (`:39-40`), `hookScriptPath` (`:43-44`), `ensureCodexHooksEnabled` (`:97`, log text `:114`), `sessionFileExists` (`:191`) and `latestSessionId` (`:210`) all hardcode `join(homedir(), '.codex', …)`. Codex tabs inherit `CODEX_HOME` from main (`pty-manager.ts:146` spreads `process.env`), so with `CODEX_HOME` set, Codex reads a home Tatsu never writes and Tatsu's hooks are already dead. This ticket derives every Codex path from `codexHomeDir()` (REQ-010).
- Trust state is read only from the user `config.toml` and from `-c` session flags (`hooks/src/config_rules.rs` `hook_states_from_stack`). `/hooks` writes `hooks.state."<key>".trusted_hash`.
- Codex ≥ 0.131.0 also has `--dangerously-bypass-hook-trust`, which runs hooks without stored trust for one invocation. It is out of scope here, like any self-approval (CON-003).

Hashes computed from these rules with Node `crypto` (no binary run):
- `Stop`: `sha256:4f1aa7bed366149ee244fb905269c4c01a5529accac1f4a405529d3888ef9f8c`
- `SessionStart`: `sha256:96cc81a196212d261ff38a60c5017702fa38431245cc4f6d1b96b0af85b32576`
- `PreToolUse`: `sha256:94034b6614dd94e8b983d01f818076b38d60e5f5916119ba5ee07f82fa771f61`

All three are for command `bash '/h/.codex/harness-hook.sh' <Event>` with `timeout: 5`. Codex source has no published numeric vector.

Flag: `features/src/lib.rs` `FeatureSpec { id: CodexHooks, key: "hooks", stage: Stable, default_enabled: true }` at both tags. `codex_hooks` is a legacy alias for the same feature (`features/src/legacy.rs`).

## 1. Requirements & Constraints

- **REQ-001**: `installHooks()` per event `E` in `hookEvents`, with `desired = makeHarnessHookEntry(makeCodexHookCommand(E))` and `arr = data.hooks[E] ?? []`:
  1. `owned` = indices `j` where `isHarnessHookEntry(arr[j])`.
  2. `keep` = the first `j` in `owned` where `isIdenticalHarnessEntry(E, arr[j], desired)` (REQ-002). If found, `arr[keep]` is not touched.
  3. Else, if `owned` is non-empty, `keep = owned[0]` and `arr[keep] = desired` (in-place replace, so later user entries keep their index).
  4. Else, push `desired` (`keep = arr.length - 1`).
  5. Remove every other index in `owned` (duplicates, legacy). Removing an owned entry **before** `keep` shifts it down by one. That only happens with pre-existing duplicates or legacy entries placed before a current one, and costs one re-review.
  - An owned group is matched and replaced (or removed) as a whole, including any non-Tatsu handlers that share it. This is existing behaviour (`isHarnessHookEntry` is `some(handler)`, and `removeOldHarnessEntries` drops whole groups); this ticket does not change it.
  - For events present in the file but not in `hookEvents`, remove owned entries as today (`removeOldHarnessEntries`). Leave empty arrays for those events as they are now (no new deletion behaviour).
  - Track a `changed` boolean through all of the above. When `changed === false`, do **not** call `writeHooksFile`.
- **REQ-002**: `isIdenticalHarnessEntry(event, entry, desired)` returns `codexHookIdentityJson(event, entry)` equality for single-handler entries: `entry.hooks.length === 1` and canonical identity JSON (from `src/main/codex-hook-trust`, REQ-006) of `entry` equals that of `desired`. This treats `async: false` as equal to absent (Codex may normalize `hooks.json` when it rewrites it), and treats a different `command`, `timeout`, `type`, a present `matcher` (except on `UserPromptSubmit`/`Stop`) or a `statusMessage` as a mismatch. Do not add extra keys to `desired`.
- **REQ-003**: `installHooks()` keeps calling `writeHookScript()` first, before the strict `hooks.json` read, so the script is written even when `hooks.json` is unreadable (TEST-001(h)). Then: if `hooks.json` exists but fails `JSON.parse` (or parses to a non-object), log `log('hooks', 'codex hooks.json unreadable; not modified', { path })` and return without writing. Today it overwrites the user's file with Tatsu-only entries. Add a `readHooksFileStrict(path): { ok: true; data: CodexHooksFile; existed: boolean } | { ok: false }` used only by `installHooks`. `uninstallHooks` / `stripHooksFromWorktree` keep `readHooksFile`.
- **REQ-004**: `writeHookScript()` writes only when the file is missing or its content differs from `makeHookScript()`. The script content is not part of the trust hash; this only avoids needless mtime churn that would wake the watcher (REQ-012).
- **REQ-005**: `ensureCodexHooksEnabled()`:
  - Read `content` (missing file → `''`). Parse with `parse` from `smol-toml`. If parsing throws, log `log('hooks', 'codex config.toml unparseable; flag not written')` and return without writing.
  - If `parsed.features` is a table and has own key `hooks` **or** `codex_hooks` (any value, including `false`), return without writing. Detection goes through the parsed object, not a substring, so `[hooks.state."…"]` tables and comments mentioning the name do not count.
  - Otherwise insert the line `hooks = true` with the existing logic: directly under an existing `[features]` header (same regex), or append `\n[features]\nhooks = true\n` with the existing separator handling. Never re-serialize the TOML (that would drop comments and reorder the user's file).
  - The path is `join(codexHomeDir(), 'config.toml')` (REQ-010), not `join(homedir(), '.codex', 'config.toml')`.
  - Log message becomes `` `enabled [features] hooks in ${configPath}` `` (the resolved path).
  - Rename nothing else; keep the function private.
- **REQ-006**: New package `src/main/codex-hook-trust/`: `index.ts` (`export * from './codex-hook-trust'`), `codex-hook-trust.ts`, `codex-hook-trust.test.ts`. No imports from `../agents` (avoids a cycle: `agents/codex` imports this package). Public API exactly:
  ```ts
  export type CodexHookTrustStatus = 'trusted' | 'modified' | 'untrusted' | 'disabled'

  export interface CodexHookHandler {
    type: string
    command: string
    timeout?: number
    async?: boolean
    statusMessage?: string
  }
  export interface CodexHookGroup {
    matcher?: string
    hooks: CodexHookHandler[]
  }

  export interface CodexHookTrustEntry {
    event: string
    groupIndex: number
    handlerIndex: number
    key: string
    hash: string
    storedHash: string | null
    status: CodexHookTrustStatus
  }

  export interface CodexHookTrustReport {
    hooksPath: string
    configPath: string
    readable: boolean
    entries: CodexHookTrustEntry[]
  }

  export interface ReadCodexHookTrustOptions {
    hooksPath: string
    configPath: string
    isOwnedHandler: (handler: CodexHookHandler) => boolean
  }

  export function codexEventSnake(event: string): string
  export function codexHookKey(hooksPath: string, event: string, groupIndex: number, handlerIndex: number): string
  export function codexHookIdentityJson(event: string, group: CodexHookGroup, handlerIndex?: number): string
  export function codexHookHash(event: string, group: CodexHookGroup, handlerIndex?: number): string
  export function readCodexHookTrust(opts: ReadCodexHookTrustOptions): Promise<CodexHookTrustReport>
  export function summarizeCodexHookTrust(report: CodexHookTrustReport, expectedEvents: readonly string[]): CodexHookTrustSummary
  export function startCodexHookTrustMonitor(opts: {
    watchDir: string
    compute: () => Promise<CodexHookTrustSummary>
    onChange: (summary: CodexHookTrustSummary) => void
    debounceMs?: number
  }): { refresh: () => Promise<void>; stop: () => void }
  ```
  - `CodexHookTrustSummary` is imported from `../../shared/state/hooks` (REQ-009) and re-exported.
  - `codexEventSnake`: insert `_` before each uppercase letter that follows a lowercase letter or digit, then lowercase.
  - `handlerIndex` defaults to `0`. `codexHookIdentityJson` builds the identity in "Hash rules" for `group.hooks[handlerIndex]`, with `timeout: Math.max(1, h.timeout ?? 600)`, then returns canonical JSON. `codexHookHash` returns `'sha256:' + createHash('sha256').update(json, 'utf8').digest('hex')`.
  - The event-name form inside the identity is produced by one private function `identityEventName(event)`; TASK-001 may change only that function, the matcher rule, or the default for `async`.
- **REQ-007**: `readCodexHookTrust(opts)`:
  - `readFile(hooksPath)`: `ENOENT` → `{ readable: true, entries: [] }`. Other errors or invalid JSON → `{ readable: false, entries: [] }`.
  - `readFile(configPath)`: `ENOENT` → no stored state (every entry `untrusted`). Other errors or `smol-toml` parse failure → `{ readable: false, entries: [] }`, logged once with `log('codex-hook-trust', 'config unreadable', { configPath })`. Never log file contents.
  - For each event in `data.hooks` (object key order), each group `g`, each handler `i` where `opts.isOwnedHandler(group.hooks[i])`: compute key and hash; look up `parsed.hooks?.state?.[key]` (only these two levels are read; nothing else from the parsed config is kept); set `storedHash` (string or `null`) and `status` per "Hash rules".
  - Only handlers matching the harness signature are hashed. Non-Tatsu handlers are skipped, including ones that share an owned group (REQ-001 note), so a user handler's review state never shows up as Tatsu's.
  - `hooksPath` is used in the key exactly as given (no `realpath`), unless TASK-001 shows Codex canonicalizes it. Source: Codex canonicalizes only the `$CODEX_HOME` directory, and only when the env var is set (see "Source check"). `globalHooksPath()` already gives the right spelling: it is `join(codexHomeDir(), 'hooks.json')`, and `codexHomeDir()` realpaths a set `CODEX_HOME` and leaves the default `~/.codex` as is (REQ-010).
- **REQ-008**: `summarizeCodexHookTrust(report, expectedEvents)`:
  - `!report.readable` → `{ state: 'unknown', reviewEvents: [] }`.
  - No entries → `{ state: 'not-installed', reviewEvents: [] }`.
  - Otherwise `reviewEvents` = sorted unique `event` of entries whose `status !== 'trusted'`, filtered to `expectedEvents`. `state` = `reviewEvents.length ? 'needs-review' : 'ok'`.
- **REQ-009**: `hooks` slice (`src/shared/state/hooks/hooks.ts`):
  ```ts
  export interface CodexHookTrustSummary {
    state: 'ok' | 'needs-review' | 'not-installed' | 'unknown'
    reviewEvents: string[]
  }
  export interface HooksState {
    consent: HooksConsent
    codexTrust: CodexHookTrustSummary | null
  }
  export type HooksEvent =
    | { type: 'hooks/consentChanged'; payload: HooksConsent }
    | { type: 'hooks/codexTrustChanged'; payload: CodexHookTrustSummary }
  ```
  - `initialHooks.codexTrust = null` (not computed yet).
  - Reducer for `hooks/codexTrustChanged` returns `state` unchanged when `payload.state` and `payload.reviewEvents` equal the current value (element-wise), else `{ ...state, codexTrust: payload }`.
  - Export `CodexHookTrustSummary` from `src/shared/state/hooks/index.ts` and add it to the type re-export line in `src/shared/state/index.ts:109`. `rootReducer` routing (`hooks/` prefix) and `mergeWireSnapshot` (`{ ...initialState.hooks, ...state.hooks }`) already cover the field; no change there beyond the test (TEST-011).
  - `src/main/build-initial-state/build-initial-state.ts` keeps `hooks: initialHooks` (nothing persisted; computed at boot).
- **REQ-010**: `src/main/agents/codex.ts` exports `codexHookTrustReport(): Promise<CodexHookTrustReport>` = `readCodexHookTrust({ hooksPath: globalHooksPath(), configPath: codexConfigPath(), isOwnedHandler: isHarnessHookHandler })`, where `isHarnessHookHandler(h)` is a new private helper holding the per-handler test now inlined in `isHarnessHookEntry` (`:84-90`), which then becomes `entry.hooks?.some(isHarnessHookHandler)`, and `codexHomeDir(): string` = `resolveCodexHome(process.env, homedir())` imported from `../folder-trust` (ticket 07 REQ-004; no `join(homedir(), '.codex')` of its own). Every Codex path in `codex.ts` derives from it: `globalHooksPath()` = `join(codexHomeDir(), 'hooks.json')`, `hookScriptPath()` = `join(codexHomeDir(), HOOK_SCRIPT_NAME)`, the `config.toml` path in `ensureCodexHooksEnabled` (REQ-005), and a private `sessionsDir()` = `join(codexHomeDir(), 'sessions')` used by `sessionFileExists` and `latestSessionId`. `codexConfigPath()` in `codexHookTrustReport` resolves through the same function, so the report and the install agree. Each call re-reads `process.env`. Re-export both, plus `hookEvents as codexHookEvents`, from `src/main/agents/index.ts` as named exports.
- **REQ-011**: Main wiring (`src/main/index.ts`):
  - Scope: everything below lives in the body of `bootLocal()` (`:131-3488`), whose unindented top level acts as module scope. `installHooksGlobally`/`uninstallHooksGlobally` (`:815`/`:824`) and `registerIpcHandlers` (`:985`, holding `hooks:uninstall` at `:2376`) are nested function declarations there; `runBoot` (`:3094`) is a sibling. `store` is the `const` at `:279` in that same scope, so the `onChange` closure built inside `runBoot` sees it directly.
  - Declare `let codexHookTrustMonitor: ReturnType<typeof startCodexHookTrustMonitor> | null = null` at that top level, directly above `installHooksGlobally()` (`:815`). A `const` inside `runBoot` would not work: `installHooksGlobally()` and `registerIpcHandlers()` are outside `runBoot` and could not see it, and the hooks IIFE (`:3141`) calls `installHooksGlobally()` (`:3183`), possibly before a `const` declared after the IIFE is initialized.
  - In `runBoot`, **before** the hooks IIFE (`:3141`), assign `codexHookTrustMonitor = startCodexHookTrustMonitor({ watchDir: codexHomeDir(), compute: async () => summarizeCodexHookTrust(await codexHookTrustReport(), codexHookEvents), onChange: (s) => store.dispatch({ type: 'hooks/codexTrustChanged', payload: s }) })`.
  - `watchDir` is the resolved home (`codexHomeDir()`, REQ-010), the same directory `installHooks` writes. The monitor is created once at boot and does not follow later `CODEX_HOME` changes to main's env; `compute` re-resolves paths on each refresh, but the watch stays on the boot-time dir.
  - Call `void codexHookTrustMonitor?.refresh()` at the end of `installHooksGlobally()` and `uninstallHooksGlobally()`. `hooks:accept` (`:2361`) can run before `runBoot` assigns the monitor; the optional call no-ops then, and the monitor's own start-up `refresh()` covers it.
  - In `registerIpcHandlers`, next to `hooks:uninstall` (`:2376`), add `transport.onRequest('hooks:refreshCodexTrust', async () => { await codexHookTrustMonitor?.refresh(); return true })`. `transport`, `store` and the monitor variable are all in scope there.
  - Call `codexHookTrustMonitor?.stop()` in the desktop `onBeforeQuit` callback (`:3459`) and the headless `shutdown` (`:3474`).
- **REQ-012**: `startCodexHookTrustMonitor`:
  - Runs `refresh()` once immediately.
  - `watchDir` is the resolved Codex home passed by REQ-011 (`codexHomeDir()`); the monitor does not resolve it itself. If `watchDir` exists, `fs.watch(watchDir, { persistent: false })`; on events whose `filename` is `config.toml` or `hooks.json` (or `null`), schedule `refresh()` after `debounceMs` (default 250), resetting the timer on each event. Watching the directory (not the files) survives atomic rename writes. If `watchDir` does not exist, do not create it; `refresh()` calls from REQ-011 still work.
  - Each `refresh()` (before `compute()`) re-attempts the watch when no watcher is active, the monitor is not stopped, and `watchDir` now exists. This covers a first `installHooks()` creating the Codex home after boot. A watcher `error` event closes it and clears the handle so the next `refresh()` retries.
  - `refresh()` runs `compute()`, catches errors (→ `{ state: 'unknown', reviewEvents: [] }`), and calls `onChange` only when `JSON.stringify(summary)` differs from the last one sent. Concurrent `refresh()` calls share one in-flight promise.
  - `stop()` closes the watcher and clears the timer.
- **REQ-013**: Renderer:
  - `src/renderer/types/types.ts`: add `refreshCodexHookTrust(): Promise<boolean>` next to `acceptHooks` (`:465`).
  - `src/renderer/build-backend/build-backend.ts`: add `refreshCodexHookTrust: () => req('hooks:refreshCodexTrust'),` next to `acceptHooks` (`:445`).
  - `Settings.tsx`: read `const { consent: hooksConsent, codexTrust } = useHooks()` (`:428`). In the Status hooks card, directly after the Codex `/hooks` paragraph (`:1710-1715`), when `hooksConsent === 'accepted' && codexTrust?.state === 'needs-review'`, render
    ```tsx
    <p className="text-xs text-warning mb-3 flex items-center gap-1">
      <AlertTriangle className="icon-xs" />
      Codex hooks need review: run <code className="bg-panel px-1 rounded">/hooks</code>
    </p>
    ```
    The element's text content is exactly `Codex hooks need review: run /hooks`. Use whichever warning icon `Settings.tsx` already imports from `lucide-react` if one exists; otherwise import `AlertTriangle`.
  - `Settings.tsx`: one `useEffect(() => { backend.refreshCodexHookTrust().catch(() => {}) }, [backend])` so opening Settings re-checks even if a watch event was missed. The `.catch` is required: an older `harness-server` answers an unknown request with `no handler registered` (`src/main/transport-websocket/transport-websocket.ts:235`), and the line then stays hidden because `codexTrust` merges to `null`. No `useState` for the trust value (it comes from the slice).
  - Do not change the consent banner text in `App.tsx`.
- **SEC-001**: Tatsu never writes `trusted_hash` or anything under `[hooks.state]`. `codex-hook-trust.ts` imports only `readFile` from `fs/promises`, `watch`/`existsSync` from `fs`, and `createHash` from `crypto`. The only `config.toml` write in the codebase stays the `[features] hooks` insert (REQ-005). TEST-008 checks bytes and mtime; TASK-011 greps.
- **SEC-002**: Only `parsed.hooks.state[<key>]` (`trusted_hash`, `enabled`) and `parsed.features` keys are read from `config.toml`. Nothing else (providers, env, auth) is copied, logged or put in the slice. The slice carries only `state` and event names, not paths or hashes.
- **CON-001**: The hook command text and timeout must not change: `makeCodexHookCommand` and `makeHarnessHookEntry` stay byte-identical (ticket 03 CON-001; any change resets trust for every user).
- **CON-002**: Do not change where Tatsu writes when `CODEX_HOME` is unset (`~/.codex/hooks.json`, `~/.codex/harness-hook.sh`, `~/.codex/config.toml`, built from `homedir()` without `realpath`). Those paths and trust keys stay byte-identical; changing the `hooks.json` path changes every key. With `CODEX_HOME` set, Tatsu writes to the resolved `$CODEX_HOME` instead (REQ-010, RISK-002).
- **CON-003**: No "Trust automatically" button, no `-c hooks.state={…}` launch override, no `codex exec` work, no launch-sheet check (Phase 3), no change to `uninstallHooks` index behaviour.
- **CON-004**: Reuse `resolveCodexHome()` and `codexConfigPath()` from `src/main/folder-trust` (ticket 07) and the `smol-toml` dependency. See DEP-001 for the order.
- **GUD-001**: AGENTS.md: package dir with barrel, imports through barrels (`../codex-hook-trust`, `../folder-trust`, `../../shared/state/hooks`), canonical text/icon sizes, no new comments beyond short "why" notes. Run `pnpm typecheck`, `pnpm build`, `npx vitest run` before each commit. Code commits push immediately; the gap 9 and gap 4 plan edit is a separate commit.
- **PAT-001**: `codex.test.ts` keeps its in-memory `fs` mock (`:3-23`). Add a `writes: string[]` array to `fsState` that `writeFileSync` appends `p` to, cleared in `beforeEach`, to assert "no write". `codex.ts` now reaches `realpathSync` through `../folder-trust`, so add `realpathSync: (p: string) => p` to the mock, and make `readdirSync` record the directories it is asked for (`fsState.readdirs`) so TEST-014 can assert the sessions dir. Add `vi.stubEnv('CODEX_HOME', '')` in `beforeEach` (and `vi.unstubAllEnvs()` in `afterEach`) so a developer's own `CODEX_HOME` does not leak in; empty counts as unset, so the existing hardcoded `join(homedir(), '.codex', …)` paths (`:43`, `:44`, `:216`) stay valid. Mock `../codex-hook-trust` is **not** needed: it is pure apart from `readFile`/`watch`, which `codex.test.ts` does not call through `installHooks`. Add `parse` from the real `smol-toml` (not mocked).
- **PAT-002**: `codex-hook-trust.test.ts` uses real temp dirs (`mkdtemp(join(tmpdir(), 'codex-hook-trust-'))`) like `src/main/fs-listing/fs-listing.test.ts`, and mocks `../debug` with `vi.mock('../debug', () => ({ log: vi.fn() }))`.

## 2. Implementation Steps

### Implementation Phase 1: Verify against a real Codex

- GOAL-001: The hash rules, key format, `async` default, event-name form and feature-flag name match Codex ≥ 0.129.0, and a known hash exists for TEST-004. If Codex can't be run, the ticket records that and proceeds with the source rules.

- [ ] **TASK-001**: Install Codex with the user's OK (`brew install codex` or `npm i -g @openai/codex`); require `codex --version` ≥ 0.129.0. Never touch the real `~/.codex` during probes:
  - `export CODEX_HOME="$(mktemp -d)"` and `cp ~/.codex/auth.json "$CODEX_HOME/"` (only if login is needed for the TUI). Write `$CODEX_HOME/hooks.json` with exactly one group per event for `Stop`, `SessionStart`, `PreToolUse`:
    `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"bash '/h/.codex/harness-hook.sh' Stop","timeout":5}]}],"SessionStart":[{"hooks":[{"type":"command","command":"bash '/h/.codex/harness-hook.sh' SessionStart","timeout":5}]}],"PreToolUse":[{"hooks":[{"type":"command","command":"bash '/h/.codex/harness-hook.sh' PreToolUse","timeout":5}]}]}}`. The command is hashed as a raw string and is not executed by the probes, so `/h` need not exist.
  - **Method A (`hooks/list`)**: confirm the request shape first with `codex app-server generate-json-schema --out "$CODEX_HOME/schema"` and `grep -ril hooks/list "$CODEX_HOME/schema"` (if that subcommand doesn't exist, read `codex-rs/app-server-protocol/src/protocol/common.rs` at the installed version's tag). Then pipe newline-delimited JSON-RPC into `codex app-server`: an `initialize` request (`clientInfo: { name: 'tatsu-probe', version: '0' }`), the `initialized` notification, and `{"id":2,"method":"hooks/list","params":{…per schema, e.g. cwd}}`. Record each `key`, `currentHash`, `trustStatus`.
  - **Method B (`/hooks`)**: run `codex` in a scratch dir with the same `CODEX_HOME`, open `/hooks`, trust the three entries, quit. Read `$CODEX_HOME/config.toml` and record the `[hooks.state."<key>"]` tables. Also record whether Codex rewrote `$CODEX_HOME/hooks.json` (compare bytes) and what keys it added (e.g. `async`).
  - Compare with the helper: run `codexHookKey("$CODEX_HOME/hooks.json", …)` and `codexHookHash(…)` from a scratch vitest file. Check: key prefix (`$CODEX_HOME` as given vs `/private/var/…` realpath on macOS), event segment, hash. If anything differs, change only `identityEventName`, the matcher rule, the `async` default, or the key path handling (REQ-006/REQ-007), until all three match.
  - Flag: with `[features] hooks = true` only, confirm hooks fire (method B entries show and `codex features list` lists `hooks`, if that subcommand exists). Also try a config with only `codex_hooks = true` and record whether Codex warns or ignores it.
  - Delete `$CODEX_HOME` afterwards. Put the three recorded hashes and the Codex version in the commit message of TASK-007 and use the `Stop` one as `KNOWN_STOP_HASH` in TEST-004.
  - If Codex can't be installed or run: implement the source rules as written, compute `KNOWN_STOP_HASH` from the canonical JSON in "Hash rules" (`printf '%s' '<json>' | shasum -a 256`), name the test `pins the Stop hash (from source, unverified against a binary)`, and record "unverified" in the commit message and the gap 9 line (TASK-013).

### Implementation Phase 2: Dependencies

- GOAL-002: `smol-toml` and `codexConfigPath()` are available.

- [ ] **TASK-002**: Works in either landing order with ticket 07 (DEP-001). Check each item on the current base branch and do only what is missing:
  - `smol-toml` not in `package.json` `dependencies` → `pnpm add smol-toml@^1.9.0`. `'smol-toml'` not in `RUNTIME_PACKAGES` in `scripts/pack-headless.mjs:139` → add it (headless externalizes runtime deps; only that list is copied into the tarball).
  - `src/main/folder-trust/` absent → create it with `index.ts` (`export * from './folder-trust'`), `folder-trust.ts` containing only `resolveCodexHome(env = process.env, homeDir = homedir())` and `codexConfigPath(env = process.env, homeDir = homedir())` per ticket 07 REQ-004, and `folder-trust.test.ts` with ticket 07 TEST-009's `resolveCodexHome` / `codexConfigPath` assertions.
  - Package present but without `resolveCodexHome` / `codexConfigPath` → add only the missing function(s) and their assertions; leave the rest of the file alone. Package present with both → no change.
  - If ticket 07 is in flight on another branch, rebase onto whichever lands first and resolve a `folder-trust.ts` conflict by keeping 07's file plus one definition of each function.

### Implementation Phase 3: Trust helper and slice

- GOAL-003: `src/main/codex-hook-trust/` and the `hooks` slice implement REQ-006 to REQ-009 and REQ-012.

- [ ] **TASK-003**: `src/shared/state/hooks/hooks.ts`, `hooks/index.ts`, `src/shared/state/index.ts:109`: REQ-009. Add reducer tests (TEST-010) and the wire-merge test (TEST-011).
- [ ] **TASK-004**: Create `src/main/codex-hook-trust/codex-hook-trust.ts` and `index.ts` per REQ-006, REQ-007, REQ-008, REQ-012. Private helpers: `canonicalJson(value)`, `identityEventName(event)`, `readStoredState(configPath)`.
- [ ] **TASK-005**: Create `codex-hook-trust.test.ts` with TEST-003 to TEST-009 and TEST-015.

### Implementation Phase 4: installHooks and flag

- GOAL-004: `codex.ts` implements REQ-001 to REQ-005 and REQ-010.

- [ ] **TASK-006**: In `src/main/agents/codex.ts`:
  - Replace the loop at `:142-149` with REQ-001; add `isIdenticalHarnessEntry` (REQ-002) using `codexHookIdentityJson` from `../codex-hook-trust`.
  - Add `readHooksFileStrict` (REQ-003), the conditional `writeHookScript` (REQ-004), the new `ensureCodexHooksEnabled` (REQ-005), and the exports in REQ-010.
  - Replace every `homedir()` use with `codexHomeDir()` (REQ-010): `globalHooksPath` (`:39-40`), `hookScriptPath` (`:43-44`), `ensureCodexHooksEnabled` (`:97`, log `:114`), and `sessionFileExists` (`:191`) / `latestSessionId` (`:210`) via `sessionsDir()`. Afterwards `rg -n "homedir\(\)" src/main/agents/codex.ts` matches only `codexHomeDir`. Make `CodexHookEntry` structurally compatible with `CodexHookGroup` (or replace it with the imported type).
  - Add the re-exports to `src/main/agents/index.ts`.
  - Update `codex.test.ts` (TEST-001, TEST-002, TEST-014).
- [ ] **TASK-007**: `pnpm typecheck`, `pnpm build`, `npx vitest run`. Commit `Keep Codex hook entries in place and report their /hooks trust` (Phase 3 + Phase 4 + any TASK-002 changes; include TASK-001 results), push.

### Implementation Phase 5: Main wiring and Settings

- GOAL-005: Every client sees the trust summary; Settings shows the review line.

- [ ] **TASK-008**: `src/main/index.ts`: REQ-011 (`watchDir: codexHomeDir()`, TEST-016).
- [ ] **TASK-009**: Renderer: REQ-013.
- [ ] **TASK-010**: `pnpm typecheck`, `pnpm build`, `npx vitest run`; if TASK-002 changed `package.json` or `pack-headless.mjs`, also `pnpm build:headless && bash scripts/smoke-headless.sh`. Run TEST-013 (manual). Commit `Show Codex hook trust status in Settings`, push.

### Implementation Phase 6: Audit

- GOAL-006: The read-only rule holds in code.

- [ ] **TASK-011**: `rg -n "trusted_hash|hooks\.state" src/` returns matches only in `src/main/codex-hook-trust/` (reads) and its test fixtures. `rg -n "writeFile|appendFile|rename" src/main/codex-hook-trust/codex-hook-trust.ts` returns nothing.
- [ ] **TASK-012**: `rg -n "codex_hooks" src/` returns only the REQ-005 read check and tests.

### Implementation Phase 7: Close gaps 9 and 4 in the plan

- GOAL-007: The plan records both gaps as closed.

- [ ] **TASK-013**: Edit `plans/dynamic-workflows/dynamic-workflows.md`:
  - Gap 9 (line starting `9. **Codex skips untrusted hooks.**`): replace the sentence starting `Remaining work:` with `Closed in <TASK-007 hash>..<TASK-010 hash>: \`installHooks\` keeps each Tatsu entry at its index and skips unchanged writes; \`src/main/codex-hook-trust\` computes each entry's key and hash read-only and feeds \`hooks.codexTrust\`, which Settings shows as "Codex hooks need review: run /hooks". Hash rules <verified on codex <ver> | from source, unverified>. Tatsu never writes \`trusted_hash\`.`
  - Gap 4 (line starting `4. **Codex hooks flag name drift.**`): append `Closed in <TASK-007 hash>: the flag is written as \`[features] hooks = true\` only when neither \`hooks\` nor \`codex_hooks\` is set; detection parses the TOML instead of a substring.`
  - "Codex hook trust (2026-10-02)" subsection, first line: if TASK-001 ran, replace `not yet checked against a running binary` with `checked against codex <ver> via \`hooks/list\` and \`/hooks\``, and correct any rule TASK-001 changed. In the "Consequences for Tatsu" bullet about position, append ` Fixed: \`installHooks\` now keeps entries in place.`
  - Phase 0 item 8: no text change.
  - Run this task only after TASK-010's commit exists (it needs both hashes). Commit `Mark workflows gaps 9 and 4 closed` as its own commit after TASK-010, push.

## 3. Alternatives

- **ALT-001**: Write `trusted_hash` for Tatsu's entries automatically. Rejected by the plan: it self-approves and skips the review Codex intends. Only as an explicit opt-in, which is out of scope.
- **ALT-002**: Ask Codex for status via `codex app-server` `hooks/list` at runtime. Rejected: needs the binary on the backend's PATH, spawns a process per check, and returns the same data the files hold. Used only for verification (TASK-001).
- **ALT-003**: Request/response query (`hooks:codexTrustStatus`) called by Settings, no slice. Rejected: every client and the future launch sheet need the same machine-level value; the AGENTS.md test says slice. A refresh request is still added (REQ-011) as a nudge, but it updates the slice rather than returning data.
- **ALT-004**: A new `codexHooks` slice. Rejected: the `hooks` slice already holds hook consent and its wire merge already spreads per-field defaults.
- **ALT-005**: Keep strip-and-append but put Tatsu's entries at index 0. Rejected: inserting at 0 shifts every user hook and marks them all `modified`; it also fails if another tool does the same.
- **ALT-006**: Compare raw `hooks.json` text to decide whether to write. Rejected: Codex may reformat the file; a structural `changed` flag avoids rewriting a file whose content is already right.
- **ALT-007**: Migrate `codex_hooks = true` to `hooks = true`. Rejected: rewrites a key the user may have set on purpose, and older Codex builds may only read `codex_hooks`.
- **ALT-008**: Hash every handler, including user hooks (and non-Tatsu handlers inside an owned group). Rejected: user handlers may use events or fields whose defaults are not modelled (`SessionEnd`/`Interrupt` timeouts, `additionalContextLimit`), and Settings only needs Tatsu's.

## 4. Dependencies

- **DEP-001**: Ticket 07 (`src/main/folder-trust`: `codexConfigPath()`, `smol-toml`, `RUNTIME_PACKAGES`). Not blocking. Both tickets may create `src/main/folder-trust/folder-trust.ts` and add `smol-toml`, so TASK-002 is create-if-absent and add-if-missing and tolerates either landing order. Ticket 07 needs a matching note (its TASK-002/TASK-003 should likewise skip `pnpm add` and the `RUNTIME_PACKAGES` line when already present, and extend an existing `folder-trust.ts` that holds only `codexConfigPath` instead of creating it); that edit belongs to ticket 07, not this one.
- **DEP-002**: `smol-toml@^1.9.0` runtime dependency (MIT, no transitive deps), shared with ticket 07.
- **DEP-003**: Codex ≥ 0.129.0 for TASK-001 and TEST-013 (optional; see TASK-001 fallback).
- **DEP-004**: None on items 1 to 6. Ticket 05 (CON-004, DEP-005) leaves `ensureCodexHooksEnabled` to this ticket. The per-terminal `CODEX_HOME` fallback now lives in contingent ticket 09 (`09-codex-home-fallback.md`); only if that ticket proceeds does it call `readCodexHookTrust({ hooksPath: <fallback>/hooks.json, configPath: <fallback>/config.toml, isOwnedHandler })` to check trust under the fallback home. This ticket does not depend on it.

## 5. Files

- **FILE-001**: `src/main/agents/codex.ts`. REQ-001 to REQ-005, REQ-010.
- **FILE-002**: `src/main/agents/codex.test.ts`. TEST-001, TEST-002; rewrite the three `codex_hooks` tests (`:215-243`).
- **FILE-003**: `src/main/agents/index.ts`. Re-exports (REQ-010).
- **FILE-004**: `src/main/codex-hook-trust/index.ts` (new). Barrel.
- **FILE-005**: `src/main/codex-hook-trust/codex-hook-trust.ts` (new). Key, hash, report, summary, monitor.
- **FILE-006**: `src/main/codex-hook-trust/codex-hook-trust.test.ts` (new).
- **FILE-007**: `src/shared/state/hooks/hooks.ts`, `src/shared/state/hooks/index.ts`, `src/shared/state/hooks/hooks.test.ts`. Slice field, event, tests.
- **FILE-008**: `src/shared/state/index.ts`. Type re-export only.
- **FILE-009**: `src/shared/state/wire-merge.test.ts`. TEST-011.
- **FILE-010**: `src/main/index.ts`. Monitor, refresh calls, request handler, cleanup.
- **FILE-011**: `src/renderer/types/types.ts`, `src/renderer/build-backend/build-backend.ts`. `refreshCodexHookTrust`.
- **FILE-012**: `src/renderer/components/Settings/Settings.tsx`. Review line and refresh effect.
- **FILE-013** (only the parts TASK-002 finds missing): `package.json`, `pnpm-lock.yaml`, `scripts/pack-headless.mjs`, `src/main/folder-trust/{index,folder-trust,folder-trust.test}.ts` (`resolveCodexHome`, `codexConfigPath`).
- **FILE-014**: `plans/dynamic-workflows/dynamic-workflows.md`. Gaps 9 and 4, research subsection (separate commit).

## 6. Testing

- **TEST-001** (`codex.test.ts`, installHooks positions; `C(E) = makeCodexHookCommand(E)`, `U = { hooks: [{ type: 'command', command: 'echo user', timeout: 10 }] }`):
  - (a) Fresh install, then push `U` onto `Stop` (after Tatsu's entry), then `installHooks()`: `Stop[0]` is Tatsu's, `Stop[1]` deep-equals `U`, and `fsState.writes` has no `HOOKS_PATH` entry for the second call.
  - (b) File with `Stop: [U, tatsuStop]` (third-party first, like this machine): `installHooks()` leaves it byte-identical and does not write it.
  - (c) Tatsu entry at `Stop[0]` with `timeout: 10`, `U` at `Stop[1]`: after install, `Stop[0]` is the desired entry (`timeout: 5`), `Stop[1]` is `U`.
  - (d) Legacy inline `bash -c '…/tmp/harness-status…'` entry at `Stop[0]`, `U` at `Stop[1]`: replaced in place at index 0, `U` still at 1.
  - (e) Duplicates `[tatsuStop, U, tatsuStop]`: result `[tatsuStop, U]`.
  - (f) Entry identical except an added `async: false`: unchanged, no write (REQ-002).
  - (g) Entry with a `statusMessage` or a `matcher: '*'` on `PreToolUse`: replaced in place.
  - (h) `hooks.json` containing `{not json`: not overwritten, no throw; the script is still written.
  - (i) Existing tests (`installHooks() called twice`, `collapses pre-existing duplicates`, `preserves user-authored hooks`, `replaces legacy inline`, `hook commands are stable`) still pass unchanged.
  - (j) `installHooks()` on an up-to-date install writes neither `HOOKS_PATH` nor `SCRIPT_PATH` (REQ-004).
- **TEST-002** (`codex.test.ts`, flag; replaces `describe('codex_hooks feature flag')`; `CONFIG_PATH` at `:216` stays `join(homedir(), '.codex', 'config.toml')` under the `beforeEach` stub in PAT-001):
  - (a) `[features]\nweb_search = true` plus other tables → `hooks = true` inserted directly under `[features]`, rest byte-identical.
  - (b) No `[features]` → `\n[features]\nhooks = true\n` appended.
  - (c) `[features]\ncodex_hooks = false\n` → unchanged (existing installs).
  - (d) `[features]\nhooks = false\n` → unchanged.
  - (e) `features.hooks = true` (dotted, top level) → unchanged.
  - (f) No `[features]` but a `[hooks.state."/h/.codex/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:x"\n` table and a comment `# codex_hooks` → flag inserted (substring trap), the `hooks.state` table byte-identical.
  - (g) Unparseable TOML (`[features`) → unchanged, no throw.
  - (h) Missing file → created with `\n[features]\nhooks = true\n` (current behaviour for empty content).
- **TEST-003** (`codex-hook-trust.test.ts`, key/identity): `codexEventSnake` for all five events; `codexHookKey('/h/.codex/hooks.json', 'SessionStart', 0, 0) === '/h/.codex/hooks.json:session_start:0:0'`; `codexHookIdentityJson('Stop', tatsuStop('/h'))` equals the worked JSON literal in "Hash rules" (after TASK-001 adjustments); a `matcher: 'Bash'` is kept for `PreToolUse` and dropped for `Stop`; a handler with no `timeout` yields `"timeout":600` and one with `timeout: 0` yields `"timeout":1`; key order in the input object does not change the output.
- **TEST-004** (pinned hash): `codexHookHash('Stop', { hooks: [{ type: 'command', command: "bash '/h/.codex/harness-hook.sh' Stop", timeout: 5 }] }) === KNOWN_STOP_HASH`, a string literal from TASK-001 method A/B (or the documented fallback). Add the `SessionStart` and `PreToolUse` hashes from TASK-001 when available.
- **TEST-005** (statuses): temp `hooks.json` with Tatsu entries for all five events plus a user group; `config.toml` with `trusted_hash` = correct hash for `Stop`, a wrong hash for `SessionStart`, `enabled = false` for `PreToolUse`, nothing for the rest → `trusted`, `modified`, `disabled`, `untrusted`, `untrusted`; user group absent from `entries`; `storedHash` set accordingly. A group `{ hooks: [userHandler, tatsuHandler] }` yields one entry with `handlerIndex: 1` and none for the user handler.
- **TEST-006** (position): Tatsu `Stop` entry at index 1 behind a user group; trust stored under `…:stop:0:0` → `untrusted`; under `…:stop:1:0` → `trusted`.
- **TEST-007** (files): missing `hooks.json` → `readable: true`, no entries → summary `not-installed`; invalid JSON → `readable: false` → `unknown`; missing `config.toml` → all `untrusted` → `needs-review` with all five events sorted; unparseable `config.toml` → `unknown`, `log` called once with `'codex-hook-trust'` and no contents.
- **TEST-008** (read-only): after TEST-005 to TEST-007, both fixture files are byte-identical with unchanged `mtimeMs`, and the temp dir has no new files.
- **TEST-009** (monitor): with `debounceMs: 20` and a `compute` mock: called once at start; writing `config.toml` in the watched temp dir triggers one more call after the debounce; writing `other.txt` does not; `onChange` fires only when the summary changes; two concurrent `refresh()` calls run `compute` once; a throwing `compute` yields `{ state: 'unknown', reviewEvents: [] }`; `stop()` stops further calls; a non-existent `watchDir` does not throw and is not created; after creating that dir and calling `refresh()`, a `config.toml` write there triggers a call (REQ-012 re-attempt). Assertions on watcher-driven calls use a poll/retry helper (`vi.waitFor` or a small loop with a deadline of a few seconds), not fixed sleeps; "does not trigger" checks wait for a positive control first (write `other.txt`, then `config.toml`, wait for exactly one extra call).
- **TEST-010** (`hooks.test.ts`): `hooks/codexTrustChanged` sets `codexTrust`; an equal payload returns the same state object (`toBe`); `initialHooks.codexTrust` is `null`; `hooks/consentChanged` keeps `codexTrust`.
- **TEST-011** (`wire-merge.test.ts`): a snapshot whose `hooks` is `{ consent: 'accepted' }` (old server) merges to `{ consent: 'accepted', codexTrust: null }`.
- **TEST-012**: `pnpm typecheck`, `pnpm build`, `npx vitest run` pass; headless smoke passes when TASK-002 changed dependencies.
- **TEST-013** (manual, needs Codex ≥ 0.129.0; skip with a note if unavailable): Tatsu writes to the real `~/.codex`, so back up `~/.codex/hooks.json` and `~/.codex/config.toml` first and restore them afterwards. Then, in `pnpm dev` with hooks accepted:
  - Settings shows "Codex hooks need review: run /hooks" before approval.
  - Open a Codex tab, run `/hooks`, trust Tatsu's entries; within a second, without reopening Settings, the line disappears (watcher path).
  - Append a user hook to `Stop` in `hooks.json`, restart Tatsu: the line stays hidden and `/hooks` still shows Tatsu's entries trusted (index stability).
  - Codex status changes (working → idle) appear in the sidebar.
  - A second client (a web client connected to the same backend) shows the same Settings state.
- **TEST-014** (`codex.test.ts`, `CODEX_HOME`; `H = '/codex-home'` in the in-memory fs, set per test with `vi.stubEnv('CODEX_HOME', H)`):
  - (a) `codexHomeDir()` with `CODEX_HOME` empty → `join(homedir(), '.codex')`; with `H` → `H` (the mocked `realpathSync` is identity). The pure case `resolveCodexHome({}, '/h') === '/h/.codex'` and the realpath cases are in ticket 07 TEST-009 (real fs).
  - (b) `installHooks()` writes `H/hooks.json` and `H/harness-hook.sh`, and `fsState.writes` has no path under `join(homedir(), '.codex')`. The hook command in `H/hooks.json` is `bash '<H>/harness-hook.sh' <Event>`.
  - (c) `ensureCodexHooksEnabled` (through `installHooks`) edits `H/config.toml` only.
  - (d) `sessionFileExists` / `latestSessionId` ask `readdirSync` for `H/sessions` (`fsState.readdirs`), not `~/.codex/sessions`.
- **TEST-015** (`codex-hook-trust.test.ts`, symlinked home): temp dir `T/real` with a symlink `T/link` to it; `home = resolveCodexHome({ CODEX_HOME: T/link }, '/h')`; `readCodexHookTrust({ hooksPath: join(home, 'hooks.json'), … })` yields keys starting with `realpath(T/real)/hooks.json:`, and trust stored under that key reads `trusted` while trust stored under `T/link/hooks.json:…` reads `untrusted`.
- **TEST-016** (monitor dir): TEST-009 already shows the monitor reacts to writes in the `watchDir` it is given; TASK-008 checks that REQ-011 passes `codexHomeDir()`, not a literal `~/.codex`. With `CODEX_HOME` set to a temp dir in TEST-013's manual run, a `/hooks` approval there clears the Settings line.

## 7. Risks & Assumptions

- **RISK-001**: The hash rules are from source at `c5d242f`; a later Codex can change the normalization. Effect: every entry shows `modified`/`untrusted`, so Settings asks for a review that `/hooks` shows as already done. Mitigation: TASK-001 pins a real hash; re-run it when the plan bumps the Codex version it targets.
- **RISK-002**: `CODEX_HOME` location change. Users without `CODEX_HOME` (or with it empty or whitespace-only, which counts as unset) see byte-identical paths and keys. Users with `CODEX_HOME` set in main's env previously had Tatsu's hooks in `~/.codex`, which Codex never read; after this ticket Tatsu installs into the resolved `$CODEX_HOME`, so their entries appear as new and need one `/hooks` review (Settings shows the line). Old `~/.codex/hooks.json` entries and `~/.codex/harness-hook.sh` stay behind as harmless leftovers; Tatsu does not clean them up. `CODEX_HOME` set only in the user's shell rc but not in Tatsu's main env (e.g. a Dock/Finder launch, where `path-fix` merges only `PATH`) is a pre-existing limit: Tatsu resolves `~/.codex` while a Codex tab whose login shell sets `CODEX_HOME` reads elsewhere. Not fixed here.
- **RISK-003**: Writing `hooks = true` on a Codex older than the rename may be ignored with a warning; hooks there don't need trust anyway, and the default is on in current builds. Existing `codex_hooks` installs are untouched.
- **RISK-004**: Removing a Tatsu entry placed before a current one (REQ-001 step 5) or `uninstallHooks` shifts later entries and costs one re-review. Rare and accepted.
- **RISK-005**: The `[features]` insert and Codex's own `config/batchWrite` from `/hooks` can race. Tatsu writes only when the flag is missing, i.e. at most once per machine.
- **RISK-006**: `fs.watch` can miss events on some filesystems; the Settings-open refresh and the install/uninstall refresh cover the visible cases.
- **ASSUMPTION-001**: Only the user config layer (`$CODEX_HOME/config.toml`) holds trust for Tatsu's entries; session `-c` overrides are not used by Tatsu.
- **ASSUMPTION-002**: Codex keys trust by `<home>/hooks.json`, where `<home>` is `realpath($CODEX_HOME)` when set and `~/.codex` (not canonicalized) otherwise; the `hooks.json` path itself is not realpath'd further. `codexHomeDir()` matches this (REQ-010; TASK-001 checks).
- **ASSUMPTION-003**: `smol-toml` parses Codex's `toml_edit` output, including quoted keys with `/` and `:`.

## 8. Related Specifications / Further Reading

- `plans/dynamic-workflows/milestones/milestone-1-prerequisites/goal.md`, Item 8
- `plans/dynamic-workflows/dynamic-workflows.md`: "Gaps found" (gaps 4 and 9), "Harness research" → "Codex hook trust (2026-10-02)", "Permissions & trust" → "Codex hook trust" (launch-sheet readiness check, Phase 3), "Phases" 0.8
- Ticket 03 (`03-hook-payloads-last-message.md`) CON-001: Codex hook command text stays unchanged
- Ticket 05 (`05-mcp-codex-opencode.md`) CON-004, DEP-005: flag fix belongs here
- Ticket 09 (`09-codex-home-fallback.md`, contingent): per-terminal `CODEX_HOME` fallback; reuses `readCodexHookTrust` only if it proceeds
- Ticket 07 (`07-folder-trust-helper.md`) REQ-004, TASK-002: `resolveCodexHome()`, `codexConfigPath()`, `smol-toml`, `RUNTIME_PACKAGES`
- Commits `7edfc85` (stable hook script, Settings/banner text) and `156d4a1` (`[features]` placement)
- Codex source `openai/codex@c5d242f`: `codex-rs/hooks/src/lib.rs:113-123`, `hooks/src/engine/discovery.rs:174,770-830`, `config/src/fingerprint.rs:54`, `tui/src/hooks_rpc.rs:58-91`, `app-server-protocol/src/protocol/common.rs:890`; PRs #20321, #21755
- https://learn.chatgpt.com/docs/hooks, https://learn.chatgpt.com/docs/app-server
- smol-toml: https://github.com/squirrelchat/smol-toml

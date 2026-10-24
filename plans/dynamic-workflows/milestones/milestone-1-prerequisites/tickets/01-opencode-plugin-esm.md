---
goal: Rewrite the opencode status plugin to the documented ESM plugin format so opencode status detection works on 1.18.x
date_created: 2026-10-02
status: 'Planned'
tags: [bug, opencode, hooks, milestone-1, dynamic-workflows]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

> Implementer: when this ticket lands, set the front-matter `status` and the badge to `Completed` and tick the TASK checkboxes below. FILE-004 covers the plan doc update.

Milestone 1, Item 1 (closes gap 3 in `plans/dynamic-workflows/dynamic-workflows.md` "Gaps found").

`makePluginContent()` in `src/main/agents/opencode.ts:32-87` generates `~/.config/opencode/plugins/harness-status.js` as CommonJS (`module.exports = { async onEvent(ctx) … }` at `:47`) and reads `ev.payload.session.id`. opencode 1.18.30 loads plugins as ES modules that export an async factory returning a `Hooks` object. The current file loads but no handler ever runs, so it writes nothing to `/tmp/harness-status/<terminalId>.ndjson`, and opencode tabs never leave their initial status.

This ticket rewrites the generated plugin to the documented format:

```js
export const HarnessStatus = async ({ client }) => ({ event, 'tool.execute.before', 'tool.execute.after' })
```

The new plugin keeps the NDJSON line shape that `src/main/hooks/hooks.ts` already parses: `{"event":"<Claude-style name>","ts":<sec>,"payload":{…}}`. With that shape, opencode tabs report `processing`, `waiting` and `needs-approval` through the existing `deriveStatus()` without any change to `hooks.ts`. On `session.idle`, the plugin also fetches the final assistant message with `client.session.messages()` and puts it in the `Stop` payload as `last_assistant_message`. Item 3 parses that field in `hooks.ts`, so this ticket only emits it.

Intended side effect: opencode tabs start resuming their session after a restart. See REQ-011.

This is a self-contained fix that also improves today's opencode tabs. It is a prerequisite for Item 3 (hook payloads) and Item 5 (MCP for opencode). The later workflow work (`promptAsync` continuation, `POST /workflow/stop-check`) adds to this same plugin in Phase 2 and is out of scope here.

## 1. Requirements & Constraints

- **REQ-001**: The generated plugin file is an ES module with exactly one export: `export const HarnessStatus = async ({ client }) => { … return hooks }`. It has no `require`, no `module.exports`, and no other exports. opencode calls every export of a plugin module as a plugin factory, so an exported constant or helper would break loading.
- **REQ-002**: Bus events are read as `{ type, properties }` through the `event: async ({ event }) => …` hook. The session id comes from `event.properties.sessionID`, or from `event.properties.info.id` for `session.created` and `session.updated`.
- **REQ-003**: Tool calls come from the `'tool.execute.before'` and `'tool.execute.after'` hooks, with signatures `(input: { tool, sessionID, callID, args? }, output: { args } | { title, output, metadata })` per `@opencode-ai/plugin` 1.18.x `Hooks`. They do not come from bus events.
- **REQ-004**: Emitted NDJSON lines keep the exact shape `{"event":E,"ts":<unix seconds>,"payload":P}` followed by `\n`, appended to `/tmp/harness-status/<terminalId>.ndjson`. `<terminalId>` is `process.env.HARNESS_TERMINAL_ID`, falling back to `process.env.CLAUDE_HARNESS_ID`. When neither is set, the factory returns `{}` and registers no hooks, so the plugin does nothing outside Harness.
- **REQ-005**: Event mapping. Each payload carries `session_id`, which is the **root** session id (see REQ-006).

  | opencode source | Condition | Emitted `event` | `payload` |
  |---|---|---|---|
  | `event` `session.status` | `properties.status.type === 'busy'` and the session's last emitted state is not `busy` | `UserPromptSubmit` | `{ session_id }` |
  | `'tool.execute.before'` hook | always | `PreToolUse` | `{ session_id, tool_name: input.tool, tool_input: output.args }` |
  | `'tool.execute.after'` hook | always | `PostToolUse` | `{ session_id, tool_name: input.tool, tool_input: input.args }` |
  | `event` `session.idle` | root session only | `Stop` | `{ session_id, last_assistant_message: string \| null }` |
  | `event` `permission.asked` (v2 shape; observed on 1.18.30) | always | `Notification` | `{ notification_type: 'permission_prompt', session_id, tool_name: properties.permission, tool_input: { patterns: properties.patterns, ...properties.metadata } }` |
  | `event` `permission.updated` (v1 shape; fallback, not emitted by 1.18.30) | always | `Notification` | `{ notification_type: 'permission_prompt', session_id, tool_name: properties.type, tool_input: { pattern: properties.pattern, ...properties.metadata } }` |
  | `event` `permission.replied` | always | `UserPromptSubmit` | `{ session_id }` |

- **REQ-006**: Subagent sessions do not flip the tab to `waiting`. The plugin keeps a `Map<childId, parentId>` filled from `session.created` and `session.updated` events, where `properties.info.parentID` is set. `rootOf(id)` follows the map to the top. `session.idle` for a non-root session emits nothing. Every other emitted payload uses `rootOf(sessionID)` as `session_id`, so the first line `hooks.ts` sees (`tailLog`, `sessionIdDiscovered`, `hooks.ts:214-223`) always carries the root session id.
- **REQ-007**: `last_assistant_message` is computed as follows. Call `await client.session.messages({ path: { id: sessionID }, query: { limit: 20 } })`. Take `res.data`, an array of `{ info: Message, parts: Part[] }`. Find the last entry with `info.role === 'assistant'`. Join its `parts` that have `type === 'text'` and `!synthetic` with `'\n'`, then trim. If the call throws, returns no data, or yields an empty string, the value is `null`.
- **REQ-008**: Every hook body is wrapped in `try { … } catch {}`. A plugin error must never break or slow the user's opencode session. `emit` uses synchronous `appendFileSync`, so each line is a single `write(2)`.
- **REQ-009**: The file still starts with the line `// harness-opencode-plugin`, the value of `HARNESS_PLUGIN_SIGNATURE` at `opencode.ts:12`. That keeps `hooksInstalled()` and `uninstallHooks()` recognizing both old and new files. The install path stays `PLUGIN_PATH = ~/.config/opencode/plugins/harness-status.js` (`opencode.ts:14`).
- **REQ-010**: opencode 1.18.30 emits `permission.asked` (verified by TASK-001; `permission.updated` never fired). Observed `properties`: `{ id: 'per_…', sessionID, permission: 'bash', patterns: ['ls'], metadata: { command: 'ls' }, always: ['ls *'], tool: { messageID, callID } }`. The reply is `permission.replied` with `{ sessionID, requestID, reply: 'once' | 'always' | 'reject' }`. Keep the `permission.updated` branch as a fallback for older builds. Put this observed name and payload in the commit message and in the plan's "Harness research" "Unverified" line.
- **REQ-011**: Side effect, intended. The first line the plugin emits carries the root session id, so `hooks.ts` dispatches `terminals/sessionIdDiscovered` and the reducer stores `sessionId` on the opencode tab (`src/shared/state/terminals/terminals.ts:112`). The subscriber at `src/main/index.ts:497-501` persists panes right away. After a restart, `buildSpawnArgs` (`opencode.ts:150-173`) calls `sessionFileExists` (`opencode.ts:124-131`, which runs `opencode export <id>`) and, when it succeeds, appends `--session <id>` (`opencode.ts:157-166`). Today's broken plugin never emits, so opencode tabs never resume. After this ticket they do. No code change is needed for this; TEST-012 (h) checks it.
- **CON-001**: Do not change `src/main/hooks/hooks.ts`. Parsing `last_assistant_message`, the `PIPE_BUF` comment and partial-line handling are Item 3.
- **CON-002**: Do not add MCP wiring, `OPENCODE_CONFIG_CONTENT`, a `harness-step` agent, `promptAsync` continuation or `/workflow/stop-check` calls. Those belong to Items 5 and 6 and Phase 2.
- **CON-003**: Do not change `buildSpawnArgs`, `sessionFileExists`, `latestSessionId` or `stripHooksFromWorktree` in `opencode.ts`.
- **GUD-001**: Follow AGENTS.md. Add no new comments except a short "why" where it isn't obvious, such as the single-export rule. Run `pnpm typecheck`, `pnpm build` and `npx vitest run` before committing. Make one descriptive commit, then push.
- **PAT-001**: Existing users get the new file without doing anything. At boot, `src/main/index.ts:3254-3258` calls `installHooksGlobally()` when consent is `'accepted'`, and `installHooks()` (`opencode.ts:99-104`) overwrites `PLUGIN_PATH`. No migration code is needed.

## 2. Implementation Steps

### Implementation Phase 1: Verify 1.18 event names

- GOAL-001: Confirm, on the installed opencode 1.18.30 (`/opt/homebrew/bin/opencode`), the plugin loading contract and the exact permission-prompt event, before writing the final mapping.

- [x] **TASK-001**: Probe the events with a throwaway plugin. Keep it out of the repo and delete it afterwards.
  - Write `~/.config/opencode/plugins/zz-harness-probe.js`:
    ```js
    import { appendFileSync } from 'node:fs'
    export const Probe = async () => ({
      event: async ({ event }) => { try { appendFileSync('/tmp/oc-probe.ndjson', JSON.stringify({ t: event.type, p: event.properties }) + '\n') } catch {} },
      'tool.execute.before': async (i, o) => { try { appendFileSync('/tmp/oc-probe.ndjson', JSON.stringify({ t: 'tool.before', i, o }) + '\n') } catch {} },
      'permission.ask': async (i, o) => { try { appendFileSync('/tmp/oc-probe.ndjson', JSON.stringify({ t: 'hook:permission.ask', i, o }) + '\n') } catch {} }
    })
    ```
  - Start the TUI so bash asks for permission: `OPENCODE_CONFIG_CONTENT='{"permission":{"bash":"ask"}}' opencode` in a scratch git repo. Prompt: `run "ls" with bash`. Approve once, then let the turn finish.
  - Read `/tmp/oc-probe.ndjson` and record:
    - (a) whether the permission bus event is `permission.asked` or `permission.updated`, and its `properties` keys;
    - (b) whether the `permission.ask` hook fires;
    - (c) the `permission.replied` properties;
    - (d) that `session.status` busy/idle and `session.idle` arrive with `properties.sessionID`;
    - (e) the `session.created` `properties.info.parentID` field (prompt `use the task tool to list files` to spawn a subagent).
  - Delete `zz-harness-probe.js` and `/tmp/oc-probe.ndjson`.
  - If (a) shows a shape REQ-005 doesn't cover, change the `Notification` row of REQ-005 to match the observed `properties` before Phase 2. Keep a fallback branch for the other name.
  - **Result (2026-10-02, opencode 1.18.30, TUI under tmux, model `opencode/big-pickle`, probe loaded from a scratch repo's `.opencode/plugins/`):**
    - (a) The bus event is `permission.asked`, with the REQ-005 v2 shape plus `always` and `tool: { messageID, callID }` (full shape in REQ-010). `permission.updated` never fired. `tool.execute.before` fires *before* `permission.asked` for the same `callID`. `tool.execute.after` fires after the reply, and its `input.args` is set.
    - (b) The `permission.ask` plugin hook did **not** fire.
    - (c) `permission.replied` properties are `{ sessionID, requestID, reply: 'once' }`.
    - (d) `session.status` is `{ sessionID, status: { type: 'busy' | 'idle' } }`. `busy` repeats 3 to 5 times per turn, including after the permission reply, so the REQ-005 dedup is required. Every turn ends with `status.type: 'idle'` followed by `session.idle` `{ sessionID }`.
    - (e) A `task` subagent gets its own `session.created`/`session.updated` with `info.parentID` set to the root session id. The child emits its own `session.status`, `permission.asked` (with the **child** `sessionID`) and `session.idle`. The parent stays `busy` until the child finishes. The parent emits no idle in between.
    - `client.session.messages({ path: { id } })` inside `session.idle` returns the finished turn. `res.data` is `[{ info, parts }]`, and the last `info.role === 'assistant'` entry's parts are `[step-start, text, step-finish]`, where the text part holds the final reply. A turn with a tool call produces two assistant messages, and only the last one holds the final text. `query: { limit: 1 }` returns just that latest assistant message.
    - In `opencode run` (non-interactive), a bash `ask` permission hangs the run with no prompt. Do not use `run` for this probe.

### Implementation Phase 2: Rewrite the generator

- GOAL-002: `makePluginContent()` emits the ESM plugin defined by REQ-001 to REQ-009.

- [ ] **TASK-002**: In `src/main/agents/opencode.ts`, replace the body of `makePluginContent()` (`:32-87`) and export the function (`export function makePluginContent(): string`) so tests can run its output. The template literal must produce this module. Escape `\n` as `\\n` inside the TS template literal, the same way the current code does at `:43`.
  ```js
  // harness-opencode-plugin
  // Auto-generated by Harness. Emits status events to /tmp/harness-status.
  import { appendFileSync, mkdirSync } from 'node:fs'
  import { join } from 'node:path'

  const STATUS_DIR = '/tmp/harness-status'

  export const HarnessStatus = async ({ client }) => {
    const terminalId = process.env.HARNESS_TERMINAL_ID || process.env.CLAUDE_HARNESS_ID
    if (!terminalId) return {}
    const file = join(STATUS_DIR, terminalId + '.ndjson')
    const parents = new Map()
    const busy = new Set()
    const rootOf = (id) => { let cur = id; const seen = new Set(); while (parents.has(cur) && !seen.has(cur)) { seen.add(cur); cur = parents.get(cur) } return cur }
    const emit = (event, payload) => {
      try {
        mkdirSync(STATUS_DIR, { recursive: true })
        appendFileSync(file, JSON.stringify({ event, ts: Math.floor(Date.now() / 1000), payload }) + '\n')
      } catch {}
    }
    const lastAssistantMessage = async (id) => {
      try {
        const res = await client.session.messages({ path: { id }, query: { limit: 20 } })
        const list = Array.isArray(res?.data) ? res.data : []
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i]?.info?.role !== 'assistant') continue
          const text = (list[i].parts || []).filter((p) => p?.type === 'text' && !p.synthetic).map((p) => p.text).join('\n').trim()
          return text || null
        }
      } catch {}
      return null
    }
    return {
      event: async ({ event }) => {
        try {
          const p = event?.properties || {}
          switch (event?.type) {
            case 'session.created':
            case 'session.updated':
              if (p.info?.id && p.info.parentID) parents.set(p.info.id, p.info.parentID)
              break
            case 'session.status': {
              const root = rootOf(p.sessionID)
              if (p.status?.type === 'busy') { if (!busy.has(root)) { busy.add(root); emit('UserPromptSubmit', { session_id: root }) } }
              else if (p.status?.type === 'idle' && root === p.sessionID) busy.delete(root)
              break
            }
            case 'session.idle': {
              if (!p.sessionID || parents.has(p.sessionID)) break
              busy.delete(p.sessionID)
              emit('Stop', { session_id: p.sessionID, last_assistant_message: await lastAssistantMessage(p.sessionID) })
              break
            }
            case 'permission.asked':
              emit('Notification', { notification_type: 'permission_prompt', session_id: rootOf(p.sessionID), tool_name: p.permission, tool_input: { patterns: p.patterns, ...(p.metadata || {}) } })
              break
            case 'permission.updated':
              emit('Notification', { notification_type: 'permission_prompt', session_id: rootOf(p.sessionID), tool_name: p.type, tool_input: { pattern: p.pattern, ...(p.metadata || {}) } })
              break
            case 'permission.replied':
              emit('UserPromptSubmit', { session_id: rootOf(p.sessionID) })
              break
          }
        } catch {}
      },
      'tool.execute.before': async (input, output) => {
        try { emit('PreToolUse', { session_id: rootOf(input?.sessionID), tool_name: input?.tool, tool_input: output?.args ?? {} }) } catch {}
      },
      'tool.execute.after': async (input) => {
        try { emit('PostToolUse', { session_id: rootOf(input?.sessionID), tool_name: input?.tool, tool_input: input?.args ?? {} }) } catch {}
      }
    }
  }
  ```
  - Adjust the permission branches to match TASK-001's findings, if needed.
- [ ] **TASK-003**: In `src/main/agents/opencode.ts:19-26`, set `hookEvents` to `['session.created', 'session.updated', 'session.status', 'session.idle', 'tool.execute.before', 'tool.execute.after', 'permission.asked', 'permission.updated', 'permission.replied']`. The `AgentModule.hookEvents` field (`src/main/agents/index.ts:22`) is informational. Nothing outside `src/main/agents/` reads it.
- [ ] **TASK-004**: Leave `installHooks`, `hooksInstalled` and `uninstallHooks` (`opencode.ts:89-117`) unchanged. They key on the signature line, which REQ-009 keeps.

### Implementation Phase 3: Tests

- GOAL-003: `opencode.test.ts` covers the generated content statically and by running it in Node with a fake `client`.
- The unit tests use a fake `client`, so they cannot catch drift in the real opencode 1.18 SDK shape (`client.session.messages({ path, query: { limit } })` returning `res.data`). That shape is verified only manually, by TASK-001 and TEST-012 (e). Re-run TEST-012 (e) after any opencode upgrade.

- [ ] **TASK-005**: Add a `describe('makePluginContent', …)` block to `src/main/agents/opencode.test.ts` with static assertions (TEST-001 to TEST-003). The file mocks `fs` (`:5-20`), so these tests only inspect the returned string.
- [ ] **TASK-006**: Create `src/main/agents/opencode-plugin.test.ts`. It needs no `fs` mock, because it writes real files. It covers TEST-004 to TEST-011.
  - In `beforeAll`, `mkdtempSync(join(tmpdir(), 'harness-oc-'))`, then write `makePluginContent()` to `<dir>/plugin.mjs` and a driver `<dir>/drive.mjs`.
  - The driver reads a JSON script from `process.argv[2]`, does `const { HarnessStatus } = await import('./plugin.mjs')`, and builds a fake client: `{ session: { messages: async () => ({ data: script.messages ?? [] }) } }` (or one that throws when `script.messagesThrow`). It calls the factory, then for each step runs either `await hooks.event({ event: step.event })` or `await hooks[step.hook](step.input, step.output)`. It prints `JSON.stringify({ keys: Object.keys(hooks) })`.
  - Run the driver with `execFileSync(process.execPath, [drive, JSON.stringify(script)], { env: { PATH: process.env.PATH, HARNESS_TERMINAL_ID: id } })`. Use a unique `id = 'vitest-oc-' + randomUUID()` per test. Read `/tmp/harness-status/<id>.ndjson`, split into lines, and `JSON.parse` each line. Remove the file in `afterEach` (track the current test's path in a variable) or in a `try { … } finally { rmSync(path, { force: true }) }` around the run and the assertions. An inline `rmSync` after the reads only runs if the test gets that far, so a failing test would leak files. In `afterAll`, `rmSync` the `mkdtemp` directory with `{ recursive: true, force: true }`. This follows the `runHook` helper in `src/main/hooks/hooks.test.ts:12-22`. Running in a child process avoids vitest's module transforms on the generated file. `process.execPath` is Node under vitest.
  - Add `vi.mock('../debug', () => ({ log: () => {} }))`, as in the existing tests.

## 3. Alternatives

- **ALT-001**: Keep CommonJS and switch only the field names. Rejected: opencode 1.18 calls exported factories and ignores `module.exports.onEvent`. The documented ESM factory is the format verified to load (gap 3).
- **ALT-002**: Emit opencode-native event names and teach `hooks.ts` an opencode branch. Rejected: `deriveStatus()` already handles `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` and `Notification`. Mapping in the plugin keeps `hooks.ts` agent-agnostic, and Item 3 stays a single parsing change.
- **ALT-003**: Use the `permission.ask` plugin hook instead of the bus event for approval detection. Rejected as the primary path: other plugins (for example `oh-my-opencode-slim`) can set `output.status` before or after ours, so the hook does not mean a prompt was shown. The bus event fires only when the TUI asks. TASK-001 records whether the hook fires, for reference.
- **ALT-004**: Use `chat.message` for `UserPromptSubmit`. Rejected: it fires only for user messages, not for a turn resumed after a permission reply or a `promptAsync`. `session.status` `busy` covers every case.
- **ALT-005**: Run the generated plugin inside vitest with a dynamic `import()`. Rejected: the existing `opencode.test.ts` mocks `fs`, and vite transforms on an out-of-tree `.mjs` are less predictable than a plain `node` child process.

## 4. Dependencies

- **DEP-001**: None on other milestone items. Item 3 and Item 5 depend on this ticket.
- **DEP-002**: opencode ≥ 1.18 installed locally (`/opt/homebrew/bin/opencode` reports 1.18.30), for TASK-001 and TEST-012. The plugin API reference is `@opencode-ai/plugin` 1.18.23 `dist/index.d.ts` (`Hooks`, `PluginInput`) and `@opencode-ai/sdk` 1.18.23 `dist/gen/types.gen.d.ts` (v1 events) and `dist/v2/gen/types.gen.d.ts` (v2 events). Local copies are under `~/.cache/opencode/packages/oh-my-opencode-slim@latest/node_modules/@opencode-ai/`. No package is added to Tatsu.

## 5. Files

- **FILE-001**: `src/main/agents/opencode.ts`. Rewrite and export `makePluginContent()` (`:32-87`) and update `hookEvents` (`:19-26`).
- **FILE-002**: `src/main/agents/opencode.test.ts`. Add static `makePluginContent` assertions.
- **FILE-003**: `src/main/agents/opencode-plugin.test.ts`, a new file. Behavioural tests that run the generated plugin in a Node child process.
- **FILE-004**: `plans/dynamic-workflows/dynamic-workflows.md`. Mark gap 3 closed with the commit hash. Replace the "opencode permission-prompt event name on 1.18" clause in the "Unverified" line under "Harness research" with the observed result.

## 6. Testing

- **TEST-001**: The first line of the `makePluginContent()` output (`output.split('\n')[0]`) equals `HARNESS_PLUGIN_SIGNATURE` (`// harness-opencode-plugin`, REQ-009). The output contains `export const HarnessStatus = async`.
- **TEST-002**: Single export and no CommonJS (REQ-001). The output matches `/\bexport\b/g` exactly once and `/^export /m` exactly once. It matches neither `/\brequire\s*\(/` nor `module.exports`.
- **TEST-003**: The output contains `'tool.execute.before'`, `'tool.execute.after'`, `client.session.messages`, `properties` and `sessionID`, and does not contain `ev.payload`.
- **TEST-004**: The plugin loads as ESM in Node (the driver exits 0), and the factory returns hooks whose keys are `event`, `tool.execute.before` and `tool.execute.after`.
- **TEST-005**: With `HARNESS_TERMINAL_ID` and `CLAUDE_HARNESS_ID` both unset, the factory returns `{}` and no file is written. With only `CLAUDE_HARNESS_ID` set, lines go to `<CLAUDE_HARNESS_ID>.ndjson`.
- **TEST-006**: `session.status` busy, busy, idle, busy for session `s1` emits exactly two `UserPromptSubmit` lines with `payload.session_id === 's1'`. Every line has `event`, a numeric `ts` and `payload`.
- **TEST-007**: Calling `tool.execute.before` with `({ tool: 'bash', sessionID: 's1', callID: 'c1' }, { args: { command: 'ls' } })` emits `PreToolUse` with `tool_name: 'bash'` and `tool_input: { command: 'ls' }`. Calling `tool.execute.after` with `input.args` emits `PostToolUse` with the same fields.
- **TEST-008**: `session.idle` for `s1`, with fake messages `[user, assistant{parts:[text 'a', text synthetic 'x', tool, text 'b']}]`, emits `Stop` with `last_assistant_message: 'a\nb'`. With `messagesThrow: true`, it emits `Stop` with `last_assistant_message: null`.
- **TEST-009**: After `session.created` with `info: { id: 'child', parentID: 's1' }`:
  - `session.idle` for `child` emits nothing;
  - `tool.execute.before` with `sessionID: 'child'` emits `session_id: 's1'`;
  - `session.status` busy for `child` while `s1` is already busy emits nothing new.
- **TEST-010**: The `permission.asked` v2 shape (`{ id, sessionID: 's1', permission: 'bash', patterns: ['ls'], metadata: {} }`) emits `Notification` with `notification_type: 'permission_prompt'`, `tool_name: 'bash'` and `tool_input.patterns: ['ls']`. The `permission.updated` v1 shape (`{ id, type: 'bash', pattern: 'ls', sessionID: 's1', … }`) emits `Notification` with `tool_name: 'bash'`. `permission.replied` emits `UserPromptSubmit`.
- **TEST-011**: An `event` with an unknown type, a missing `properties`, or a malformed hook input (`undefined`) does not throw. The driver exits 0.
- **TEST-012** (manual, required before merge): Run `pnpm dev`, accept hooks if prompted, and confirm `~/.config/opencode/plugins/harness-status.js` is the new ESM file. Open an opencode tab, set `OPENCODE_CONFIG_CONTENT='{"permission":{"bash":"ask"}}'` (for example through the tab's command setting), and give it a prompt that runs `ls` with bash. Confirm all of the following:
  - (a) the tab shows working while the turn runs;
  - (b) it shows needs-approval with the bash tool while the permission prompt is open;
  - (c) it returns to working after approval;
  - (d) it shows idle/waiting when the turn ends;
  - (e) `/tmp/harness-status/<terminalId>.ndjson` has a `Stop` line whose `last_assistant_message` matches the reply;
  - (f) a subagent (`task`) turn does not flip the tab to waiting before the parent finishes;
  - (g) `opencode` started in a plain terminal outside Tatsu writes nothing;
  - (h) quit and relaunch Tatsu, and confirm the opencode tab resumes the same opencode session (REQ-011): the earlier conversation is visible, and the respawn command includes `--session <id>`.
- **TEST-013**: Run `pnpm typecheck`, `pnpm build` and `npx vitest run`. All pass.

## 7. Risks & Assumptions

- **RISK-001**: opencode might load `~/.config/opencode/plugins/*.js` from a different directory name on some versions (`plugin/` vs `plugins/`). Mitigation: TASK-001 places the probe at the same directory as `PLUGIN_PATH`, so a probe that writes nothing exposes the problem before the rewrite.
- **RISK-002**: `client.session.messages()` without `limit` returns the whole session, which is slow on very long sessions. It runs once per root idle, which is acceptable. TASK-001 confirmed that `query.limit` returns the latest N messages, so pass `query: { limit: 20 }`.
- **RISK-003**: A `Stop` line with a long `last_assistant_message` can exceed `PIPE_BUF` (4096 B). That is safe because only this terminal's opencode process writes the file, but `hooks.ts`'s comment and partial-line handling still assume otherwise. Item 3 fixes this. Until it lands, `tailLog` already keeps a trailing partial line in `residual` (`hooks.ts:194-199`), so a split write is parsed on the next read.
- **RISK-004**: Another plugin may throw inside the same opencode process. Our hooks catch all of their own errors and cannot be affected by others' failures.
- **RISK-005**: The parent map is filled only from `session.created`/`session.updated` events seen after the plugin loaded. A child session created before that (for example, opencode was already running when the plugin was installed) is treated as a root, so its `session.idle` could emit a spurious `Stop` and flip the tab to waiting early. Accepted: the plugin loads at opencode start, so this only affects sessions already running when the plugin was installed, and the next root turn corrects the status.
- **RISK-006**: The opencode 1.18 SDK shape (`client.session.messages({ path, query: { limit } })`, `res.data`) is verified only manually (TASK-001, TEST-012 (e)). The unit tests use a fake client and cannot catch drift. If the shape changes, `last_assistant_message` silently becomes `null`, while status detection keeps working.
- **ASSUMPTION-001**: `session.idle` fires once per finished root turn on 1.18.30. This was verified during plan research ("Harness research", gap 3). `session.status` with `busy` fires at the start of every turn, including one resumed after a permission reply. TASK-001 (d) confirmed both on 1.18.30. `busy` also repeats several times within one turn.
- **ASSUMPTION-002**: `PtyManager` sets `HARNESS_TERMINAL_ID` for opencode tabs (`src/main/pty-manager/pty-manager.ts:149`), and opencode passes its environment through to plugins via `process.env`.

## 8. Related Specifications / Further Reading

- `plans/dynamic-workflows/milestones/milestone-1-prerequisites/goal.md`, Item 1
- `plans/dynamic-workflows/dynamic-workflows.md`: "Gaps found" (gap 3), "Harness research (2026-10-01)", "Architecture" (Agents bullet)
- `src/main/hooks/hooks.ts` (`deriveStatus`, `tailLog`), the consumer of the emitted lines
- opencode plugin docs: https://opencode.ai/docs/plugins/

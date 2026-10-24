---
goal: Parse last_assistant_message from every agent's Stop line, emit Stops without a transcript path, and make the NDJSON hook reader byte-safe for lines larger than PIPE_BUF
date_created: 2026-10-02
status: 'Planned'
tags: [bug, hooks, claude, codex, opencode, milestone-1, dynamic-workflows]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Milestone 1, Item 3 (closes gap 7 in `plans/dynamic-workflows/dynamic-workflows.md` "Gaps found"). Depends on Item 1 (`01-opencode-plugin-esm.md`).

Every agent's hook appends one NDJSON line per event to `/tmp/harness-status/<terminalId>.ndjson`, shaped `{"event":E,"ts":<sec>,"payload":P}`. `src/main/hooks/hooks.ts` tails that file. Three things are wrong or missing today:

| Location | Today | Problem |
|---|---|---|
| `hooks.ts:38-41` (comment above `makeHookCommand`) | "A single write(2) under PIPE_BUF (4096 bytes) is guaranteed atomic vs. other O_APPEND writers on POSIX." | `Stop` payloads carry `last_assistant_message` and are often several KB. `PreToolUse` payloads for `Write`/`Edit` are too. The comment describes a guarantee the code doesn't have. |
| `hooks.ts:128-130`, `:189-199` (`residual`, `tailLog`) | Reads `size - off` bytes, sets the offset to `size` without checking `bytesRead`, decodes the chunk with `buf.toString('utf-8')`, then keeps the text after the last `\n` as a `string` residual. | A read that ends inside a multi-byte UTF-8 character decodes both halves to `U+FFFD`. The line still parses as JSON, so the corruption is silent. Assistant messages regularly contain non-ASCII (`—`, `→`, curly quotes, emoji). |
| `hooks.ts:135-170` (`StopEvent`, `emitStopIfRelevant`) | Emits a `StopEvent` only when the payload has both a string `session_id` and a string `transcript_path`. `last_assistant_message` is never read. | opencode `Stop` lines from Item 1 carry `session_id` and `last_assistant_message` but no `transcript_path`, so they are dropped. Codex's `transcript_path` may be `null`. The workflow runner (Phase 2) needs the final message as its fallback `summary` (plan, "Step output contract", step 2). |

This ticket:

1. Parses `last_assistant_message` from every `Stop` line, whatever the agent, into `StopEvent.lastAssistantMessage: string | null`.
2. Emits a `StopEvent` for every `Stop` line with a string `session_id`, with `transcriptPath: string | null`. `CostTracker` skips Stops with no transcript path.
3. Replaces the `PIPE_BUF` comment with an accurate one.
4. Makes the reader work on bytes: it keeps a partial trailing line as a `Buffer` until its `\n` arrives, decodes only complete lines, reads until it has the bytes `fstat` reported (or hits end of file), and advances the offset by the bytes actually read.

**Where the message goes.** `lastAssistantMessage` lives only on the main-process `StopEvent`, delivered through the existing `onStopEvent()` listener channel. It is **not** added to a store slice. The value can be many KB per turn per terminal, no renderer shows it, and a slice would push it over IPC/WebSocket to every client on every turn. The Phase 2 runner is main-side and subscribes with `onStopEvent()`. If a later UI needs it, that is a separate slice decision.

This ticket completes Item 3. The runner that consumes `lastAssistantMessage` is Phase 2 and out of scope.

## 1. Requirements & Constraints

- **REQ-001**: `StopEvent` in `src/main/hooks/hooks.ts:135-140` becomes:
  ```ts
  export interface StopEvent {
    terminalId: string
    sessionId: string
    transcriptPath: string | null
    lastAssistantMessage: string | null
    ts: number
  }
  ```
- **REQ-002**: `emitStopIfRelevant` (`hooks.ts:155-170`) emits a `StopEvent` for every line with `ev.event === 'Stop'`, a non-null object `payload`, and a non-empty string `payload.session_id`. Field rules:
  - `transcriptPath` is `payload.transcript_path` when it is a non-empty string, otherwise `null`.
  - `lastAssistantMessage` is `payload.last_assistant_message` when it is a non-empty string, otherwise `null`. The string is passed through unchanged (no trim, no truncation).
  - A `Stop` line without a string `session_id` still emits nothing, as today. It still drives `deriveStatus()` to `waiting`, as today.
- **REQ-003**: There is no per-agent branch. Claude (`last_assistant_message: string`, `transcript_path: string`), Codex (`last_assistant_message: string | null`, `transcript_path: string | null`) and opencode (Item 1: `{ session_id, last_assistant_message: string | null }`, no `transcript_path`) all go through REQ-002.
- **REQ-004**: `CostTracker.handleStop` (`src/main/cost-tracker/cost-tracker.ts:110-114`) returns immediately when `ev.transcriptPath === null`, **before** `this.lastStops.set(...)`. `parseAndDispatchStop` (`:116-138`) reads the path into a local `const transcriptPath = ev.transcriptPath` and returns if it is `null`, so its type narrows to `string` for `parseIncremental` and `SessionUsage.transcriptPath` (`src/shared/state/costs/types.ts:48`, which stays `string`). Cost behaviour for Claude and Codex Stops with a path is unchanged.
- **REQ-005**: `emitStopIfRelevant` logs one line per emitted Stop: `log('hooks', \`stop terminal=${terminalId} transcript=${transcriptPath ? 'yes' : 'no'} lastMessageChars=${lastAssistantMessage?.length ?? 0}\`)`. It never logs the message text itself.
- **REQ-006**: The reader works on bytes:
  - `residual` (`hooks.ts:130`) becomes `Map<string, Buffer>`.
  - A new exported pure function `splitNdjson(pending: Buffer, chunk: Buffer): { lines: string[]; rest: Buffer }` concatenates `pending` and `chunk`, splits on byte `0x0a`, decodes each complete line with `toString('utf-8')`, and returns everything after the last `0x0a` as `rest` (a zero-length `Buffer` when the input ends with `0x0a`). It does not trim or filter; `tailLog` keeps skipping blank lines (`:202`).
  - `tailLog` stores `rest` in `residual` when `rest.length > 0`, otherwise deletes the entry.
  - `tailLog` calls `readSync` in a loop until it has read `len = size - off` bytes or a call returns `0`, accumulating the total in `n`. A single `readSync` may return fewer bytes than asked for; the loop keeps those bytes from waiting for the next `fs.watch` event, which may never come if the agent goes quiet after its `Stop` line.
  - `tailLog` advances the offset by the bytes actually read, `offsets.set(terminalId, off + n)`, and passes `buf.subarray(0, n)` to `splitNdjson`.
  - The truncation reset (`:183-187`) and `cleanupTerminalLog` (`:265-275`) keep deleting the residual.
- **REQ-007**: `tailLog` is exported (`export function tailLog(terminalId: string, store: Store): void`) so tests can drive it without `fs.watch`. Its behaviour is otherwise unchanged: session-id discovery (`:214-223`), `emitStopIfRelevant`, `deriveStatus`, and `terminals/statusChanged` dispatch stay in the same order.
- **REQ-008**: The comment block above `makeHookCommand` (`hooks.ts:38-41`) is replaced with exactly:
  ```ts
  // POSIX only — no jq, no python. The bash reads stdin into a shell var,
  // defaults empty to `null`, then printf appends one line to the file.
  // Lines often exceed PIPE_BUF (4096 bytes): Stop carries
  // last_assistant_message and PreToolUse carries whole file contents, so a
  // line can land in several write(2) calls. That is safe because each
  // terminal's file has a single writer, the one agent running in that
  // terminal, and the reader in tailLog holds a partial trailing line until
  // its newline arrives.
  ```
  The comment deliberately says nothing about hook ordering. `Stop` normally fires after the turn's other hooks finish, but no agent documents that as a guarantee, so the claim would go stale in code. It lives in RISK-001 instead.

  The comment above `makeHookScript` (`:52-56`) still says "Same NDJSON writer as makeHookCommand" and needs no change.
- **REQ-009**: The `residual` comment (`hooks.ts:128-129`) is replaced with: `// Bytes after the last newline from the previous read: a line still being written. Kept as bytes so a multi-byte character split across reads decodes intact.`
- **CON-001**: Do not change the hook writers: `makeHookCommand`, `makeHookScript` (`hooks.ts:42-67`), the Claude entries in `src/main/agents/claude.ts:55-98`, or the Codex entries and `harness-hook.sh` in `src/main/agents/codex.ts:47-151`. They already append the entire stdin payload, so `last_assistant_message` is already on disk. Changing the Codex command text would also reset Codex hook trust (gap 9).
- **CON-002**: Do not change the opencode plugin. Item 1 owns its line shape.
- **CON-003**: Do not add a store slice, a `StateEvent` variant, or any renderer/transport surface for `lastAssistantMessage` (see Introduction, "Where the message goes").
- **CON-004**: Do not change `deriveStatus()` (`hooks.ts:97-123`) or the `HookEvent` interface (`:69-73`).
- **GUD-001**: Follow AGENTS.md. No new comments beyond REQ-008 and REQ-009. Run `pnpm typecheck`, `pnpm build` and `npx vitest run` before committing. One descriptive commit for the code, then push. The gap-7 edit to the plan is a separate commit (TASK-009).
- **PAT-001**: Tests follow `src/main/hooks/hooks.test.ts`: `vi.mock('../debug', () => ({ log: vi.fn() }))`, real files under `/tmp/harness-status/`, a unique terminal id per test, cleanup in `finally`/`afterEach`.

## 2. Implementation Steps

### Implementation Phase 1: Byte-safe reader

- GOAL-001: `tailLog` never splits or corrupts a line, whatever its size or where a read boundary falls.

- [ ] **TASK-001**: In `src/main/hooks/hooks.ts`, add `splitNdjson` (REQ-006) above `tailLog`:
  ```ts
  export function splitNdjson(pending: Buffer, chunk: Buffer): { lines: string[]; rest: Buffer } {
    const data = pending.length ? Buffer.concat([pending, chunk]) : chunk
    const lines: string[] = []
    let start = 0
    let nl = data.indexOf(0x0a, start)
    while (nl !== -1) {
      lines.push(data.toString('utf-8', start, nl))
      start = nl + 1
      nl = data.indexOf(0x0a, start)
    }
    return { lines, rest: Buffer.from(data.subarray(start)) }
  }
  ```
  `Buffer.from(subarray)` copies the tail so the residual doesn't pin the whole read buffer.
- [ ] **TASK-002**: Change `residual` to `Map<string, Buffer>` and replace its comment (REQ-009).
- [ ] **TASK-003**: Export `tailLog` (REQ-007) and replace `hooks.ts:189-199` with:
  ```ts
  const len = size - off
  const buf = Buffer.alloc(len)
  let n = 0
  while (n < len) {
    const r = readSync(fd, buf, n, len - n, off + n)
    if (r === 0) break
    n += r
  }
  offsets.set(terminalId, off + n)

  const { lines, rest } = splitNdjson(residual.get(terminalId) ?? Buffer.alloc(0), buf.subarray(0, n))
  if (rest.length) residual.set(terminalId, rest)
  else residual.delete(terminalId)
  ```
  This removes the old `text`, `lines` and `tail` locals (`:194-199`, including the `// Last chunk may be a partial line` comment) and the single `readSync` / `offsets.set(terminalId, size)` pair, so `lines` is declared only once. `const len`, `Buffer.alloc(len)` and the `if (size === off) return` early return above them stay as they are. The loop from `:201` is unchanged.
- [ ] **TASK-004**: Replace the comment at `hooks.ts:38-41` with the text in REQ-008.

### Implementation Phase 2: Stop payload parsing

- GOAL-002: Every `Stop` line with a session id reaches `onStopEvent` listeners with its final message, and `CostTracker` ignores the ones it can't use.

- [ ] **TASK-005**: Update `StopEvent` (REQ-001) and rewrite `emitStopIfRelevant` (REQ-002, REQ-005):
  ```ts
  function emitStopIfRelevant(terminalId: string, ev: HookEvent): void {
    if (ev.event !== 'Stop') return
    const p = ev.payload
    if (!p || typeof p !== 'object') return
    const sessionId = p.session_id
    if (typeof sessionId !== 'string' || !sessionId) return
    const transcriptPath = typeof p.transcript_path === 'string' && p.transcript_path ? p.transcript_path : null
    const lastAssistantMessage =
      typeof p.last_assistant_message === 'string' && p.last_assistant_message ? p.last_assistant_message : null
    log('hooks', `stop terminal=${terminalId} transcript=${transcriptPath ? 'yes' : 'no'} lastMessageChars=${lastAssistantMessage?.length ?? 0}`)
    const payload: StopEvent = { terminalId, sessionId, transcriptPath, lastAssistantMessage, ts: ev.ts }
    for (const l of stopListeners) {
      try {
        l(payload)
      } catch (err) {
        log('hooks', 'stop listener error', err instanceof Error ? err.message : err)
      }
    }
  }
  ```
- [ ] **TASK-006**: Update the JSDoc on `onStopEvent` (`hooks.ts:145-147`) to: `/** Subscribe to Stop hook events: session id, transcript_path when the agent has one, and the turn's final assistant message. Used by CostTracker to re-tail a session jsonl. Returns an unsubscribe fn. */`
- [ ] **TASK-007**: In `src/main/cost-tracker/cost-tracker.ts`, apply REQ-004:
  - `handleStop`: first line `if (ev.transcriptPath === null) return`.
  - `parseAndDispatchStop`: first lines `const transcriptPath = ev.transcriptPath` and `if (transcriptPath === null) return`. Use `transcriptPath` instead of `ev.transcriptPath` at `:118`, `:122` and `:135`.
  - Run `pnpm typecheck` and fix any other `StopEvent` construction it reports, in source and test files alike (`tsconfig` project references cover `*.test.ts`). Today the only producer is `emitStopIfRelevant` and the only consumer is `CostTracker`. `src/main/cost-tracker/cost-tracker.test.ts` builds no `StopEvent` objects (it drives `CostTracker` through a mocked `fs.readFileSync` and never calls `handleStop`), and `grep -rn StopEvent src` finds no test that does, so no test fixture needs `lastAssistantMessage`. If one appears before this lands, add `lastAssistantMessage: null` to it.

### Implementation Phase 3: Tests and verification

- GOAL-003: Unit tests pin the reader and the Stop parsing. CI checks pass. The plan records gap 7 as closed.

- [ ] **TASK-008**: Extend `src/main/hooks/hooks.test.ts` with TEST-001 to TEST-009 and TEST-012.
  - Import `splitNdjson`, `tailLog`, `onStopEvent`, `cleanupTerminalLog`, `type StopEvent` from `'.'`, and `type { Store } from '../store'`.
  - Fake store: `const dispatch = vi.fn(); const store = { dispatch } as unknown as Store`.
  - For `tailLog` tests, use `id = 'vitest-hooks-' + randomUUID()` (from `crypto`), `mkdirSync('/tmp/harness-status', { recursive: true })`, write with `appendFileSync`, call `tailLog(id, store)` after each write, and call `cleanupTerminalLog(id)` in `afterEach`. It deletes the file and all per-terminal maps.
  - Capture Stops with `const stops: StopEvent[] = []; const off = onStopEvent((e) => stops.push(e))` and call `off()` in `afterEach`.
  - For TEST-012, wrap `fs.readSync` with a pass-through mock that caps each read, following the `vi.mock('fs', ...)` pattern in `src/main/cost-tracker/cost-tracker.test.ts`: `const fsCap = vi.hoisted(() => ({ maxRead: Infinity }))`, then `vi.mock('fs', async () => { const actual = await vi.importActual<typeof import('fs')>('fs'); return { ...actual, readSync: (fd: number, buf: Buffer, offset: number, length: number, position: number) => actual.readSync(fd, buf, offset, Math.min(length, fsCap.maxRead), position) } })`. Reset `fsCap.maxRead = Infinity` in `afterEach` so the other tests do full reads.
- [ ] **TASK-009**: Run `pnpm typecheck`, `pnpm build`, `npx vitest run`, then TEST-010 ((c) only once Item 1 is merged, DEP-001). Commit the code and tests with a message such as `Parse last_assistant_message from Stop hooks and keep split NDJSON lines intact`, then push. After that, edit `plans/dynamic-workflows/dynamic-workflows.md`:
  - Gap 7 ("Gaps found", the line starting `7. **Hook line atomicity.**`): append the following, where `<short hash>` is the short hash of the code commit above (`git rev-parse --short HEAD` right after that commit), not of the plan-edit commit: `Closed in <short hash>: the comment now says lines can exceed PIPE_BUF and why that is safe, the reader buffers partial lines as bytes, and every Stop's last_assistant_message reaches onStopEvent.`
  - "Existing primitives", row "Final assistant message": replace `Only \`src/main/hooks/hooks.ts\` parsing is missing.` with `\`hooks.ts\` parses it (and opencode's plugin-emitted value) into \`StopEvent.lastAssistantMessage\`.`
  - Commit that edit separately and push.

## 3. Alternatives

- **ALT-001**: Store the last message in the `terminals` slice (for example `lastAssistantMessage: Record<terminalId, string>`). Rejected: messages can be many KB, nothing in the renderer reads them, and every client would receive them on every turn. The runner is main-side and `onStopEvent` already exists for main-side Stop consumers. CON-003.
- **ALT-002**: Keep `emitStopIfRelevant` requiring `transcript_path`, and add a second opencode-only event. Rejected: two channels for the same turn-end signal, and Codex Stops with a `null` path would still be lost. One `StopEvent` with a nullable path is simpler, and `CostTracker` is the only consumer that needs the path.
- **ALT-003**: Make lines atomic on the writer side (write to a temp file and `mv`, or `flock`). Rejected: every file has one writer, so the only failure was the reader's. Changing the Codex command text would also reset Codex hook trust (gap 9).
- **ALT-004**: Keep `string` residuals and use `StringDecoder` per terminal. It would also fix the multi-byte split, but it adds a per-terminal decoder object to manage alongside `offsets`/`residual`. Splitting on byte `0x0a` is safe in UTF-8 (it never appears inside a multi-byte sequence) and gives a pure, easily tested function.
- **ALT-005**: Truncate `lastAssistantMessage` to a fixed size. Rejected: the runner uses it as the step `summary` and later steps need the full text. It never leaves main and is never logged.

## 4. Dependencies

- **DEP-001**: Item 1 (`01-opencode-plugin-esm.md`) defines the opencode `Stop` line shape `{ session_id, last_assistant_message: string | null }` with no `transcript_path`. The code in this ticket doesn't import anything from Item 1, so Phases 1-3 and TEST-001 to TEST-009 (plus TEST-012) can be implemented and committed before Item 1 merges. Only TEST-007 (whose fixture must match the shape Item 1 actually ships) and TEST-010 (c) (which needs a working opencode plugin) need Item 1 merged; re-check TEST-007's fixture and run TEST-010 (c) once it is.
- **DEP-002**: Claude Code ≥ 2.1.x (2.1.286 on the dev machine), whose `Stop` payload includes `last_assistant_message` (plan, "Harness research", row "Hook carries final message").
- **DEP-003**: None for Codex. Codex isn't installed on the dev machine, so the nullable Codex shape is covered by fixtures (TEST-006) only. When Item 8 installs Codex, re-run TEST-010 (b).

## 5. Files

- **FILE-001**: `src/main/hooks/hooks.ts`. Replace the PIPE_BUF comment (`:38-41`). `residual` becomes `Map<string, Buffer>` with a new comment (`:128-130`). New `StopEvent` fields (`:135-140`). New `onStopEvent` JSDoc (`:145-147`). Rewrite `emitStopIfRelevant` (`:155-170`). Add the exported `splitNdjson`. Export `tailLog` and switch it to byte reads (`:172-199`).
- **FILE-002**: `src/main/cost-tracker/cost-tracker.ts`. Null-path guards in `handleStop` and `parseAndDispatchStop` (`:110-138`).
- **FILE-003**: `src/main/hooks/hooks.test.ts`. New tests TEST-001 to TEST-009 and TEST-012, and a pass-through `fs.readSync` mock.
- **FILE-004**: `plans/dynamic-workflows/dynamic-workflows.md`. Gap 7 closed with the commit hash, and the "Final assistant message" row updated (separate commit).

## 6. Testing

- **TEST-001** (`splitNdjson`): `splitNdjson(empty, Buffer.from('{"a":1}\n{"b":2}\n'))` returns `lines: ['{"a":1}', '{"b":2}']` and a zero-length `rest`.
- **TEST-002** (`splitNdjson`): `splitNdjson(empty, Buffer.from('{"a":1}\n{"b":'))` returns `lines: ['{"a":1}']` and `rest` equal to `'{"b":'`. Passing that `rest` with `Buffer.from('2}\n')` returns `lines: ['{"b":2}']`.
- **TEST-003** (`splitNdjson`, multi-byte split): take `const line = Buffer.from('{"m":"a—b🙂c"}\n')`, then split it at every byte index `i` from 1 to `line.length - 1`. For each `i`, `splitNdjson(empty, line.subarray(0, i))` followed by `splitNdjson(rest, line.subarray(i))` yields exactly one line, and `JSON.parse(line).m === 'a—b🙂c'`. A variant that decodes each chunk with `toString('utf-8')` and keeps a string residual (the approach `tailLog` uses today) fails this test; `splitNdjson` itself is new, so there is no current version of it to fail.
- **TEST-004** (`tailLog`, split across two reads): build `const line = Buffer.from(JSON.stringify({ event: 'Stop', ts: 1, payload: { session_id: 's1', transcript_path: '/tmp/t.jsonl', last_assistant_message: 'é'.repeat(6000) } }) + '\n')` (about 12 KB, larger than `PIPE_BUF`). Work in bytes, not characters: `const first = line.indexOf('é')` is the byte index of the first `é` (`0xc3`), and `const cut = first + 1 + 2 * 2100` lands an odd number of bytes past it, on the second byte of an `é`. Assert `(line[cut] & 0xc0) === 0x80` (a UTF-8 continuation byte) and `cut > 4096`, so the test still holds if the prefix length changes. Append `line.subarray(0, cut)` and call `tailLog`. Assert no Stop was emitted and `dispatch` was not called with `terminals/statusChanged`. Append `line.subarray(cut)` and call `tailLog` again. Assert exactly one `StopEvent` with `lastAssistantMessage === 'é'.repeat(6000)`, `transcriptPath === '/tmp/t.jsonl'`, `sessionId === 's1'`, and `dispatch` was called with `{ type: 'terminals/statusChanged', payload: { id, status: 'waiting', pendingTool: null } }`.
- **TEST-005** (`tailLog`, Claude shape): one complete line `{"event":"Stop","ts":1,"payload":{"session_id":"c1","transcript_path":"/tmp/c.jsonl","last_assistant_message":"Done.","stop_hook_active":false}}`. The `StopEvent` is `{ terminalId: id, sessionId: 'c1', transcriptPath: '/tmp/c.jsonl', lastAssistantMessage: 'Done.', ts: 1 }`.
- **TEST-006** (`tailLog`, Codex shapes): `payload: { session_id: 'x1', transcript_path: null, last_assistant_message: null, turn_id: 't', stop_hook_active: false }` gives `transcriptPath: null` and `lastAssistantMessage: null`. With `last_assistant_message: 'ok'` and no `transcript_path` key, it gives `lastAssistantMessage: 'ok'`. With `last_assistant_message: ''`, it gives `null`.
- **TEST-007** (`tailLog`, opencode shape from Item 1): `payload: { session_id: 'o1', last_assistant_message: 'line1\nline2' }` emits a `StopEvent` with `transcriptPath: null` and `lastAssistantMessage: 'line1\nline2'`.
- **TEST-008** (`tailLog`, no session id): a `Stop` line with `payload: null` and one with `payload: { last_assistant_message: 'x' }` emit no `StopEvent`, but each still dispatches `terminals/statusChanged` with `status: 'waiting'`.
- **TEST-009** (`tailLog`, unaffected events): in one append, write `{"event":"PreToolUse","ts":1,"payload":{"session_id":"p1","tool_name":"Bash","tool_input":{"command":"ls"}}}` followed by `{"event":"Notification","ts":2,"payload":{"session_id":"p1","notification_type":"permission_prompt"}}`, then call `tailLog` once. Assert `dispatch.mock.calls.map((c) => c[0])` equals, in this order:
  1. `{ type: 'terminals/sessionIdDiscovered', payload: { terminalId: id, sessionId: 'p1' } }` (from the first line; dispatched only once per terminal),
  2. `{ type: 'terminals/statusChanged', payload: { id, status: 'processing', pendingTool: null } }`,
  3. `{ type: 'terminals/statusChanged', payload: { id, status: 'needs-approval', pendingTool: { name: 'Bash', input: { command: 'ls' } } } }`.

  `pendingTool` has the `{ name, input }` shape that `readPendingTool` (`hooks.ts:85-95`) returns and `PendingTool` (`src/shared/state/terminals/types.ts:3-6`) declares. The Notification carries no `tool_name`, so the value comes from the `lastPreTool` fallback. This guards REQ-007.
- **TEST-010** (manual, required before merge): run `pnpm log:clear` and `pnpm dev`, accept hooks if prompted, then:
  - (a) In a Claude tab, ask for a reply of at least 6 KB containing non-ASCII (for example `write 150 numbered lines, each ending with — and 🙂`). When the turn ends, `pnpm log` shows `stop terminal=<id> transcript=yes lastMessageChars=<n>` with `n` > 4096. `grep '"event":"Stop"' /tmp/harness-status/<id>.ndjson | tail -n 1 | wc -c` prints a number greater than 4096. The tab shows waiting. The Cost panel still updates for that tab.
  - (b) Codex: skipped until Codex is installed (DEP-003). Record "Codex not verified" in the commit message.
  - (c) In an opencode tab (Item 1 merged), after a turn ends, `pnpm log` shows `stop terminal=<id> transcript=no lastMessageChars=<n>` with `n` > 0. The Cost panel shows no new error lines (`pnpm log | grep cost-tracker`).
- **TEST-011**: `pnpm typecheck`, `pnpm build` and `npx vitest run` all pass. `src/main/cost-tracker/cost-tracker.test.ts` passes unchanged; it builds no `StopEvent` objects (TASK-007). Any test file that does build one must include `lastAssistantMessage`, or `pnpm typecheck` fails.
- **TEST-012** (`tailLog`, short reads): set `fsCap.maxRead = 7` (TASK-008), append the TEST-005 Claude line, and call `tailLog` once. Assert exactly one `StopEvent` equal to the TEST-005 one and one `terminals/statusChanged` dispatch with `status: 'waiting'`. With a single `readSync` call this test would emit nothing, because only the first 7 bytes would be read and the offset would stop there.

## 7. Risks & Assumptions

- **RISK-001**: Claude can run `PreToolUse` hooks for parallel tool calls at the same time, so two bash processes may append to the same file at once. If both lines exceed `PIPE_BUF` and bash splits them into several `write(2)` calls, they can interleave. The reader then logs a parse error and drops the merged line, and the next event corrects the status. This ticket doesn't fix it (ALT-003), and the REQ-008 comment limits its safety claim to the single-writer property. `Stop`, the only line whose content is consumed in full, normally fires after the turn's other hooks have finished, so it is not expected to interleave. No agent documents that ordering as a guarantee; it is observed behaviour, which is why it stays here and out of the code comment.
- **RISK-002**: If a hook process dies mid-line, its partial line stays in `residual` and is prepended to the next line, which then fails to parse once and is dropped. The status recovers on the following event. Accepted; it is the same failure as today's string residual.
- **RISK-003**: Codex's real `Stop` payload is unverified on this machine. The field names (`session_id`, `transcript_path`, `last_assistant_message`) come from the plan's "Harness research" table. A different name would give `lastAssistantMessage: null` without breaking anything else.
- **ASSUMPTION-001**: Each `/tmp/harness-status/<terminalId>.ndjson` has exactly one agent writing to it: `PtyManager` sets a unique `HARNESS_TERMINAL_ID` per terminal (`src/main/pty-manager/pty-manager.ts:149`).
- **ASSUMPTION-002**: `onStopEvent` listeners run synchronously inside `tailLog`, and nothing besides `CostTracker` subscribes today (`grep -rn onStopEvent src` returns only `cost-tracker.ts:86` outside `hooks.ts`).
- **ASSUMPTION-003**: Byte `0x0a` never occurs inside a multi-byte UTF-8 sequence, and every hook writer JSON-encodes the payload, so a literal newline only ever ends a line.

## 8. Related Specifications / Further Reading

- `plans/dynamic-workflows/milestones/milestone-1-prerequisites/goal.md`, Item 3
- `plans/dynamic-workflows/dynamic-workflows.md`: "Existing primitives" (row "Final assistant message"), "Gaps found" (gap 7), "Harness research (2026-10-01)" (row "Hook carries final message"), "Step output contract" (step 2, fallback `summary`)
- `plans/dynamic-workflows/milestones/milestone-1-prerequisites/tickets/01-opencode-plugin-esm.md`: REQ-005 (opencode `Stop` line shape), RISK-003
- Claude Code hooks reference (`Stop` input fields): https://docs.claude.com/en/docs/claude-code/hooks

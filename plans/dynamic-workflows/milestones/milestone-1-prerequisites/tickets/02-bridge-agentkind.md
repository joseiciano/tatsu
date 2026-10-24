---
goal: Make the MCP bridge's create_worktree accept opencode so its agentKind enum, validation and label match the control server
date_created: 2026-10-02
status: 'Planned'
tags: [bug, mcp, opencode, milestone-1, dynamic-workflows]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Milestone 1, Item 2 (closes gap 6 in `plans/dynamic-workflows/dynamic-workflows.md` "Gaps found").

`resources/mcp-bridge.js` is the stdio MCP server that agents use to reach the Tatsu control server. Its `create_worktree` tool disagrees with the server about which agents it can spawn:

| Location | Today | Server (`src/main/control-server/control-server.ts:15-23`, `parseAgentKind`) |
|---|---|---|
| `mcp-bridge.js:108-113` input schema `agentKind.enum` | `['claude', 'codex']` | accepts `claude`, `codex`, `opencode` (trimmed, case-insensitive) |
| `mcp-bridge.js:467-474` local validation | throws `agentKind must be "claude" or "codex"` for anything else, before calling the server | returns 400 `agentKind must be "claude", "codex", or "opencode"` |
| `mcp-bridge.js:485` result label | `args.agentKind === 'codex' ? 'Codex' : 'Claude'` | n/a |

An agent that asks for an opencode worktree is either steered away by the schema or rejected locally, and the request never reaches the server, which would accept it. The label also says "Claude" when `agentKind` is omitted, even though the server then uses the user's configured default agent, which may be Codex or opencode.

This ticket also changes the result text when `agentKind` is omitted: the label goes from `Claude` to `agent` (REQ-004). The old text was wrong whenever the user's default agent is not Claude.

This ticket makes the bridge's single list of agent kinds match the server's, uses it for the enum, the validation and the label, and adds a test that fails if the bridge and `AGENT_REGISTRY` drift apart again. It is a self-contained fix for today's MCP tool. The workflow runner does not depend on it directly. This ticket completes Item 2; nothing follows from it.

## 1. Requirements & Constraints

- **REQ-001**: `resources/mcp-bridge.js` declares one module-level constant, `const AGENT_KINDS = ['claude', 'codex', 'opencode']`, in the same order as `AGENT_REGISTRY` in `src/shared/agent-registry/agent-registry.ts:13-17`. The enum, the validation and the label all derive from it. No other literal list of agent kinds remains in the bridge.
- **REQ-002**: The `create_worktree` input schema uses `enum: AGENT_KINDS` for `agentKind`. The description stays as is: "Which CLI agent to spawn in the new worktree's first tab. Defaults to the user's configured default agent (Settings → Agent)."
- **REQ-003**: The bridge validates `agentKind` the same way as `parseAgentKind`:
  - `undefined`, `null` or `''` means "not set". The bridge sends `agentKind: undefined`, which `JSON.stringify` drops, as today.
  - Any non-string throws `agentKind must be a string`.
  - A string is normalized with `.trim().toLowerCase()`. If the result is in `AGENT_KINDS`, the **normalized** value goes in the `POST /worktrees` body. Otherwise the bridge throws `agentKind must be "claude", "codex", or "opencode"`, which is the server's exact message, without calling the server.
- **REQ-004**: The result text uses a label from `const AGENT_LABELS = { claude: 'Claude', codex: 'Codex', opencode: 'opencode' }`. When `agentKind` is not set, the label is `agent`, so the text reads "Harness will open a new agent chat tab in it". The rest of the two result strings at `mcp-bridge.js:487-489` is unchanged.
- **REQ-005**: The server's accepted set equals `AGENT_REGISTRY.map((a) => a.kind)`, and a test asserts it. The server's code does not change.
- **CON-001**: Do not change `parseAgentKind`, the `POST /worktrees` handler, `runPendingPRWorktree`, or the `worktrees:externalCreate` broadcast (`src/main/index.ts:3389-3400`). The server already accepts opencode.
- **CON-002**: The bridge stays a dependency-free CommonJS script that runs under `ELECTRON_RUN_AS_NODE=1`. It must not `require` anything from `src/` or `out/`. That is why the list is duplicated and guarded by a test (TEST-005) instead of imported.
- **CON-003**: Do not touch the opencode plugin (`src/main/agents/opencode.ts`, Item 1) or MCP wiring for Codex and opencode (Item 5). Whether an opencode tab can call `harness-control` tools itself is Item 5's concern. This ticket only lets any MCP caller *create* an opencode worktree.
- **CON-004**: Do not change other tools in `TOOLS`, `filterToolsByPerms`, or the JSON-RPC handling in `handle()`.
- **GUD-001**: Follow AGENTS.md. Add no comments. Run `pnpm typecheck`, `pnpm build` and `npx vitest run` before committing. Make one descriptive commit, then push.
- **PAT-001**: Bridge tests spawn the real bridge against a stub HTTP server through `startStub` and `spawnBridge` in `resources/mcp-bridge.test.js:11-90`. New tests reuse these helpers inside the existing `describe('mcp-bridge create_worktree', …)` block (`:92`). Vitest picks up `resources/*.test.js` through its default include; there is no vitest config file.

## 2. Implementation Steps

### Implementation Phase 1: Bridge change

- GOAL-001: The bridge advertises, accepts and labels all three agent kinds, matching the server.

- [ ] **TASK-001**: In `resources/mcp-bridge.js`, directly above `const TOOLS = [` (`:74`), add:
  ```js
  const AGENT_KINDS = ['claude', 'codex', 'opencode']
  const AGENT_LABELS = { claude: 'Claude', codex: 'Codex', opencode: 'opencode' }
  ```
- [ ] **TASK-002**: In the `create_worktree` input schema, change `enum: ['claude', 'codex'],` (`:110`) to `enum: AGENT_KINDS,`.
- [ ] **TASK-003**: In `handleToolCall`, replace the `if (args.agentKind !== undefined && … )` block (`:467-474`) with:
  ```js
  let agentKind
  if (args.agentKind !== undefined && args.agentKind !== null && args.agentKind !== '') {
    if (typeof args.agentKind !== 'string') throw new Error('agentKind must be a string')
    agentKind = args.agentKind.trim().toLowerCase()
    if (!AGENT_KINDS.includes(agentKind)) {
      throw new Error('agentKind must be "claude", "codex", or "opencode"')
    }
  }
  ```
  - In the `callControl('POST', '/worktrees', { … })` body (`:475-484`), change `agentKind: args.agentKind,` (`:482`) to `agentKind,`.
- [ ] **TASK-004**: Replace `const agentLabel = args.agentKind === 'codex' ? 'Codex' : 'Claude'` (`:485`) with `const agentLabel = agentKind ? AGENT_LABELS[agentKind] : 'agent'`.

### Implementation Phase 2: Tests

- GOAL-002: Tests cover opencode end to end through the bridge and fail if the bridge, the server and `AGENT_REGISTRY` stop agreeing.

- [ ] **TASK-005**: In `resources/mcp-bridge.test.js`, update the existing test `'rejects unknown agentKind locally without hitting the server'` (`:252-276`). Change its assertion at `:273` from `toMatch(/claude.*codex/i)` to `toBe('agentKind must be "claude", "codex", or "opencode"')`. `handle()` returns the thrown `err.message` unprefixed as `content[0].text` with `isError: true` (`mcp-bridge.js:710-720`).
- [ ] **TASK-006**: Add the tests TEST-001 to TEST-005 to the `describe('mcp-bridge create_worktree', …)` block. Each stub answers `/scope` with `{ scope: null, browser: { enabled: true, mode: 'full' } }` and `/worktrees` with `{ path: '/tmp/wt-oc', branch: 'feat' }`, as the test at `:217-250` does.
  - Grep `resources/mcp-bridge.test.js` for `Claude chat tab` and update any hit to the new `agent` label (REQ-004). As of writing there are none: the only result-text assertion is the codex test at `:217-250`, which checks `Codex` and stays valid.
  - For TEST-005, add `import { AGENT_REGISTRY } from '../src/shared/agent-registry'` at the top of the file. Send `tools/list` and read `result.tools.find((t) => t.name === 'create_worktree').inputSchema.properties.agentKind.enum`.
- [ ] **TASK-007**: In `src/main/control-server/control-server.test.ts`, add TEST-006 to the `describe('parseAgentKind', …)` block. Import `AGENT_REGISTRY` from `'../../shared/agent-registry'`.

### Implementation Phase 3: Verify and close the gap

- GOAL-003: The change passes CI checks and the plan records gap 6 as closed.

- [ ] **TASK-008**: Run `pnpm typecheck`, `pnpm build` and `npx vitest run`. All pass.
- [ ] **TASK-009**: Run TEST-007 (manual).
- [ ] **TASK-010**: Commit the code and tests with a message such as `Accept opencode in the MCP bridge's create_worktree agentKind`, then push. Only after that commit exists, edit gap 6 in `plans/dynamic-workflows/dynamic-workflows.md` ("Gaps found", the line starting `6. **Bridge agentKind mismatch.**`): append `Closed in <short hash>: the bridge's enum, validation and label now use one list that matches the server, and a test guards it against AGENT_REGISTRY.`, where `<short hash>` is the code commit's short hash (`git rev-parse --short HEAD` right after it). Commit that edit separately and push.
  - Stage only `plans/dynamic-workflows/dynamic-workflows.md` for the plan commit (`git add plans/dynamic-workflows/dynamic-workflows.md`, never `git add -A` or `git add plans/`). The working tree may hold an unrelated plans-directory move in progress (the old `plans/dynamic-workflows/tickets/milestone-1-prerequesites/goal.md` deleted, `plans/dynamic-workflows/milestones/` untracked) that must not ride along. Likewise stage only the code and test files for the code commit.

## 3. Alternatives

- **ALT-001**: Remove the bridge's local validation and the schema enum, and rely on the server's 400. Rejected: the enum is what tells the calling model which values exist, and the local check keeps the existing "reject without hitting the server" behaviour that `mcp-bridge.test.js:252` covers.
- **ALT-002**: Generate the bridge's list from `AGENT_REGISTRY` at build time, or have the bridge fetch it from the control server. Rejected: the bridge is a plain script shipped under `resources/` with no build step (CON-002), and a fetch would add a round trip to `tools/list`. Three values guarded by TEST-005 is enough.
- **ALT-003**: Keep exact-match validation instead of trim and lowercase. Rejected: the goal is for the bridge to accept exactly what the server accepts. An agent that sends `"Opencode"` would otherwise be rejected locally even though the server accepts it.
- **ALT-004**: Use `agentDisplayName()` names ("Claude Code", "Codex", "Opencode") for the label. Rejected: the bridge can't import from `src/` (CON-002). The short labels keep today's "Claude"/"Codex" wording that the existing test at `:243` checks.

## 4. Dependencies

- **DEP-001**: None. This ticket does not depend on any other milestone item, and no other item depends on it.

## 5. Files

- **FILE-001**: `resources/mcp-bridge.js`. Adds `AGENT_KINDS` and `AGENT_LABELS`, and changes the schema enum (`:110`), the validation (`:467-474`), the POST body (`:482`) and the label (`:485`).
- **FILE-002**: `resources/mcp-bridge.test.js`. Updates the unknown-kind assertion and adds TEST-001 to TEST-005.
- **FILE-003**: `src/main/control-server/control-server.test.ts`. Adds TEST-006.
- **FILE-004**: `plans/dynamic-workflows/dynamic-workflows.md`. Marks gap 6 closed with the commit hash.

## 6. Testing

- **TEST-001**: `create_worktree` with `{ branchName: 'feat', agentKind: 'opencode', model: 'x' }` succeeds. The captured `POST /worktrees` body has `agentKind: 'opencode'`, and the result text contains `opencode chat tab` and `x`.
- **TEST-002**: `agentKind: '  OpenCode '` sends `agentKind: 'opencode'` in the POST body (normalization, REQ-003).
- **TEST-003**: `agentKind: 42` returns `isError: true` with text containing `agentKind must be a string`, and no `POST /worktrees` is captured.
- **TEST-004**: With `agentKind` omitted, the POST body has no `agentKind` key and the result text contains `new agent chat tab`. With `agentKind: ''`, the result is the same.
- **TEST-005**: `tools/list` returns a `create_worktree` whose `inputSchema.properties.agentKind.enum` deep-equals `AGENT_REGISTRY.map((a) => a.kind)`.
- **TEST-006**: For every `a` in `AGENT_REGISTRY`, `parseAgentKind(a.kind)` equals `{ kind: a.kind }`. Together with TEST-005, this ties the bridge and the server to the same list.
- **TEST-007** (manual, required before merge): Run `pnpm dev` and open a Claude tab in a Tatsu-managed repo. Ask it to call the `harness-control` `create_worktree` tool with `branchName: 'bridge-oc-check'` and `agentKind: 'opencode'`. Confirm that the tool result says "opencode", that the new worktree appears in the sidebar, and that its first tab is an opencode tab. Delete the worktree afterwards.
- **TEST-008**: Run `pnpm typecheck`, `pnpm build` and `npx vitest run`. All pass, including the updated `resources/mcp-bridge.test.js`.

## 7. Risks & Assumptions

- **RISK-001** (resolved from code, TEST-007 confirms): both paths pass `opencode` through to the first tab. PR path: `POST /worktrees` → `deps.runPendingPRWorktree` (`src/main/index.ts:3367`) → `WorktreesFSM.runPendingPR` → `finishCreate` → `onWorktreeCreated` (`worktrees-fsm.ts:258-264`) → `panesFSM.ensureInitialized(createdPath, { agentKind, … })` (`index.ts:790-792`). New-branch path: `deps.broadcast('worktrees:externalCreate', { agentKind, … })` (`control-server.ts:198-204`) → the broadcast handler calls `panesFSM.ensureInitialized(path, { agentKind, … })` before `refreshList` (`index.ts:3398-3417`). `ensureInitialized` (`panes-fsm.ts:226-264`) uses `opts.agentKind` ahead of the default, only switches to a json-claude tab when the kind is `claude`, and builds `{ type: 'agent', agentKind: 'opencode', label: 'Opencode' }`. `WorkspaceView` passes `tab.agentKind` to `XTerminal`, whose spawn goes through `agent:buildSpawnArgs` (`toAgentKind` keeps `opencode`) and `pty:create` (applies `opencodeEnvVars`). The renderer's `onWorktreesExternalCreate` only focuses the path. Remaining caveat, shared by every kind: `ensureInitialized` no-ops if the worktree already has a pane tree, so a `worktrees/listChanged` refresh that lands between `addWorktree` and the broadcast would create a default-agent tab. If TEST-007 shows a non-opencode tab, record it in the commit message and file a follow-up; the server code is out of scope (CON-001).
- **RISK-002**: Lowercasing in the bridge changes behaviour for callers that sent mixed case before. Before this change they were rejected locally, so no working caller is affected.
- **ASSUMPTION-001**: The control server's accepted set (`parseAgentKind`) is the source of truth, and it matches `AGENT_REGISTRY` today (`claude`, `codex`, `opencode`).
- **ASSUMPTION-002** (verified): The bridge test runner can import TypeScript from `src/shared/agent-registry`. There is no `vitest.config.*` or `vite.config.*`, so vitest uses its defaults: the default include picks up `resources/*.test.js`, and vite transforms the imported `.ts` and resolves the directory barrel. A probe `resources/*.test.js` with `import { AGENT_REGISTRY } from '../src/shared/agent-registry'` passed alongside `mcp-bridge.test.js` under `npx vitest run` (vitest 4.1.7). Fallback if that import fails at implementation time: keep TEST-005 out of `resources/`, and instead add it to a `src/` test (e.g. `src/shared/agent-registry/agent-registry.test.ts`) that reads `AGENT_REGISTRY` directly, spawns `resources/mcp-bridge.js` with the same stub-server approach, sends `tools/list`, and asserts the enum there. Update TASK-006 and FILE-002 accordingly.

## 8. Related Specifications / Further Reading

- `plans/dynamic-workflows/milestones/milestone-1-prerequisites/goal.md`, Item 2
- `plans/dynamic-workflows/dynamic-workflows.md`, "Gaps found" (gap 6)
- `src/main/control-server/control-server.ts` (`parseAgentKind`, `POST /worktrees` handler)
- `src/shared/agent-registry/agent-registry.ts` (`AGENT_REGISTRY`)

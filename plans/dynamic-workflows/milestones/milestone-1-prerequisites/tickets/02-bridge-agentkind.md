---
goal: Guard the MCP bridge's create_worktree agentKind list against AGENT_REGISTRY drift (the bridge fix itself landed in d4759f6 before this plan was written)
date_created: 2026-10-02
status: 'Planned'
tags: [test, mcp, agents, milestone-1, dynamic-workflows]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Milestone 1, Item 2 (gap 6 in `plans/dynamic-workflows/dynamic-workflows.md` "Gaps found").

**Scope reduced on 2026-10-24.** The original ticket described `resources/mcp-bridge.js` advertising `enum: ['claude', 'codex']` and rejecting `opencode`. That was already fixed in `d4759f6` (2026-09-25, "fix: accept all agent kinds in harness-control create_worktree"), a week before the plan's "Gaps found" section was written against a stale checkout. Today:

| Location | Now |
|---|---|
| `mcp-bridge.js:12` | `const AGENT_KIND_LABELS = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi' }` |
| `mcp-bridge.js:116` | `enum: Object.keys(AGENT_KIND_LABELS)` |
| `mcp-bridge.js:473-479` | rejects any kind not in `AGENT_KIND_LABELS` with `agentKind must be "claude", "codex", "opencode", or "pi"` |
| `mcp-bridge.js:490-493` | label from `AGENT_KIND_LABELS`, `agent` when `agentKind` is omitted |
| `resources/mcp-bridge.test.js:215-250` | parametrised rows for all four kinds |

What is still missing is a test that fails when `AGENT_REGISTRY` (`src/shared/agent-registry/agent-registry.ts`) and the bridge's hand-copied list drift apart again. The bridge cannot import from `src/` (it is a dependency-free CommonJS script run under `ELECTRON_RUN_AS_NODE=1`), so the list is duplicated and must be guarded.

Also not done: the bridge does not `trim().toLowerCase()` like `parseAgentKind` (`src/main/control-server/control-server.ts:16-27`). An agent sending `"OpenCode"` is rejected locally while the server would accept it. Fix that in the same change.

## 1. Requirements & Constraints

- **REQ-001**: The bridge normalises `agentKind` with `.trim().toLowerCase()` before the `AGENT_KIND_LABELS` check and sends the normalised value in the `POST /worktrees` body. `undefined`, `null` and `''` still mean "not set" (key dropped by `JSON.stringify`). Any non-string throws `agentKind must be a string`.
- **REQ-002**: A test asserts `tools/list` → `create_worktree.inputSchema.properties.agentKind.enum` deep-equals `AGENT_REGISTRY.map((a) => a.kind)`.
- **REQ-003**: A test asserts, for every `a` in `AGENT_REGISTRY`, `parseAgentKind(a.kind)` equals `{ kind: a.kind }`.
- **CON-001**: Do not change `parseAgentKind`, the `POST /worktrees` handler, or any other bridge tool. Do not add a build step or an import from `src/` to the bridge.
- **GUD-001**: Follow AGENTS.md. No comments. Run `pnpm typecheck`, `pnpm build` and `npx vitest run` before committing. One descriptive commit, then push.
- **PAT-001**: Bridge tests use `startStub` / `spawnBridge` in `resources/mcp-bridge.test.js`. Vitest has no config file; `resources/*.test.js` is picked up by the default include and can import TypeScript from `src/shared/` (verified with vitest 4.1.7).

## 2. Implementation Steps

### Implementation Phase 1: Normalise and guard

- GOAL-001: The bridge accepts exactly what the server accepts, and a test ties both to `AGENT_REGISTRY`.

- [ ] **TASK-001**: In `handleToolCall` for `create_worktree`, normalise `agentKind` per REQ-001 and use the normalised value in the POST body and the label.
- [ ] **TASK-002**: In `resources/mcp-bridge.test.js`, add `import { AGENT_REGISTRY } from '../src/shared/agent-registry'` and the TEST-001 / TEST-002 cases inside `describe('mcp-bridge create_worktree', …)`.
- [ ] **TASK-003**: In `src/main/control-server/control-server.test.ts`, add TEST-003 to the `parseAgentKind` block.
- [ ] **TASK-004**: Run `pnpm typecheck`, `pnpm build`, `npx vitest run`. Commit (`Guard the MCP bridge agentKind list against AGENT_REGISTRY drift`), push.
- [ ] **TASK-005**: Edit gap 6 in `plans/dynamic-workflows/dynamic-workflows.md` only if its text does not yet name this commit (the 2026-10-24 review already recorded `d4759f6` there); stage only the plan file. Commit separately, push.

## 3. Alternatives

- **ALT-001**: Generate the bridge's list from `AGENT_REGISTRY` at build time or fetch it from the control server. Rejected: the bridge has no build step and a fetch adds a round trip to `tools/list`. Four values plus a guard test is enough.

## 4. Dependencies

- **DEP-001**: None. Nothing depends on this ticket.

## 5. Files

- **FILE-001**: `resources/mcp-bridge.js`. Normalisation in `create_worktree`.
- **FILE-002**: `resources/mcp-bridge.test.js`. TEST-001, TEST-002.
- **FILE-003**: `src/main/control-server/control-server.test.ts`. TEST-003.

## 6. Testing

- **TEST-001**: `agentKind: '  OpenCode '` sends `agentKind: 'opencode'` in the POST body and the result text contains `OpenCode chat tab`.
- **TEST-002**: `tools/list` returns a `create_worktree` whose `inputSchema.properties.agentKind.enum` deep-equals `AGENT_REGISTRY.map((a) => a.kind)`.
- **TEST-003**: For every `a` in `AGENT_REGISTRY`, `parseAgentKind(a.kind)` equals `{ kind: a.kind }`.
- **TEST-004**: `pnpm typecheck`, `pnpm build` and `npx vitest run` pass.

## 7. Risks & Assumptions

- **ASSUMPTION-001**: `AGENT_REGISTRY` order matches `AGENT_KIND_LABELS` key order (`claude`, `codex`, `opencode`, `pi`). If TEST-002 fails on order only, sort both sides.

## 8. Related Specifications / Further Reading

- `plans/dynamic-workflows/milestones/milestone-1-prerequisites/goal.md`, Item 2
- `plans/dynamic-workflows/dynamic-workflows.md`, "Gaps found" (gap 6)
- Commit `d4759f6`

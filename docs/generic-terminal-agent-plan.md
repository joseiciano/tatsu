# Generic terminal-agent support plan

## Goal

- Enable generic terminal agents in Harness
- Provide optional deep integrations for built-ins and future adapters
- Preserve Claude JSON chat mode, current Claude/Codex/OpenCode resume behavior, and current built-in hook/status flow

## Phase 1 — shared types + settings model

- Add `src/shared/terminal-agents.ts` with:
  - `TerminalAgentId`
  - `ModelOption`
  - `TerminalAgentCapabilities`
  - `TerminalAgentDefinition`
  - `UserTerminalAgentDefinition`
  - `AgentRuntimeConfig`
- Refactor `src/shared/agent-registry.ts` into:
  - `builtin-terminal-agents.ts`
  - `terminal-agent-registry.ts`
- Move current built-ins Claude/Codex/OpenCode into `TerminalAgentDefinition` data
- Add merge/get helper functions
- Refactor `src/shared/state/settings.ts` to replace `defaultAgent` and all per-agent command/env/model fields with:
  - `defaultTerminalAgentId`
  - `userTerminalAgents`
  - `agentConfigs`
- Keep Claude-only JSON/chat settings separate

## Phase 2 — persistence + migration

- Refactor `src/main/persistence.ts` `Config` to add:
  - `defaultTerminalAgentId`
  - `userTerminalAgents`
  - `agentConfigs`
- Keep old per-agent fields temporarily for migration reads
- Add migration in `src/main/persistence-migrations.ts` to fold `defaultAgent`/`claude*`/`codex*`/`opencode*` into `agentConfigs` and `defaultTerminalAgentId`
- Add migration tests

## Phase 3 — open agent ids in tabs/worktrees

- Refactor `src/shared/state/terminals.ts` from closed `AgentKind` union to string `TerminalAgentId`
- Rename `TerminalTab.agentKind` to `agentId`
- Update persistence migrated tab field from `agentKind` to `agentId`
- Update main/renderer callers accordingly

## Phase 4 — generic backend/runtime resolution

- Replace `src/main/agent-kind.ts` usage with registry-based resolver in `src/main/terminal-agent-resolver.ts`
- Add `src/main/generic-terminal-agent-spawn.ts` with generic `buildGenericSpawnArgs` helper
- Add managed integration layer in:
  - `src/main/managed-agents/types.ts`
  - `src/main/managed-agents/index.ts`
- Adapt existing `src/main/agents/claude.ts`, `codex.ts`, `opencode.ts` to the managed integration interface
- Refactor `src/main/index.ts` request handlers and `pty:create` env resolution to use generic agent definitions + runtime configs instead of hardcoded ternaries
- Refactor control-server validation to use registry-based validation

## Phase 5 — hook/status integration cleanup

- Keep `src/main/hooks.ts` but make it agent-aware
- Resolve `terminalId -> agentId` before deriving status
- Apply optional managed integration raw-event mapper before `deriveStatus`
- Replace hardcoded hook install/uninstall loops in `src/main/index.ts` with iteration over managed integrations

## Phase 6 — renderer API changes

- Update `src/renderer/types.ts` and `src/renderer/build-backend.ts`
- Replace per-agent setter methods with:
  - `setDefaultTerminalAgentId`
  - `setUserTerminalAgents`
  - `setAgentRuntimeConfig`
  - `removeAgentRuntimeConfig`
- Replace `agentKind` parameters with `agentId` in worktree creation, spawn, and terminal creation APIs

## Phase 7 — renderer UI refactor

- Refactor `src/renderer/components/Settings.tsx` to render dynamic agent cards and a custom agent section instead of hardcoded Claude/Codex/OpenCode sections
- Keep Claude-only advanced JSON/chat controls separate
- Refactor `src/renderer/components/NewWorktreeScreen.tsx` to use merged agent definitions and capability-driven UI
- Refactor `src/renderer/hooks/useTabHandlers.ts`, `useWorktreeHandlers.ts`, and `src/renderer/components/TerminalPanel.tsx` to use `agentId` and registry-driven behavior

## Phase 8 — main FSM updates

- Refactor `src/main/panes-fsm.ts` and `src/main/worktrees-fsm.ts` to use `agentId` and `defaultTerminalAgentId`
- Preserve Claude-only json-claude behavior via capability checks

## Phase 9 — tests

- Update settings reducer tests
- Update persistence migration tests
- Update control-server tests
- Add resolver/spawn/integration tests

## Recommended execution order

1. Shared `terminal-agents` types
2. Split shared registry
3. Settings slice
4. Persistence config
5. Persistence migrations
6. Migration/settings tests
7. `terminals.ts` rename to `agentId`
8. Renderer/main rename plumbing
9. Generic resolver + generic spawn builder
10. `index.ts` request handler refactor
11. Managed integration registry
12. `hooks.ts` agent-aware normalization
13. Renderer API changes
14. Settings/NewWorktree/TerminalPanel refactor
15. Final hardening/tests

## Important constraints

- Keep built-in managed integrations for Claude/Codex/OpenCode
- Keep Claude JSON mode untouched in first pass
- Do not attempt generic chat agents or automatic deep integration for arbitrary CLIs in first implementation
- Do not rewrite Harness around a Superset-style wrapper/bin-dir model in first pass
- Harness can keep generic launch support + optional managed adapters + NDJSON hook transport

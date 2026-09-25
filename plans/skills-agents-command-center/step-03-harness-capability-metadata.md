---
goal: Add shared harness configuration capability metadata to the agent registry
date_created: 2026-09-25
last_updated: 2026-09-25
status: 'Planned'
tags: [feature, metadata, agent-registry, harness-config]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan extends Tatsu's shared agent registry with declarative metadata describing which logical harness configuration resources each agent supports. It translates the feature goals and scope in [implementation-details.md](./implementation-details.md), the product boundary in [Step 1](./step-01-product-boundary-source-of-truth.md), and the resolver matrix in [Step 2](./step-02-main-process-harness-config-service.md) into a renderer-safe capability contract without exposing home-directory assumptions or resolved filesystem paths. This is Step 3 of the larger [Skills-Agents-Commands-Sync plan](./skills-agents-commands-sync.md); completing it does not implement discovery, persistence, transport, shared inventory state, or UI.

## 1. Requirements & Constraints

- **REQ-001**: Define and export the canonical shared `HarnessConfigResourceType = 'agents' | 'skills' | 'commands'` union from `src/shared/agent-registry/agent-registry.ts`; this union MUST contain exactly the three logical resource types established by the product boundary.
- **REQ-002**: Define and export `AgentConfigCapability` from `src/shared/agent-registry/agent-registry.ts` with `resourceType: HarnessConfigResourceType`, `supported: boolean`, `label: string`, optional `notes?: string`, and optional `aliasResourceTypes?: readonly HarnessConfigResourceType[]`.
- **REQ-003**: `HarnessConfigResourceType` MUST be the single type-level source for Step 2's resolver service, this capability metadata, and later shared state. `src/main/harness-config/` may re-export it from its package barrel but MUST NOT declare an independent duplicate union. `aliasResourceTypes` MUST mean that physical resources canonical to this capability can also appear in the named logical views; it MUST NOT mean that every native resource in the target view is an alias, and it MUST NOT contain the capability's own `resourceType`.
- **REQ-004**: Extend `AgentInfo` with `configCapabilities: readonly AgentConfigCapability[]`. Every entry in `AGENT_REGISTRY` MUST supply this property so consumers never infer support from `kind`, vendor, executable availability, or filesystem state.
- **REQ-005**: Every agent MUST declare exactly one capability for each resource type, in the stable order `agents`, `skills`, `commands`. Duplicate or omitted resource types are invalid registry data.
- **REQ-006**: In shared metadata, `supported: true` MUST mean that Tatsu has a first-version resolver and management contract for the harness/resource pair. It MUST NOT mean that a directory or file currently exists on the user's machine.
- **REQ-007**: Runtime layout availability, environment overrides, version-specific resolver failures, and unknown installed layouts MUST remain owned by `src/main/harness-config/`. A missing on-disk directory MUST NOT make an otherwise supported static capability false because a confirmed create may create the directory.
- **REQ-008**: Populate the capability matrix exactly as follows, matching the resolver contract in Step 2:

  | Agent kind | Agents | Skills | Commands |
  |---|---:|---:|---:|
  | `claude` | Supported | Supported | Supported |
  | `codex` | Supported | Supported | Supported |
  | `opencode` | Supported | Supported | Supported |
  | `pi` | Unsupported in the first implementation | Unsupported in the first implementation | Unsupported in the first implementation |

- **REQ-009**: Use the exact user-facing labels `Agents`, `Skills`, and `Commands` for their corresponding resource types across every agent entry.
- **REQ-010**: Every unsupported capability MUST include a non-empty explanatory `notes` value. For all three Pi capabilities, use `Pi config management is not available in the first implementation.` so the future Config UI can render a disabled state without inventing copy.
- **REQ-011**: The Claude `skills` capability MUST set `aliasResourceTypes: ['commands']` and explain in `notes` that Claude skills also appear in the Commands view as the same physical resource.
- **REQ-012**: The Claude `commands` capability MUST remain independently supported because native Claude command files are also resolved. It MUST NOT set a reciprocal `aliasResourceTypes: ['skills']`; the file-level `canonicalResourceType` and `aliasResourceTypes` from Step 2 determine whether an individual Commands row is a skill alias.
- **REQ-013**: Codex Skills MUST be marked supported to match Step 2's `skills/*/SKILL.md` resolver contract. If that resolver contract changes after vendor verification, update the resolver, this matrix, explanatory notes, and tests in the same change rather than allowing shared metadata and main-process behavior to diverge.
- **REQ-014**: Capability metadata MUST NOT contain absolute paths, home-directory expansions, environment-variable values, resolver roots, or OS-specific separators. Labels and notes MAY describe behavior but MUST remain filesystem-neutral.
- **REQ-015**: `src/shared/agent-registry/agent-registry.ts` MUST remain safe to import in the renderer, main process, preload, and web client; it MUST NOT import Node filesystem, path, OS, process-environment, or Electron APIs.
- **REQ-016**: Existing registry behavior MUST remain unchanged: registry ordering stays `claude`, `codex`, `opencode`, `pi`; `getAgentInfo`, `agentDisplayName`, `getNextAgentKind`, and `cycleAltAgent` preserve their current results.
- **REQ-017**: The package barrel `src/shared/agent-registry/index.ts` MUST remain the public import surface. Its existing `export * from './agent-registry'` MUST expose `HarnessConfigResourceType` and `AgentConfigCapability` without a deep import or a second shared export path.
- **CON-001**: This step is limited to `src/shared/agent-registry/agent-registry.ts` and `src/shared/agent-registry/agent-registry.test.ts`; it MUST NOT add main-process resolvers, shared state, transport handlers, persistence fields, or UI components.
- **CON-002**: Pi remains a launchable `AgentKind` and registry entry, but harness configuration management for Pi is deferred by Step 1. This step MUST represent that deferral as three visible unsupported capabilities rather than removing Pi or guessing its layouts.
- **CON-003**: No new runtime or development dependency is permitted.
- **GUD-001**: Keep the capability table explicit in each `AgentInfo` entry. Do not introduce factories, inheritance, or a second lookup map for twelve static rows; direct data is easier to audit against the resolver matrix.
- **GUD-002**: Renderer consumers SHOULD read `getAgentInfo(kind).configCapabilities` or the existing registry entry and use `supported`, `notes`, and `aliasResourceTypes` directly. They MUST NOT reconstruct support with agent-kind conditionals.
- **PAT-001**: Follow the existing shared registry pattern: exported contracts precede `AgentInfo`, static metadata lives in `AGENT_REGISTRY`, and tests import through the local package barrel `.`.

## 2. Implementation Steps

### Implementation Phase 1: Define the capability contract

- **GOAL-001**: Add a complete, renderer-safe capability model to every shared agent registry entry while preserving existing registry behavior.

- [ ] **TASK-001**: In `src/shared/agent-registry/agent-registry.ts`, add the exported canonical `HarnessConfigResourceType` union and `AgentConfigCapability` interface immediately before `AgentInfo`.
  - Use the fields and readonly alias array from REQ-001 through REQ-003 exactly.
  - Treat the shared union as the dependency source for `src/main/harness-config/` and later shared-state types; shared code MUST NOT import a main-process type.
- [ ] **TASK-002**: Extend `AgentInfo` with `configCapabilities: readonly AgentConfigCapability[]`.
  - Dependency: TASK-001.
  - Keep `kind`, `displayName`, `vendor`, and `assignsSessionId` unchanged.
  - Do not make `configCapabilities` optional; optional metadata would force consumers to interpret absence and could enable unsupported operations.
- [ ] **TASK-003**: Expand all four `AGENT_REGISTRY` entries with the exact three-row capability matrix from REQ-008 through REQ-013.
  - Dependency: TASK-002.
  - Preserve agent ordering and all existing non-capability values.
  - Use the stable capability order `agents`, `skills`, `commands` for each agent.
  - Give all Pi rows `supported: false` and the exact note from REQ-010.
- [ ] **TASK-004**: Encode Claude alias behavior in the capability rows without collapsing native commands into skill aliases.
  - Dependency: TASK-003.
  - Set only the Claude Skills row to `aliasResourceTypes: ['commands']`.
  - Set its note to `Claude skills also appear in the Commands view as the same physical resource.`
  - Set the Claude Commands note to `Includes native Claude commands and aliases of Claude skills.` and omit `aliasResourceTypes` from that row.
  - Leave file identity, canonical resource type, conversion idempotency, and path mapping to `src/main/harness-config/` as specified by Step 2.

### Implementation Phase 2: Lock the metadata behavior with tests

- **GOAL-002**: Prove that the registry exposes a total, exact capability matrix and enough alias/unsupported context for later UI work.

- [ ] **TASK-005**: Update `src/shared/agent-registry/agent-registry.test.ts` to import `AGENT_REGISTRY` and `getAgentInfo` from `.` alongside the existing cycle helpers.
  - Dependency: GOAL-001.
  - Keep tests inside the package and avoid deep imports from `./agent-registry`.
- [ ] **TASK-006**: Add a table-driven test that asserts the complete observable capability objects for each `AgentKind`.
  - Dependency: TASK-005.
  - For every row, assert the exact `resourceType`, `supported`, `label`, `notes`, and `aliasResourceTypes` value, including omitted optional fields.
  - Assert exactly three capabilities in the required `agents`, `skills`, `commands` order so duplicate or missing rows fail.
  - Include Pi so future additions cannot accidentally inherit Claude or another harness's support.
- [ ] **TASK-007**: Add focused alias-invariant tests.
  - Dependency: TASK-005.
  - Assert that the Claude Skills capability has exactly `aliasResourceTypes: ['commands']` and the exact explanatory note from TASK-004.
  - Assert that the Claude Commands capability is supported independently, has the exact note from TASK-004, and has no reciprocal alias declaration.
  - Iterate every capability and assert that `aliasResourceTypes` never contains its own `resourceType`; assert that Codex, OpenCode, and Pi advertise no capability-level aliases.
- [ ] **TASK-008**: Add an unsupported-state test for Pi and retain the existing cycle tests unchanged.
  - Dependency: TASK-005.
  - Assert that all Pi capabilities are unsupported and every one exposes the exact non-empty note from REQ-010.
  - Assert through `getAgentInfo` so the public registry accessor is covered after `AgentInfo` changes.

### Implementation Phase 3: Verify and deliver the registry change

- **GOAL-003**: Demonstrate that the shared metadata contract passes focused behavior checks and remains compatible with all current consumers.

- [ ] **TASK-009**: Run `npx vitest run src/shared/agent-registry/agent-registry.test.ts` and resolve every failure without weakening exact matrix or alias assertions.
  - Dependency: GOAL-002.
- [ ] **TASK-010**: Run `pnpm typecheck` and resolve every error across main, preload, renderer, and web-client consumers of `AgentInfo` and `AGENT_REGISTRY`.
  - Dependency: TASK-009.
  - Do not add casts or optional chaining to hide an incomplete registry entry.
- [ ] **TASK-011**: Run `pnpm build` and resolve any desktop or web bundle failure caused by the shared contract change.
  - Dependency: TASK-010.
  - Confirm from the build result that the shared registry remains browser-safe and introduces no Node-only dependency.
- [ ] **TASK-012**: Review the final diff against Step 2's resolver matrix and type contract, then verify that `HarnessConfigResourceType` has no independently declared duplicate and that no path, environment variable value, filesystem API, persistence behavior, transport handler, state mutation, or UI code entered this step.
  - Dependency: TASK-011.
- [ ] **TASK-013**: Commit only the two runtime/test files in CON-001 with message `feat: add harness config capability metadata`, then run `git push origin <current-branch>` immediately after the commit succeeds.
  - Dependency: TASK-012.
  - Do not include unrelated working-tree changes in the commit.

## 3. Alternatives

- **ALT-001**: Store absolute or home-relative resolver paths in `AGENT_REGISTRY`. Rejected because shared code is imported by renderer and web-client bundles, paths vary by OS and environment overrides, and the main process must remain the only filesystem authority.
- **ALT-002**: Infer capabilities in each UI component from `AgentKind`. Rejected because duplicated conditionals drift from the main resolver matrix and cannot carry a consistent disabled-state explanation or alias relationship.
- **ALT-003**: Represent capability support as an optional array containing only supported resource types. Rejected because omission cannot distinguish unsupported, deferred, and malformed metadata, and the UI must show unsupported combinations as disabled rows with explanations.
- **ALT-004**: Model Claude Commands as a complete alias of Skills. Rejected because Step 2 also recognizes native Claude command files; aliasing applies to individual Claude skill resources exposed in the Commands view, not to the entire Commands capability.
- **ALT-005**: Detect installed directories or CLI versions while constructing the shared registry. Rejected because registry initialization must be deterministic and browser-safe; main-process resolvers own runtime availability and version-specific layout handling.
- **ALT-006**: Add a generic capability factory or lookup service. Rejected because the matrix contains twelve static rows, and an extra abstraction would obscure rather than simplify auditing.

## 4. Dependencies

- **DEP-001**: [implementation-details.md](./implementation-details.md) defines the feature goals, three logical resource views, source-of-truth model, and Claude skill/command caveat.
- **DEP-002**: [Step 1](./step-01-product-boundary-source-of-truth.md) limits the first managed harness scope to Claude, Codex, and OpenCode, requires unsupported combinations to remain visible, and explicitly defers Pi config management.
- **DEP-003**: [Step 2](./step-02-main-process-harness-config-service.md) is authoritative for the current resolver matrix and physical alias semantics. Its `src/main/harness-config/` implementation MUST import and, if needed, re-export the canonical `HarnessConfigResourceType` from the shared agent-registry barrel rather than declaring the union again; capability support flags must match that resolver matrix without copying paths into shared metadata.
- **DEP-004**: `src/shared/state/terminals/types.ts` defines `AgentKind = 'claude' | 'codex' | 'opencode' | 'pi'`; every member requires a complete capability table.
- **DEP-005**: `src/shared/agent-registry/index.ts` already re-exports `agent-registry.ts` and requires no edit for the new contracts to be public.
- **DEP-006**: Steps 7, 9, and 10 will consume this metadata for supported/disabled controls, conflict scope presentation, and conversion actions; they must still use main-service file refs and plans as mutation authority.

## 5. Files

- **FILE-001**: `src/shared/agent-registry/agent-registry.ts` — exported capability contracts and the complete per-agent capability matrix.
- **FILE-002**: `src/shared/agent-registry/agent-registry.test.ts` — exact matrix, Claude alias, Pi unsupported-state, and existing registry cycling coverage.

## 6. Testing

- **TEST-001**: The exact capability matrix test proves every agent exposes `agents`, `skills`, and `commands` once, in stable order, with exact labels, supported flags, notes, and alias arrays.
- **TEST-002**: Alias-invariant tests prove Claude Skills advertises Commands as an additional view, native Commands remains independently supported with exact explanatory copy, no row aliases itself, and no other harness advertises capability-level aliases.
- **TEST-003**: Pi tests prove all deferred capabilities are visible as unsupported and carry deterministic explanatory text.
- **TEST-004**: Existing `getNextAgentKind` and `cycleAltAgent` tests prove the registry order and terminal-agent behavior remain unchanged.
- **TEST-005**: `npx vitest run src/shared/agent-registry/agent-registry.test.ts` exits successfully.
- **TEST-006**: `pnpm typecheck` exits successfully across all TypeScript project references.
- **TEST-007**: `pnpm build` exits successfully for desktop and web-client bundles.
- **TEST-008**: Run identifier declaration validation from the `plan-implementation-plan` skill against this file; duplicate TASK/GOAL declarations and duplicate bullet-style declaration identifiers MUST both produce zero results.

## 7. Risks & Assumptions

- **RISK-001**: Consumers may misread static `supported` as proof that an installed layout exists. REQ-006 and REQ-007 define it as Tatsu resolver support; runtime scans and structured service errors remain authoritative for the local machine.
- **RISK-002**: A reciprocal Claude alias declaration could make native command files appear to be skills and cause duplicate or incorrect conversion behavior. REQ-011 and REQ-012 intentionally model only skill resources appearing in Commands.
- **RISK-003**: Vendor layout support or the resource union can change after this plan is implemented. REQ-003 and REQ-013 require one canonical shared union plus an atomic resolver, metadata, notes, and test update so main and renderer never advertise different types or capabilities.
- **RISK-004**: Adding required nested metadata to `AgentInfo` can break registry fixtures or object literals outside the defining file. Current callsite research found `AGENT_REGISTRY` consumers but no additional `AgentInfo` object construction; `pnpm typecheck` remains the authoritative guard.
- **RISK-005**: Showing Pi as disabled may be mistaken for permanent non-support. The required note explicitly says `first implementation`, preserving the deferred scope rather than declaring Pi incapable.
- **ASSUMPTION-001**: Step 2's current resolver matrix is accepted for this plan, including Codex Skills support.
- **ASSUMPTION-002**: Capability labels are product copy shared by all clients and therefore belong in shared metadata, while runtime error details continue to come from the main service.
- **ASSUMPTION-003**: Capability-level aliases describe possible cross-view exposure; individual file refs from Step 2 remain authoritative for stable identity and whether a particular row is an alias.
- **ASSUMPTION-004**: No installed-version probe is required in Step 3; unknown or changed layouts are reported by main-process resolver behavior rather than represented by mutable shared registry state.

## 8. Related Specifications / Further Reading

- [Implementation details and product goals](./implementation-details.md)
- [Parent implementation plan](./skills-agents-commands-sync.md)
- [Step 1: Product boundary and source of truth](./step-01-product-boundary-source-of-truth.md)
- [Step 2: Main-process harness config service](./step-02-main-process-harness-config-service.md)
- [Step 4: Shared state slice](./step-04-shared-state-slice.md)
- [Step 7: Config page shell](./step-07-config-page-shell.md)
- [Step 9: Sync conflict UX](./step-09-sync-conflict-ux.md)
- [Step 10: Skill-command conversion](./step-10-skill-command-conversion.md)
- [Step 11: Tests](./step-11-tests.md)
- [Step 14: Acceptance criteria](./step-14-acceptance-criteria.md)

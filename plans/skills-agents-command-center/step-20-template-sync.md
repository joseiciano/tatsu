---
goal: Sync rendered template output to harness folders through the existing scoped, confirmed plan flow
date_created: 2026-10-22
last_updated: 2026-10-22
status: 'Planned'
tags: [feature, main-process, harness-config, templates, sync]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan is Step 20 of the [Skills-Agents-Commands-Sync plan](./skills-agents-commands-sync.md). It makes rendered template output ([Step 19](./step-19-template-renderer.md)) part of Tatsu config, so the existing compare, sync-to-disk, and conflict flows handle templates without a second sync path. Terminology follows [implementation-details.md](./implementation-details.md), as amended for templates.

## 1. Requirements & Constraints

- **REQ-001**: For a scope `${agentKind}:${resourceType}`, Tatsu config is the union of the existing desired resources in `config.harnessConfig` and the rendered resources whose `agentKind` and `resourceType` match the scope. Template-rendered resources are marked `source: 'template'` with their `templateRef`.
- **REQ-002**: If a template-rendered resource and a stored desired resource have the same path, the template wins and the stored entry is reported as shadowed in compare output. Saving a template that shadows a stored entry MUST warn first.
- **REQ-003**: The sync plan fingerprint MUST include, for the scope, the hash of every contributing template, every fragment those templates use, and `RENDERER_VERSION`. Editing a fragment therefore makes every pending plan that depends on it stale.
- **REQ-004**: Editing one template or fragment can create conflicts in several scopes at once. This is expected. Each scope is still compared, planned, confirmed, and applied on its own; there is no "sync all" action (REQ-011 of [step-01](./step-01-product-boundary-source-of-truth.md) is unchanged).
- **REQ-005**: The Config page MUST show, after a template or fragment save, which scopes now differ from disk, with a link to each scope's conflict modal.
- **REQ-006**: Adopt from disk for a scope MUST NOT overwrite templates. For a resource that is template-rendered, adopt offers either "Keep template" (skip) or "Detach from template", which stores the disk content as a plain desired resource and removes that target from the template's harness blocks. The conflict modal MUST state this for each affected entry.
- **REQ-007**: Templates with render errors contribute nothing to Tatsu config, and the conflict modal for an affected scope MUST show the error instead of proposing deletes for that template's earlier output.
- **REQ-008**: Managed-elsewhere resources ([Step 17](./step-17-symlink-aware-inventory.md)) at a rendered path block sync for that one resource with a clear message: the user must remove the link (or change the root) before Tatsu can write there.
- **CON-001**: Backup, confirmation, stale-plan rejection, and scope rules from [step-01](./step-01-product-boundary-source-of-truth.md) apply unchanged.

## 2. Implementation Steps

### Implementation Phase 1: Desired-state union

- **GOAL-001**: Treat rendered output as desired state.

- [ ] **TASK-001**: Add a `desiredForScope` source that merges stored resources with rendered resources per REQ-001 and REQ-002.
- [ ] **TASK-002**: Extend `planFingerprint` per REQ-003.
- [ ] **TASK-003**: Re-render on every template or fragment slice event and rescan only the scopes the change touches (anti-pattern #1 in [AGENTS.md](../../AGENTS.md)).

### Implementation Phase 2: Conflict flow

- **GOAL-002**: Make template-driven conflicts understandable.

- [ ] **TASK-004**: Add `source` and `templateRef` to compare entries and show them in `ConfigSyncDialog.tsx`.
- [ ] **TASK-005**: Implement adopt options per REQ-006.
- [ ] **TASK-006**: Show render errors per REQ-007 and blocked links per REQ-008.
- [ ] **TASK-007**: Add the "scopes now out of sync" notice per REQ-005.

## 3. Alternatives

- **ALT-001**: A separate "Build" button that writes all rendered output at once. Rejected: bypasses scoped confirmation and backups.
- **ALT-002**: Adopt from disk rewrites the template body from disk content. Rejected: the renderer is not reversible once fragments are involved, so the result would be wrong or would silently inline fragments.

## 4. Dependencies

- **DEP-001**: [Step 18](./step-18-template-source-model.md) and [Step 19](./step-19-template-renderer.md).
- **DEP-002**: [Step 9](./step-09-sync-conflict-ux.md) conflict modal.

## 5. Files

- **FILE-001**: `src/main/harness-config/harness-config.ts`, tests.
- **FILE-002**: `src/shared/state/harness-config/types.ts`.
- **FILE-003**: `src/renderer/components/Config/ConfigSyncDialog.tsx`, `config-sync-review.ts`, `Config.tsx`, tests.

## 6. Testing

- **TEST-001**: A template targeting Claude and Opencode makes both scopes report config-only until each is synced separately.
- **TEST-002**: Editing a shared fragment makes a pending plan in each dependent scope stale, and applying it is rejected.
- **TEST-003**: Bumping `RENDERER_VERSION` makes pending plans stale.
- **TEST-004**: Adopt with "Keep template" leaves the template unchanged; "Detach" stores the disk content and removes the target.
- **TEST-005**: A template with a render error does not cause deletes in its scope.
- **TEST-006**: Sync over an existing file creates a backup first.
- **TEST-007**: `pnpm typecheck`, `pnpm build`, `pnpm test`.

## 7. Risks & Assumptions

- **RISK-001**: Re-rendering every template on each keystroke is too slow for large sets. Render only templates that use the changed fragment; cache per-template output by input hash.
- **RISK-002**: Users expect one click to update every harness. The per-scope rule is intentional; the REQ-005 notice keeps the extra clicks visible and short.

## 8. Related Specifications / Further Reading

[Feature implementation details](./implementation-details.md)

[Step 21: Template editor](./step-21-template-editor.md)

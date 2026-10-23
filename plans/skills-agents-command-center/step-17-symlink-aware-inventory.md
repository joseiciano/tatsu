---
goal: Inventory symlinked harness resources read-only while keeping writes off symlinked paths
date_created: 2026-10-22
last_updated: 2026-10-22
status: 'Planned'
tags: [feature, main-process, harness-config, path-safety]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan is Step 17 of the [Skills-Agents-Commands-Sync plan](./skills-agents-commands-sync.md). It makes the harness config service read configuration that is symlinked from somewhere else, such as a dotfiles repository, without writing through those links. Terminology follows [implementation-details.md](./implementation-details.md).

The service in `src/main/harness-config/harness-config.ts` currently fails on symlinks in three places:

1. `resolveRoot()` calls `lstatSync(root).isDirectory()`, which is false for a symlinked folder, so the scope reports "The resolver known root is unavailable".
2. `walk()` skips every entry where `lstat` reports a symbolic link, so per-entry symlinked skills and commands never appear.
3. `assertRealContainment()` rejects any path with a symlinked component and any path whose real location is outside the root's real location.

A common real-world layout hits all three: `~/.claude/agents` is a symlink to a build folder, and each entry in `~/.claude/skills` and `~/.claude/commands` is a symlink into that build folder.

## 1. Requirements & Constraints

- **REQ-001**: `resolveRoot()` MUST follow a symlinked root. Use `statSync` for the directory check and `realpathSync` for the returned root. A broken root link stays unavailable.
- **REQ-002**: `walk()` MUST include symlinked files and directories. It MUST skip broken links, and it MUST detect loops by tracking the real paths of visited directories.
- **REQ-003**: Each inventoried `HarnessConfigFileRef` gains `linkedFrom?: string`, the real path of the symlinked component when any part of the resource path below the root is a symlink. It is display-only and never trusted as a write target.
- **REQ-004**: A resource with `linkedFrom` set is **managed elsewhere**. Direct update, direct delete, and sync-to-disk overwrite or delete of that resource MUST be rejected with a new error code `linked-resource`. The containment check for writes stays as strict as today.
- **REQ-005**: Reading a managed-elsewhere resource (`harnessConfig:readFile`, compare, adopt from disk) MUST work. Containment for reads is checked against the real path of the root plus the real path of each symlink target the walker followed, not against the root alone.
- **REQ-006**: Creating a new resource inside a symlinked root folder is allowed, because the root itself was resolved to its real path and the new file is a plain file there. Creating a resource whose path would pass through a symlinked entry (for example a new file inside a symlinked skill folder) MUST be rejected with `linked-resource`.
- **REQ-007**: The Config UI MUST show managed-elsewhere resources with a badge and the `linkedFrom` path, disable Edit and Delete for them, and explain why.
- **REQ-008**: The sync conflict modal MUST list managed-elsewhere entries but exclude them from the operations of a sync-to-disk plan, and say so in the modal.
- **SEC-001**: No write may follow a symlink. Reads may follow symlinks only to regular files, never to devices, sockets, or FIFOs.
- **CON-001**: This step does not change where the default roots are; [Step 16](./step-16-config-root-settings.md) owns overrides.

## 2. Implementation Steps

### Implementation Phase 1: Service

- **GOAL-001**: Read through symlinks, never write through them.

- [ ] **TASK-001**: Update `resolveRoot()` per REQ-001.
- [ ] **TASK-002**: Update `walk()` per REQ-002 and set `linkedFrom` per REQ-003.
- [ ] **TASK-003**: Split `assertRealContainment()` into a read mode and a write mode per REQ-004 and REQ-005. Write mode keeps today's checks.
- [ ] **TASK-004**: Add `linked-resource` to `HarnessConfigErrorCode` and reject linked targets in direct mutations and in sync plan generation.

### Implementation Phase 2: UI

- **GOAL-002**: Make managed-elsewhere resources visible and understandable.

- [ ] **TASK-005**: Badge and disable actions in `ConfigResourceList.tsx` and `ConfigEditor.tsx`.
- [ ] **TASK-006**: Show excluded entries in `ConfigSyncDialog.tsx`.

## 3. Alternatives

- **ALT-001**: Write through symlinks to the real file. Rejected. Typical dotfiles builds regenerate their output folder (for example `rm -rf output/claude` before rebuilding), so edits written there are lost on the next build. Templates ([Step 18](./step-18-template-source-model.md) onward) are the supported way to edit shared configuration.
- **ALT-002**: Keep ignoring symlinks. Rejected: users with dotfiles-managed configuration see an empty or broken Config page.
- **ALT-003**: Replace each symlink with a copy on first edit. Rejected: silently breaks the user's link-based setup.

## 4. Dependencies

- **DEP-001**: [Step 2](./step-02-main-process-harness-config-service.md) path-safety rules, which this step relaxes for reads only.
- **DEP-002**: [Step 9](./step-09-sync-conflict-ux.md) conflict modal.

## 5. Files

- **FILE-001**: `src/main/harness-config/harness-config.ts`, `harness-config.test.ts`.
- **FILE-002**: `src/shared/state/harness-config/types.ts` — `linkedFrom`, `linked-resource`.
- **FILE-003**: `src/renderer/components/Config/ConfigResourceList.tsx`, `ConfigEditor.tsx`, `ConfigSyncDialog.tsx`.
- **FILE-004**: `plans/skills-agents-command-center/step-02-main-process-harness-config-service.md` — note the read-mode relaxation.

## 6. Testing

- **TEST-001**: A symlinked root folder scans its entries.
- **TEST-002**: Symlinked skill folders and symlinked command files appear with `linkedFrom` set.
- **TEST-003**: A broken link and a directory loop are skipped without failing the scan.
- **TEST-004**: Update, delete, and sync-to-disk on a linked resource reject with `linked-resource` and leave both the link and its target unchanged.
- **TEST-005**: Creating a new file inside a symlinked root writes a regular file in the real folder.
- **TEST-006**: Adopt from disk copies a linked resource's content into Tatsu config.
- **TEST-007**: `pnpm typecheck`, `pnpm build`, `pnpm test`.

## 7. Risks & Assumptions

- **RISK-001**: Following links widens what a scan reads. Limited to regular files that match resolver patterns, within `maxDepth`.
- **RISK-002**: Adopting a linked resource and then syncing a different harness scope writes a real file that duplicates the dotfiles copy. Expected; the user chose both actions.
- **ASSUMPTION-001**: `realpathSync.native` is available on all supported platforms.

## 8. Related Specifications / Further Reading

[Feature implementation details](./implementation-details.md)

[Step 16: Config root settings](./step-16-config-root-settings.md)

[Step 22: Import an existing template setup](./step-22-import-existing-setup.md)

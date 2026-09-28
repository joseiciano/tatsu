---
goal: Record the open questions that remain after the product boundary and source-of-truth decisions, and lock the invariants those questions may not weaken
date_created: 2026-09-25
last_updated: 2026-09-25
status: 'Planned'
tags: [feature, open-questions, harness-config, resolver, documentation]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This step reconciles the plan set's open-questions ledger with the accepted product boundary in [step-01-product-boundary-source-of-truth.md](./step-01-product-boundary-source-of-truth.md) and [implementation-details.md](./implementation-details.md). It is documentation-only. The sync-scope question is resolved, not open. Only the three resolver-owned discovery questions remain open, and their answers cannot weaken confirmation, backup, alias identity, scoped mutation, or no-cross-harness/plugin-copy invariants. This step owns no runtime behavior and makes no new product decisions.

## 1. Requirements & Constraints

- **REQ-001**: The former sync-scope question ("should sync apply globally across all harnesses and resource types, or per harness and resource type?") is **RESOLVED**, not open. Every comparison and mutation is scoped by `${agentKind}:${resourceType}`; no global cross-harness sync exists in the initial implementation. This is established by REQ-011 and ALT-003 of [step-01-product-boundary-source-of-truth.md](./step-01-product-boundary-source-of-truth.md) and by the source-of-truth operation matrix in [implementation-details.md](./implementation-details.md). No later step may reopen it.
- **REQ-002**: The exact harness directory conventions per harness and harness version (paths, filenames, and layout rules that each resolver recognizes) MUST remain an **OPEN** question explicitly deferred to the owning resolver steps: Step 2, [step-02-main-process-harness-config-service.md](./step-02-main-process-harness-config-service.md), and Step 3, [step-03-harness-capability-metadata.md](./step-03-harness-capability-metadata.md). This step MUST NOT propose paths or layouts.
- **REQ-003**: The repo-local versus global discovery-roots question (which configuration roots each resolver scans, and with what precedence) MUST remain an **OPEN** question explicitly deferred to Steps 2 and 3. This step MUST NOT enumerate roots or precedence rules.
- **REQ-004**: The nested skill asset support question (whether and how a skill package's additional asset files beyond its entrypoint are discovered, represented, or synced) MUST remain an **OPEN** question explicitly deferred to Steps 2 and 3. This step MUST NOT decide the shape or extent of nested-asset handling.
- **REQ-005**: Answers to REQ-002 through REQ-004 may refine only what each resolver discovers and where it discovers it. They MUST NOT weaken explicit confirmation for every mutation; rejection of a stale confirmed plan or an absent plan; no-op Cancel and dismiss actions; backup of original bytes before overwrite or delete with abort on backup failure; stable Claude skill/command alias identity, shared physical path, and conversion reuse of the existing identity; comparison and mutation scoped by `${agentKind}:${resourceType}`; or the prohibition on copying, installing, or converting managed resources across harnesses and copying plugins across harnesses. Plugins remain provenance metadata, never a fourth resource type or an automatic cross-harness payload.
- **REQ-006**: Source-of-truth direction is settled and MUST NOT be reopened by a resolver answer: `sync to disk` writes a confirmed Tatsu config snapshot to the selected harness directory, while `adopt from disk` writes a confirmed disk inventory snapshot to the selected Tatsu config scope.
- **REQ-007**: The managed resource union is exactly `agents | skills | commands`. Initial harness scope is `claude`, `codex`, and `opencode`; `pi` is explicitly deferred. The resolver questions MUST NOT expand either boundary.
- **REQ-008**: The open-question ledger MUST contain only REQ-002 through REQ-004. This step MUST NOT introduce a question, contract, or requirement that competes with, redefines, or renumbers identifiers in Step 1, [implementation-details.md](./implementation-details.md), or any other plan in this directory.
- **CON-001**: Runtime source files under `src/` MUST remain unchanged while executing this step; it is documentation-only.
- **GUD-001**: Use the Step 1 canonical terminology (`disk inventory`, `Tatsu config`, `sync to disk`, `adopt from disk`, `conflict`, `confirmed plan`) consistently when describing any open question.

## 2. Implementation Steps

### Implementation Phase 1: Reconcile the open-questions ledger

- **GOAL-001**: Produce one authoritative ledger that retains only the three genuinely open resolver questions with explicit owners after the accepted boundary.

- [ ] **TASK-001**: Record the sync-scope question as resolved with a pointer to the deciding sources.
  - Quote the resolved rule: every comparison and mutation is scoped by `${agentKind}:${resourceType}`; no global cross-harness sync exists in the initial implementation.
  - Cite [step-01-product-boundary-source-of-truth.md](./step-01-product-boundary-source-of-truth.md) REQ-011 and ALT-003, and the operation matrix in [implementation-details.md](./implementation-details.md).
- [ ] **TASK-002**: Keep exactly three resolver questions open with their owning steps: exact harness directory conventions per harness/version, repo-local versus global discovery roots, and nested skill asset support, all explicitly deferred to Steps 2 and 3.
  - For each, record only the open dimension and owner; do not answer it here.
- [ ] **TASK-003**: Exclude settled source-of-truth direction, mutation scope, managed resource scope, harness scope, and mutation safeguards from the open-question ledger.
- [ ] **TASK-004**: Record the invariant protection statement from REQ-005 so resolver answers cannot weaken confirmation, backup, alias identity, scoped mutation, or no-cross-harness/plugin-copy rules.

## 3. Files

- **FILE-001**: `plans/skills-agents-command-center/step-15-open-questions.md` — the reconciled open-questions ledger created by this step.
- **FILE-002**: `plans/skills-agents-command-center/step-01-product-boundary-source-of-truth.md` — read-only source of the resolved boundary and invariants; no change in this step.
- **FILE-003**: `plans/skills-agents-command-center/implementation-details.md` — read-only canonical feature specification referenced for the resolved rules; no change in this step.

## 4. Testing

- **TEST-001**: Review FILE-001 and verify the sync-scope question appears only as resolved, with explicit pointers to Step 1 (REQ-011, ALT-003) and the operation matrix in implementation-details.md; no section may present it as open.
- **TEST-002**: Review FILE-001 and verify exactly three questions remain open, each explicitly deferred to Steps 2 and 3, with no proposed paths, roots, layouts, precedence, or asset-handling decisions.
- **TEST-003**: Review FILE-001 and verify the invariant protection statement names explicit confirmation, stale-or-absent-plan rejection, no-op cancellation/dismissal, backup of original bytes before overwrite/delete with abort on failure, Claude alias identity and physical-path reuse, `${agentKind}:${resourceType}` scoped mutation, and the no-cross-harness/plugin-copy rule.
- **TEST-004**: Review FILE-001 and verify no open question reopens the direction of `sync to disk` or `adopt from disk`, expands `agents | skills | commands`, adds `pi` to the initial harness scope, or treats plugins as a resource type or automatic cross-harness payload.
- **TEST-005**: Run Markdown link validation for all relative links in FILE-001 and confirm every target exists.
- **TEST-006**: Run identifier declaration validation from the `plan-implementation-plan` skill against this file; duplicate TASK/GOAL rows and duplicate bullet-style declaration identifiers MUST both produce zero results.
- **TEST-007**: Do not run TypeScript tests, `pnpm typecheck`, or `pnpm build` for this documentation-only step because CON-001 prohibits runtime source changes.

## 5. Risks & Assumptions

- **RISK-001**: A later resolver step could treat an open question as license to bypass a safety gate (for example, skipping backup for a write inside a newly discovered root). REQ-005 makes the protection rule explicit; Step 14 acceptance criteria remain the enforcement point.
- **RISK-002**: A reader could mistake the resolved sync-scope entry for an open question if the resolved/open framing is inconsistent. REQ-001 uses an explicit resolved marker, while REQ-002 through REQ-004 use explicit open markers and owners.
- **RISK-003**: Ownership drift: if resolver work moves to a different step, owners recorded here could go stale. Owners must be re-checked when the parent plan [skills-agents-commands-sync.md](./skills-agents-commands-sync.md) changes structure.
- **ASSUMPTION-001**: Step 1 is accepted as the final product boundary; this step's only job is reconciliation, not re-derivation.
- **ASSUMPTION-002**: Steps 2 and 3 own and will answer the three resolver questions. Until then, this file records their explicit deferral without supplying fallback answers.

## 6. Related Specifications / Further Reading

- [Implementation details and product goals](./implementation-details.md)
- [Parent implementation plan](./skills-agents-commands-sync.md)
- [Step 1: Product boundary and source of truth](./step-01-product-boundary-source-of-truth.md)
- [Step 2: Main-process harness config service](./step-02-main-process-harness-config-service.md)
- [Step 3: Harness capability metadata](./step-03-harness-capability-metadata.md)

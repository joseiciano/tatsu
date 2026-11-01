# Code Review 2 — Step 02 harness-config service re-review

**Scope**: Current working tree (`src/main/harness-config/` implementation and tests; plan/docs updates in Step 2, 3, 5, 6).
**Method**: `ocr review` attempt + manual evidence-based review. The automated OCR run timed out after 20 minutes while attempting to read `src/shared/state/terminals.ts` (file not found — OCR probed a wrong path); no OCR output was produced. Findings below come from the manual review.

## Prior findings — re-check results

- **Dangling/escaping ancestor symlinks** — addressed; `assertRealContainment` rejects any symlink component including dangling ancestors, with a dedicated regression test (`rejects creates beneath dangling symlink directories`).
- **CLAUDE_CONFIG_DIR / ambiguous OpenCode override** — addressed; `CLAUDE_CONFIG_DIR` is honored for claude roots, and an `OPENCODE_CONFIG_DIR` that disagrees with the computed default is rejected for opencode agents/commands as ambiguous (test present). Note: `OPENCODE_CONFIG_DIR` equal to the default is still accepted but has no effect on `opencodeSkills`, which always resolves from `$HOME/.config/opencode`; this is intentional-ish but worth a follow-up contract decision — not a defect.
- **Physical ID recompute for desired resources** — addressed; `configEntries` recomputes `expectedId` from `(agentKind, rootKey, target.relativePath)` and rejects mismatched persisted IDs before comparison (`rejects a persisted resource whose id does not match physical identity...`).

## High priority

### 1. Direct Claude alias mutations persist through the canonical Skills scope, dropping native Commands records

**File**: `src/main/harness-config/harness-config.ts` (~lines 1301–1338)

Direct create/update/delete on a Claude alias target (a skill exposed in the Commands view) resolves the operation's descriptor to the `skills` resolver, computes `canonicalScope = claude:skills`, filters desired resources to canonical Skills only, and calls `replaceDesiredScope(claude:skills, …)`.

Per the revised Step 5 contract, `replacePersistedHarnessConfigScope(config, scope, resources)` replaces the full **logical** scope: it removes every record participating in `scope` by canonical type **or** alias membership and retains only the provided snapshot. A direct mutation issued through the **Commands** view on a *native* command uses `descriptorResourceType(scope, commandsDescriptor) = 'commands'` → canonical scope `claude:commands`; the Step 5 logical-view replacement then removes existing canonical **Skills** records that advertise `aliasResourceTypes: ['commands']` from persisted state, because the replacement snapshot contains only the one mutated command. Result: a mutation issued through the **Commands** view on a *native* command uses `descriptorResourceType(scope, commandsDescriptor) = 'commands'` → canonical scope `claude:commands`; the Step 5 logical-view replacement then removes existing canonical **Skills** records that advertise `aliasResourceTypes: ['commands']` from persisted state, because the replacement snapshot contains only the one mutated command. Result: adopting/keeping a Claude skill in the Skills view is silently erased from Tatsu config by an unrelated native-command direct create/update/delete.

**Evidence**:
- `persistDirectMutation` (lines ~1301–1338) selects `current` only by `(canonicalResourceType ?? resourceType) === canonicalScope.resourceType`, builds `resources` from that filtered set plus/minus the mutated ID, then `replaceDesired(canonicalScope, resources)`.
- Step 5 REQ-012 (revised): a canonical resource belongs to the logical view when `resourceType === scope.resourceType` **or** `aliasResourceTypes.includes(scope.resourceType)`; replacement "removes the p[articipating records]" — i.e., replacement is by logical-view membership.
- The service test suite has **no** direct-mutation coverage where a canonical Skills record with `aliasResourceTypes: ['commands']` coexists with a native Commands mutation — the alias tests cover adopt-from-disk and comparison only.

**Impact**: Silent deletion of Claude Skills desired-state records when the user creates/updates/deletes a native Claude command; subsequent sync-to-disk for the Skills view will propose deleting the on-disk skill files (config-only). Data-loss class bug at the persistence seam, hidden until a later scan/plan.

**Suggested fix**: When persisting a direct mutation, either (a) pass the canonical snapshot **plus** all records whose `aliasResourceTypes` include the canonical resource type, or (b) make `replaceDesiredScope` semantics "replace canonical membership only" and have Step 5 remove only records whose canonical type matches — one of the two sides must be made consistent and tested. Given Step 5's revised contract, fix the service: compute the retained set from logical-view membership and re-add surviving canonical members:

```ts
const current = this.loadDesired().filter((resource) =>
  resource.agentKind === canonicalScope.agentKind &&
  ((resource.canonicalResourceType ?? resource.resourceType) === canonicalScope.resourceType ||
    (resource.aliasResourceTypes ?? []).includes(canonicalScope.resourceType))
)
```

(and symmetrically retain canonical records whose alias sets point at the view, per Step 5's "retaining canonical records" clause — align the exact rule with the Step 5 implementer before landing).

## Medium priority

### 2. `prepareConversion` destination-collision check can miss an existing destination whose file matches the *source* resolver's pattern

**File**: `src/main/harness-config/harness-config.ts` (~lines 1150–1156)

`prepareConversion` resolves the draft destination via the destination descriptor and then scans `destinationScope` with `scanDisk(destinationScope, …)` to find an existing resource at `target.relativePath`. `scanDisk` walks the destination root using the **destination** descriptor, so this is consistent within one call. However, when the source and destination descriptors share the same `rootKey` (the common Claude case is excluded by the early `alias` return, but any custom resolver fixture or future descriptor pairing with a shared root and non-overlapping patterns is affected), the existing check depends on `scanDisk` of the destination scope only. If a destination file exists but does not match the destination descriptor's pattern (e.g., created later by a resolver change), `resolveCandidate(..., mustExist: false)` succeeds, `scanDisk` finds nothing, and a draft is returned for a path that physically exists; the subsequent confirmed create would then hit `preflight`'s `collision` — safe, but the user gets a draft instead of the required `{ status: 'existing', ref }`, and the ref identity is never surfaced. Lower severity because apply-time preflight still blocks the write; flagging for contract fidelity of REQ-027 (`existing` must be returned when an independent destination already exists).

**Suggested fix**: In the `existing` lookup, prefer a direct existence check on `target.absolutePath` plus a scan for the matching relative path across the harness's descriptors for that root, rather than relying solely on the destination descriptor's pattern-matched scan.

### 3. Adopt-from-disk passes the requested (possibly alias) scope to `replaceDesiredScope` while resources are canonicalized

**File**: `src/main/harness-config/harness-config.ts` (~lines 390–397, 537–546)

`planAdoptFromDisk` canonicalizes each disk ref into a desired resource with `resourceType = ref.canonicalResourceType` (so adopting from Claude Commands yields canonical `skills` records), but `applyPlan` calls `replaceDesired(scope, plan.adoptedResources)` with the **requested** scope (e.g., `claude:commands`). Step 5's revised membership rule accepts such records (canonical skill belongs to the Commands logical view via alias), so this works with the revised persistence helper — but it is fragile: the service hands the persistence layer a scope that does not equal the canonical scope of the payload. If any persistence implementation filters by exact `resourceType === scope.resourceType` (the pre-revision contract), adopt from Claude Commands would silently persist nothing. Since Step 5's text is the authority and the current pairing is consistent with it, this is a contract-robustness note rather than a defect; consider passing the canonical scope derived from the payload (as `persistDirectMutation` does) for symmetry and to survive future contract tightening.

## Low priority / informational

- `resolveRoot`'s "multiple active configuration roots" guard only covers `opencodeAgents`/`opencodeCommands` and only rejects *differing* overrides; `OPENCODE_CONFIG_DIR` equal to the computed default is silently accepted but `opencodeSkills` ignores the variable entirely (always `$HOME/.config/opencode`). If the vendor contract is a single config dir, skills should honor it too; if not, the guard is dead weight. Team decision needed; not a code defect today.
- `createBackup`'s failure cleanup unlinks a partially written backup file on a non-EEXIST write failure; harmless but the file could contain partial bytes if the process dies mid-write. `wx` + subsequent full-content write is acceptable for the stated invariant.
- `compactTimestamp` formats `YYYYMMDDTHHmmssSSSZ` correctly via ISO string munging; the backup regex `BACKUP_SUFFIX` matches exactly this shape including collision suffixes. No issue found.
- Tests: fixture `makeFsAdapter` exposes `appendFileSync` that the production `HarnessConfigFilesystem` type does not declare — type-loose but test-only; harmless.

## Verification status

- OCR attempt: failed (timeout; wrong-path file probe `src/shared/state/terminals.ts`); output empty. Not retried per instruction.
- Manual findings above are grounded in the current tree contents as read during this review session; the High finding's persistence-contract impact is corroborated by the revised Step 5 REQ-012 text in `plans/skills-agents-command-center/step-05-persist-tatsu-managed-config.md`.

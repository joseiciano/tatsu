# Implementation Details: Skills-Agents-Commands-Sync

This implementation plan is for the skills-sync feature. It will detail the goal, implementation steps, and end result for this feature.

The binding product contract for this feature is defined in [step-01-product-boundary-source-of-truth.md](./step-01-product-boundary-source-of-truth.md). Every later step MUST reference the terminology and invariants declared there and MUST NOT redefine synchronization direction or confirmation semantics (GUD-001, DEP-005).

## Goal

The goal is to let Tatsu view and manage exactly three logical resource types:

- `agents` — **Agents**
- `skills` — **Skills**
- `commands` — **Commands**

This allows users to compare the resources configured for one agentic harness with those configured for another, then create, edit, delete, sync to disk, or adopt from disk within an explicitly selected harness and resource scope.

### Why Create This

Tatsu connects users to multiple agentic harnesses, but today each harness must be configured separately outside the app. This plan provides one in-app surface for inspecting and managing those configurations without erasing the differences between harness capabilities.

### End-state happy path

- A new button on the home page opens a Config page.
- The Config page has three tabs with the preserved labels `Agents`, `Skills`, and `Commands`; they map only to `agents`, `skills`, and `commands`, respectively.
- Every harness/resource combination remains visible. Managed combinations are enabled; deferred, unsupported, or unknown combinations are disabled with an explanation.
- For an enabled `${agentKind}:${resourceType}` scope, the selected tab shows disk inventory and its comparison with Tatsu config. Users can create, edit, or delete one resource through the explicit gates in the operation matrix below.
- A conflict presents the scoped differences and lets the user either `Sync Tatsu config to disk`, `Adopt current disk files into Tatsu config`, or `Cancel`. Nothing is written until the user confirms a current plan.
- The `Skills` view offers `Create command`, and the `Commands` view offers `Create skill`. Where Claude exposes the same physical resource in both views, conversion reuses its stable identity and path rather than creating another file.

## Product Boundary and Source of Truth

### Canonical resource types

The first implementation exposes exactly three logical resource types: `agents`, `skills`, and `commands` (REQ-001). These are logical categories, not filesystem layouts: each harness resolver owns the mapping from a resource type to concrete directories and filenames. Filesystem layout, per-version directory names, and nested asset support are resolver decisions owned by Steps 2 and 3 (CON-001) and are not specified here.

| Resource | Logical definition | Examples | User-facing label |
|---|---|---|---|
| `agents` | Harness-facing instruction or agent-definition files, including resolver-recognized `AGENTS.md`, `CLAUDE.md`, and harness-specific equivalents | `AGENTS.md`, `CLAUDE.md`, harness-specific agent definition files | Agents |
| `skills` | Resolver-recognized reusable skill files or packages that a harness can load | `SKILL.md`, skill directories, opencode skills | Skills |
| `commands` | Resolver-recognized slash-command or prompt-command files for harnesses that support them | Claude commands, Codex/OpenCode command files where supported | Commands |

Plugin provenance is metadata on an inventoried `agents`, `skills`, or `commands` resource, never a fourth managed resource type or a separately managed payload. The UI MAY identify a plugin-provided resource under its originating harness, but plugin installation, plugin conversion, and automatic cross-harness copying are outside the first implementation (REQ-018, ALT-004).

### First-version harness/resource matrix

Every cell is explicit so the UI can render all known combinations without inferring support or hiding disabled rows.

| Agent kind | Agents | Skills | Commands |
|---|---|---|---|
| `claude` | Managed | Managed | Managed |
| `codex` | Managed | Managed | Managed |
| `opencode` | Managed | Managed | Managed |
| `pi` | Deferred — visible and disabled | Deferred — visible and disabled | Deferred — visible and disabled |

`claude`, `codex`, and `opencode` are the complete managed harness scope for the first implementation. `pi` remains an `AgentKind`, but its configuration management is explicitly deferred until its resource capabilities and filesystem conventions are specified; it is not unsupported forever.

Any harness/resource combination that capability metadata marks unsupported or unknown MUST remain visible and disabled with an explanation. It MUST NOT be omitted, treated as supported, or assigned a guessed resolver path (REQ-006). Step 3 owns the capability metadata; this table owns the product boundary and does not prescribe filesystem layouts.

Every comparison, generated plan, current-plan slot, and mutation is scoped by `${agentKind}:${resourceType}` (REQ-011, TASK-005). No first-version action may implicitly mutate every harness or every resource type; there is no global sync across harnesses (ALT-003).

### Source-of-truth rules

Canonical terminology (GUD-001) — use these terms consistently in every downstream plan and UI contract:

- **Disk inventory** — the files currently discovered by a harness-specific resolver inside known configuration roots. It is an observation, not desired state.
- **Tatsu config** — the persisted desired managed state stored in Tatsu's app config. It is NOT a cache of the latest disk scan.
- **Sync to disk** — generate and, only after confirmation, apply a plan that makes the selected disk scope match Tatsu config.
- **Adopt from disk** — generate and, only after confirmation, apply a plan that replaces the selected portion of Tatsu config with the current disk inventory.
- **Conflict** — a difference between disk inventory and Tatsu config for a scoped `${agentKind}:${resourceType}`.
- **Confirmed plan** — a previously generated, still-current plan that the user has explicitly confirmed for a specific mutation.

Direction is fixed: sync to disk writes Tatsu config to disk; adopt from disk writes disk inventory into Tatsu config (TEST-002).

### Source-of-truth operation matrix

| Operation | Reads | Writes | Required user gate |
|---|---|---|---|
| Scan | Known harness roots | Nothing | None |
| Compare | Disk inventory and Tatsu config | Nothing | None |
| Sync to disk | Confirmed Tatsu config snapshot | Selected harness directory | Confirmed current sync plan |
| Adopt from disk | Confirmed disk inventory snapshot | Selected Tatsu config scope | Confirmed current adopt plan |
| Direct create | User draft and target capability | One new resource | Explicit Create action |
| Direct update | User draft and current resource | Backup plus one existing resource | Explicit Save confirmation |
| Direct delete | Current resource | Backup plus removal of one existing resource | Explicit Delete confirmation |

Scan and compare are read-only and MAY run automatically (REQ-014). No direct create, direct update, direct delete, sync to disk, adopt from disk, or plugin setup operation may run without an explicit user action that confirms that specific mutation.

Existing unmanaged user files remain unmanaged until the user explicitly uses adopt from disk or confirms a direct mutation (CON-003).

### Conflict and current-plan behavior

A **conflict** exists only within one `${agentKind}:${resourceType}` scope when disk inventory and Tatsu config differ. Tatsu MUST show the scoped conflict modal before any sync to disk or adopt from disk mutation (REQ-012). The modal:

- Displays disk-only, config-only, and content-changed entries, each labeled with the originating harness and logical resource type (REQ-013, GUD-002).
- Offers exactly three outcomes: `Sync Tatsu config to disk`, `Adopt current disk files into Tatsu config`, and `Cancel` (REQ-013).
- Mutates nothing when opened, canceled, or dismissed. `Cancel` and dismissal are no-op outcomes (REQ-015).

Each generated sync to disk or adopt from disk plan occupies only the current-plan slot for its `${agentKind}:${resourceType}` scope and binds the disk inventory and Tatsu config snapshots used to generate it. A new scan that changes either bound snapshot invalidates that displayed plan. Apply MUST reject an absent, unconfirmed, or stale plan; the user must regenerate and explicitly confirm a current plan before any mutation (REQ-015, TASK-005).

The full conflict presentation contract is owned by [step-09-sync-conflict-ux.md](./step-09-sync-conflict-ux.md).

### Caveats

**Claude skill/command aliasing** (REQ-017, TASK-007):

Where Claude exposes one physical skill file through both the skill and command concepts, the Skills and Commands views model the two appearances as aliases of the same underlying resource. Native Claude command resources remain commands rather than becoming skill aliases:

- One physical Claude resource may appear in both logical views.
- Both views MUST resolve to the same stable resource identity and underlying path.
- Create-skill / create-command conversion MUST return the existing resource reference when the alias already exists and MUST NOT create a duplicate file.

Alias capability rules are owned by [step-03-harness-capability-metadata.md](./step-03-harness-capability-metadata.md); conversion behavior is owned by [step-10-skill-command-conversion.md](./step-10-skill-command-conversion.md).

**Plugin provenance and inventory** (REQ-018):

Plugin origin MAY be displayed as provenance metadata for an inventoried `agents`, `skills`, or `commands` resource under its originating harness. Plugin metadata does not make the plugin a managed resource, add it to the resource union or capability matrix, or authorize plugin installation, conversion, or automatic cross-harness copying. Plugins are never sync to disk or adopt from disk payloads in the first implementation.

**Backup invariant** (REQ-016, SEC-001, TASK-008):

- Existing files MUST be backed up before every destructive disk write, including direct overwrite, direct delete, and any overwrite or delete performed by sync to disk. The backup MUST be a dated, byte-for-byte copy of the unmodified file.
- Backup creation MUST happen from the unmodified bytes BEFORE the original is replaced or deleted.
- If backup creation fails (permissions, storage, naming collisions), the destructive write MUST be aborted and the original file left untouched (fail-closed).
- Brand-new files do not require a backup; the backup step is skipped only when the target file does not already exist.

Backup implementation rules are owned by [step-02-main-process-harness-config-service.md](./step-02-main-process-harness-config-service.md); end-to-end backup acceptance criteria are owned by [step-14-acceptance-criteria.md](./step-14-acceptance-criteria.md).

**Path safety** (SEC-002, PAT-001):

All filesystem implementations restrict writes to main-process-resolved, normalized paths inside known harness configuration roots. Renderer input MUST NOT supply trusted absolute paths. The main process performs filesystem and persistence work; renderer clients request plans and render store-backed results.

**Open resolver questions** (CON-001, TASK-009):

Exact harness directory conventions, repo-local versus global discovery roots, and nested skill asset support remain open for their owning resolver steps ([step-15-open-questions.md](./step-15-open-questions.md)). None of those resolver questions may weaken the confirmation, backup, alias, or no-cross-harness-copy invariants established here.

## Alternatives considered

- **ALT-001**: Treat disk as the only source of truth and use Tatsu solely as a file editor. Rejected: cannot represent desired resources that are temporarily missing from disk and cannot provide a deterministic sync to disk direction.
- **ALT-002**: Treat Tatsu config as authoritative and automatically overwrite drift on scan. Rejected: can destroy existing user-authored harness configuration without informed consent.
- **ALT-003**: Provide one global sync action across all harnesses and resource types. Rejected for the first implementation: blast radius too large and plugin/capability differences make a single confirmation ambiguous.
- **ALT-004**: Convert plugin and resource formats between harnesses automatically. Rejected: plugin schemas and runtime assumptions are not portable across vendors.

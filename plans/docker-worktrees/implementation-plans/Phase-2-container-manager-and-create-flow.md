# Phase 2 — container manager and create flow

## Deliverable

When the setting is enabled, new worktrees receive a companion container, and setup runs
inside that container.

System contracts: [`../System-Design.md`](../System-Design.md).

## New package

```text
src/main/worktree-containers/
├── index.ts
├── types.ts
├── worktree-containers.ts
└── worktree-containers.test.ts
```

## Types

- `DockerRunner`
  - `run(args: string[], opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>`
  - injected for tests; implementation wraps existing process spawn helpers.
- `ResolvedWorktreeContainerConfig`
  - resolved image/dockerfile/workdir/shell/env/volumes/ports.
- `CreatedWorktreeContainer`
  - `id`, `name`, `image`, `workdir`, `shell`, `status`.

## Manager responsibilities

- `checkDockerAvailable()` runs `docker version` or equivalent and returns
  actionable errors for missing CLI vs daemon unavailable.
- `resolveContainerConfig(repoRoot, worktreePath, repoConfig?)` merges `.harness.json` with defaults.
- `ensureImage(config)` pulls image configs when needed and rebuilds Dockerfile configs.
  - for image configs, inspect local image and pull explicitly when missing.
- `createForWorktree(repoRoot, worktreePath, config)` creates and
  starts container with Tatsu labels.
- `execInContainer(containerId, command, opts)` runs non-interactive setup.
- `stopContainer(containerId)` stops and removes a container, continuing to `rm -f` if stop fails and propagating removal errors to the caller.
- sanitize names from repo + branch and assert labels are always present.
- `getWorktreeId(worktreePath)` returns `sha256(absPath).slice(0, 12)` for
  labels and generated tags.

## Repo config integration

- `src/shared/state/repo-configs/types.ts`
  - add `container?: RepoContainerConfig` to repo config shape.
- `src/main/repo-config/repo-config.ts`
  - parse file-backed container config.
  - validate `image`/`dockerfile` exclusivity and path rules.
  - return actionable validation errors to worktree creation.
- `src/main/repo-config/repo-config.test.ts`
  - cover valid image, valid Dockerfile, both-set rejection, invalid workdir,
    invalid env key, and rejected volume target.

Validation belongs in repo-config parsing plus container-manager normalization.
WorktreesFSM should receive either resolved config or typed validation failure.

## WorktreesFSM changes

- `src/main/worktrees-fsm/worktrees-fsm.ts`
  - add `getEnableWorktreeContainers: () => boolean` to `WorktreesFSMOptions`.
  - add `containers: WorktreeContainers` to options.
  - keep `runPending()` and `runPendingPR()` host worktree creation unchanged.
  - after `addWorktree()` returns `created`, before setup, branch on setting:
    1. dispatch pending update for container creation phase.
    2. create/start container.
    3. pass container context into `finishCreate()`.
  - if container creation fails, dispatch pending `status: 'error'` with Docker
    message and leave host worktree intact for manual cleanup.
- `finishCreate()`
  - accept optional `container` context.
  - choose host executor or container executor for setup script.
  - after success, refresh list and preserve container metadata in final worktree state.
  - setup failure leaves container running for investigation.
- `src/main/index.ts`
  - construct container manager once.
  - pass `getEnableWorktreeContainers: () => store.getSnapshot().settings.enableWorktreeContainers`.

## State/event detail

- Append visible setup log message `Creating Docker container...` before container creation.
- Add pending phase only if existing UI cannot render that message clearly.
- Final `Worktree.container.status` starts as `running` after successful create.

## Failure policy

- Docker CLI missing: pending worktree error says Docker not installed or not on PATH.
- Docker daemon stopped: pending worktree error says Docker daemon unavailable.
- image build/pull fails: pending worktree error includes Docker stderr.
- container starts but setup fails: pending status becomes setup-failed; container is left running.
- host worktree creation fails: no Docker attempt.

## Tests

- `src/main/worktree-containers/worktree-containers.test.ts`
  - builds expected `docker run` args with labels, mount, workdir, env, ports.
  - sanitizes container name.
  - distinguishes CLI missing from daemon unavailable.
  - emits configured `docker build` before `docker run` for Dockerfile config.
  - tests image inspect/pull behavior for configured and default images.
- `src/main/repo-config/repo-config.test.ts`
  - validates container config parsing, path normalization, and rejected unsafe volumes/env keys.
- `src/main/worktrees-fsm/worktrees-fsm.test.ts`
  - setting off: no container manager calls; setup uses host executor.
  - setting on: order is host worktree → container create → setup in container → `onWorktreeCreated`.
  - Docker failure: pending error, no setup, no `onWorktreeCreated`.
  - setup failure after container create: pending setup-failed and container metadata retained for cleanup.

## Verification

```text
pnpm typecheck
npx vitest run src/main/worktree-containers src/main/repo-config src/main/worktrees-fsm/worktrees-fsm.test.ts
```

## Outcome

New worktrees can be containerized and setup runs in a container.

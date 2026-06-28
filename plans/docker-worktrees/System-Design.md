# Docker worktrees — system design

## Architecture invariant

Use host git worktrees with companion containers. Do not create container-only git
worktrees. Host git worktrees remain canonical; containers provide runtime
isolation only.

Host remains responsible for:

- `git worktree list` source of truth.
- changed-files panel git commands.
- PR polling path mapping.
- hook file installation.
- editor/open-file host paths.
- filesystem watchers.

## Functional behavior contract

### Settings

Settings Experimental adds **Enable worktree containers**.

Copy:

> New worktrees run setup scripts and terminals inside a dedicated Docker
> container. Existing worktrees are unchanged.

Default is off. Docker availability is validated lazily on next worktree
creation, not when saving Settings.

### Worktree creation

When toggle is off, current flow is unchanged.

When toggle is on:

1. Create normal host git worktree at current path.
2. Resolve container spec from repo config/defaults.
3. Inspect/pull configured image or build Dockerfile image.
4. Create/start one long-lived container for this worktree.
5. Mount host worktree into container at `/workspace`.
6. Run setup script inside container.
7. Mark worktree as containerized in shared state.
8. New terminal/chat agent panes for that worktree execute through `docker exec`.

If container creation fails after host worktree creation, mark pending worktree
failed and include cleanup guidance. Do not silently delete user files.

Toggle affects only future worktrees. First slice does not containerize existing
sessions.

## Container identity

Each container gets stable labels:

- `tatsu.worktree.id=<derived id>`
- `tatsu.worktree.path=<absolute host path>`
- `tatsu.repo.root=<repo root>`

Name format:

```text
tatsu-wt-<basename>-<short-hash>
```

Labels are authoritative. Name is for humans.

Containers start detached with idle entrypoint:

```text
tail -f /dev/null
```

Terminals then use `docker exec -it`.

## Repo configuration

Add optional `container` object to `.harness.json` through `RepoConfig`:

```ts
type RepoContainerConfig = {
  image?: string
  dockerfile?: string
  buildContext?: string
  workdir?: string
  shell?: string
  env?: Record<string, string>
  ports?: number[]
  volumes?: Array<{ source: string; target: string }>
  disabled?: boolean
}
```

Resolution order:

1. Global Settings toggle must be on.
2. Repo config can set `container.disabled: true` to opt out.
3. Repo config can set `container.disabled: false` (or omit), but global toggle must also be on.
4. Image selection:
   - `container.image` if set.
   - else build `container.dockerfile` if set.
   - else use `node:20-alpine`.

First implementation reads these fields only from file-backed repo config. No
Settings or repo-config editor UI fields.

Schema rules:

- `image` and `dockerfile` are mutually exclusive.
- Relative `dockerfile` and extra volume `source` paths resolve
  from repo root.
- Absolute volume `source` paths are allowed only after security validation.
- `workdir` defaults to `/workspace` and must be an absolute container path.
- `shell` defaults to `/bin/sh`. If missing inside image, show actionable
  terminal/setup error. Do not silently fall back to host execution.
- When building from a Dockerfile, `--build-arg WORKDIR=<workdir>` is passed
  so Dockerfiles can use it to set up the working directory.
- No environment variable interpolation in first slice. `container.env` values
  are literal strings.

## Secret and agent auth policy

Running agents inside containers changes credential boundary.

Do not mount host auth directories by default.

Support `shareAgentConfig: true` in repo config as explicit opt-in. When true,
mount known agent config directories read-only where possible:

- `~/.claude` for Claude Code.
- `~/.config/opencode` for Opencode.
- `~/.codex` or configured Codex home if present.

If agent binary/auth is missing inside container, terminal should show clear
message: install agent CLI in image or enable/share required config.

No Settings UI toggle for credential sharing in first slice.

## State model

### Settings slice

Add:

- `enableWorktreeContainers: boolean`
- event: `settings/enableWorktreeContainersChanged`
- default: `false`

### Persistence

Add config fields:

- `enableWorktreeContainers?: boolean`
- `worktreeContainers?: Record<string, PersistedWorktreeContainer>` keyed by
  absolute host worktree path.

Hydrate with strict true check.

Persisted container metadata is app-local runtime state, not repo config:

```ts
type PersistedWorktreeContainer = {
  id?: string
  name: string
  image: string
  workdir: string
  shell: string
}
```

Docker labels remain authoritative for live status, but persisted metadata keeps
app from falling back to host terminals when Docker is unavailable on boot.

Metadata update points:

- create success: write metadata before final worktree refresh dispatch.
- setup failure after container create: write metadata and keep pending failure visible.
- boot recovery: merge Docker inspect status into shared state; persist only stable
  identity fields.
- stop/error detection: update shared state only; avoid config churn for transient status.
- delete success: remove `worktreeContainers[worktreePath]` after container and
  host worktree cleanup both succeed.
- force host deletion after container cleanup failure: keep persisted metadata so
  restart still routes cleanup/recovery toward Docker.

Use one main-process helper, e.g. `persistWorktreeContainerMetadata(path,
metadata)`, so creation, recovery, and deletion do not each rewrite config
differently.

### Worktrees slice

Add optional metadata to `Worktree`:

```ts
container?: {
  id: string
  name: string
  image: string
  workdir: string
  shell: string
  status: 'starting' | 'running' | 'stopped' | 'error'
  error?: string
}
```

Add targeted update event:

```ts
{
  type: 'worktrees/containerUpdated';
  payload: { path: string; container?: WorktreeContainerMetadata };
}
```

Use it for create success, boot recovery, stopped/error updates, and deletion
cleanup instead of replacing full worktree list for status-only changes.

### Root state and wire compatibility

Wire both new state surfaces explicitly:

- add settings event to `StateEvent`.
- route `settings/enableWorktreeContainersChanged` through `rootReducer`.
- route `worktrees/containerUpdated` through `rootReducer`.
- keep `initialState.settings.enableWorktreeContainers` defaulted to `false`.
- update `mergeWireSnapshot` so old server snapshots backfill missing setting and
  missing `Worktree.container` safely.

## Main-process integration contracts

### Settings request handler

Add backend method:

```ts
setEnableWorktreeContainers(enabled: boolean): Promise<boolean>
```

Canonical request name: `config:setEnableWorktreeContainers`.

Handler pattern:

1. validate boolean.
2. persist to config.
3. dispatch settings event.
4. return true.

### WorktreesFSM

Add option:

```ts
getEnableWorktreeContainers: () => boolean
```

Inject container step after host worktree exists and before setup script runs.
`finishCreate()` receives optional container context and chooses setup executor.

### Container manager package

Create package:

```text
src/main/worktree-containers/
├── index.ts
├── worktree-containers.ts
├── types.ts
└── worktree-containers.test.ts
```

Keep Docker calls isolated here. Other modules should not shell out to Docker.

Responsibilities:

- check Docker CLI availability.
- resolve repo container config.
- build image when Dockerfile configured.
- inspect/pull image when configured/default image is not local.
- create/start container with labels, mounts, env, ports.
- run commands inside container.
- stop/remove container on worktree delete.
- inspect/recover container status on boot.

### Docker runner

Docker calls go through injected runner:

```ts
type DockerRunner = {
  run(args: string[], opts?: {
    cwd?: string
    env?: Record<string, string>
    timeoutMs?: number
    onOutput?: (chunk: string) => void
  }): Promise<{ stdout: string; stderr: string; exitCode: number }>
}
```

Rules:

- Never invoke shell for Docker commands; pass argv arrays.
- Classify spawn `ENOENT` as Docker CLI missing.
- Classify `docker version` nonzero as Docker daemon unavailable.
- Preserve stdout/stderr for setup logs and pending error messages.
- Tests inject fake runner; no tests require real Docker daemon.

### Setup executor

Use one executor contract for host and container setup:

```ts
type WorktreeCommandExecutor = {
  run(command: string, opts: {
    cwd: string
    env?: Record<string, string>
    onOutput?: (chunk: string) => void
  }): Promise<{ ok: boolean; exitCode: number }>
}
```

Host executor preserves current setup behavior. Container executor runs:

```text
docker exec --workdir <workdir> <container> <shell> -lc <setup-command>
```

`onOutput` feeds existing setup logs so pending-worktree UI keeps working.

### PTY and agent command routing

Renderer continues to send host `cwd`. Main resolves that path to a worktree and
checks `Worktree.container`.

Resolver contract:

```ts
type WorktreeContainerResolver = (hostCwd: string) => WorktreeContainerResolution

type WorktreeContainerResolution =
  | { kind: 'host' }
  | { kind: 'container'; worktreePath: string; container: WorktreeContainerMetadata }
  | { kind: 'container-error'; message: string }
```

Resolution rules:

- normalize `hostCwd` with realpath when possible.
- choose longest worktree path prefix so nested repos do not match wrong worktree.
- if matched worktree has no `container`, return `host`.
- if matched worktree has persisted metadata but Docker is unavailable, return
  `container-error`, not `host`.
- pure helper maps terminal/command/agent args to final Docker argv for unit tests.

Command mapping:

- interactive terminal: `docker exec -it --workdir <workdir> <container> <shell>`.
- explicit command/args: `docker exec -it --workdir <workdir> <container> <command> ...args`.
- shell command: `docker exec -it --workdir <workdir> <container> <shell> -lc <command>`.
- agent pane: preserve requested command and args, but route through Docker.
- pass `HARNESS_TERMINAL_ID`, `CLAUDE_HARNESS_ID`, `TERM`, and `COLORTERM` via
  `docker exec -e`.

Do not fall back to host execution when containerized agent command or shell is
missing.

### Hooks and status events

Keep hook installation and status watching host-side. Containerized worktrees see
hook files through `/workspace` mount.

Mount status directory into containers:

```text
--mount type=bind,source=/tmp/harness-status,target=/tmp/harness-status
```

Agent hooks continue writing NDJSON to `/tmp/harness-status/<terminal-id>.ndjson`.
Existing host watcher remains unchanged.

### Deletion force semantics

Default containerized delete order:

1. run teardown inside container if configured and container is running.
2. stop container.
3. remove container.
4. remove host worktree.

If stop/remove fails, block host worktree deletion and show pending deletion
error. `force: true` may remove host worktree anyway, but must warn that orphan
container may remain. Force does not imply `docker rm -f`; that requires separate
explicit container cleanup request.

Container status transitions:

| Trigger | Previous | Next | Persistence |
|---|---|---|---|
| create start | none | `starting` | no config write yet |
| docker run success | `starting` | `running` | write metadata |
| docker run failure | `starting` | `error` | no metadata unless container id exists |
| setup failure after run | `running` | `running` | keep metadata |
| boot inspect running | any persisted | `running` | shared state only |
| boot inspect exited | any persisted | `stopped` | shared state only |
| boot Docker unavailable | any persisted | `error` | keep metadata |
| terminal opens stopped container | `stopped` | `stopped` | shared state only |
| delete start | `running`/`stopped` | existing status | keep metadata |
| delete success | any | none | remove metadata |
| delete container cleanup failure | any | `error` | keep metadata |

## Docker command shape

### Create/start

Image path:

```text
docker run -d \
  --name <name> \
  --label tatsu.worktree.id=<id> \
  --label tatsu.worktree.path=<path> \
  --label tatsu.repo.root=<repo-root> \
  --workdir /workspace \
  --mount type=bind,source=<host-worktree>,target=/workspace \
  <env args> \
  <port args> \
  <image> \
  tail -f /dev/null
```

Dockerfile path:

```text
docker build -t <tag> -f <dockerfile> --build-arg WORKDIR=<workdir> <context>
docker run ... <tag> tail -f /dev/null
```

For image configs, run `docker inspect --type=image <image>` first. If missing, run
`docker pull <image>` before `docker run`. Dockerfile builds skip pull.

### Exec command

```text
docker exec -it --workdir /workspace <container> <shell>
```

Non-interactive setup:

```text
docker exec --workdir /workspace <container> <shell> -c <setup-command>
```

## Port strategy

First slice supports repo-configured static ports only.

Auto-port allocation is deferred because it needs discoverable UI/state. If two
worktrees map same host port, Docker fails with clear error and user fixes
config.

## Security and validation

- Mounting repo into container lets container modify source files. Expected.
- Mounting Docker socket into container is forbidden by default.
- Mounting host agent credentials is explicit opt-in only.
- Env vars from host are not wholesale forwarded.
- Container names/labels sanitize repo and branch names.

Concrete validation rules:

- container name slug: lowercase ASCII letters, digits, and `-`; replace
  all other chars with `-`; collapse repeated `-`; trim to 63 chars; append
  short hash.
- label values can keep full repo/worktree paths, but reject NUL and newline.
- `tatsu.worktree.id` is `sha256(<absolute worktree path>).slice(0, 12)`.
- resolve relative volume sources from repo root, then realpath.
- reject paths outside repo root unless explicitly absolute and allowed.
- reject extra volume targets `/`, `/workspace`, `/proc`, `/sys`, `/dev`,
  `/var/run/docker.sock`, and descendants of `/var/run/docker.sock`.
- reject symlink-resolved sources pointing to Docker socket, home directory, SSH
  agent socket, git credential files, or cloud credential directories unless
  explicit allowlist is added.
- reject env keys that do not match `^[A-Za-z_][A-Za-z0-9_]*$`.

Default mounts:

- host worktree read-write at `/workspace`.
- `/tmp/harness-status` read-write at `/tmp/harness-status`.

Pass only:

- configured `container.env`.
- `HARNESS_TERMINAL_ID`.
- `CLAUDE_HARNESS_ID`.
- minimal terminal vars if needed: `TERM`, `COLORTERM`.

## Resolved decisions

1. Default image: `node:20-alpine`; no
   Harness-owned image first slice.
2. Agent credentials: repo-config opt-in with `shareAgentConfig: true`; no
   Settings UI toggle first slice.
3. Existing worktrees: defer manual “containerize existing worktree” action.
4. Ports: static repo-config ports first; defer automatic allocation and port UI.
5. Docker Compose: defer. Future shape can be `container.compose`; first slice
   uses one long-lived container per worktree.

## Full verification set

Automated:

```text
pnpm typecheck
pnpm build
npx vitest run src/shared/state/settings src/shared/state/wire-merge.test.ts src/main/build-initial-state src/main/repo-config src/main/worktree-containers src/main/worktrees-fsm src/main/worktree-deletion-fsm
```

Manual happy path:

1. Start app with Docker running.
2. Enable setting.
3. Create worktree.
4. Confirm host worktree exists.
5. Confirm Docker container exists with labels.
6. Open terminal; `pwd` returns `/workspace`.
7. Create file in terminal; host worktree sees it.
8. Delete worktree; container removed.
9. Disable setting; create worktree; no container created.

Manual failure paths:

1. Docker CLI missing or not on PATH: actionable pending error.
2. Docker daemon stopped: pending error says daemon unavailable.
3. Bad Dockerfile/image: pending error includes build/pull failure.
4. Container stopped before opening terminal: terminal reports not running and
   suggests restart/recreate.
5. Container removal failure during delete: host worktree remains and pending
   deletion shows failure.

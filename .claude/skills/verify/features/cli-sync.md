# CLI sync (`tatsu config ls`, `tatsu sync status`, `tatsu sync plan`)

`tatsu config ls` lists the agents, skills and commands Tatsu sees, one block per scope (harness × resource type). It calls `harnessConfig:scan({scope})` once per scope, one call after another. The scopes come from the shared agent registry: the supported capabilities of `claude`, `codex` and `opencode`, in registry order. The CLI never reads harness files itself.

`tatsu sync status` calls `harnessConfig:compare({scope})` per scope in the same order, and `tatsu sync plan` calls `harnessConfig:planSyncToDisk({scope})` (or `{scope, detach}`) for exactly one scope. Neither writes anything. Ticket 03 (`sync apply`) adds its steps to this file. They reuse the preconditions and the `control.mjs` shim below.

## Sub-features

- `ls-json`: `config ls [--agent] [--type] --json` prints `[{scope:{agentKind,resourceType}, resources: HarnessConfigFileRef[]}]` and exits 0.
- `ls-human`: one header per scope (`Claude Code · skills`), then a row per resource with the label, the relative path and the flags (`template` when `templateRef` is set, `linked` when `linkedFrom` is set). A scope with no resources prints `  (none)`. Scopes are separated by a blank line.
- `ls-filters`: with `--agent` alone or `--type` alone, unsupported pairs are skipped (`--type commands` covers claude and opencode, not codex). All of the following exit 2 with code `usage` before the CLI connects:
  - an unknown value (`--agent nope`, `--type hooks`);
  - an explicitly unsupported pair (`--agent codex --type commands` gives `Codex does not support commands`);
  - a filter that leaves zero scopes (`--agent pi` gives `Pi has no supported config scopes`).
- `envelope`: the CLI unwraps every `harnessConfig:*` reply (`{ok:true,value}` or `{ok:false,error:{code,message,applied?}}`) with `hcRequest` in `src/cli/harness-config`. Error codes map to exit codes as follows:
  - `invalid-request`, `unsupported-scope` and `invalid-name` map to `usage` (exit 2);
  - `unknown-plan`, `stale-plan` and `unconfirmed-plan` map to `command-failed` (exit 1), and the message adds the hint to re-run `tatsu sync plan`;
  - `unknown-resource` maps to `usage` only when `--detach` was passed;
  - every other code maps to `command-failed`.

  `details` is `{code, applied?}`. A malformed reply is `request-failed` (exit 1).

- `status-human`: a table with the columns SCOPE, STATUS, NOT ON DISK (`configOnly.length`), CHANGED (`changed.length`) and NOTES (`N render errors, N fragment errors, N fragment edits`, empty when there are none). `--json` prints `HarnessConfigComparison[]`.
- `status-check`: `sync status --check` exits 1 (`command-failed`, `N scopes out of sync`, singular for 1) after printing the table (or the JSON) when any scope is not `synced`; it exits 0 when all are. Without `--check` the command exits 0 whatever the status.
- `plan`: `sync plan --agent <k> --type <t> [--detach <id>...]`. Both `--agent` and `--type` are required (exit 2 before connecting otherwise). The human output starts with `Plan <planId> · <scope>` and then takes one of three shapes (`classifyPlan` in `src/cli/commands/sync`):
  - writes (`configOnly + changed + detach > 0`): `Not on disk:`, `Content changed:` (template-built rows add `[template <templateRef>]` and the id to pass to `--detach`; ids being detached are listed only under `Detach:`, since the backend keeps them in `changed` but never overwrites them), `Detach:`, any issue sections, and `Apply with: tatsu sync apply --agent <k> --type <t> --plan <planId> --yes`;
  - no writes but issues: the issue sections (`Render errors:`, `Fragment errors:`, `Fragment edits:`) and `Nothing to write; N issues need attention.`;
  - neither: `Already in sync.`

  `sync plan` exits 0 whenever the request succeeds, issues or not. `--json` prints the `HarnessConfigSyncPlan`. A `--detach` id the backend rejects (`unknown-resource`) exits 2.

## How to get to it (user POV)

- From a shell: `pnpm tatsu config ls [--agent claude|codex|opencode] [--type agents|skills|commands] [--json]`. This runs `node dist-headless/cli/index.js`. Likewise `pnpm tatsu sync status [--agent] [--type] [--check] [--json]` and `pnpm tatsu sync plan --agent <k> --type <t> [--detach <id>...] [--json]`.
- The CLI finds the backend the same way as `tatsu status` (see [cli-status.md](cli-status.md)).

## Driving it

Preconditions:

- `pnpm build:headless` has run since the last source change. It builds the CLI too.
- Run `STATE=$(.claude/skills/verify/scripts/launch.sh --build clisync1 | tail -1)`. Then `.claude/skills/verify/scripts/doctor.sh "$STATE"` must print only `ok` lines. `launch.sh` runs `seed.sh`, so the sandbox HOME already holds the fixtures listed under "Seeded fixtures".
- Register `trap '.claude/skills/verify/scripts/cleanup.sh "$STATE"' EXIT` before the first CLI call, so cleanup also runs after a failure.
- Set up the shell:
  - `. "$STATE"; TOKEN="${URL##*token=}"; ROOT="$PWD"`
  - `CLI() { env -u TATSU_ENDPOINT_FILE -u TATSU_URL -u TATSU_TOKEN HARNESS_DATA_DIR="$DATA_DIR" HOME="$SANDBOX_HOME" node "$ROOT/dist-headless/cli/index.js" "$@"; }`

### The `control.mjs` shim (raw requests against the `launch.sh` server)

`control.mjs` drives any instance whose run dir holds an `instance.json` with `port` and `token`. Write the shim under `$SCRATCH`, so cleanup removes the shim and its token too:

```bash
mkdir -p "$SCRATCH/ctl"
node -e 'const [pid,port,token,url,data,log,out]=process.argv.slice(1);require("fs").writeFileSync(out,JSON.stringify({pid:+pid,port:+port,token,url,data,log}))' \
  "$PID" "$PORT" "$TOKEN" "$URL" "$DATA_DIR" "$LOG" "$SCRATCH/ctl/instance.json"
export TATSU_VERIFY_RUN="$SCRATCH/ctl"; C="$ROOT/.claude/skills/verify/scripts/control.mjs"
node $C req harnessConfig:scan '{"scope":{"agentKind":"claude","resourceType":"skills"}}'
# {"ok":true,"value":{"resources":[...hello, linked-skill (linkedFrom set)...],"scannedAt":...}}
```

`req` sends each JSON argument as one request arg, so the payload is the single `{scope}` object that the handler expects. The handler rejects any extra key with `invalid-request`. The sync tickets seed templates the same way, for example `node $C req harnessConfig:saveTemplate '{...,"confirmed":true}'`. Never run `control.mjs stop` against the shim; tear down with `cleanup.sh`.

### Seeded fixtures (from `seed.sh`)

| Scope | Resources |
|---|---|
| Claude Code · agents | `reviewer` (`reviewer.md`) |
| Claude Code · skills | `hello`, `linked-skill` (symlink into `$SCRATCH/dotfiles`, `linked`) |
| Claude Code · commands | `hello`, `linked-skill` (skill aliases), `run-tests` |
| Codex · agents | none |
| Codex · skills | `hello` (`~/.agents/skills`) |
| Opencode · agents | none |
| Opencode · skills | `release-notes` |
| Opencode · commands | `run-tests` |

### `config ls` steps

- **Raw envelope.** The shim's `harnessConfig:scan` returns `ok: true` with value keys `resources` and `scannedAt`. `linked-skill` has `linkedFrom` set to `/private/var/.../dotfiles/skills/linked-skill`.
- **JSON.** `CLI config ls --agent claude --type skills --json` exits 0. It prints one scope, `{agentKind:"claude",resourceType:"skills"}`, with resources `hello` and `linked-skill`, and `linked-skill` carries `linkedFrom`.
- **Human.** `CLI config ls --agent claude --type skills` exits 0 and prints:
  ```
  Claude Code · skills
    hello         hello/SKILL.md
    linked-skill  linked-skill/SKILL.md  linked
  ```
- **Unfiltered.** `CLI config ls` exits 0 and prints 8 blocks in registry order, matching the seeded fixtures table.
- **Single-axis filter.** `CLI config ls --type commands` exits 0 and prints only `Claude Code · commands` and `Opencode · commands`.
- **Zero scopes.** `CLI config ls --agent pi` exits 2 with `tatsu: Pi has no supported config scopes`. With `--json`, stderr is `{"error":{"code":"usage","message":"Pi has no supported config scopes","details":null}}`.
- **Explicitly unsupported.** `CLI config ls --agent codex --type commands` exits 2 with `tatsu: Codex does not support commands`.
- **Unknown values.** `--agent nope` and `--type hooks` exit 2 and name the allowed values. An extra positional argument exits 2.
- **Teardown.** `cleanup.sh "$STATE"` (the trap runs it) prints `real harness roots unchanged`.

Last run: ticket sync-01 (tatsu-cli/sync-01-config-ls). Every `config ls` step above passed, the shim was included, and cleanup printed `real harness roots unchanged`.

### `sync status` and `sync plan` steps

Same preconditions and shim as above (`launch.sh --build clisync2`).

- **Baseline.** `CLI sync status --check` exits 0, and every one of the 8 scopes is `synced` with `0` / `0`.
- **Seed `greet`.** Send exactly:
  ```bash
  node $C req harnessConfig:saveTemplate '{"template":{"kind":"skill","name":"greet","description":"Greet the user.","fragments":[],"body":"Say hi.","harnesses":{"claude":{"frontmatter":{}}},"references":[]},"confirmed":true}'
  ```
  It returns `ok: true` with `relativePath: "skills/greet/TEMPLATE.md"`.
- **Drift check.** `CLI sync status --check` prints the table and exits 1 with `tatsu: 2 scopes out of sync`. Both `Claude Code · skills` and `Claude Code · commands` are `config-only` with NOT ON DISK `1`, because Claude skills alias into commands (see Gotchas). Everything else stays `synced`.
- **Human status.** `CLI sync status` prints the same table and exits 0.
- **Plan JSON.** `CLI sync plan --agent claude --type skills --json` exits 0. `status` is `config-only`, `configOnly` holds one ref with `label: "greet"`, `relativePath: "greet/SKILL.md"`, and `planId` is a UUID.
- **Plan human.** `CLI sync plan --agent claude --type skills` exits 0 and prints:
  ```
  Plan <uuid> · Claude Code · skills

  Not on disk:
    greet/SKILL.md

  Apply with: tatsu sync apply --agent claude --type skills --plan <uuid> --yes
  ```
  Each call makes a fresh `planId`.
- **Missing `--type`.** `CLI sync plan --agent claude` exits 2 with `tatsu: sync plan needs both --agent and --type. ...`.
- **Bad detach id.** `CLI sync plan --agent claude --type skills --detach nope` exits 2 with `tatsu: Only template-built files that exist on disk can be detached`. With `--json`, `details` is `{"code":"unknown-resource"}`.
- **Nothing applied.** Before cleanup, `test ! -e "$SANDBOX_HOME/.claude/skills/greet"` passes. Check it before the trap runs `cleanup.sh`, because cleanup removes the sandbox.
- **Teardown.** `cleanup.sh` prints `real harness roots unchanged`.

Last run: ticket sync-02 (tatsu-cli/sync-02-status-plan). Every step above passed; the baseline was all `synced`, so the risk mitigation (narrowing `--check` to `--agent claude`) was not needed.

## Gotchas

- Claude skills also appear under `Claude Code · commands`, because the registry gives Claude skills `aliasResourceTypes: ['commands']`. This is expected, and it means a Claude skill template drifts two scopes in `sync status`: seeding `greet` makes `--check` report `2 scopes out of sync`, and `sync plan --agent claude --type commands` also lists `greet/SKILL.md`. The ref's `resourceType` is `commands` and its `canonicalResourceType` is `skills`. The CLI does not flag aliases.
- `absolutePath` in the JSON uses the `/var/...` spelling of `$SANDBOX_HOME`, but `linkedFrom` is a realpath (`/private/var/...`).
- Every `harnessConfig:scan` also dispatches `harnessConfig/resourcesLoaded`, so an open Config page refreshes after a `config ls`. A failing `harnessConfig:*` call sets `harnessConfig/errorChanged`, which shows the error in an open Config page.
- Run the binary with `node`, not `pnpm -s tatsu`, because `pnpm -s` turns every non-zero exit into 1.
- Before saving a transcript, redact the 64-hex token with `sed -E 's/[a-f0-9]{64}/<redacted>/g'`. This also blanks resource `id` and `hash` values.
- Inside a Tatsu terminal, `TATSU_ENDPOINT_FILE` points at your real backend. The `CLI` function unsets it.

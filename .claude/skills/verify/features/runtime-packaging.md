# Bundled runtimes and first-use download

The desktop app ships the Claude native binary and the codex-acp bridge inside `Contents/Resources/runtimes`, and downloads the OpenCode and Codex natives the first time a user opens a chat tab for them, verifying each tarball against the hash from `pnpm-lock.yaml`. The chat shows a download card with the size and progress until the runtime is ready.

## Sub-features

- `pack-staged` a packaged app has `runtimes/` with the Claude native and codex-acp, and `claude --version` runs from there.
- `pack-no-asar-natives` no agent runtime package is in `asarUnpack`.
- `download-manifest` `resources/runtime-manifest.json` covers four platforms with sha512 hashes from the lockfile.
- `download-boot` the manifest's tarballs download, verify, extract, and boot OpenCode and codex-acp.
- `download-card` the chat shows `missing` → `downloading` → `ready` in the `runtimes` slice and disables the composer until ready.

## How to get to it (user POV)

- Install the DMG, open a chat tab for OpenCode or Codex; the download card appears above the composer.
- Settings → the OpenCode or Codex "Interface" toggle set to Chat.

## Driving it with control.mjs

Preconditions:

- `pnpm install` is current on this worktree and about 2 GB of disk is free for `--pack`.
- Network access to registry.npmjs.org for `--all`.

- **Static.** Run `bash .claude/skills/verify/scripts/gate.sh`. The `static invariants` stage prints `ok` for the asarUnpack, afterPack, manifest-gitignored, and manifest-regenerates lines.
- **Packaged app.** Run `bash .claude/skills/verify/scripts/gate.sh --pack`. The `pack + desktop runtime smoke` stage passes and `ls release/mac-arm64/*.app/Contents/Resources/runtimes/node_modules/@anthropic-ai` lists `claude-agent-sdk-darwin-arm64`; copy that listing into `$RUN/artifacts/runtimes-listing.txt`.
- **Download path.** Run `bash .claude/skills/verify/scripts/gate.sh --all`. The `first-use download smoke` stage logs `opencode: verified sha512-…`, `opencode: booted`, `codex: verified`, `codex: booted`.
- **Runtime status.** In the headless run, read the slice. Run `node $C get runtimes.byAgent --save runtimes-status`. Both agents report `state: "bundled"` because dev and headless resolve the natives from `node_modules`.
- **Download card.** Needs a packaged build installed and launched with a fresh user data dir. Open an OpenCode chat tab; the card shows the size from the manifest, `runtimes:download opencode` moves the slice through `downloading` with `receivedBytes` increasing to `ready`, and `~/Library/Application Support/<app>/runtimes/opencode-darwin-arm64@<ver>/.ok` exists afterwards.
- **Proof.** The gate's log dir, `runtimes-listing.txt`, `runtimes-status.json`, and for the card a screenshot of the Ready state plus the `.ok` path.

## Gotchas

- `pnpm pack` is pnpm's tarball command; the packaging script is `pnpm run pack`.
- The headless server can never show `missing` or `downloading`; the download card can only be driven in a packaged desktop build. Report `download-card` as not run when no build is installed.
- The manifest is gitignored and regenerated at the start of `pnpm build`. A bumped runtime version without `pnpm install` fails the manifest stage with `no integrity for … (no such entry)`.
- A signed and notarized build has not yet shipped with this layout; `mac.binaries` is set by the afterPack hook, so the first `build-mac.yml` run is where signing of the staged Mach-O files is proved.

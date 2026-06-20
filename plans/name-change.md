# Name change plan

## Goal

Rename app-name references from `Harness` / `harness` to `Tatsu` / `tatsu` without changing generic uses of “harness” that mean an agent harness or execution harness.

## Non-goals

- Do not blanket-replace every `harness` string.
- Do not rewrite product docs where `harness` means a generic agent harness.
- Do not break existing installs by removing old runtime names without compatibility.
- Do not rename internal state fields/events in the first pass unless needed for user-visible output.

## Classification rule

Rename when `harness` refers to this app, its website, its repo, its binaries, its config, or its branded integrations.

Leave unchanged when `harness` refers to a generic class of agent tools, CLI harnesses, testing harnesses, or architecture vocabulary.

## Phase 1 — product-facing copy

Mechanical user-visible copy rename. Low compatibility risk.

### App shell and renderer

- `src/renderer/index.html`: title
- `src/web-client/index.html`: title/loading copy
- `src/web-client/public/manifest.webmanifest`: PWA name/short name
- `src/renderer/App/App.tsx`: onboarding, title, hook banner, update copy
- `src/renderer/components/Settings/Settings.tsx`: settings labels, help text, update text, GitHub star copy
- `src/renderer/components/TerminalPanel/TerminalPanel.tsx`: title bar label
- `src/renderer/components/Guide/Guide.tsx`: guide copy
- `src/renderer/components/QuestCard/QuestCard.tsx`: quest copy
- `src/renderer/components/ReportIssueScreen/ReportIssueScreen.tsx`: issue template copy
- `src/renderer/components/ActivityCosts/ActivityCosts.tsx`: share/footer copy
- `src/renderer/components/WeeklyWrappedScreen/WeeklyWrappedScreen.tsx`: share/footer copy
- `src/renderer/components/PRStatusPanel/PRStatusPanel.tsx`: empty-state copy
- `src/renderer/themes/themes.ts`: theme description copy

### Main process user-facing strings

- `src/main/desktop-shell/desktop-shell.ts`: dialog titles and dev userData display name
- `src/main/control-server/control-server.ts`: user-facing error messages
- `src/main/github/github.ts` and `src/main/github-auth/github-auth.ts`: `User-Agent`
- `src/main/persistence/constants.ts`: default system prompt text, keeping MCP tool names unchanged in this phase
- `resources/mcp-bridge.js`: descriptions that say “Harness-managed” or “managed by Harness”, keeping tool/protocol names unchanged

### Verification

- Search `\bHarness\b` and review remaining hits manually.
- Run `pnpm typecheck`.
- Run `pnpm build`.

## Phase 2 — website, README, release surfaces

Rename public-facing docs and site assets once target URLs/repo names are known.

### Files

- `README.md`
- `site/index.html`
- `site/src/components/*`
- `site/public/guide.html`
- `site/public/announcements.html`
- `site/public/announcements.json`
- `site/public/announcements/*`
- `site/public/releases.html`
- `site/og-build/*`
- `site/public/CNAME`
- `scripts/release.sh`
- `.github/workflows/*`

### Decisions needed before implementation

- New production domain: current value is `harness.mikelyons.org`.
- New GitHub repo owner/name: current constants point at `frenchie4111/harness`.
- Whether old release notes keep historical “Harness” language or get rewritten to “Tatsu”. Recommended: current marketing copy becomes Tatsu, historical changelog entries may remain Harness if describing old releases.

### Verification

- `pnpm build:site`
- Link check for repo/release/download URLs.

## Phase 3 — package and app identity

Rename build/distribution identity. Medium risk because package names, app IDs, updater metadata, install paths, and userData paths can change.

### Files

- `package.json`
  - `name`: `harness` → `tatsu`
  - `description`
  - `build.appId`: decide new bundle id, e.g. `org.mikelyons.tatsu`
  - `build.productName`: `Tatsu`
  - Linux artifact name: `Tatsu-${version}.${ext}`
  - GitHub publish repo
- `scripts/release.sh`
- `scripts/pack-headless.mjs`
- `.github/workflows/build-linux.yml`
- `.github/workflows/build-mac.yml`
- `.github/workflows/headless-release.yml`
- `.github/workflows/release.yml`

### Migration notes

- Changing Electron `appId` can create a separate app identity.
- Changing `productName` can change app bundle name and user-facing install name.
- Decide whether production userData moves from old path to new path or old path remains for continuity.
- If moving userData, add one-time migration from old path to new path before changing defaults.

### Verification

- `pnpm typecheck`
- `pnpm build`
- `pnpm pack`
- Inspect generated artifact names.

## Phase 4 — branded runtime contracts with compatibility

Rename app-branded protocols only with backward-compatible aliases. Highest compatibility risk.

### Headless binary and data dir

Current names:

- `harness-server`
- `HARNESS_DATA_DIR`
- `HARNESS_WS_HOST`
- `HARNESS_WS_PORT`
- `~/.harness`

Target names:

- `tatsu-server`
- `TATSU_DATA_DIR`
- `TATSU_WS_HOST`
- `TATSU_WS_PORT`
- `~/.tatsu`

Plan:

1. Add `TATSU_*` env vars and prefer them.
2. Keep `HARNESS_*` env vars as deprecated aliases.
3. Package `tatsu-server` binary/symlink.
4. Optionally keep `harness-server` symlink for one or more releases.
5. Add userData migration or fallback read from `~/.harness`.

### MCP server and tools

Current names:

- `harness-control`
- `mcp__harness-control__create_worktree`
- `mcp__harness-control__list_worktrees`
- `resources/mcp-bridge.js` stderr prefix `harness-mcp`

Target names:

- `tatsu-control`
- `mcp__tatsu-control__create_worktree`
- `mcp__tatsu-control__list_worktrees`

Plan:

1. Register `tatsu-control` as primary MCP server.
2. Keep accepting/displaying `harness-control` tool names for old sessions.
3. Update renderer pretty-name logic to support both prefixes.
4. Update permission pattern tests for both old and new prefixes.
5. Update default system prompt to mention `tatsu-control` while noting old `harness-control` compatibility only if needed.

### Repo config

Current name:

- `.harness.json`

Target name:

- `.tatsu.json`

Plan:

1. Read `.tatsu.json` first.
2. Fall back to `.harness.json`.
3. Write `.tatsu.json` for new changes.
4. Show migration note in Settings if old file is loaded.
5. Add tests for fallback and write behavior.

### Status hooks and env vars

Current names:

- `/tmp/harness-status`
- `HARNESS_TERMINAL_ID`
- `CLAUDE_HARNESS_ID`
- `HARNESS_WORKTREE_PATH`
- `HARNESS_BRANCH`
- `HARNESS_REPO_ROOT`
- `HARNESS_PLAYWRIGHT_BROWSER`

Target names:

- `/tmp/tatsu-status`
- `TATSU_TERMINAL_ID`
- `TATSU_WORKTREE_PATH`
- `TATSU_BRANCH`
- `TATSU_REPO_ROOT`
- `TATSU_PLAYWRIGHT_BROWSER`

Plan:

1. Emit both old and new env vars from spawned sessions for one or more releases.
2. Watch both old and new status directories.
3. Install new hook commands that write to `/tmp/tatsu-status`.
4. Keep uninstall logic able to remove old Harness-marked hooks.
5. Keep `CLAUDE_HARNESS_ID` as legacy fallback only.

### Preload globals and localStorage

Current names:

- `__harness_local_transport`
- `__harness_electron_helpers`
- `__HARNESS_WEB__`
- `__HARNESS_PLATFORM__`
- `harness:sidebarWidth`, `harness:rightPanelWidth`, etc.

Target names:

- `__tatsu_local_transport`
- `__tatsu_electron_helpers`
- `__TATSU_WEB__`
- `__TATSU_PLATFORM__`
- `tatsu:*`

Plan:

1. Expose both old and new globals from preload.
2. Renderer reads new key first, old key fallback.
3. On write, write new localStorage key.
4. Optionally copy old localStorage values to new keys on first boot.
5. Remove old globals only after compatibility window.

### Verification

- `pnpm typecheck`
- `pnpm build`
- `npx vitest run`
- `pnpm build:headless && bash scripts/smoke-headless.sh`
- Manual test: existing config with old `.harness.json`, old env vars, and old hooks still works.

## Phase 5 — internal identifier cleanup

Rename internal code symbols after external behavior is stable.

Candidates:

- `harnessMcpEnabled` → `tatsuMcpEnabled`
- `harnessSystemPrompt` → `tatsuSystemPrompt`
- `harnessSystemPromptMain` → `tatsuSystemPromptMain`
- `harnessStarred` → `tatsuStarred`
- `setHarnessMcpEnabled` → `setTatsuMcpEnabled`
- `settings/harnessMcpEnabledChanged` → `settings/tatsuMcpEnabledChanged`
- `DEFAULT_HARNESS_SYSTEM_PROMPT` → `DEFAULT_TATSU_SYSTEM_PROMPT`
- `HARNESS_REPO_URL` → `TATSU_REPO_URL`
- `harnessReleaseNotesUrl` → `tatsuReleaseNotesUrl`

Plan:

1. Rename TypeScript symbols mechanically.
2. Add persistence migration for config fields if persisted names change.
3. Add wire-snapshot compatibility for old state event/snapshot names if needed.
4. Update reducer tests and persistence migration tests.

Verification:

- `pnpm typecheck`
- `pnpm build`
- `npx vitest run src/shared/state/settings src/main/persistence-migrations`

## Search checklist

Use these searches after each phase:

```sh
rg -n "\\bHarness\\b" src site README.md package.json scripts resources .github
rg -n "harness\\.mikelyons\\.org|frenchie4111/harness" .
rg -n "harness-server|harness-control|\\.harness\\b|~/.harness|/tmp/harness-status" .
rg -n "HARNESS_|__HARNESS|__harness|harness:" src scripts resources package.json .github
```

Every remaining hit should be classified as one of:

- Generic “agent harness” language — leave.
- Historical compatibility alias — leave with comment/test.
- Migration fallback — leave with test.
- Missed app-name reference — rename.

## Suggested commit split

1. `Rename user-facing product copy to Tatsu`
2. `Update website and README branding for Tatsu`
3. `Update package identity for Tatsu`
4. `Add Tatsu runtime names with Harness compatibility`
5. `Rename internal Harness identifiers to Tatsu`

## Follow Ups

- Update production domain from `harness.mikelyons.org` to new Tatsu domain once decided (affects `site/public/CNAME`, all site/README URL references, OG image URLs).
- Update GitHub repo references from `frenchie4111/harness` to new repo owner/name once decided (affects `scripts/release.sh`, `scripts/install-headless.sh`, README links, site components, package.json publish config).

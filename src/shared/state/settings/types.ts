import type { JsonClaudePermissionMode } from '../json-claude'

export interface WorktreeScripts {
  setup: string
  teardown: string
}

export type MergeStrategy = 'squash' | 'merge-commit' | 'fast-forward'
export type WorktreeBase = 'remote' | 'local'
export type WorktreeDetail = 'diff' | 'age' | 'pr' | 'none'

export type AgentKindSetting = 'claude' | 'codex' | 'opencode'

export type BrowserToolsMode = 'view' | 'full'

export type JsonModeChatDensity = 'compact' | 'comfy'

/** Five-step UI density. Controls the root `html` font-size so every
 *  `rem`-based unit (and therefore the entire `text-xs` / `text-sm` /
 *  `text-base` / `text-lg` scale and every `w-N` / `h-N` icon) shifts
 *  together. See SCALES below for the authoritative table — adding a
 *  sixth rung later is a one-line change there. */
export type UiScale = 'x-small' | 'small' | 'medium' | 'large' | 'x-large'

export interface UiScaleSpec {
  id: UiScale
  label: string
  rootPx: number
  /** Pixels added to the user's `terminalFontSize` so xterm stays in
   *  proportion with the rest of the UI. XTerminal and the Settings
   *  preview both read from this same table. */
  terminalOffset: number
}

export type ThemeMode = 'light' | 'dark' | 'system'

/** A theme loaded from `<userData>/themes/*.json`. Stays minimal — the
 *  loader only validates `name` + `mode` + an optional `colors` map of the
 *  16 semantic keys; missing keys inherit from the default of that mode at
 *  apply time. */
export interface CustomTheme {
  /** Derived from filename, sanitized to `[a-z0-9-]`. Unique across the
   *  set (collisions are dropped by the loader). */
  id: string
  /** Display label from the file's `name` field. */
  name: string
  mode: 'light' | 'dark'
  /** Partial map of semantic color keys → CSS color string. The loader
   *  doesn't enforce which keys are present — apply just sets whichever
   *  are listed. */
  colors: Record<string, string>
}

export interface SettingsState {
  /** Whether the active theme is the light theme, the dark theme, or follows
   *  the OS appearance. Default 'system'. */
  themeMode: ThemeMode
  /** Theme id used when `themeMode` resolves to 'light'. */
  themeLight: string
  /** Theme id used when `themeMode` resolves to 'dark'. */
  themeDark: string
  /** User-authored themes loaded from `<userData>/themes/*.json` at boot
   *  (and on reload). Replaced wholesale on rescan — array reference
   *  changes only when the on-disk contents actually change. */
  customThemes: CustomTheme[]
  hotkeys: Record<string, string> | null
  defaultAgent: AgentKindSetting
  claudeCommand: string
  codexCommand: string
  opencodeCommand: string
  worktreeScripts: WorktreeScripts
  claudeEnvVars: Record<string, string>
  codexEnvVars: Record<string, string>
  opencodeEnvVars: Record<string, string>
  harnessMcpEnabled: boolean
  nameClaudeSessions: boolean
  terminalFontFamily: string
  terminalFontSize: number
  editor: string
  worktreeBase: WorktreeBase
  mergeStrategy: MergeStrategy
  worktreeDetail: WorktreeDetail
  shareClaudeSettings: boolean
  claudeModel: string | null
  codexModel: string | null
  opencodeModel: string | null
  hasGithubToken: boolean
  githubAuthSource: 'pat' | 'gh-cli' | null
  /** GitHub login of the user whose token is configured. Resolved at
   *  boot via a /user call once the token is available. Used by the
   *  sidebar to bucket PRs you didn't author into the Reviewing group;
   *  null until resolved or when the token is missing/invalid. */
  viewerLogin: string | null
  harnessStarred: boolean | null
  autoUpdateEnabled: boolean
  harnessSystemPromptEnabled: boolean
  harnessSystemPrompt: string
  harnessSystemPromptMain: string
  claudeTuiFullscreen: boolean
  wsTransportEnabled: boolean
  wsTransportPort: number
  wsTransportHost: string
  browserToolsEnabled: boolean
  browserToolsMode: BrowserToolsMode
  /** Controls whether new Claude tabs spawn as the terminal-hosted TUI
   *  ('xterm') or the React chat interface ('json'). Internal values are
   *  unchanged; the user-facing label is "Terminal" / "Chat". */
  defaultClaudeTabType: 'xterm' | 'json'
  /** True once the user clicks the X on the "Switch to the new Chat
   *  mode" overlay shown on Terminal Claude tabs. Persistent so the
   *  promotion stays dismissed across reloads. */
  chatPromotionDismissed: boolean
  /** When true, JSON-mode tabs run a Haiku oneshot to auto-approve
   *  obviously-safe tool calls instead of prompting the user. Productivity
   *  feature only — an LLM judging another LLM is not a security boundary.
   *  A hardcoded deny-list catches the high-blast-radius cases (rm -rf,
   *  git push, web fetch, etc.) before Haiku is ever consulted. Default
   *  off. */
  autoApprovePermissions: boolean
  /** Optional project-specific guidance appended to the auto-approver's
   *  policy prompt (after the hardcoded safety preamble). Useful for
   *  per-project carve-outs like "approve `pnpm install` on this repo"
   *  or "be especially strict about Bash that writes outside src/".
   *  Empty by default — the base policy is what runs. Has no effect
   *  unless autoApprovePermissions is on. */
  autoApproveSteerInstructions: string
  /** Diagnostic toggle (no UI): when true, json-mode tabs spawn the user's
   *  PATH `claude` instead of the bundled one. Default off. */
  useSystemClaudeForJsonMode: boolean
  /** Visual density of the JSON-mode chat. 'compact' (default) keeps the
   *  power-user defaults; 'comfy' bumps font sizes, padding, and corner
   *  radius for newcomers / screen-sharing. Wired via CSS variables on
   *  the chat root, so it's a pure styling switch. */
  jsonModeChatDensity: JsonModeChatDensity
  /** Global UI density. Maps to a root `html` font-size — see SCALES. */
  uiScale: UiScale
  /** When true, plain Enter sends a message in the JSON-mode chat
   *  composer (Shift+Enter inserts a newline). When false (default),
   *  the historical behavior applies: Cmd/Ctrl+Enter sends and plain
   *  Enter inserts a newline. */
  jsonModeSendOnEnter: boolean
  /** Permission mode applied to a freshly-spawned json-mode session.
   *  Existing sessions keep whatever mode they were in (set via the
   *  statusline picker). Default 'acceptEdits' so first-time users
   *  don't get a wall of approval cards for routine edits; Bash and
   *  other risky tools still surface approvals. */
  jsonModeDefaultPermissionMode: JsonClaudePermissionMode
  /** Minutes a json-mode tab can sit at the yellow "waiting" dot before
   *  the auto-sleep monitor tears its subprocess down. The slept tab
   *  stays in the tree (history intact) and re-spawns on click. 0
   *  disables auto-sleep entirely. */
  autoSleepMinutes: number
  snoozeDefaultDays: number
  /** When true, high-volume diagnostic categories are written to
   *  debug.log — currently per-GitHub-API-call `[github-api]` lines (URL,
   *  method, status, duration). Off by default because the per-call
   *  volume is high during PR refresh bursts. HUD metrics like "GH API"
   *  rate are always on regardless of this flag. */
  expandedDiagnosticLoggingEnabled: boolean
  /** Default prompt pre-filled into the "Open PR as worktree" screen and
   *  used as the kickoff prompt when an MCP `create_worktree` call provides
   *  a `prNumber` without an explicit `initialPrompt`. The textarea on the
   *  PR-creation screen is seeded from this value but edits there are
   *  one-shot — managing the default happens in Settings. */
  prReviewPrompt: string
  /** Announcement ids the user has dismissed with the per-banner `×`.
   *  Used to filter the fetched feed down to the most recent unseen
   *  entry. Append-only — we never garbage-collect because entries fall
   *  out of the feed on their own once they expire. */
  dismissedAnnouncementIds: string[]
  /** When true, all announcement banners are suppressed regardless of
   *  the feed contents. Set by the "Hide all announcements" action and
   *  cleared only by the user. */
  announcementsMuted: boolean
}

export type SettingsEvent =
  | { type: 'settings/themeModeChanged'; payload: ThemeMode }
  | { type: 'settings/themeLightChanged'; payload: string }
  | { type: 'settings/themeDarkChanged'; payload: string }
  | { type: 'settings/customThemesChanged'; payload: CustomTheme[] }
  | { type: 'settings/hotkeysChanged'; payload: Record<string, string> | null }
  | { type: 'settings/defaultAgentChanged'; payload: AgentKindSetting }
  | { type: 'settings/claudeCommandChanged'; payload: string }
  | { type: 'settings/codexCommandChanged'; payload: string }
  | { type: 'settings/opencodeCommandChanged'; payload: string }
  | { type: 'settings/worktreeScriptsChanged'; payload: WorktreeScripts }
  | { type: 'settings/claudeEnvVarsChanged'; payload: Record<string, string> }
  | { type: 'settings/codexEnvVarsChanged'; payload: Record<string, string> }
  | { type: 'settings/opencodeEnvVarsChanged'; payload: Record<string, string> }
  | { type: 'settings/harnessMcpEnabledChanged'; payload: boolean }
  | { type: 'settings/nameClaudeSessionsChanged'; payload: boolean }
  | { type: 'settings/terminalFontFamilyChanged'; payload: string }
  | { type: 'settings/terminalFontSizeChanged'; payload: number }
  | { type: 'settings/editorChanged'; payload: string }
  | { type: 'settings/worktreeBaseChanged'; payload: WorktreeBase }
  | { type: 'settings/mergeStrategyChanged'; payload: MergeStrategy }
  | { type: 'settings/worktreeDetailChanged'; payload: WorktreeDetail }
  | { type: 'settings/shareClaudeSettingsChanged'; payload: boolean }
  | { type: 'settings/hasGithubTokenChanged'; payload: boolean }
  | { type: 'settings/githubAuthSourceChanged'; payload: 'pat' | 'gh-cli' | null }
  | { type: 'settings/viewerLoginChanged'; payload: string | null }
  | { type: 'settings/harnessStarredChanged'; payload: boolean | null }
  | { type: 'settings/claudeModelChanged'; payload: string | null }
  | { type: 'settings/codexModelChanged'; payload: string | null }
  | { type: 'settings/opencodeModelChanged'; payload: string | null }
  | { type: 'settings/autoUpdateEnabledChanged'; payload: boolean }
  | { type: 'settings/harnessSystemPromptEnabledChanged'; payload: boolean }
  | { type: 'settings/harnessSystemPromptChanged'; payload: string }
  | { type: 'settings/harnessSystemPromptMainChanged'; payload: string }
  | { type: 'settings/claudeTuiFullscreenChanged'; payload: boolean }
  | { type: 'settings/wsTransportEnabledChanged'; payload: boolean }
  | { type: 'settings/wsTransportPortChanged'; payload: number }
  | { type: 'settings/wsTransportHostChanged'; payload: string }
  | { type: 'settings/browserToolsEnabledChanged'; payload: boolean }
  | { type: 'settings/browserToolsModeChanged'; payload: BrowserToolsMode }
  | { type: 'settings/defaultClaudeTabTypeChanged'; payload: 'xterm' | 'json' }
  | { type: 'settings/chatPromotionDismissedChanged'; payload: boolean }
  | { type: 'settings/autoApprovePermissionsChanged'; payload: boolean }
  | { type: 'settings/autoApproveSteerInstructionsChanged'; payload: string }
  | { type: 'settings/useSystemClaudeForJsonModeChanged'; payload: boolean }
  | { type: 'settings/jsonModeChatDensityChanged'; payload: JsonModeChatDensity }
  | { type: 'settings/uiScaleChanged'; payload: UiScale }
  | { type: 'settings/jsonModeSendOnEnterChanged'; payload: boolean }
  | {
      type: 'settings/jsonModeDefaultPermissionModeChanged'
      payload: JsonClaudePermissionMode
    }
  | { type: 'settings/autoSleepMinutesChanged'; payload: number }
  | { type: 'settings/snoozeDefaultDaysChanged'; payload: number }
  | { type: 'settings/expandedDiagnosticLoggingEnabledChanged'; payload: boolean }
  | { type: 'settings/prReviewPromptChanged'; payload: string }
  | { type: 'settings/announcementDismissed'; payload: string }
  | { type: 'settings/announcementsMutedChanged'; payload: boolean }

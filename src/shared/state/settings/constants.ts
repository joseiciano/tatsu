import type { CustomTheme, SettingsState, UiScale, UiScaleSpec } from './types'

export const SCALES: readonly UiScaleSpec[] = [
  { id: 'x-small', label: 'X-Small', rootPx: 14, terminalOffset: -2 },
  { id: 'small', label: 'Small', rootPx: 16, terminalOffset: 0 },
  { id: 'medium', label: 'Medium', rootPx: 18, terminalOffset: 2 },
  { id: 'large', label: 'Large', rootPx: 20, terminalOffset: 4 },
  { id: 'x-large', label: 'X-Large', rootPx: 22, terminalOffset: 6 }
] as const

export function scaleSpec(id: UiScale): UiScaleSpec {
  return SCALES.find((s) => s.id === id) ?? SCALES[0]
}

/** Shared empty-array reference so the initial reducer and "no themes on
 *  disk" outcomes return the same array — keeps `useMemo` deps stable in
 *  components reading the slice. */
export const EMPTY_CUSTOM_THEMES: CustomTheme[] = []

/** Built-in theme ids used as the per-mode default when nothing else
 *  applies — the seed value for `themeLight`/`themeDark`, the IPC "this
 *  matches the default so don't persist it" guard, and the fallback
 *  `[data-theme]` selector for partial custom themes. Kept in shared so
 *  main and renderer agree without crossing the import boundary. */
export const DEFAULT_LIGHT_THEME = 'solarized-light'
export const DEFAULT_DARK_THEME = 'dark'

/** Default kickoff prompt for "Open PR as worktree". Editable globally in
 *  Settings (`prReviewPrompt`) and per-creation in the New Worktree screen. */
export const DEFAULT_PR_REVIEW_PROMPT =
  "Review this PR. Read the diff, then check for correctness issues, design problems, security concerns, and missing edge cases. Cite file paths and line numbers for anything you flag. Skip restating what the PR does — focus on what could go wrong or be improved."

// Client-side placeholder. Real values are seeded in the main-process Store
// constructor from the on-disk config and secrets.
export const initialSettings: SettingsState = {
  themeMode: 'system',
  themeLight: DEFAULT_LIGHT_THEME,
  themeDark: DEFAULT_DARK_THEME,
  customThemes: EMPTY_CUSTOM_THEMES,
  hotkeys: null,
  defaultAgent: 'claude',
  claudeCommand: '',
  codexCommand: '',
  opencodeCommand: '',
  worktreeScripts: { setup: '', teardown: '' },
  claudeEnvVars: {},
  codexEnvVars: {},
  opencodeEnvVars: {},
  tatsuMcpEnabled: true,
  nameClaudeSessions: false,
  terminalFontFamily: '',
  terminalFontSize: 13,
  editor: 'vscode',
  worktreeBase: 'remote',
  mergeStrategy: 'squash',
  worktreeDetail: 'diff',
  shareClaudeSettings: true,
  claudeModel: null,
  codexModel: null,
  opencodeModel: null,
  hasGithubToken: false,
  githubAuthSource: null,
  viewerLogin: null,
  tatsuStarred: null,
  autoUpdateEnabled: true,
  tatsuSystemPromptEnabled: true,
  tatsuSystemPrompt: '',
  tatsuSystemPromptMain: '',
  claudeTuiFullscreen: true,
  wsTransportEnabled: false,
  wsTransportPort: 37291,
  wsTransportHost: '127.0.0.1',
  browserToolsEnabled: true,
  browserToolsMode: 'full',
  defaultClaudeTabType: 'xterm',
  chatPromotionDismissed: false,
  autoApprovePermissions: false,
  autoApproveSteerInstructions: '',
  useSystemClaudeForJsonMode: false,
  jsonModeChatDensity: 'compact',
  uiScale: 'small',
  jsonModeSendOnEnter: false,
  jsonModeDefaultPermissionMode: 'acceptEdits',
  autoSleepMinutes: 30,
  snoozeDefaultDays: 7,
  expandedDiagnosticLoggingEnabled: false,
  prReviewPrompt: DEFAULT_PR_REVIEW_PROMPT,
  dismissedAnnouncementIds: [],
  announcementsMuted: false
}

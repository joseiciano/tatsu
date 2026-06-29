import type {
  PersistedPane,
  PersistedPaneNode,
  PersistedTab
} from '../persistence-migrations'
import type { CostsState } from '../../shared/state/costs'
import type { SnoozeEntry } from '../../shared/state/snooze'

import type { AgentKind } from '../../shared/state/terminals'
export type { PersistedPane, PersistedPaneNode, PersistedTab }

export type QuestStep = 'hidden' | 'spawn-second' | 'switch-between' | 'finale' | 'done'

export interface BackendConnection {
  id: string
  label: string
  url: string
  kind: 'local' | 'remote'
  addedAt: number
  lastConnectedAt?: number
  color?: string
  initials?: string
}

export interface Config {
  schemaVersion?: number
  windowBounds: { x: number; y: number; width: number; height: number } | null
  repoRoots: string[]
  hotkeys?: Record<string, string>
  defaultAgent?: AgentKind
  claudeCommand?: string
  codexCommand?: string
  opencodeCommand?: string
  claudeEnvVars?: Record<string, string>
  claudeModel?: string
  codexModel?: string
  opencodeModel?: string
  codexEnvVars?: Record<string, string>
  opencodeEnvVars?: Record<string, string>
  piCommand?: string
  piEnvVars?: Record<string, string>
  piModel?: string
  harnessMcpEnabled?: boolean
  panes?: Record<string, Record<string, PersistedPaneNode>>
  legacyPanes?: Record<string, PersistedPane[]>
  terminalTabs?: Record<string, PersistedTab[]>
  activeTabId?: Record<string, string>
  themeMode?: 'light' | 'dark' | 'system'
  themeLight?: string
  themeDark?: string
  lastEffectiveAppBg?: string
  terminalFontFamily?: string
  terminalFontSize?: number
  editor?: string
  worktreeBase?: 'remote' | 'local'
  mergeStrategy?: 'squash' | 'merge-commit' | 'fast-forward'
  worktreeDetail?: 'diff' | 'age' | 'pr' | 'none'
  worktreeSetupCommand?: string
  worktreeTeardownCommand?: string
  locallyMerged?: Record<string, string>
  nameClaudeSessions?: boolean
  onboarding?: {
    quest?: QuestStep
  }
  harnessAutoStarred?: boolean
  costs?: CostsState
  autoUpdateEnabled?: boolean
  shareClaudeSettings?: boolean
  hooksConsent?: 'pending' | 'accepted' | 'declined'
  hooksMigratedToGlobal?: boolean
  harnessSystemPromptEnabled?: boolean
  harnessSystemPrompt?: string
  harnessSystemPromptMain?: string
  prReviewPrompt?: string
  claudeTuiFullscreen?: boolean
  wsTransportEnabled?: boolean
  wsTransportPort?: number
  wsTransportHost?: string
  browserToolsEnabled?: boolean
  browserToolsMode?: 'view' | 'full'
  defaultClaudeTabType?: 'xterm' | 'json'
  chatPromotionDismissed?: boolean
  autoApprovePermissions?: boolean
  autoApproveSteerInstructions?: string
  useSystemClaudeForJsonMode?: boolean
  jsonModeChatDensity?: 'compact' | 'comfy'
  uiScale?: 'x-small' | 'small' | 'medium' | 'large' | 'x-large'
  jsonModeSendOnEnter?: boolean
  jsonModeDefaultPermissionMode?: 'default' | 'acceptEdits' | 'plan'
  autoSleepMinutes?: number
  connections?: BackendConnection[]
  activeBackendId?: string
  snooze?: Record<string, SnoozeEntry>
  snoozeDefaultDays?: number
  expandedDiagnosticLoggingEnabled?: boolean
  dismissedAnnouncementIds?: string[]
  announcementsMuted?: boolean
  scratchpadNotes?: Record<string, Record<string, string>>
}
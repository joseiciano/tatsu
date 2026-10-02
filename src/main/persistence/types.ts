import type {
  PersistedPane,
  PersistedPaneNode,
  PersistedTab
} from '../persistence-migrations'
import type { CostsState } from '../../shared/state/costs'
import type { SnoozeEntry } from '../../shared/state/snooze'
import type { HarnessConfigDesiredResource } from '../harness-config'

import type { AgentKind } from '../../shared/state/terminals'
export type { PersistedPane, PersistedPaneNode, PersistedTab }

export type QuestStep = 'hidden' | 'spawn-second' | 'switch-between' | 'finale' | 'done'

/** Canonical Tatsu config resource contract, reused verbatim from the
 *  harness-config service (never independently restated here). */
export type PersistedHarnessConfigResource = HarnessConfigDesiredResource

export interface PersistedHarnessConfig {
  version: 1
  resources: PersistedHarnessConfigResource[]
}

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

export interface PersistedWorktreeContainer {
  id?: string
  name: string
  image: string
  workdir: string
  shell: string
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
  enableWorktreeContainers?: boolean
  worktreeSetupCommand?: string
  worktreeTeardownCommand?: string
  worktreeContainers?: Record<string, PersistedWorktreeContainer>
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
  harnessConfig?: PersistedHarnessConfig
}

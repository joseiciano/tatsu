import { describe, expect, it } from 'vitest'
import type * as Generated from './generated'
import type { WireEqual } from '../wire-check'
import type { HarnessConfigResourceType as RegistryResourceType } from '../agent-registry'
import type {
  HarnessConfigChangedRef,
  HarnessConfigComparison,
  HarnessConfigFragmentEditEntry,
  HarnessConfigFragmentErrorEntry,
  HarnessConfigRenderErrorEntry,
  HarnessConfigScope,
  HarnessConfigFileRef,
  HarnessConfigResourceType,
  HarnessConfigRootKey,
  HarnessConfigRoots,
  HarnessConfigScopeKey,
  HarnessConfigEvent,
  HarnessConfigState,
  HarnessConfigSyncDirection,
  HarnessConfigSyncPlan,
  HarnessConfigSyncStatus,
  HarnessConfigTemplateSyncNotice,
  HarnessFragment,
  HarnessTemplate,
  HarnessTemplateHarnessBlock,
  HarnessTemplateHarnesses,
  HarnessTemplateKind,
  HarnessTemplateParseError,
  HarnessTemplateReference,
  HarnessTemplateSourceState,
  ManagedHarnessKind
} from './harness-config'
import type { Announcement, AnnouncementsEvent, AnnouncementsState } from './announcements'
import type { BrowserEvent, BrowserState, BrowserTabState } from './browser'
import type { ContentBreakdown, CostsEvent, CostsState, ModelTally, SessionUsage } from './costs'
import type { HooksConsent, HooksEvent, HooksState } from './hooks'
import type {
  AutoReviewStatus,
  ChatRuntimeCapabilities,
  ChatRuntimeId,
  JsonClaudeAuthMethod,
  JsonClaudeChatEntry,
  JsonClaudeEvent,
  JsonClaudeMessageBlock,
  JsonClaudePendingApproval,
  JsonClaudePermissionMode,
  JsonClaudeSession,
  JsonClaudeSessionState,
  JsonClaudeState
} from './json-claude'
import type { OnboardingEvent, OnboardingState, QuestStep } from './onboarding'
import type { CheckStatus, PRReview, PRsEvent, PRsState, PRStatus } from './prs'
import type {
  HiddenRightPanels,
  RepoConfig,
  RepoConfigsEvent,
  RepoConfigsState,
  RightPanelKey
} from './repo-configs'
import type { DownloadableRuntime, RuntimesEvent, RuntimesState, RuntimeStatus } from './runtimes'
import type { ScratchpadEvent, ScratchpadState } from './scratchpad'
import type {
  AgentKindSetting,
  BrowserToolsMode,
  CustomTheme,
  JsonModeChatDensity,
  MergeStrategy as SettingsMergeStrategy,
  SettingsEvent,
  SettingsState,
  ThemeMode,
  UiScale,
  WorktreeBase,
  WorktreeDetail,
  WorktreeScripts
} from './settings'
import { initialSnooze, snoozeReducer, type SnoozeEvent, type SnoozeState } from './snooze'
import type {
  AgentKind,
  PaneLeaf,
  PaneNode,
  PaneSplit,
  PendingTool,
  PtyStatus,
  ShellActivity,
  TerminalProgress,
  TerminalSession,
  TerminalsEvent,
  TerminalsState,
  TerminalTab
} from './terminals'
import type { UpdaterEvent, UpdaterState, UpdaterStatus } from './updater'
import type {
  PendingDeletion,
  PendingDeletionPhase,
  PendingStatus,
  PendingWorktree,
  Worktree,
  WorktreesEvent,
  WorktreesState
} from './worktrees'

const snoozeState: WireEqual<Generated.SnoozeState, SnoozeState> = true
const snoozeEvent: WireEqual<Generated.SnoozeEvent, SnoozeEvent> = true

const questStep: WireEqual<Generated.QuestStep, QuestStep> = true
const onboardingState: WireEqual<Generated.OnboardingState, OnboardingState> = true
const onboardingEvent: WireEqual<Generated.OnboardingEvent, OnboardingEvent> = true
const hooksConsent: WireEqual<Generated.HooksConsent, HooksConsent> = true
const hooksState: WireEqual<Generated.HooksState, HooksState> = true
const hooksEvent: WireEqual<Generated.HooksEvent, HooksEvent> = true
const updaterStatus: WireEqual<Generated.UpdaterStatus, UpdaterStatus> = true
const updaterState: WireEqual<Generated.UpdaterState, UpdaterState> = true
const updaterEvent: WireEqual<Generated.UpdaterEvent, UpdaterEvent> = true
const browserTabState: WireEqual<Generated.BrowserTabState, BrowserTabState> = true
const browserTabStatePatch: WireEqual<Generated.BrowserTabStatePatch, Partial<BrowserTabState>> = true
const browserState: WireEqual<Generated.BrowserState, BrowserState> = true
const browserEvent: WireEqual<Generated.BrowserEvent, BrowserEvent> = true
const announcement: WireEqual<Generated.Announcement, Announcement> = true
const announcementsState: WireEqual<Generated.AnnouncementsState, AnnouncementsState> = true
const announcementsEvent: WireEqual<Generated.AnnouncementsEvent, AnnouncementsEvent> = true
const scratchpadState: WireEqual<Generated.ScratchpadState, ScratchpadState> = true
const scratchpadEvent: WireEqual<Generated.ScratchpadEvent, ScratchpadEvent> = true
const checkStatus: WireEqual<Generated.CheckStatus, CheckStatus> = true
const checkState: WireEqual<Generated.CheckState, CheckStatus['state']> = true
const prReview: WireEqual<Generated.PRReview, PRReview> = true
const prReviewState: WireEqual<Generated.PRReviewState, PRReview['state']> = true
const prState: WireEqual<Generated.PRState, PRStatus['state']> = true
const checksOverall: WireEqual<Generated.ChecksOverall, PRStatus['checksOverall']> = true
const reviewDecision: WireEqual<Generated.ReviewDecision, PRStatus['reviewDecision']> = true
const prAuthor: WireEqual<Generated.GithubUser, NonNullable<PRStatus['author']>> = true
const prAssignee: WireEqual<Generated.GithubUser, PRStatus['assignees'][number]> = true
const prMilestone: WireEqual<Generated.PRMilestone, NonNullable<PRStatus['milestone']>> = true
const prMilestoneField: WireEqual<Generated.PRStatus['milestone'], PRStatus['milestone']> = true
const prLinkedIssue: WireEqual<Generated.PRLinkedIssue, PRStatus['linkedIssues'][number]> = true
const prLabel: WireEqual<Generated.PRLabel, PRStatus['labels'][number]> = true
const prStatus: WireEqual<Generated.PRStatus, PRStatus> = true
const prsState: WireEqual<Generated.PRsState, PRsState> = true
const prsEvent: WireEqual<Generated.PRsEvent, PRsEvent> = true
const modelTally: WireEqual<Generated.ModelTally, ModelTally> = true
const contentBreakdown: WireEqual<Generated.ContentBreakdown, ContentBreakdown> = true
const sessionUsage: WireEqual<Generated.SessionUsage, SessionUsage> = true
const costsState: WireEqual<Generated.CostsState, CostsState> = true
const costsEvent: WireEqual<Generated.CostsEvent, CostsEvent> = true
const rightPanelKey: WireEqual<Generated.RightPanelKey, RightPanelKey> = true
const mergeStrategy: WireEqual<Generated.MergeStrategy, NonNullable<RepoConfig['mergeStrategy']>> = true
const hiddenRightPanels: WireEqual<NonNullable<Generated.RepoConfig['hiddenRightPanels']>, HiddenRightPanels> = true
const repoConfig: WireEqual<Generated.RepoConfig, RepoConfig> = true
const repoConfigsState: WireEqual<Generated.RepoConfigsState, RepoConfigsState> = true
const repoConfigsEvent: WireEqual<Generated.RepoConfigsEvent, RepoConfigsEvent> = true
const runtimesEvent: WireEqual<Generated.RuntimesEvent, RuntimesEvent> = true

const agentKind: WireEqual<Generated.AgentKind, AgentKind> = true
const chatRuntimeId: WireEqual<Generated.ChatRuntimeId, ChatRuntimeId> = true
const permissionMode: WireEqual<Generated.JsonClaudePermissionMode, JsonClaudePermissionMode> = true
const resourceType: WireEqual<Generated.HarnessConfigResourceType, HarnessConfigResourceType> = true
const registryResourceType: WireEqual<Generated.HarnessConfigResourceType, RegistryResourceType> = true
const managedHarnessKind: WireEqual<Generated.ManagedHarnessKind, ManagedHarnessKind> = true
const rootKey: WireEqual<Generated.HarnessConfigRootKey, HarnessConfigRootKey> = true
const syncStatus: WireEqual<Generated.HarnessConfigSyncStatus, HarnessConfigSyncStatus> = true
const scopeKey: WireEqual<Generated.HarnessConfigScopeKey, HarnessConfigScopeKey> = true

const scope: WireEqual<Generated.HarnessConfigScope, HarnessConfigScope> = true
const changedRef: WireEqual<Generated.HarnessConfigChangedRef, HarnessConfigChangedRef> = true
const renderError: WireEqual<Generated.HarnessConfigRenderErrorEntry, HarnessConfigRenderErrorEntry> = true
const fragmentError: WireEqual<Generated.HarnessConfigFragmentErrorEntry, HarnessConfigFragmentErrorEntry> = true
const fragmentEdit: WireEqual<Generated.HarnessConfigFragmentEditEntry, HarnessConfigFragmentEditEntry> = true
const fileRef: WireEqual<Generated.HarnessConfigFileRef, HarnessConfigFileRef> = true
const runtimeStatus: WireEqual<Generated.RuntimeStatus, RuntimeStatus> = true
const downloadableRuntime: WireEqual<Generated.DownloadableRuntime, DownloadableRuntime> = true

const harnessBlock: WireEqual<Generated.HarnessTemplateHarnessBlock, HarnessTemplateHarnessBlock> = true
const frontmatter: WireEqual<
  Generated.HarnessTemplateHarnessBlock['frontmatter'],
  Record<string, unknown>
> = true
const harnessEntry: WireEqual<
  Generated.HarnessTemplateHarnessEntry,
  HarnessTemplateHarnessBlock | false
> = true
const harnesses: WireEqual<Generated.HarnessTemplateHarnesses, HarnessTemplateHarnesses> = true
const roots: WireEqual<Generated.HarnessConfigRoots, HarnessConfigRoots> = true
const settingsRoots: WireEqual<Generated.HarnessConfigRoots, SettingsState['harnessConfigRoots']> = true
const comparison: WireEqual<Generated.HarnessConfigComparison, HarnessConfigComparison> = true
const comparisons: WireEqual<Generated.HarnessConfigComparisons, HarnessConfigState['comparisons']> = true
const syncDirection: WireEqual<Generated.HarnessConfigSyncDirection, HarnessConfigSyncDirection> = true
const syncPlan: WireEqual<Generated.HarnessConfigSyncPlan, HarnessConfigSyncPlan> = true
const templateKind: WireEqual<Generated.HarnessTemplateKind, HarnessTemplateKind> = true
const templateReference: WireEqual<Generated.HarnessTemplateReference, HarnessTemplateReference> = true
const harnessTemplate: WireEqual<Generated.HarnessTemplate, HarnessTemplate> = true
const harnessFragment: WireEqual<Generated.HarnessFragment, HarnessFragment> = true
const templateParseError: WireEqual<Generated.HarnessTemplateParseError, HarnessTemplateParseError> = true
const templateSource: WireEqual<Generated.HarnessTemplateSourceState, HarnessTemplateSourceState> = true
const templateSyncNotice: WireEqual<Generated.HarnessConfigTemplateSyncNotice, HarnessConfigTemplateSyncNotice> = true
const harnessResources: WireEqual<Generated.HarnessConfigResources, HarnessConfigState['resources']> = true
const harnessConfigState: WireEqual<Generated.HarnessConfigState, HarnessConfigState> = true
const harnessConfigEvent: WireEqual<Generated.HarnessConfigEvent, HarnessConfigEvent> = true
const runtimesState: WireEqual<Generated.RuntimesState, RuntimesState> = true
const byAgent: WireEqual<Generated.RuntimesState['byAgent'], RuntimesState['byAgent']> = true

const themeMode: WireEqual<Generated.ThemeMode, ThemeMode> = true
const customThemeMode: WireEqual<Generated.CustomThemeMode, CustomTheme['mode']> = true
const customTheme: WireEqual<Generated.CustomTheme, CustomTheme> = true
const worktreeScripts: WireEqual<Generated.WorktreeScripts, WorktreeScripts> = true
const worktreeBase: WireEqual<Generated.WorktreeBase, WorktreeBase> = true
const worktreeDetail: WireEqual<Generated.WorktreeDetail, WorktreeDetail> = true
const settingsMergeStrategy: WireEqual<Generated.MergeStrategy, SettingsMergeStrategy> = true
const agentKindSetting: WireEqual<Generated.AgentKind, AgentKindSetting> = true
const githubAuthSource: WireEqual<Generated.GithubAuthSource, NonNullable<SettingsState['githubAuthSource']>> = true
const browserToolsMode: WireEqual<Generated.BrowserToolsMode, BrowserToolsMode> = true
const claudeTabType: WireEqual<Generated.AgentTabType, SettingsState['defaultClaudeTabType']> = true
const opencodeTabType: WireEqual<Generated.AgentTabType, SettingsState['defaultOpencodeTabType']> = true
const codexTabType: WireEqual<Generated.AgentTabType, SettingsState['defaultCodexTabType']> = true
const chatDensity: WireEqual<Generated.JsonModeChatDensity, JsonModeChatDensity> = true
const uiScale: WireEqual<Generated.UiScale, UiScale> = true
const settingsHotkeys: WireEqual<Generated.SettingsState['hotkeys'], SettingsState['hotkeys']> = true
const settingsEnvVars: WireEqual<Generated.SettingsState['claudeEnvVars'], SettingsState['claudeEnvVars']> = true
const rootChange: WireEqual<
  Generated.HarnessConfigRootChange,
  Extract<SettingsEvent, { type: 'settings/harnessConfigRootsChanged' }>['payload']
> = true
const settingsState: WireEqual<Generated.SettingsState, SettingsState> = true
const settingsEvent: WireEqual<Generated.SettingsEvent, SettingsEvent> = true

const terminalTab: WireEqual<Generated.TerminalTab, TerminalTab> = true
const paneLeaf: WireEqual<Generated.PaneLeaf, Omit<PaneLeaf, 'type'>> = true
const paneSplit: WireEqual<Generated.PaneSplit, Omit<PaneSplit, 'type'>> = true
const paneNode: WireEqual<Generated.PaneNode, PaneNode> = true
const ptyStatus: WireEqual<Generated.PtyStatus, PtyStatus> = true
const pendingTool: WireEqual<Generated.PendingTool, PendingTool> = true
const shellActivity: WireEqual<Generated.ShellActivity, ShellActivity> = true
const terminalProgress: WireEqual<Generated.TerminalProgress, TerminalProgress> = true
const terminalProgressState: WireEqual<Generated.TerminalProgress['state'], TerminalProgress['state']> = true
const terminalSession: WireEqual<Generated.TerminalSession, TerminalSession> = true
const terminalSize: WireEqual<Generated.TerminalSize, NonNullable<TerminalSession['size']>> = true
const terminalsState: WireEqual<Generated.TerminalsState, TerminalsState> = true
const terminalsEvent: WireEqual<Generated.TerminalsEvent, TerminalsEvent> = true

const jsonClaudeSessionState: WireEqual<Generated.JsonClaudeSessionState, JsonClaudeSessionState> = true
const jsonClaudeAuthMethod: WireEqual<Generated.JsonClaudeAuthMethod, JsonClaudeAuthMethod> = true
const jsonClaudeAuthMethodType: WireEqual<
  Generated.JsonClaudeAuthMethodType,
  NonNullable<JsonClaudeAuthMethod['type']>
> = true
const chatRuntimeCapabilities: WireEqual<Generated.ChatRuntimeCapabilities, ChatRuntimeCapabilities> = true
const jsonClaudeBlockType: WireEqual<Generated.JsonClaudeBlockType, JsonClaudeMessageBlock['type']> = true
const jsonClaudeBlockInput: WireEqual<
  NonNullable<Generated.JsonClaudeMessageBlock['input']>,
  NonNullable<JsonClaudeMessageBlock['input']>
> = true
const jsonClaudeMessageBlock: WireEqual<Generated.JsonClaudeMessageBlock, JsonClaudeMessageBlock> = true
const jsonClaudeEntryKind: WireEqual<Generated.JsonClaudeEntryKind, JsonClaudeChatEntry['kind']> = true
const jsonClaudeCompactTrigger: WireEqual<
  Generated.JsonClaudeCompactTrigger,
  NonNullable<JsonClaudeChatEntry['compactTrigger']>
> = true
const jsonClaudeErrorKind: WireEqual<Generated.JsonClaudeErrorKind, NonNullable<JsonClaudeChatEntry['errorKind']>> = true
const jsonClaudeImage: WireEqual<
  Generated.JsonClaudeImageAttachment,
  NonNullable<JsonClaudeChatEntry['images']>[number]
> = true
const jsonClaudeRateLimitDetail: WireEqual<
  Generated.JsonClaudeRateLimitDetail,
  NonNullable<JsonClaudeChatEntry['rateLimitDetail']>
> = true
const jsonClaudeChatEntry: WireEqual<Generated.JsonClaudeChatEntry, JsonClaudeChatEntry> = true
const jsonClaudeAutoApprovedDecision: WireEqual<
  Generated.JsonClaudeAutoApprovedDecision,
  JsonClaudeSession['autoApprovedDecisions'][string]
> = true
const jsonClaudeSessionAllowedDecision: WireEqual<
  Generated.JsonClaudeSessionAllowedDecision,
  JsonClaudeSession['sessionAllowedDecisions'][string]
> = true
const jsonClaudeSession: WireEqual<Generated.JsonClaudeSession, JsonClaudeSession> = true
const autoReviewState: WireEqual<Generated.AutoReviewState, AutoReviewStatus['state']> = true
const autoReviewDecision: WireEqual<Generated.AutoReviewDecision, NonNullable<AutoReviewStatus['decision']>> = true
const autoReviewStatus: WireEqual<Generated.AutoReviewStatus, AutoReviewStatus> = true
const jsonClaudePendingApproval: WireEqual<Generated.JsonClaudePendingApproval, JsonClaudePendingApproval> = true
const jsonClaudeStateChangeExitCode: WireEqual<
  Generated.JsonClaudeSessionStateChange['exitCode'],
  Extract<JsonClaudeEvent, { type: 'jsonClaude/sessionStateChanged' }>['payload']['exitCode']
> = true
const jsonClaudeStateChangeExitReason: WireEqual<
  Generated.JsonClaudeSessionStateChange['exitReason'],
  Extract<JsonClaudeEvent, { type: 'jsonClaude/sessionStateChanged' }>['payload']['exitReason']
> = true
const jsonClaudeState: WireEqual<Generated.JsonClaudeState, JsonClaudeState> = true
const jsonClaudeEvent: WireEqual<Generated.JsonClaudeEvent, JsonClaudeEvent> = true

const pendingWorktree: WireEqual<Generated.PendingWorktree, PendingWorktree> = true
const pendingWorktreePatch: WireEqual<Generated.PendingWorktreePatch, Partial<PendingWorktree>> = true
const pendingDeletion: WireEqual<Generated.PendingDeletion, PendingDeletion> = true
const pendingDeletionPatch: WireEqual<Generated.PendingDeletionPatch, Partial<PendingDeletion>> = true
const pendingStatus: WireEqual<Generated.PendingStatus, PendingStatus> = true
const pendingDeletionPhase: WireEqual<Generated.PendingDeletionPhase, PendingDeletionPhase> = true
const worktree: WireEqual<Generated.Worktree, Worktree> = true
const worktreesState: WireEqual<Generated.WorktreesState, WorktreesState> = true
const worktreesEvent: WireEqual<Generated.WorktreesEvent, WorktreesEvent> = true

describe('generated wire types', () => {
  it('the TS reducer applies events typed with the generated union', () => {
    const events: Generated.SnoozeEvent[] = [
      { type: 'snooze/set', payload: { path: '/a', snoozedAt: 1, wakeAt: 2.5 } },
      { type: 'snooze/set', payload: { path: '/b', snoozedAt: 1, wakeAt: 3 } },
      { type: 'snooze/clear', payload: '/a' }
    ]
    const state: Generated.SnoozeState = events.reduce(snoozeReducer, initialSnooze)
    expect(state).toEqual({ byPath: { '/b': { path: '/b', snoozedAt: 1, wakeAt: 3 } } })
  })
})

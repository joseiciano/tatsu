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
  HarnessConfigState,
  HarnessConfigSyncStatus,
  HarnessTemplateHarnessBlock,
  HarnessTemplateHarnesses,
  ManagedHarnessKind
} from './harness-config'
import type { Announcement, AnnouncementsEvent, AnnouncementsState } from './announcements'
import type { BrowserEvent, BrowserState, BrowserTabState } from './browser'
import type { HooksConsent, HooksEvent, HooksState } from './hooks'
import type { ChatRuntimeId, JsonClaudePermissionMode } from './json-claude'
import type { OnboardingEvent, OnboardingState, QuestStep } from './onboarding'
import type { DownloadableRuntime, RuntimesEvent, RuntimesState, RuntimeStatus } from './runtimes'
import type { ScratchpadEvent, ScratchpadState } from './scratchpad'
import type { SettingsState } from './settings'
import { initialSnooze, snoozeReducer, type SnoozeEvent, type SnoozeState } from './snooze'
import type { AgentKind, PaneLeaf, PaneNode, PaneSplit, TerminalTab } from './terminals'
import type { UpdaterEvent, UpdaterState, UpdaterStatus } from './updater'
import type { PendingDeletion, PendingWorktree } from './worktrees'

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
const runtimesState: WireEqual<Generated.RuntimesState, RuntimesState> = true
const byAgent: WireEqual<Generated.RuntimesState['byAgent'], RuntimesState['byAgent']> = true

const terminalTab: WireEqual<Generated.TerminalTab, TerminalTab> = true
const paneLeaf: WireEqual<Generated.PaneLeaf, Omit<PaneLeaf, 'type'>> = true
const paneSplit: WireEqual<Generated.PaneSplit, Omit<PaneSplit, 'type'>> = true
const paneNode: WireEqual<Generated.PaneNode, PaneNode> = true

const pendingWorktree: WireEqual<Generated.PendingWorktree, PendingWorktree> = true
const pendingWorktreePatch: WireEqual<Generated.PendingWorktreePatch, Partial<PendingWorktree>> = true
const pendingDeletion: WireEqual<Generated.PendingDeletion, PendingDeletion> = true
const pendingDeletionPatch: WireEqual<Generated.PendingDeletionPatch, Partial<PendingDeletion>> = true

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

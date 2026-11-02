import { describe, expect, it } from 'vitest'
import type * as Generated from './generated'
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
import type { ChatRuntimeId, JsonClaudePermissionMode } from './json-claude'
import type { DownloadableRuntime, RuntimesState, RuntimeStatus } from './runtimes'
import type { SettingsState } from './settings'
import { initialSnooze, snoozeReducer, type SnoozeEvent, type SnoozeState } from './snooze'
import type { AgentKind, PaneLeaf, PaneNode, PaneSplit, TerminalTab } from './terminals'
import type { PendingDeletion, PendingWorktree } from './worktrees'

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type WireEqual<A, B> = MutuallyAssignable<A, B> extends true ? MutuallyAssignable<keyof A, keyof B> : false

const snoozeState: WireEqual<Generated.SnoozeState, SnoozeState> = true
const snoozeEvent: WireEqual<Generated.SnoozeEvent, SnoozeEvent> = true

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

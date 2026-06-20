import type { SettingsEvent, SettingsState } from './types'

export function settingsReducer(state: SettingsState, event: SettingsEvent): SettingsState {
  switch (event.type) {
    case 'settings/themeModeChanged':
      return { ...state, themeMode: event.payload }
    case 'settings/themeLightChanged':
      return { ...state, themeLight: event.payload }
    case 'settings/themeDarkChanged':
      return { ...state, themeDark: event.payload }
    case 'settings/customThemesChanged':
      return { ...state, customThemes: event.payload }
    case 'settings/hotkeysChanged':
      return { ...state, hotkeys: event.payload }
    case 'settings/defaultAgentChanged':
      return { ...state, defaultAgent: event.payload }
    case 'settings/claudeCommandChanged':
      return { ...state, claudeCommand: event.payload }
    case 'settings/codexCommandChanged':
      return { ...state, codexCommand: event.payload }
    case 'settings/opencodeCommandChanged':
      return { ...state, opencodeCommand: event.payload }
    case 'settings/worktreeScriptsChanged':
      return { ...state, worktreeScripts: event.payload }
    case 'settings/claudeEnvVarsChanged':
      return { ...state, claudeEnvVars: event.payload }
    case 'settings/codexEnvVarsChanged':
      return { ...state, codexEnvVars: event.payload }
    case 'settings/opencodeEnvVarsChanged':
      return { ...state, opencodeEnvVars: event.payload }
    case 'settings/tatsuMcpEnabledChanged':
      return { ...state, tatsuMcpEnabled: event.payload }
    case 'settings/nameClaudeSessionsChanged':
      return { ...state, nameClaudeSessions: event.payload }
    case 'settings/terminalFontFamilyChanged':
      return { ...state, terminalFontFamily: event.payload }
    case 'settings/terminalFontSizeChanged':
      return { ...state, terminalFontSize: event.payload }
    case 'settings/editorChanged':
      return { ...state, editor: event.payload }
    case 'settings/worktreeBaseChanged':
      return { ...state, worktreeBase: event.payload }
    case 'settings/mergeStrategyChanged':
      return { ...state, mergeStrategy: event.payload }
    case 'settings/worktreeDetailChanged':
      return { ...state, worktreeDetail: event.payload }
    case 'settings/shareClaudeSettingsChanged':
      return { ...state, shareClaudeSettings: event.payload }
    case 'settings/hasGithubTokenChanged':
      return { ...state, hasGithubToken: event.payload }
    case 'settings/githubAuthSourceChanged':
      return { ...state, githubAuthSource: event.payload }
    case 'settings/viewerLoginChanged':
      return { ...state, viewerLogin: event.payload }
    case 'settings/tatsuStarredChanged':
      return { ...state, tatsuStarred: event.payload }
    case 'settings/claudeModelChanged':
      return { ...state, claudeModel: event.payload }
    case 'settings/codexModelChanged':
      return { ...state, codexModel: event.payload }
    case 'settings/opencodeModelChanged':
      return { ...state, opencodeModel: event.payload }
    case 'settings/autoUpdateEnabledChanged':
      return { ...state, autoUpdateEnabled: event.payload }
    case 'settings/tatsuSystemPromptEnabledChanged':
      return { ...state, tatsuSystemPromptEnabled: event.payload }
    case 'settings/tatsuSystemPromptChanged':
      return { ...state, tatsuSystemPrompt: event.payload }
    case 'settings/tatsuSystemPromptMainChanged':
      return { ...state, tatsuSystemPromptMain: event.payload }
    case 'settings/claudeTuiFullscreenChanged':
      return { ...state, claudeTuiFullscreen: event.payload }
    case 'settings/wsTransportEnabledChanged':
      return { ...state, wsTransportEnabled: event.payload }
    case 'settings/wsTransportPortChanged':
      return { ...state, wsTransportPort: event.payload }
    case 'settings/wsTransportHostChanged':
      return { ...state, wsTransportHost: event.payload }
    case 'settings/browserToolsEnabledChanged':
      return { ...state, browserToolsEnabled: event.payload }
    case 'settings/browserToolsModeChanged':
      return { ...state, browserToolsMode: event.payload }
    case 'settings/defaultClaudeTabTypeChanged':
      return { ...state, defaultClaudeTabType: event.payload }
    case 'settings/chatPromotionDismissedChanged':
      return { ...state, chatPromotionDismissed: event.payload }
    case 'settings/autoApprovePermissionsChanged':
      return { ...state, autoApprovePermissions: event.payload }
    case 'settings/autoApproveSteerInstructionsChanged':
      return { ...state, autoApproveSteerInstructions: event.payload }
    case 'settings/useSystemClaudeForJsonModeChanged':
      return { ...state, useSystemClaudeForJsonMode: event.payload }
    case 'settings/jsonModeChatDensityChanged':
      return { ...state, jsonModeChatDensity: event.payload }
    case 'settings/uiScaleChanged':
      return { ...state, uiScale: event.payload }
    case 'settings/jsonModeSendOnEnterChanged':
      return { ...state, jsonModeSendOnEnter: event.payload }
    case 'settings/jsonModeDefaultPermissionModeChanged':
      return { ...state, jsonModeDefaultPermissionMode: event.payload }
    case 'settings/autoSleepMinutesChanged':
      return { ...state, autoSleepMinutes: event.payload }
    case 'settings/snoozeDefaultDaysChanged':
      return { ...state, snoozeDefaultDays: event.payload }
    case 'settings/expandedDiagnosticLoggingEnabledChanged':
      return { ...state, expandedDiagnosticLoggingEnabled: event.payload }
    case 'settings/prReviewPromptChanged':
      return { ...state, prReviewPrompt: event.payload }
    case 'settings/announcementDismissed': {
      if (state.dismissedAnnouncementIds.includes(event.payload)) return state
      return {
        ...state,
        dismissedAnnouncementIds: [...state.dismissedAnnouncementIds, event.payload]
      }
    }
    case 'settings/announcementsMutedChanged':
      return { ...state, announcementsMuted: event.payload }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

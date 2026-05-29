import { describe, it, expect } from 'vitest'
import {
  resolveTerminalAgentId,
  getDefaultTerminalAgentId,
  getAgentRuntimeConfig,
  resolveAgentCommand,
  resolveAgentModel,
  resolveAgentEnvVars,
  isManagedAgent
} from './terminal-agent-resolver'
import type { SettingsState } from '../shared/state/settings'

const baseSettings: SettingsState = {
  themeMode: 'system',
  themeLight: 'solarized-light',
  themeDark: 'dark',
  customThemes: [],
  hotkeys: null,
  defaultTerminalAgentId: 'claude',
  userTerminalAgents: [],
  agentConfigs: {},
  defaultAgent: 'claude',
  claudeCommand: '',
  codexCommand: '',
  opencodeCommand: '',
  claudeEnvVars: {},
  codexEnvVars: {},
  opencodeEnvVars: {},
  claudeModel: null,
  codexModel: null,
  opencodeModel: null,
  worktreeScripts: { setup: '', teardown: '' },
  harnessMcpEnabled: true,
  nameClaudeSessions: false,
  terminalFontFamily: '',
  terminalFontSize: 13,
  editor: 'vscode',
  worktreeBase: 'remote',
  mergeStrategy: 'squash',
  worktreeDetail: 'diff',
  shareClaudeSettings: true,
  hasGithubToken: false,
  githubAuthSource: null,
  viewerLogin: null,
  harnessStarred: null,
  autoUpdateEnabled: true,
  harnessSystemPromptEnabled: true,
  harnessSystemPrompt: '',
  harnessSystemPromptMain: '',
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
  prReviewPrompt: '',
  dismissedAnnouncementIds: [],
  announcementsMuted: false
}

describe('resolveTerminalAgentId', () => {
  it('returns requested id when valid', () => {
    expect(resolveTerminalAgentId({ settings: baseSettings, requestedAgentId: 'codex' })).toBe('codex')
  })

  it('falls back to default when requested is invalid', () => {
    expect(resolveTerminalAgentId({ settings: baseSettings, requestedAgentId: 'unknown' })).toBe('claude')
  })

  it('falls back to claude when default is invalid', () => {
    const settings = { ...baseSettings, defaultTerminalAgentId: 'unknown' }
    expect(resolveTerminalAgentId({ settings })).toBe('claude')
  })

  it('falls back to claude when default is invalid', () => {
    const settings = { ...baseSettings, defaultTerminalAgentId: 'unknown', userTerminalAgents: [{ id: 'custom', displayName: 'Custom', vendor: 'test', capabilities: { assignsSessionId: false, supportsResume: false, supportsModel: false, supportsPrompt: false, supportsJsonMode: false, supportsHarnessMcp: false, supportsHooks: false } }] }
    expect(resolveTerminalAgentId({ settings })).toBe('claude')
  })

  it('returns requested id even if invalid when fallback is disabled', () => {
    expect(resolveTerminalAgentId({ settings: baseSettings, requestedAgentId: 'unknown', fallbackToDefault: false })).toBe('unknown')
  })
})

describe('getDefaultTerminalAgentId', () => {
  it('returns default when valid', () => {
    expect(getDefaultTerminalAgentId(baseSettings)).toBe('claude')
  })

  it('falls back to claude when default is invalid', () => {
    const settings = { ...baseSettings, defaultTerminalAgentId: 'unknown' }
    expect(getDefaultTerminalAgentId(settings)).toBe('claude')
  })
})

describe('getAgentRuntimeConfig', () => {
  it('returns config for agent', () => {
    const settings = { ...baseSettings, agentConfigs: { claude: { command: 'claude-dev' } } }
    expect(getAgentRuntimeConfig(settings, 'claude')).toEqual({ command: 'claude-dev' })
  })

  it('returns empty object when no config', () => {
    expect(getAgentRuntimeConfig(baseSettings, 'claude')).toEqual({})
  })
})

describe('resolveAgentCommand', () => {
  it('returns config command when set', () => {
    const settings = { ...baseSettings, agentConfigs: { claude: { command: 'claude-dev' } } }
    expect(resolveAgentCommand(settings, 'claude')).toBe('claude-dev')
  })

  it('returns built-in defaults', () => {
    expect(resolveAgentCommand(baseSettings, 'claude')).toBe('claude')
    expect(resolveAgentCommand(baseSettings, 'codex')).toBe('codex')
    expect(resolveAgentCommand(baseSettings, 'opencode')).toBe('opencode')
  })

  it('returns agent id for custom agents', () => {
    expect(resolveAgentCommand(baseSettings, 'custom')).toBe('custom')
  })
})

describe('resolveAgentModel', () => {
  it('returns tab override when set', () => {
    expect(resolveAgentModel(baseSettings, 'claude', 'sonnet-4')).toBe('sonnet-4')
  })

  it('returns config model when set', () => {
    const settings = { ...baseSettings, agentConfigs: { claude: { model: 'opus' } } }
    expect(resolveAgentModel(settings, 'claude')).toBe('opus')
  })

  it('returns null when no model', () => {
    expect(resolveAgentModel(baseSettings, 'claude')).toBeNull()
  })
})

describe('resolveAgentEnvVars', () => {
  it('returns config env vars', () => {
    const settings = { ...baseSettings, agentConfigs: { claude: { envVars: { FOO: 'bar' } } } }
    expect(resolveAgentEnvVars(settings, 'claude')).toEqual({ FOO: 'bar' })
  })

  it('returns empty object when no env vars', () => {
    expect(resolveAgentEnvVars(baseSettings, 'claude')).toEqual({})
  })
})

describe('isManagedAgent', () => {
  it('returns true for built-in agents', () => {
    expect(isManagedAgent('claude')).toBe(true)
    expect(isManagedAgent('codex')).toBe(true)
    expect(isManagedAgent('opencode')).toBe(true)
  })

  it('returns false for custom agents', () => {
    expect(isManagedAgent('custom')).toBe(false)
  })
})

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::slices::{
    harness_config::{HarnessConfigRootKey, HarnessConfigRoots},
    json_claude::JsonClaudePermissionMode,
    repo_configs::MergeStrategy,
    terminals::AgentKind,
};

pub const DEFAULT_LIGHT_THEME: &str = "solarized-light";
pub const DEFAULT_DARK_THEME: &str = "dark";
pub const DEFAULT_PR_REVIEW_PROMPT: &str = "Review this PR. Read the diff, then check for correctness issues, design problems, security concerns, and missing edge cases. Cite file paths and line numbers for anything you flag. Skip restating what the PR does — focus on what could go wrong or be improved.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    Light,
    Dark,
    System,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum CustomThemeMode {
    Light,
    Dark,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
pub struct CustomTheme {
    pub id: String,
    pub name: String,
    pub mode: CustomThemeMode,
    pub colors: IndexMap<String, String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct WorktreeScripts {
    pub setup: String,
    pub teardown: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum WorktreeBase {
    Remote,
    Local,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum WorktreeDetail {
    Diff,
    Age,
    Pr,
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum GithubAuthSource {
    Pat,
    GhCli,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum BrowserToolsMode {
    View,
    Full,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum AgentTabType {
    Xterm,
    Json,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum JsonModeChatDensity {
    Compact,
    Comfy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum UiScale {
    XSmall,
    Small,
    Medium,
    Large,
    XLarge,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsState {
    pub theme_mode: ThemeMode,
    pub theme_light: String,
    pub theme_dark: String,
    pub custom_themes: Vec<CustomTheme>,
    pub hotkeys: Option<IndexMap<String, String>>,
    pub default_agent: AgentKind,
    pub claude_command: String,
    pub codex_command: String,
    pub opencode_command: String,
    pub worktree_scripts: WorktreeScripts,
    pub claude_env_vars: IndexMap<String, String>,
    pub codex_env_vars: IndexMap<String, String>,
    pub opencode_env_vars: IndexMap<String, String>,
    pub harness_mcp_enabled: bool,
    pub name_claude_sessions: bool,
    pub terminal_font_family: String,
    #[serde(serialize_with = "crate::wire::number::serialize")]
    #[specta(type = f64)]
    pub terminal_font_size: f64,
    pub editor: String,
    pub worktree_base: WorktreeBase,
    pub merge_strategy: MergeStrategy,
    pub worktree_detail: WorktreeDetail,
    pub share_claude_settings: bool,
    pub claude_model: Option<String>,
    pub codex_model: Option<String>,
    pub opencode_model: Option<String>,
    pub pi_command: String,
    pub pi_env_vars: IndexMap<String, String>,
    pub pi_model: Option<String>,
    pub has_github_token: bool,
    pub github_auth_source: Option<GithubAuthSource>,
    pub viewer_login: Option<String>,
    pub harness_starred: Option<bool>,
    pub auto_update_enabled: bool,
    pub experimental_chat_agents_enabled: bool,
    pub harness_system_prompt_enabled: bool,
    pub harness_system_prompt: String,
    pub harness_system_prompt_main: String,
    pub claude_tui_fullscreen: bool,
    pub ws_transport_enabled: bool,
    #[serde(serialize_with = "crate::wire::number::serialize")]
    #[specta(type = f64)]
    pub ws_transport_port: f64,
    pub ws_transport_host: String,
    pub browser_tools_enabled: bool,
    pub browser_tools_mode: BrowserToolsMode,
    pub default_claude_tab_type: AgentTabType,
    pub default_opencode_tab_type: AgentTabType,
    pub default_codex_tab_type: AgentTabType,
    pub chat_promotion_dismissed: bool,
    pub auto_approve_permissions: bool,
    pub auto_approve_steer_instructions: String,
    pub use_system_claude_for_json_mode: bool,
    pub json_mode_chat_density: JsonModeChatDensity,
    pub ui_scale: UiScale,
    pub json_mode_send_on_enter: bool,
    pub json_mode_default_permission_mode: JsonClaudePermissionMode,
    #[serde(serialize_with = "crate::wire::number::serialize")]
    #[specta(type = f64)]
    pub auto_sleep_minutes: f64,
    #[serde(serialize_with = "crate::wire::number::serialize")]
    #[specta(type = f64)]
    pub snooze_default_days: f64,
    pub expanded_diagnostic_logging_enabled: bool,
    pub pr_review_prompt: String,
    pub dismissed_announcement_ids: Vec<String>,
    pub announcements_muted: bool,
    pub harness_config_roots: HarnessConfigRoots,
    pub harness_config_source_dir: Option<String>,
}

impl Default for SettingsState {
    fn default() -> Self {
        Self {
            theme_mode: ThemeMode::System,
            theme_light: DEFAULT_LIGHT_THEME.to_string(),
            theme_dark: DEFAULT_DARK_THEME.to_string(),
            custom_themes: Vec::new(),
            hotkeys: None,
            default_agent: AgentKind::Claude,
            claude_command: String::new(),
            codex_command: String::new(),
            opencode_command: String::new(),
            worktree_scripts: WorktreeScripts::default(),
            claude_env_vars: IndexMap::new(),
            codex_env_vars: IndexMap::new(),
            opencode_env_vars: IndexMap::new(),
            harness_mcp_enabled: true,
            name_claude_sessions: false,
            terminal_font_family: String::new(),
            terminal_font_size: 13.0,
            editor: "vscode".to_string(),
            worktree_base: WorktreeBase::Remote,
            merge_strategy: MergeStrategy::Squash,
            worktree_detail: WorktreeDetail::Diff,
            share_claude_settings: true,
            claude_model: None,
            codex_model: None,
            opencode_model: None,
            pi_command: String::new(),
            pi_env_vars: IndexMap::new(),
            pi_model: None,
            has_github_token: false,
            github_auth_source: None,
            viewer_login: None,
            harness_starred: None,
            auto_update_enabled: true,
            experimental_chat_agents_enabled: false,
            harness_system_prompt_enabled: true,
            harness_system_prompt: String::new(),
            harness_system_prompt_main: String::new(),
            claude_tui_fullscreen: true,
            ws_transport_enabled: false,
            ws_transport_port: 37291.0,
            ws_transport_host: "127.0.0.1".to_string(),
            browser_tools_enabled: true,
            browser_tools_mode: BrowserToolsMode::Full,
            default_claude_tab_type: AgentTabType::Xterm,
            default_opencode_tab_type: AgentTabType::Xterm,
            default_codex_tab_type: AgentTabType::Xterm,
            chat_promotion_dismissed: false,
            auto_approve_permissions: false,
            auto_approve_steer_instructions: String::new(),
            use_system_claude_for_json_mode: false,
            json_mode_chat_density: JsonModeChatDensity::Compact,
            ui_scale: UiScale::Small,
            json_mode_send_on_enter: false,
            json_mode_default_permission_mode: JsonClaudePermissionMode::AcceptEdits,
            auto_sleep_minutes: 30.0,
            snooze_default_days: 7.0,
            expanded_diagnostic_logging_enabled: false,
            pr_review_prompt: DEFAULT_PR_REVIEW_PROMPT.to_string(),
            dismissed_announcement_ids: Vec::new(),
            announcements_muted: false,
            harness_config_roots: HarnessConfigRoots::default(),
            harness_config_source_dir: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
pub struct HarnessConfigRootChange {
    pub key: HarnessConfigRootKey,
    pub path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload")]
pub enum SettingsEvent {
    #[serde(rename = "settings/themeModeChanged")]
    ThemeModeChanged(ThemeMode),
    #[serde(rename = "settings/themeLightChanged")]
    ThemeLightChanged(String),
    #[serde(rename = "settings/themeDarkChanged")]
    ThemeDarkChanged(String),
    #[serde(rename = "settings/customThemesChanged")]
    CustomThemesChanged(Vec<CustomTheme>),
    #[serde(rename = "settings/hotkeysChanged")]
    HotkeysChanged(Option<IndexMap<String, String>>),
    #[serde(rename = "settings/defaultAgentChanged")]
    DefaultAgentChanged(AgentKind),
    #[serde(rename = "settings/claudeCommandChanged")]
    ClaudeCommandChanged(String),
    #[serde(rename = "settings/codexCommandChanged")]
    CodexCommandChanged(String),
    #[serde(rename = "settings/opencodeCommandChanged")]
    OpencodeCommandChanged(String),
    #[serde(rename = "settings/worktreeScriptsChanged")]
    WorktreeScriptsChanged(WorktreeScripts),
    #[serde(rename = "settings/claudeEnvVarsChanged")]
    ClaudeEnvVarsChanged(IndexMap<String, String>),
    #[serde(rename = "settings/codexEnvVarsChanged")]
    CodexEnvVarsChanged(IndexMap<String, String>),
    #[serde(rename = "settings/opencodeEnvVarsChanged")]
    OpencodeEnvVarsChanged(IndexMap<String, String>),
    #[serde(rename = "settings/harnessMcpEnabledChanged")]
    HarnessMcpEnabledChanged(bool),
    #[serde(rename = "settings/nameClaudeSessionsChanged")]
    NameClaudeSessionsChanged(bool),
    #[serde(rename = "settings/terminalFontFamilyChanged")]
    TerminalFontFamilyChanged(String),
    #[serde(rename = "settings/terminalFontSizeChanged")]
    TerminalFontSizeChanged(
        #[serde(serialize_with = "crate::wire::number::serialize")]
        #[specta(type = f64)]
        f64,
    ),
    #[serde(rename = "settings/editorChanged")]
    EditorChanged(String),
    #[serde(rename = "settings/worktreeBaseChanged")]
    WorktreeBaseChanged(WorktreeBase),
    #[serde(rename = "settings/mergeStrategyChanged")]
    MergeStrategyChanged(MergeStrategy),
    #[serde(rename = "settings/worktreeDetailChanged")]
    WorktreeDetailChanged(WorktreeDetail),
    #[serde(rename = "settings/shareClaudeSettingsChanged")]
    ShareClaudeSettingsChanged(bool),
    #[serde(rename = "settings/hasGithubTokenChanged")]
    HasGithubTokenChanged(bool),
    #[serde(rename = "settings/githubAuthSourceChanged")]
    GithubAuthSourceChanged(Option<GithubAuthSource>),
    #[serde(rename = "settings/viewerLoginChanged")]
    ViewerLoginChanged(Option<String>),
    #[serde(rename = "settings/harnessStarredChanged")]
    HarnessStarredChanged(Option<bool>),
    #[serde(rename = "settings/claudeModelChanged")]
    ClaudeModelChanged(Option<String>),
    #[serde(rename = "settings/codexModelChanged")]
    CodexModelChanged(Option<String>),
    #[serde(rename = "settings/opencodeModelChanged")]
    OpencodeModelChanged(Option<String>),
    #[serde(rename = "settings/autoUpdateEnabledChanged")]
    AutoUpdateEnabledChanged(bool),
    #[serde(rename = "settings/experimentalChatAgentsEnabledChanged")]
    ExperimentalChatAgentsEnabledChanged(bool),
    #[serde(rename = "settings/harnessSystemPromptEnabledChanged")]
    HarnessSystemPromptEnabledChanged(bool),
    #[serde(rename = "settings/harnessSystemPromptChanged")]
    HarnessSystemPromptChanged(String),
    #[serde(rename = "settings/harnessSystemPromptMainChanged")]
    HarnessSystemPromptMainChanged(String),
    #[serde(rename = "settings/claudeTuiFullscreenChanged")]
    ClaudeTuiFullscreenChanged(bool),
    #[serde(rename = "settings/wsTransportEnabledChanged")]
    WsTransportEnabledChanged(bool),
    #[serde(rename = "settings/wsTransportPortChanged")]
    WsTransportPortChanged(
        #[serde(serialize_with = "crate::wire::number::serialize")]
        #[specta(type = f64)]
        f64,
    ),
    #[serde(rename = "settings/wsTransportHostChanged")]
    WsTransportHostChanged(String),
    #[serde(rename = "settings/browserToolsEnabledChanged")]
    BrowserToolsEnabledChanged(bool),
    #[serde(rename = "settings/browserToolsModeChanged")]
    BrowserToolsModeChanged(BrowserToolsMode),
    #[serde(rename = "settings/defaultClaudeTabTypeChanged")]
    DefaultClaudeTabTypeChanged(AgentTabType),
    #[serde(rename = "settings/defaultOpencodeTabTypeChanged")]
    DefaultOpencodeTabTypeChanged(AgentTabType),
    #[serde(rename = "settings/defaultCodexTabTypeChanged")]
    DefaultCodexTabTypeChanged(AgentTabType),
    #[serde(rename = "settings/chatPromotionDismissedChanged")]
    ChatPromotionDismissedChanged(bool),
    #[serde(rename = "settings/autoApprovePermissionsChanged")]
    AutoApprovePermissionsChanged(bool),
    #[serde(rename = "settings/autoApproveSteerInstructionsChanged")]
    AutoApproveSteerInstructionsChanged(String),
    #[serde(rename = "settings/useSystemClaudeForJsonModeChanged")]
    UseSystemClaudeForJsonModeChanged(bool),
    #[serde(rename = "settings/jsonModeChatDensityChanged")]
    JsonModeChatDensityChanged(JsonModeChatDensity),
    #[serde(rename = "settings/uiScaleChanged")]
    UiScaleChanged(UiScale),
    #[serde(rename = "settings/jsonModeSendOnEnterChanged")]
    JsonModeSendOnEnterChanged(bool),
    #[serde(rename = "settings/jsonModeDefaultPermissionModeChanged")]
    JsonModeDefaultPermissionModeChanged(JsonClaudePermissionMode),
    #[serde(rename = "settings/autoSleepMinutesChanged")]
    AutoSleepMinutesChanged(
        #[serde(serialize_with = "crate::wire::number::serialize")]
        #[specta(type = f64)]
        f64,
    ),
    #[serde(rename = "settings/snoozeDefaultDaysChanged")]
    SnoozeDefaultDaysChanged(
        #[serde(serialize_with = "crate::wire::number::serialize")]
        #[specta(type = f64)]
        f64,
    ),
    #[serde(rename = "settings/expandedDiagnosticLoggingEnabledChanged")]
    ExpandedDiagnosticLoggingEnabledChanged(bool),
    #[serde(rename = "settings/prReviewPromptChanged")]
    PrReviewPromptChanged(String),
    #[serde(rename = "settings/announcementDismissed")]
    AnnouncementDismissed(String),
    #[serde(rename = "settings/announcementsMutedChanged")]
    AnnouncementsMutedChanged(bool),
    #[serde(rename = "settings/piCommandChanged")]
    PiCommandChanged(String),
    #[serde(rename = "settings/piEnvVarsChanged")]
    PiEnvVarsChanged(IndexMap<String, String>),
    #[serde(rename = "settings/piModelChanged")]
    PiModelChanged(Option<String>),
    #[serde(rename = "settings/harnessConfigRootsChanged")]
    HarnessConfigRootsChanged(HarnessConfigRootChange),
    #[serde(rename = "settings/harnessConfigSourceDirChanged")]
    HarnessConfigSourceDirChanged(Option<String>),
}

pub fn reduce(state: &mut SettingsState, event: SettingsEvent) {
    use SettingsEvent as E;
    match event {
        E::ThemeModeChanged(v) => state.theme_mode = v,
        E::ThemeLightChanged(v) => state.theme_light = v,
        E::ThemeDarkChanged(v) => state.theme_dark = v,
        E::CustomThemesChanged(v) => state.custom_themes = v,
        E::HotkeysChanged(v) => state.hotkeys = v,
        E::DefaultAgentChanged(v) => state.default_agent = v,
        E::ClaudeCommandChanged(v) => state.claude_command = v,
        E::CodexCommandChanged(v) => state.codex_command = v,
        E::OpencodeCommandChanged(v) => state.opencode_command = v,
        E::WorktreeScriptsChanged(v) => state.worktree_scripts = v,
        E::ClaudeEnvVarsChanged(v) => state.claude_env_vars = v,
        E::CodexEnvVarsChanged(v) => state.codex_env_vars = v,
        E::OpencodeEnvVarsChanged(v) => state.opencode_env_vars = v,
        E::HarnessMcpEnabledChanged(v) => state.harness_mcp_enabled = v,
        E::NameClaudeSessionsChanged(v) => state.name_claude_sessions = v,
        E::TerminalFontFamilyChanged(v) => state.terminal_font_family = v,
        E::TerminalFontSizeChanged(v) => state.terminal_font_size = v,
        E::EditorChanged(v) => state.editor = v,
        E::WorktreeBaseChanged(v) => state.worktree_base = v,
        E::MergeStrategyChanged(v) => state.merge_strategy = v,
        E::WorktreeDetailChanged(v) => state.worktree_detail = v,
        E::ShareClaudeSettingsChanged(v) => state.share_claude_settings = v,
        E::HasGithubTokenChanged(v) => state.has_github_token = v,
        E::GithubAuthSourceChanged(v) => state.github_auth_source = v,
        E::ViewerLoginChanged(v) => state.viewer_login = v,
        E::HarnessStarredChanged(v) => state.harness_starred = v,
        E::ClaudeModelChanged(v) => state.claude_model = v,
        E::CodexModelChanged(v) => state.codex_model = v,
        E::OpencodeModelChanged(v) => state.opencode_model = v,
        E::AutoUpdateEnabledChanged(v) => state.auto_update_enabled = v,
        E::ExperimentalChatAgentsEnabledChanged(v) => state.experimental_chat_agents_enabled = v,
        E::HarnessSystemPromptEnabledChanged(v) => state.harness_system_prompt_enabled = v,
        E::HarnessSystemPromptChanged(v) => state.harness_system_prompt = v,
        E::HarnessSystemPromptMainChanged(v) => state.harness_system_prompt_main = v,
        E::ClaudeTuiFullscreenChanged(v) => state.claude_tui_fullscreen = v,
        E::WsTransportEnabledChanged(v) => state.ws_transport_enabled = v,
        E::WsTransportPortChanged(v) => state.ws_transport_port = v,
        E::WsTransportHostChanged(v) => state.ws_transport_host = v,
        E::BrowserToolsEnabledChanged(v) => state.browser_tools_enabled = v,
        E::BrowserToolsModeChanged(v) => state.browser_tools_mode = v,
        E::DefaultClaudeTabTypeChanged(v) => state.default_claude_tab_type = v,
        E::DefaultOpencodeTabTypeChanged(v) => state.default_opencode_tab_type = v,
        E::DefaultCodexTabTypeChanged(v) => state.default_codex_tab_type = v,
        E::ChatPromotionDismissedChanged(v) => state.chat_promotion_dismissed = v,
        E::AutoApprovePermissionsChanged(v) => state.auto_approve_permissions = v,
        E::AutoApproveSteerInstructionsChanged(v) => state.auto_approve_steer_instructions = v,
        E::UseSystemClaudeForJsonModeChanged(v) => state.use_system_claude_for_json_mode = v,
        E::JsonModeChatDensityChanged(v) => state.json_mode_chat_density = v,
        E::UiScaleChanged(v) => state.ui_scale = v,
        E::JsonModeSendOnEnterChanged(v) => state.json_mode_send_on_enter = v,
        E::JsonModeDefaultPermissionModeChanged(v) => state.json_mode_default_permission_mode = v,
        E::AutoSleepMinutesChanged(v) => state.auto_sleep_minutes = v,
        E::SnoozeDefaultDaysChanged(v) => state.snooze_default_days = v,
        E::ExpandedDiagnosticLoggingEnabledChanged(v) => {
            state.expanded_diagnostic_logging_enabled = v
        }
        E::PrReviewPromptChanged(v) => state.pr_review_prompt = v,
        E::AnnouncementDismissed(id) => {
            if !state.dismissed_announcement_ids.contains(&id) {
                state.dismissed_announcement_ids.push(id);
            }
        }
        E::AnnouncementsMutedChanged(v) => state.announcements_muted = v,
        E::PiCommandChanged(v) => state.pi_command = v,
        E::PiEnvVarsChanged(v) => state.pi_env_vars = v,
        E::PiModelChanged(v) => state.pi_model = v,
        E::HarnessConfigRootsChanged(HarnessConfigRootChange { key, path }) => match path {
            None => {
                state.harness_config_roots.0.shift_remove(&key);
            }
            Some(path) => {
                state.harness_config_roots.0.insert(key, path);
            }
        },
        E::HarnessConfigSourceDirChanged(v) => state.harness_config_source_dir = v,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn roots(state: &SettingsState) -> Vec<HarnessConfigRootKey> {
        state.harness_config_roots.0.keys().copied().collect()
    }

    fn set_root(state: &mut SettingsState, key: HarnessConfigRootKey, path: Option<&str>) {
        reduce(
            state,
            SettingsEvent::HarnessConfigRootsChanged(HarnessConfigRootChange {
                key,
                path: path.map(str::to_string),
            }),
        );
    }

    fn state_with_roots(keys: &[HarnessConfigRootKey]) -> SettingsState {
        let mut state = SettingsState::default();
        for key in keys {
            set_root(&mut state, *key, Some("/old"));
        }
        state
    }

    use HarnessConfigRootKey::{ClaudeAgents, CodexHome, OpencodeSkills};

    #[test]
    fn setting_an_existing_root_keeps_its_position() {
        let mut state = state_with_roots(&[ClaudeAgents, CodexHome, OpencodeSkills]);
        set_root(&mut state, ClaudeAgents, Some("/new"));
        assert_eq!(roots(&state), [ClaudeAgents, CodexHome, OpencodeSkills]);
        assert_eq!(state.harness_config_roots.0[&ClaudeAgents], "/new");
    }

    #[test]
    fn removing_a_root_keeps_the_order_of_the_rest() {
        let mut state = state_with_roots(&[ClaudeAgents, CodexHome, OpencodeSkills]);
        set_root(&mut state, ClaudeAgents, None);
        assert_eq!(roots(&state), [CodexHome, OpencodeSkills]);
    }

    #[test]
    fn a_removed_root_set_again_moves_to_the_end() {
        let mut state = state_with_roots(&[ClaudeAgents, CodexHome]);
        set_root(&mut state, ClaudeAgents, None);
        set_root(&mut state, ClaudeAgents, Some("/back"));
        assert_eq!(roots(&state), [CodexHome, ClaudeAgents]);
    }

    #[test]
    fn partial_settings_fill_from_the_initial_state_and_ignore_unknown_fields() {
        let state: SettingsState = serde_json::from_value(json!({
            "themeMode": "dark",
            "terminalFontSize": 14.5,
            "removedInANewerBuild": { "nested": true }
        }))
        .unwrap();
        assert_eq!(
            state,
            SettingsState {
                theme_mode: ThemeMode::Dark,
                terminal_font_size: 14.5,
                ..SettingsState::default()
            }
        );
    }

    #[test]
    fn nullable_fields_serialize_as_null_and_whole_numbers_without_a_fraction() {
        let value = serde_json::to_value(SettingsState::default()).unwrap();
        for key in [
            "hotkeys",
            "claudeModel",
            "codexModel",
            "opencodeModel",
            "piModel",
            "githubAuthSource",
            "viewerLogin",
            "harnessStarred",
            "harnessConfigSourceDir",
        ] {
            assert_eq!(value[key], json!(null), "{key}");
        }
        assert_eq!(
            serde_json::to_string(&value["wsTransportPort"]).unwrap(),
            "37291"
        );
    }
}

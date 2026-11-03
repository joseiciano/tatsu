pub mod constants;

use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use tatsu_state::AppState;
use tatsu_state::slices::json_claude::JsonClaudePermissionMode;
use tatsu_state::slices::onboarding::QuestStep;
use tatsu_state::slices::settings::{
    AgentTabType, BrowserToolsMode, JsonModeChatDensity, ThemeMode, UiScale, WorktreeScripts,
};
use tatsu_state::slices::terminals::AgentKind;

use crate::config::ConfigView;
use crate::logs;
use constants::*;

pub type SeedHook = Box<dyn Fn(&ConfigView, &mut AppState) + Send + Sync>;

pub fn build_initial_state(
    view: &ConfigView,
    has_github_token: bool,
    hooks: &[SeedHook],
) -> AppState {
    build_with_report(view, has_github_token, hooks, &mut |key| {
        logs::log(
            "config",
            &format!("initial state: config value for {key} has the wrong type; using the default"),
        )
    })
}

pub(crate) fn build_with_report(
    view: &ConfigView,
    has_github_token: bool,
    hooks: &[SeedHook],
    report: &mut dyn FnMut(&str),
) -> AppState {
    let mut rules = Rules { view, report };
    let mut state = AppState::default();
    apply_settings(&mut rules, &mut state, has_github_token);
    apply_slices(&mut rules, &mut state);
    for hook in hooks {
        hook(view, &mut state);
    }
    state
}

struct Rules<'a> {
    view: &'a ConfigView,
    report: &'a mut dyn FnMut(&str),
}

impl Rules<'_> {
    fn raw(&self, key: &str) -> Option<&Value> {
        self.view.get_raw(key)
    }

    fn decode_or<T: DeserializeOwned>(&mut self, key: &str, value: &Value, default: T) -> T {
        T::deserialize(value).unwrap_or_else(|_| {
            (self.report)(key);
            default
        })
    }

    fn or<T: DeserializeOwned>(&mut self, key: &str, default: T) -> T {
        match self.raw(key).filter(|v| tatsu_js::truthy(v)).cloned() {
            Some(value) => self.decode_or(key, &value, default),
            None => default,
        }
    }

    fn or_string(&mut self, key: &str, default: &str) -> String {
        self.or(key, default.to_owned())
    }

    fn nullish<T: DeserializeOwned>(&mut self, key: &str, default: T) -> T {
        match self.raw(key).filter(|v| !v.is_null()).cloned() {
            Some(value) => self.decode_or(key, &value, default),
            None => default,
        }
    }

    fn not_false(&self, key: &str) -> bool {
        self.raw(key) != Some(&Value::Bool(false))
    }

    fn is_true(&self, key: &str) -> bool {
        self.raw(key) == Some(&Value::Bool(true))
    }

    fn choice<T: DeserializeOwned>(&self, key: &str, allowed: &[&str], default: T) -> T {
        match self.raw(key) {
            Some(value @ Value::String(s)) if allowed.contains(&s.as_str()) => {
                T::deserialize(value).unwrap_or(default)
            }
            _ => default,
        }
    }
}

fn apply_settings(r: &mut Rules, state: &mut AppState, has_github_token: bool) {
    let s = &mut state.settings;
    s.theme_mode = r.choice("themeMode", &["light", "dark"], ThemeMode::System);
    s.theme_light = r.or_string("themeLight", DEFAULT_LIGHT_THEME);
    s.theme_dark = r.or_string("themeDark", DEFAULT_DARK_THEME);
    s.hotkeys = r.or("hotkeys", None);
    s.default_agent = r.or("defaultAgent", AgentKind::Claude);
    s.claude_command = r.or_string("claudeCommand", DEFAULT_CLAUDE_COMMAND);
    s.codex_command = r.or_string("codexCommand", DEFAULT_CODEX_COMMAND);
    s.opencode_command = r.or_string("opencodeCommand", DEFAULT_OPENCODE_COMMAND);
    s.worktree_scripts = WorktreeScripts {
        setup: r.or_string("worktreeSetupCommand", ""),
        teardown: r.or_string("worktreeTeardownCommand", ""),
    };
    s.claude_env_vars = r.or("claudeEnvVars", Default::default());
    s.codex_env_vars = r.or("codexEnvVars", Default::default());
    s.opencode_env_vars = r.or("opencodeEnvVars", Default::default());
    s.harness_mcp_enabled = r.not_false("harnessMcpEnabled");
    s.name_claude_sessions = r.nullish("nameClaudeSessions", false);
    s.terminal_font_family = r.or_string("terminalFontFamily", DEFAULT_TERMINAL_FONT_FAMILY);
    s.terminal_font_size = r.or("terminalFontSize", DEFAULT_TERMINAL_FONT_SIZE);
    s.editor = r.or_string("editor", DEFAULT_EDITOR_ID);
    s.worktree_base = r.or("worktreeBase", DEFAULT_WORKTREE_BASE);
    s.merge_strategy = r.or("mergeStrategy", DEFAULT_MERGE_STRATEGY);
    s.worktree_detail = r.or("worktreeDetail", DEFAULT_WORKTREE_DETAIL);
    s.claude_model = r.or("claudeModel", None);
    s.codex_model = r.or("codexModel", None);
    s.opencode_model = r.or("opencodeModel", None);
    s.pi_command = r.or_string("piCommand", DEFAULT_PI_COMMAND);
    s.pi_env_vars = r.or("piEnvVars", Default::default());
    s.pi_model = r.or("piModel", None);
    s.has_github_token = has_github_token;
    s.auto_update_enabled = r.not_false("autoUpdateEnabled");
    s.experimental_chat_agents_enabled = r.is_true("experimentalChatAgentsEnabled");
    s.share_claude_settings = r.not_false("shareClaudeSettings");
    s.harness_system_prompt_enabled = r.not_false("harnessSystemPromptEnabled");
    s.harness_system_prompt = r.or_string("harnessSystemPrompt", DEFAULT_HARNESS_SYSTEM_PROMPT);
    s.harness_system_prompt_main = r.or_string(
        "harnessSystemPromptMain",
        DEFAULT_HARNESS_SYSTEM_PROMPT_MAIN,
    );
    s.claude_tui_fullscreen = r.not_false("claudeTuiFullscreen");
    s.ws_transport_enabled = r.is_true("wsTransportEnabled");
    s.ws_transport_port = r.nullish("wsTransportPort", DEFAULT_WS_TRANSPORT_PORT);
    s.ws_transport_host = r.nullish("wsTransportHost", DEFAULT_WS_TRANSPORT_HOST.to_owned());
    s.browser_tools_enabled = r.not_false("browserToolsEnabled");
    s.browser_tools_mode = r.choice("browserToolsMode", &["view"], BrowserToolsMode::Full);
    s.default_claude_tab_type = r.choice("defaultClaudeTabType", &["json"], AgentTabType::Xterm);
    s.default_opencode_tab_type =
        r.choice("defaultOpencodeTabType", &["json"], AgentTabType::Xterm);
    s.default_codex_tab_type = r.choice("defaultCodexTabType", &["json"], AgentTabType::Xterm);
    s.chat_promotion_dismissed = r.is_true("chatPromotionDismissed");
    s.json_mode_chat_density = r.choice(
        "jsonModeChatDensity",
        &["comfy"],
        JsonModeChatDensity::Compact,
    );
    s.ui_scale = r.choice(
        "uiScale",
        &["x-small", "medium", "large", "x-large"],
        UiScale::Small,
    );
    s.json_mode_send_on_enter = r.is_true("jsonModeSendOnEnter");
    s.json_mode_default_permission_mode = r.choice(
        "jsonModeDefaultPermissionMode",
        &["default", "plan"],
        JsonClaudePermissionMode::AcceptEdits,
    );
    s.auto_sleep_minutes = auto_sleep_minutes(r.raw("autoSleepMinutes"));
    s.snooze_default_days = snooze_default_days(r.raw("snoozeDefaultDays"));
    s.expanded_diagnostic_logging_enabled = r.is_true("expandedDiagnosticLoggingEnabled");
    s.pr_review_prompt = r.or_string("prReviewPrompt", DEFAULT_PR_REVIEW_PROMPT);
    s.dismissed_announcement_ids = match r.raw("dismissedAnnouncementIds") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    };
    s.announcements_muted = r.is_true("announcementsMuted");
}

fn auto_sleep_minutes(value: Option<&Value>) -> f64 {
    match value.and_then(Value::as_f64) {
        Some(minutes) if minutes.is_finite() && minutes >= 0.0 => minutes.floor(),
        _ => DEFAULT_AUTO_SLEEP_MINUTES,
    }
}

fn snooze_default_days(value: Option<&Value>) -> f64 {
    let days = match value {
        None | Some(Value::Null) => DEFAULT_SNOOZE_DAYS,
        Some(value) => tatsu_js::to_number(value).floor(),
    };
    if days.is_nan() { days } else { days.max(1.0) }
}

fn apply_slices(r: &mut Rules, state: &mut AppState) {
    state.onboarding.quest = match r.raw("onboarding").cloned() {
        Some(Value::Object(onboarding)) => match onboarding.get("quest") {
            None | Some(Value::Null) => QuestStep::Hidden,
            Some(quest) => r.decode_or("onboarding.quest", quest, QuestStep::Hidden),
        },
        _ => QuestStep::Hidden,
    };
    state.worktrees.repo_roots = r.or("repoRoots", Vec::new());
    if let Some(costs) = r.raw("costs").filter(|v| tatsu_js::truthy(v)).cloned() {
        let mut merged = Map::new();
        merged.insert("byTerminal".to_owned(), Value::Object(Map::new()));
        match costs {
            Value::Object(fields) => {
                if fields.keys().any(|k| k != "byTerminal") {
                    (r.report)("costs");
                }
                merged.extend(fields);
            }
            _ => (r.report)("costs"),
        }
        state.costs = r.decode_or("costs", &Value::Object(merged), Default::default());
    }
    if let Some(snooze) = r.raw("snooze").filter(|v| tatsu_js::truthy(v)).cloned() {
        state.snooze.by_path = r.decode_or("snooze", &snooze, Default::default());
    }
    if let Some(nested) = r
        .raw("scratchpadNotes")
        .filter(|v| tatsu_js::truthy(v))
        .cloned()
    {
        flatten_scratchpad(r, state, &nested);
    }
}

fn flatten_scratchpad(r: &mut Rules, state: &mut AppState, nested: &Value) {
    let Value::Object(repos) = nested else {
        (r.report)("scratchpadNotes");
        return;
    };
    for by_path in repos.values().filter(|v| tatsu_js::truthy(v)) {
        let Value::Object(by_path) = by_path else {
            (r.report)("scratchpadNotes");
            continue;
        };
        for (worktree_path, text) in by_path {
            if let Some(text) = text.as_str().filter(|t| !t.is_empty()) {
                state
                    .scratchpad
                    .by_worktree_path
                    .insert(worktree_path.clone(), text.to_owned());
            }
        }
    }
}

#[cfg(test)]
mod tests;

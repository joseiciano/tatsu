mod activity;
mod agents;
mod chat_ui;
mod hooks;
mod info;
mod logs;
mod onboarding;
mod prompts;
mod repo_config;
mod scratchpad;
mod settings;
mod tab_types;
mod terminal_font;
mod themes;
mod timers;
mod toggles;
mod worktree_settings;
mod ws;

use std::sync::{Arc, Weak};

use serde_json::Value;

use crate::lifecycle::Core;

pub(crate) use themes::reload_custom_themes;

pub fn register_core_handlers(core: &Arc<Core>) {
    settings::register(core);
    onboarding::register(core);
    agents::register(core);
    toggles::register(core);
    prompts::register(core);
    worktree_settings::register(core);
    terminal_font::register(core);
    timers::register(core);
    tab_types::register(core);
    chat_ui::register(core);
    themes::register(core);
    repo_config::register(core);
    scratchpad::register(core);
    hooks::register(core);
    ws::register(core);
    logs::register(core);
    info::register(core);
    activity::register(core);
}

fn upgrade(core: &Weak<Core>) -> Result<Arc<Core>, String> {
    core.upgrade().ok_or_else(|| "core shut down".to_owned())
}

fn trim_or_empty<'a>(value: Option<&'a Value>, expr: &str) -> Result<&'a str, String> {
    match value {
        Some(Value::String(s)) => Ok(tatsu_js::trim(s)),
        Some(v) if tatsu_js::truthy(v) => Err(format!("({expr}).trim is not a function")),
        _ => Ok(""),
    }
}

fn js_math_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

mod agents;
mod chat_ui;
mod onboarding;
mod prompts;
mod settings;
mod tab_types;
mod terminal_font;
mod timers;
mod toggles;
mod worktree_settings;

use std::sync::{Arc, Weak};

use serde_json::Value;

use crate::lifecycle::Core;

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

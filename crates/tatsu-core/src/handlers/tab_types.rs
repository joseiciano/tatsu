use std::sync::Arc;

use serde_json::Value;
use tatsu_state::StateEvent;
use tatsu_state::slices::settings::{AgentTabType, SettingsEvent};

use super::upgrade;
use crate::lifecycle::Core;
use crate::router::Reply;

type TabTypeSetter = (
    &'static str,
    &'static str,
    fn(AgentTabType) -> SettingsEvent,
);

const SETTERS: [TabTypeSetter; 3] = [
    (
        "config:setDefaultClaudeTabType",
        "defaultClaudeTabType",
        SettingsEvent::DefaultClaudeTabTypeChanged,
    ),
    (
        "config:setDefaultOpencodeTabType",
        "defaultOpencodeTabType",
        SettingsEvent::DefaultOpencodeTabTypeChanged,
    ),
    (
        "config:setDefaultCodexTabType",
        "defaultCodexTabType",
        SettingsEvent::DefaultCodexTabTypeChanged,
    ),
];

pub(super) fn register(core: &Arc<Core>) {
    let router = core.router();

    for (channel, key, event) in SETTERS {
        let weak = Arc::downgrade(core);
        router
            .request(channel, move |_ctx, args| {
                let core = upgrade(&weak);
                async move {
                    let core = core?;
                    let next = match args.first() {
                        Some(Value::String(s)) if s == "json" => AgentTabType::Json,
                        _ => AgentTabType::Xterm,
                    };
                    match next {
                        AgentTabType::Xterm => {
                            core.config().remove(key);
                        }
                        AgentTabType::Json => {
                            core.config().set(key, Value::String("json".to_owned()));
                        }
                    }
                    core.store().dispatch(StateEvent::Settings(event(next)));
                    Ok(Reply::Value(Value::Bool(true)))
                }
            })
            .expect("tab type setter registers once");
    }
}

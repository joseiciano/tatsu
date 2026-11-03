use std::sync::Arc;

use serde_json::Value;
use tatsu_state::StateEvent;
use tatsu_state::slices::settings::SettingsEvent;

use super::upgrade;
use crate::agent_kind;
use crate::lifecycle::Core;
use crate::router::Reply;

const HOTKEYS_KEY: &str = "hotkeys";
const DEFAULT_AGENT_KEY: &str = "defaultAgent";

pub(super) fn register(core: &Arc<Core>) {
    let router = core.router();

    let weak = Arc::downgrade(core);
    router
        .request("config:setHotkeys", move |_ctx, args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                let raw = args.first().cloned().unwrap_or(Value::Null);
                // TS stores and dispatches any argument; the hotkeysChanged event cannot carry a non-map, so a non-map or null argument is an error reply here.
                let hotkeys = serde_json::from_value(raw.clone()).map_err(|e| e.to_string())?;
                core.config().set(HOTKEYS_KEY, raw);
                core.store()
                    .dispatch(StateEvent::Settings(SettingsEvent::HotkeysChanged(Some(
                        hotkeys,
                    ))));
                Ok(Reply::Value(Value::Bool(true)))
            }
        })
        .expect("config:setHotkeys registers once");

    let weak = Arc::downgrade(core);
    router
        .request("config:resetHotkeys", move |_ctx, _args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                core.config().remove(HOTKEYS_KEY);
                core.store()
                    .dispatch(StateEvent::Settings(SettingsEvent::HotkeysChanged(None)));
                Ok(Reply::Value(Value::Bool(true)))
            }
        })
        .expect("config:resetHotkeys registers once");

    let weak = Arc::downgrade(core);
    router
        .request("config:setDefaultAgent", move |_ctx, args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                let kind = agent_kind::parse(args.first().and_then(Value::as_str));
                let value = serde_json::to_value(kind).map_err(|e| e.to_string())?;
                core.config().set(DEFAULT_AGENT_KEY, value);
                core.store()
                    .dispatch(StateEvent::Settings(SettingsEvent::DefaultAgentChanged(
                        kind,
                    )));
                Ok(Reply::Value(Value::Bool(true)))
            }
        })
        .expect("config:setDefaultAgent registers once");
}

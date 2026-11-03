use std::sync::Arc;

use serde_json::Value;
use tatsu_state::StateEvent;
use tatsu_state::slices::json_claude::JsonClaudePermissionMode;
use tatsu_state::slices::settings::{JsonModeChatDensity, SettingsEvent, UiScale};

use super::upgrade;
use crate::lifecycle::Core;
use crate::router::Reply;

pub(super) fn register(core: &Arc<Core>) {
    let router = core.router();

    let weak = Arc::downgrade(core);
    router
        .request("config:setChatPromotionDismissed", move |_ctx, args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                // TS dispatches the raw argument; the bool event carries its truthiness instead.
                let dismissed = args.first().is_some_and(tatsu_js::truthy);
                if dismissed {
                    core.config()
                        .set("chatPromotionDismissed", Value::Bool(true));
                } else {
                    core.config().remove("chatPromotionDismissed");
                }
                core.store().dispatch(StateEvent::Settings(
                    SettingsEvent::ChatPromotionDismissedChanged(dismissed),
                ));
                Ok(Reply::Value(Value::Bool(true)))
            }
        })
        .expect("config:setChatPromotionDismissed registers once");

    let weak = Arc::downgrade(core);
    router
        .request("config:setJsonModeChatDensity", move |_ctx, args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                let (next, stored) = match string_arg(&args) {
                    Some("comfy") => (JsonModeChatDensity::Comfy, Some("comfy")),
                    _ => (JsonModeChatDensity::Compact, None),
                };
                store_or_remove(&core, "jsonModeChatDensity", stored);
                core.store().dispatch(StateEvent::Settings(
                    SettingsEvent::JsonModeChatDensityChanged(next),
                ));
                Ok(Reply::Value(Value::Bool(true)))
            }
        })
        .expect("config:setJsonModeChatDensity registers once");

    let weak = Arc::downgrade(core);
    router
        .request("config:setUiScale", move |_ctx, args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                let (next, stored) = match string_arg(&args) {
                    Some("x-small") => (UiScale::XSmall, Some("x-small")),
                    Some("medium") => (UiScale::Medium, Some("medium")),
                    Some("large") => (UiScale::Large, Some("large")),
                    Some("x-large") => (UiScale::XLarge, Some("x-large")),
                    _ => (UiScale::Small, None),
                };
                store_or_remove(&core, "uiScale", stored);
                core.store()
                    .dispatch(StateEvent::Settings(SettingsEvent::UiScaleChanged(next)));
                Ok(Reply::Value(Value::Bool(true)))
            }
        })
        .expect("config:setUiScale registers once");

    let weak = Arc::downgrade(core);
    router
        .request("config:setJsonModeSendOnEnter", move |_ctx, args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                let next = matches!(args.first(), Some(Value::Bool(true)));
                if next {
                    core.config().set("jsonModeSendOnEnter", Value::Bool(true));
                } else {
                    core.config().remove("jsonModeSendOnEnter");
                }
                core.store().dispatch(StateEvent::Settings(
                    SettingsEvent::JsonModeSendOnEnterChanged(next),
                ));
                Ok(Reply::Value(Value::Bool(true)))
            }
        })
        .expect("config:setJsonModeSendOnEnter registers once");

    let weak = Arc::downgrade(core);
    router
        .request(
            "config:setJsonModeDefaultPermissionMode",
            move |_ctx, args| {
                let core = upgrade(&weak);
                async move {
                    let core = core?;
                    let (next, stored) = match string_arg(&args) {
                        Some("default") => (JsonClaudePermissionMode::Default, Some("default")),
                        Some("plan") => (JsonClaudePermissionMode::Plan, Some("plan")),
                        _ => (JsonClaudePermissionMode::AcceptEdits, None),
                    };
                    store_or_remove(&core, "jsonModeDefaultPermissionMode", stored);
                    core.store().dispatch(StateEvent::Settings(
                        SettingsEvent::JsonModeDefaultPermissionModeChanged(next),
                    ));
                    Ok(Reply::Value(Value::Bool(true)))
                }
            },
        )
        .expect("config:setJsonModeDefaultPermissionMode registers once");
}

fn string_arg(args: &[Value]) -> Option<&str> {
    match args.first() {
        Some(Value::String(s)) => Some(s),
        _ => None,
    }
}

fn store_or_remove(core: &Core, key: &str, stored: Option<&str>) {
    match stored {
        Some(value) => {
            core.config().set(key, Value::String(value.to_owned()));
        }
        None => {
            core.config().remove(key);
        }
    }
}

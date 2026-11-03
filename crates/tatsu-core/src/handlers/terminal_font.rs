use std::sync::Arc;

use serde_json::Value;
use tatsu_state::StateEvent;
use tatsu_state::slices::settings::SettingsEvent;

use super::{js_math_round, trim_or_empty, upgrade};
use crate::initial_state::constants::{DEFAULT_TERMINAL_FONT_FAMILY, DEFAULT_TERMINAL_FONT_SIZE};
use crate::lifecycle::Core;
use crate::router::Reply;

pub(super) fn register(core: &Arc<Core>) {
    let router = core.router();

    let weak = Arc::downgrade(core);
    router
        .request("config:setTerminalFontFamily", move |_ctx, args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                let trimmed = trim_or_empty(args.first(), "fontFamily || \"\"")?;
                let payload = if trimmed.is_empty() || trimmed == DEFAULT_TERMINAL_FONT_FAMILY {
                    core.config().remove("terminalFontFamily");
                    DEFAULT_TERMINAL_FONT_FAMILY
                } else {
                    core.config()
                        .set("terminalFontFamily", Value::String(trimmed.to_owned()));
                    trimmed
                };
                core.store().dispatch(StateEvent::Settings(
                    SettingsEvent::TerminalFontFamilyChanged(payload.to_owned()),
                ));
                Ok(Reply::Value(Value::Bool(true)))
            }
        })
        .expect("config:setTerminalFontFamily registers once");

    router
        .request("config:getDefaultTerminalFontFamily", |_ctx, _args| async {
            Ok(Reply::Value(Value::String(
                DEFAULT_TERMINAL_FONT_FAMILY.to_owned(),
            )))
        })
        .expect("config:getDefaultTerminalFontFamily registers once");

    let weak = Arc::downgrade(core);
    router
        .request("config:setTerminalFontSize", move |_ctx, args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                let n = args.first().map_or(f64::NAN, tatsu_js::to_number);
                if !(8.0..=48.0).contains(&n) {
                    return Ok(Reply::Value(Value::Bool(false)));
                }
                let rounded = js_math_round(n);
                if rounded == DEFAULT_TERMINAL_FONT_SIZE {
                    core.config().remove("terminalFontSize");
                } else {
                    core.config().set("terminalFontSize", Value::from(rounded));
                }
                core.store().dispatch(StateEvent::Settings(
                    SettingsEvent::TerminalFontSizeChanged(rounded),
                ));
                Ok(Reply::Value(Value::Bool(true)))
            }
        })
        .expect("config:setTerminalFontSize registers once");
}

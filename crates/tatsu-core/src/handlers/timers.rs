use std::sync::Arc;

use serde_json::Value;
use tatsu_state::StateEvent;
use tatsu_state::slices::settings::SettingsEvent;

use super::upgrade;
use crate::initial_state::constants::{DEFAULT_AUTO_SLEEP_MINUTES, DEFAULT_SNOOZE_DAYS};
use crate::lifecycle::Core;
use crate::router::Reply;

pub(super) fn register(core: &Arc<Core>) {
    let router = core.router();

    let weak = Arc::downgrade(core);
    router
        .request("config:setAutoSleepMinutes", move |_ctx, args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                let n = args.first().map_or(f64::NAN, tatsu_js::to_number);
                if !(0.0..=24.0 * 60.0).contains(&n) {
                    return Ok(Reply::Value(Value::Bool(false)));
                }
                let minutes = n.floor();
                store_unless_default(
                    &core,
                    "autoSleepMinutes",
                    minutes,
                    DEFAULT_AUTO_SLEEP_MINUTES,
                );
                core.store().dispatch(StateEvent::Settings(
                    SettingsEvent::AutoSleepMinutesChanged(minutes),
                ));
                Ok(Reply::Value(Value::Bool(true)))
            }
        })
        .expect("config:setAutoSleepMinutes registers once");

    let weak = Arc::downgrade(core);
    router
        .request("config:setSnoozeDefaultDays", move |_ctx, args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                let n = args.first().map_or(f64::NAN, tatsu_js::to_number);
                if !n.is_finite() {
                    return Ok(Reply::Value(Value::Bool(false)));
                }
                let days = n.floor().max(1.0);
                store_unless_default(&core, "snoozeDefaultDays", days, DEFAULT_SNOOZE_DAYS);
                core.store().dispatch(StateEvent::Settings(
                    SettingsEvent::SnoozeDefaultDaysChanged(days),
                ));
                Ok(Reply::Value(Value::Bool(true)))
            }
        })
        .expect("config:setSnoozeDefaultDays registers once");
}

fn store_unless_default(core: &Core, key: &str, value: f64, default: f64) {
    if value == default {
        core.config().remove(key);
    } else {
        core.config().set(key, Value::from(value));
    }
}

use std::sync::Arc;

use serde_json::{Value, json};
use tatsu_state::StateEvent;
use tatsu_state::slices::settings::SettingsEvent;

use super::upgrade;
use crate::lifecycle::Core;
use crate::logs;
use crate::router::Reply;
use crate::secrets::ws_token;
use crate::ws_settings::{DEFAULT_WS_HOST, DEFAULT_WS_PORT};

const ALL_INTERFACES: &str = "0.0.0.0";

pub(super) fn register(core: &Arc<Core>) {
    let router = core.router();

    let weak = Arc::downgrade(core);
    router
        .request("config:setWsTransportEnabled", move |_ctx, args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                // TS dispatches the raw argument; the bool event carries its truthiness instead.
                let enabled = args.first().is_some_and(tatsu_js::truthy);
                if enabled {
                    core.config().set("wsTransportEnabled", Value::Bool(true));
                } else {
                    core.config().remove("wsTransportEnabled");
                }
                core.store().dispatch(StateEvent::Settings(
                    SettingsEvent::WsTransportEnabledChanged(enabled),
                ));
                Ok(Reply::Value(Value::Bool(true)))
            }
        })
        .expect("config:setWsTransportEnabled registers once");

    let weak = Arc::downgrade(core);
    router
        .request("config:setWsTransportPort", move |_ctx, args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                let n = args.first().map_or(f64::NAN, tatsu_js::to_number);
                let clamped = n.floor().clamp(1024.0, 65535.0);
                if clamped == DEFAULT_WS_PORT {
                    core.config().remove("wsTransportPort");
                } else {
                    core.config().set("wsTransportPort", Value::from(clamped));
                }
                core.store()
                    .dispatch(StateEvent::Settings(SettingsEvent::WsTransportPortChanged(
                        clamped,
                    )));
                Ok(Reply::Value(Value::from(clamped)))
            }
        })
        .expect("config:setWsTransportPort registers once");

    let weak = Arc::downgrade(core);
    router
        .request("config:setWsTransportHost", move |_ctx, args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                let next = match args.first() {
                    Some(Value::String(host)) if host == ALL_INTERFACES => ALL_INTERFACES,
                    _ => DEFAULT_WS_HOST,
                };
                if next == DEFAULT_WS_HOST {
                    core.config().remove("wsTransportHost");
                } else {
                    core.config()
                        .set("wsTransportHost", Value::String(next.to_owned()));
                }
                core.store()
                    .dispatch(StateEvent::Settings(SettingsEvent::WsTransportHostChanged(
                        next.to_owned(),
                    )));
                Ok(Reply::Value(Value::String(next.to_owned())))
            }
        })
        .expect("config:setWsTransportHost registers once");

    let weak = Arc::downgrade(core);
    router
        .request("config:getWsTransportInfo", move |_ctx, _args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                let Some(bound) = core.ws_bound() else {
                    return Ok(Reply::Value(Value::Null));
                };
                Ok(Reply::Value(json!({
                    "port": bound.port,
                    "token": core.ws_token(),
                    "host": bound.host,
                })))
            }
        })
        .expect("config:getWsTransportInfo registers once");

    let weak = Arc::downgrade(core);
    router
        .request("config:rotateWsToken", move |_ctx, _args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                let next = ws_token::rotate(core.secrets().as_ref(), core.random().as_ref());
                logs::log(
                    "ws-transport",
                    "auth token rotated — takes effect on next launch",
                );
                Ok(Reply::Value(Value::String(next)))
            }
        })
        .expect("config:rotateWsToken registers once");
}

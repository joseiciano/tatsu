use std::sync::Arc;

use serde_json::Value;

use crate::lifecycle::Core;
use crate::router::Reply;

pub(super) fn register(core: &Arc<Core>) {
    core.router()
        .request("updater:getVersion", |_ctx, _args| async {
            Ok(Reply::Value(Value::String(crate::APP_VERSION.to_owned())))
        })
        .expect("updater:getVersion registers once");

    core.router()
        .request("net:getLanAddresses", |_ctx, _args| async {
            let addresses = crate::net::lan_addresses();
            Ok(Reply::Value(
                serde_json::to_value(addresses).expect("LAN addresses serialize"),
            ))
        })
        .expect("net:getLanAddresses registers once");
}

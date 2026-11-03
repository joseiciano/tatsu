use std::sync::Arc;

use serde_json::Value;

use super::upgrade;
use crate::activity::ActivityState;
use crate::lifecycle::Core;
use crate::router::{Args, Reply};

pub(super) fn register(core: &Arc<Core>) {
    let weak = Arc::downgrade(core);
    core.router()
        .signal("activity:record", move |_ctx, args| {
            let core = upgrade(&weak)?;
            // TS records whatever it is sent; a strict decode here is deliberate, so bad input is dropped and the router logs its signal error line.
            let (path, state) = <(String, ActivityState)>::decode(&args)?;
            core.activity().record(&path, state);
            Ok(())
        })
        .expect("activity:record registers once");

    let weak = Arc::downgrade(core);
    core.router()
        .request("activity:get", move |_ctx, _args| {
            let core = upgrade(&weak);
            async move { Ok(Reply::Value(core?.activity().get())) }
        })
        .expect("activity:get registers once");

    let weak = Arc::downgrade(core);
    core.router()
        .request("activity:clear", move |_ctx, args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                match args.first().filter(|path| tatsu_js::truthy(path)) {
                    Some(path) => core.activity().clear(&path_key(path)),
                    None => core.activity().clear_all(),
                }
                Ok(Reply::Value(Value::Bool(true)))
            }
        })
        .expect("activity:clear registers once");
}

// JS deletes `log[path]`, which turns a non-string key into its string form.
fn path_key(path: &Value) -> String {
    match path {
        Value::String(path) => path.clone(),
        other => tatsu_js::to_js_string(other),
    }
}

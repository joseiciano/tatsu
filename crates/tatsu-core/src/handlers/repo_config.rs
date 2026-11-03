use std::sync::Arc;

use serde_json::Value;
use tatsu_state::StateEvent;
use tatsu_state::slices::repo_configs::{RepoConfigChange, RepoConfigsEvent};

use super::upgrade;
use crate::lifecycle::Core;
use crate::repo_config::sanitize;
use crate::router::Reply;

fn path_type_error(value: &Value) -> String {
    let received = match value {
        Value::Bool(b) => format!("type boolean ({b})"),
        Value::Number(n) => format!(
            "type number ({})",
            tatsu_js::number_to_string(n.as_f64().unwrap_or(f64::NAN))
        ),
        Value::Array(_) => "an instance of Array".to_owned(),
        _ => "an instance of Object".to_owned(),
    };
    format!("The \"path\" argument must be of type string. Received {received}")
}

fn command_type_error(next: Option<&Value>) -> Option<String> {
    let Some(Value::Object(next)) = next else {
        return None;
    };
    ["setupCommand", "teardownCommand"]
        .into_iter()
        .find(|key| !matches!(next.get(*key), None | Some(Value::Null | Value::String(_))))
        .map(|key| format!("next.{key}?.trim is not a function"))
}

pub(super) fn register(core: &Arc<Core>) {
    let weak = Arc::downgrade(core);
    core.router()
        .request("repoConfig:set", move |_ctx, args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                let repo_root = match args.first() {
                    Some(root) if !tatsu_js::truthy(root) => return Ok(Reply::Value(Value::Null)),
                    None => return Ok(Reply::Value(Value::Null)),
                    Some(Value::String(root)) => root.clone(),
                    Some(root) => return Err(path_type_error(root)),
                };
                let next = args.get(1);
                if let Some(error) = command_type_error(next) {
                    return Err(error);
                }
                let saved = core.repo_configs().update(&repo_root, |current| {
                    let Ok(Value::Object(mut merged)) = serde_json::to_value(&current) else {
                        return current;
                    };
                    if let Some(Value::Object(next)) = next {
                        for (key, value) in next {
                            if value.is_null() {
                                merged.shift_remove(key);
                            } else {
                                merged.insert(key.clone(), value.clone());
                            }
                        }
                    }
                    // TS writes a truthy mergeStrategy or hiddenRightPanels value as given; the strict type cannot hold an unknown one, so it is dropped.
                    sanitize(&Value::Object(merged)).0
                });
                core.store()
                    .dispatch(StateEvent::RepoConfigs(RepoConfigsEvent::Changed(
                        RepoConfigChange {
                            repo_root,
                            config: saved.clone(),
                        },
                    )));
                let reply = serde_json::to_value(&saved).map_err(|err| err.to_string())?;
                Ok(Reply::Value(reply))
            }
        })
        .expect("repoConfig:set registers once");
}

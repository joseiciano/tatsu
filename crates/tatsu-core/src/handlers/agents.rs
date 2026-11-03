use std::sync::Arc;

use serde_json::Value;
use tatsu_state::StateEvent;
use tatsu_state::slices::settings::SettingsEvent;

use super::upgrade;
use crate::initial_state::constants::{
    DEFAULT_CLAUDE_COMMAND, DEFAULT_CODEX_COMMAND, DEFAULT_OPENCODE_COMMAND, DEFAULT_PI_COMMAND,
};
use crate::lifecycle::Core;
use crate::router::Reply;

type EnvVars = Vec<(String, String)>;
type CommandSetter = (
    &'static str,
    &'static str,
    &'static str,
    fn(String) -> SettingsEvent,
);
type ModelSetter = (
    &'static str,
    &'static str,
    fn(Option<String>) -> SettingsEvent,
);
type EnvVarsSetter = (&'static str, &'static str, fn(EnvVars) -> SettingsEvent);

const COMMANDS: [CommandSetter; 4] = [
    (
        "config:setClaudeCommand",
        "claudeCommand",
        DEFAULT_CLAUDE_COMMAND,
        SettingsEvent::ClaudeCommandChanged,
    ),
    (
        "config:setCodexCommand",
        "codexCommand",
        DEFAULT_CODEX_COMMAND,
        SettingsEvent::CodexCommandChanged,
    ),
    (
        "config:setOpencodeCommand",
        "opencodeCommand",
        DEFAULT_OPENCODE_COMMAND,
        SettingsEvent::OpencodeCommandChanged,
    ),
    (
        "config:setPiCommand",
        "piCommand",
        DEFAULT_PI_COMMAND,
        SettingsEvent::PiCommandChanged,
    ),
];

const MODELS: [ModelSetter; 4] = [
    (
        "config:setClaudeModel",
        "claudeModel",
        SettingsEvent::ClaudeModelChanged,
    ),
    (
        "config:setCodexModel",
        "codexModel",
        SettingsEvent::CodexModelChanged,
    ),
    (
        "config:setOpencodeModel",
        "opencodeModel",
        SettingsEvent::OpencodeModelChanged,
    ),
    (
        "config:setPiModel",
        "piModel",
        SettingsEvent::PiModelChanged,
    ),
];

const RAW_ENV_VARS: [EnvVarsSetter; 2] = [
    ("config:setCodexEnvVars", "codexEnvVars", |vars| {
        SettingsEvent::CodexEnvVarsChanged(vars.into_iter().collect())
    }),
    ("config:setOpencodeEnvVars", "opencodeEnvVars", |vars| {
        SettingsEvent::OpencodeEnvVarsChanged(vars.into_iter().collect())
    }),
];

const CLEANED_ENV_VARS: [EnvVarsSetter; 2] = [
    ("config:setClaudeEnvVars", "claudeEnvVars", |vars| {
        SettingsEvent::ClaudeEnvVarsChanged(vars.into_iter().collect())
    }),
    ("config:setPiEnvVars", "piEnvVars", |vars| {
        SettingsEvent::PiEnvVarsChanged(vars.into_iter().collect())
    }),
];

pub(super) fn register(core: &Arc<Core>) {
    let router = core.router();

    for (channel, key, default, event) in COMMANDS {
        let weak = Arc::downgrade(core);
        router
            .request(channel, move |_ctx, args| {
                let core = upgrade(&weak);
                async move {
                    let core = core?;
                    let trimmed = command_arg(args.first())?;
                    let payload = if trimmed.is_empty() || trimmed == default {
                        core.config().remove(key);
                        default.to_owned()
                    } else {
                        core.config().set(key, Value::String(trimmed.clone()));
                        trimmed
                    };
                    core.store().dispatch(StateEvent::Settings(event(payload)));
                    Ok(Reply::Value(Value::Bool(true)))
                }
            })
            .expect("agent command setter registers once");
    }

    router
        .request("config:getDefaultClaudeCommand", |_ctx, _args| async {
            Ok(Reply::Value(Value::String(
                DEFAULT_CLAUDE_COMMAND.to_owned(),
            )))
        })
        .expect("config:getDefaultClaudeCommand registers once");

    for (channel, key, event) in MODELS {
        let weak = Arc::downgrade(core);
        router
            .request(channel, move |_ctx, args| {
                let core = upgrade(&weak);
                async move {
                    let core = core?;
                    let model = model_arg(args.first())?;
                    match &model {
                        Some(name) if !name.is_empty() => {
                            core.config().set(key, Value::String(name.clone()));
                        }
                        _ => {
                            core.config().remove(key);
                        }
                    }
                    core.store().dispatch(StateEvent::Settings(event(model)));
                    Ok(Reply::Value(Value::Bool(true)))
                }
            })
            .expect("agent model setter registers once");
    }

    for (channel, key, event) in RAW_ENV_VARS {
        let weak = Arc::downgrade(core);
        router
            .request(channel, move |_ctx, args| {
                let core = upgrade(&weak);
                async move {
                    let core = core?;
                    let raw = args.first().cloned().unwrap_or(Value::Null);
                    let vars = raw_env_vars(&raw)?;
                    if vars.is_empty() {
                        core.config().remove(key);
                    } else {
                        core.config().set(key, raw);
                    }
                    core.store().dispatch(StateEvent::Settings(event(vars)));
                    Ok(Reply::Value(Value::Bool(true)))
                }
            })
            .expect("agent env var setter registers once");
    }

    for (channel, key, event) in CLEANED_ENV_VARS {
        let weak = Arc::downgrade(core);
        router
            .request(channel, move |_ctx, args| {
                let core = upgrade(&weak);
                async move {
                    let core = core?;
                    let cleaned = clean_env_vars(args.first());
                    if cleaned.is_empty() {
                        core.config().remove(key);
                    } else {
                        let stored = cleaned
                            .iter()
                            .map(|(k, v)| (k.clone(), Value::String(v.clone())))
                            .collect();
                        core.config().set(key, Value::Object(stored));
                    }
                    core.store().dispatch(StateEvent::Settings(event(cleaned)));
                    Ok(Reply::Value(Value::Bool(true)))
                }
            })
            .expect("agent env var setter registers once");
    }
}

fn command_arg(arg: Option<&Value>) -> Result<String, String> {
    match arg {
        Some(Value::String(command)) => Ok(tatsu_js::trim(command).to_owned()),
        None => Err("Cannot read properties of undefined (reading 'trim')".to_owned()),
        Some(Value::Null) => Err("Cannot read properties of null (reading 'trim')".to_owned()),
        Some(_) => Err("command.trim is not a function".to_owned()),
    }
}

fn model_arg(arg: Option<&Value>) -> Result<Option<String>, String> {
    match arg {
        Some(Value::String(model)) => Ok(Some(model.clone())),
        // TS dispatches `undefined`, which the event cannot carry apart from null.
        None | Some(Value::Null) => Ok(None),
        // TS stores and dispatches any other value; the model events only carry a string or null.
        Some(other) => Err(format!(
            "model must be a string or null, got {}",
            tatsu_js::stringify(other)
        )),
    }
}

fn raw_env_vars(raw: &Value) -> Result<EnvVars, String> {
    match raw {
        Value::Object(map) => {
            let mut entries = map
                .iter()
                .map(|(k, v)| match v {
                    Value::String(s) => Ok((k.clone(), s.clone())),
                    // TS stores and dispatches the map as is; the env var events only carry string values.
                    other => Err(format!(
                        "env var {k:?} must be a string, got {}",
                        tatsu_js::stringify(other)
                    )),
                })
                .collect::<Result<Vec<_>, _>>()?;
            entries.sort_by_key(|(k, _)| array_index(k).map_or((1, 0), |i| (0, i)));
            Ok(entries)
        }
        Value::Array(items) if items.is_empty() => Ok(EnvVars::new()),
        Value::String(s) if s.is_empty() => Ok(EnvVars::new()),
        Value::Null | Value::Bool(_) | Value::Number(_) => Ok(EnvVars::new()),
        // TS stores and dispatches any value with keys; a non-empty string or array has index keys the env var events cannot carry.
        other => Err(format!(
            "env vars must be an object, got {}",
            tatsu_js::stringify(other)
        )),
    }
}

fn array_index(key: &str) -> Option<u32> {
    let index: u32 = key.parse().ok()?;
    (index != u32::MAX && index.to_string() == key).then_some(index)
}

fn clean_env_vars(arg: Option<&Value>) -> EnvVars {
    let entries: Vec<(String, &Value)> = match arg {
        Some(Value::Object(map)) => map.iter().map(|(k, v)| (k.clone(), v)).collect(),
        Some(Value::Array(items)) => items
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v))
            .collect(),
        _ => Vec::new(),
    };
    let mut cleaned = EnvVars::new();
    for (raw_key, raw_val) in entries {
        let key = tatsu_js::trim(&raw_key);
        // TS assigns into a plain object, so `cleaned["__proto__"] = ...` hits the prototype setter and the key never lands.
        if !is_env_name(key) || key == "__proto__" {
            continue;
        }
        let value = match raw_val {
            Value::Null => String::new(),
            other => tatsu_js::to_js_string(other),
        };
        match cleaned.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = value,
            None => cleaned.push((key.to_owned(), value)),
        }
    }
    cleaned
}

fn is_env_name(key: &str) -> bool {
    let mut chars = key.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{array_index, clean_env_vars, is_env_name, model_arg, raw_env_vars};

    #[test]
    fn models_that_are_not_strings_or_null_are_rejected() {
        for bad in [
            json!(5),
            json!(0),
            json!(false),
            json!(true),
            json!({}),
            json!(["m"]),
        ] {
            assert!(model_arg(Some(&bad)).is_err(), "{bad}");
        }
        assert_eq!(model_arg(None), Ok(None));
        assert_eq!(model_arg(Some(&json!(null))), Ok(None));
        assert_eq!(model_arg(Some(&json!(""))), Ok(Some(String::new())));
    }

    #[test]
    fn raw_env_vars_reject_values_with_keys_the_event_cannot_carry() {
        for bad in [
            json!("abc"),
            json!(["A"]),
            json!({"K": 5}),
            json!({"K": null}),
        ] {
            assert!(raw_env_vars(&bad).is_err(), "{bad}");
        }
        for empty in [
            json!(null),
            json!(0),
            json!(7),
            json!(true),
            json!(false),
            json!(""),
            json!([]),
            json!({}),
        ] {
            assert_eq!(raw_env_vars(&empty), Ok(Vec::new()), "{empty}");
        }
    }

    #[test]
    fn raw_env_vars_put_array_index_keys_first_like_js() {
        let vars = raw_env_vars(&json!({"Z": "z", "10": "ten", "01": "o", "2": "two"})).unwrap();
        let keys: Vec<&str> = vars.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["2", "10", "Z", "01"]);
        assert_eq!(array_index("4294967295"), None);
        assert_eq!(array_index("4294967294"), Some(4_294_967_294));
    }

    #[test]
    fn cleaned_env_vars_never_hold_a_key_outside_the_posix_name_set() {
        let cleaned = clean_env_vars(Some(&json!({
            "PATH=/evil": "x", "A B": "y", "A\nB": "z", "LD_PRELOAD": "ok", "\u{00a0}K\u{3000}": 1
        })));
        assert_eq!(
            cleaned,
            [
                ("LD_PRELOAD".to_owned(), "ok".to_owned()),
                ("K".to_owned(), "1".to_owned())
            ]
        );
        assert!(!is_env_name(""));
        assert!(!is_env_name("9A"));
        assert!(!is_env_name("É"));
    }
}

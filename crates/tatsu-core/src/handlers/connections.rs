use std::sync::{Arc, Weak};

use serde_json::{Map, Value, json};

use super::upgrade;
use crate::config::ConfigDoc;
use crate::lifecycle::Core;
use crate::router::Reply;

const LOCAL_BACKEND_ID: &str = "local";
const CONNECTIONS_KEY: &str = "connections";
const ACTIVE_KEY: &str = "activeBackendId";

type Handler = fn(&Core, &[Value]) -> Result<Reply, String>;

enum NoSave {
    Unchanged,
    Fail(String),
}

impl From<String> for NoSave {
    fn from(text: String) -> Self {
        Self::Fail(text)
    }
}

fn edit(
    core: &Core,
    change: impl FnOnce(&mut ConfigDoc) -> Result<(), NoSave>,
) -> Result<bool, String> {
    match core.config().try_update(change) {
        Ok(()) => Ok(true),
        Err(NoSave::Unchanged) => Ok(false),
        Err(NoSave::Fail(text)) => Err(text),
    }
}

pub(super) fn register(core: &Arc<Core>) {
    let handlers: [(&str, Handler); 9] = [
        ("connections:list", list),
        ("connections:add", add),
        ("connections:remove", remove),
        ("connections:rename", rename),
        ("connections:setActive", set_active),
        ("connections:getActive", get_active),
        ("connections:setLastConnected", set_last_connected),
        ("connections:getToken", get_token),
        ("connections:hasToken", has_token),
    ];
    for (channel, handler) in handlers {
        let weak: Weak<Core> = Arc::downgrade(core);
        core.router()
            .request(channel, move |_ctx, args| {
                let core = upgrade(&weak);
                async move {
                    let core = core?;
                    handler(&core, &args)
                }
            })
            .unwrap_or_else(|_| panic!("{channel} registers once"));
    }
}

fn value(v: Value) -> Result<Reply, String> {
    Ok(Reply::Value(v))
}

fn list(core: &Core, _args: &[Value]) -> Result<Reply, String> {
    value(stored_list(core.config().get_raw(CONNECTIONS_KEY)))
}

fn add(core: &Core, args: &[Value]) -> Result<Reply, String> {
    let input = match args.first() {
        Some(Value::Object(input)) if input.get("kind") == Some(&json!("remote")) => input,
        _ => return Err("connections:add only accepts remote connections".to_owned()),
    };
    let url = non_empty_string(input.get("url")).ok_or("url is required")?;
    let label = non_empty_string(input.get("label")).ok_or("label is required")?;
    let token = non_empty_string(args.get(1)).ok_or("token is required")?;
    let id = core.new_id();
    let mut conn = Map::new();
    conn.insert("id".to_owned(), Value::String(id.clone()));
    conn.insert("label".to_owned(), Value::String(label.to_owned()));
    conn.insert("url".to_owned(), Value::String(url.to_owned()));
    conn.insert("kind".to_owned(), json!("remote"));
    conn.insert("addedAt".to_owned(), json!(core.now_ms()));
    for key in ["color", "initials"] {
        if let Some(v) = input.get(key).filter(|v| tatsu_js::truthy(v)) {
            conn.insert(key.to_owned(), v.clone());
        }
    }
    let conn = Value::Object(conn);
    edit(core, |doc| {
        let mut items = match stored_list(doc.get(CONNECTIONS_KEY).cloned()) {
            Value::Array(items) => items,
            Value::String(_) => return Err("list.push is not a function".to_owned().into()),
            _ => {
                return Err("(config.connections ?? []).slice is not a function"
                    .to_owned()
                    .into());
            }
        };
        items.push(conn.clone());
        doc.set(CONNECTIONS_KEY, Value::Array(items));
        Ok(())
    })?;
    core.secrets().set(&token_key(Some(&json!(id))), token);
    value(conn)
}

fn remove(core: &Core, args: &[Value]) -> Result<Reply, String> {
    let id = args.first();
    if is_local(id) {
        return Err("cannot remove the local backend".to_owned());
    }
    let removed = edit(core, |doc| {
        let items = array_or_err(doc, "filter")?;
        let mut kept = Vec::with_capacity(items.len());
        for item in &items {
            if !strict_eq(entry_id(item)?, id) {
                kept.push(item.clone());
            }
        }
        if kept.len() == items.len() {
            return Err(NoSave::Unchanged);
        }
        doc.set(CONNECTIONS_KEY, Value::Array(kept));
        if strict_eq(doc.get(ACTIVE_KEY), id) {
            doc.set(ACTIVE_KEY, json!(LOCAL_BACKEND_ID));
        }
        Ok(())
    })?;
    if removed {
        core.secrets().delete(&token_key(id));
    }
    value(Value::Bool(removed))
}

fn rename(core: &Core, args: &[Value]) -> Result<Reply, String> {
    let label = match args.get(1) {
        Some(Value::String(label)) if !tatsu_js::trim(label).is_empty() => tatsu_js::trim(label),
        _ => return Err("label is required".to_owned()),
    };
    patch_entry(core, args.first(), "label", Value::String(label.to_owned()))
}

fn set_active(core: &Core, args: &[Value]) -> Result<Reply, String> {
    edit(core, |doc| set_active_in(doc, args.first()))?;
    value(Value::Bool(true))
}

fn set_active_in(doc: &mut ConfigDoc, id: Option<&Value>) -> Result<(), NoSave> {
    let items = array_or_err(doc, "some")?;
    if position(&items, id)?.is_none() {
        return Err(format!("unknown backend id: {}", js_template(id)).into());
    }
    match id {
        Some(id) => doc.set(ACTIVE_KEY, id.clone()),
        // TS assigns `undefined`, which JSON.stringify drops from the saved file. TS keeps the
        // key's slot for a later in-session assignment; removing it here re-appends it instead.
        None => {
            doc.remove(ACTIVE_KEY);
        }
    }
    Ok(())
}

fn get_active(core: &Core, _args: &[Value]) -> Result<Reply, String> {
    let active = core
        .config()
        .get_raw(ACTIVE_KEY)
        .filter(|v| !v.is_null())
        .unwrap_or_else(|| json!(LOCAL_BACKEND_ID));
    value(active)
}

fn set_last_connected(core: &Core, args: &[Value]) -> Result<Reply, String> {
    let when = match args.get(1) {
        Some(when @ Value::Number(_)) => when.clone(),
        _ => json!(core.now_ms()),
    };
    patch_entry(core, args.first(), "lastConnectedAt", when)
}

fn get_token(core: &Core, args: &[Value]) -> Result<Reply, String> {
    let id = args.first();
    if is_local(id) {
        return value(Value::Null);
    }
    value(
        core.secrets()
            .get(&token_key(id))
            .map_or(Value::Null, Value::String),
    )
}

fn has_token(core: &Core, args: &[Value]) -> Result<Reply, String> {
    let id = args.first();
    if is_local(id) {
        return value(Value::Bool(false));
    }
    value(Value::Bool(core.secrets().has(&token_key(id))))
}

fn patch_entry(core: &Core, id: Option<&Value>, key: &str, next: Value) -> Result<Reply, String> {
    let patched = edit(core, |doc| {
        let mut items = array_or_err(doc, "findIndex")?;
        let Some(idx) = position(&items, id)? else {
            return Err(NoSave::Unchanged);
        };
        let mut entry = spread(&items[idx]);
        entry.insert(key.to_owned(), next);
        items[idx] = Value::Object(entry);
        doc.set(CONNECTIONS_KEY, Value::Array(items));
        Ok(())
    })?;
    value(Value::Bool(patched))
}

fn stored_list(stored: Option<Value>) -> Value {
    stored
        .filter(|v| !v.is_null())
        .unwrap_or_else(|| Value::Array(Vec::new()))
}

fn array_or_err(doc: &ConfigDoc, method: &str) -> Result<Vec<Value>, String> {
    match stored_list(doc.get(CONNECTIONS_KEY).cloned()) {
        Value::Array(items) => Ok(items),
        _ => Err(format!("list.{method} is not a function")),
    }
}

fn position(items: &[Value], id: Option<&Value>) -> Result<Option<usize>, String> {
    for (idx, item) in items.iter().enumerate() {
        if strict_eq(entry_id(item)?, id) {
            return Ok(Some(idx));
        }
    }
    Ok(None)
}

fn entry_id(entry: &Value) -> Result<Option<&Value>, String> {
    match entry {
        Value::Null => Err("Cannot read properties of null (reading 'id')".to_owned()),
        Value::Object(map) => Ok(map.get("id")),
        _ => Ok(None),
    }
}

fn spread(entry: &Value) -> Map<String, Value> {
    match entry {
        Value::Object(map) => map.clone(),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v.clone()))
            .collect(),
        // JS spreads a string by UTF-16 code unit; a lone surrogate half has no Rust string form,
        // so an astral character splits into two U+FFFD here.
        Value::String(s) => s
            .encode_utf16()
            .enumerate()
            .map(|(i, unit)| {
                (
                    i.to_string(),
                    Value::String(String::from_utf16_lossy(&[unit])),
                )
            })
            .collect(),
        _ => Map::new(),
    }
}

fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(Value::String(a)), Some(Value::String(b))) => a == b,
        _ => false,
    }
}

fn is_local(id: Option<&Value>) -> bool {
    matches!(id, Some(Value::String(id)) if id == LOCAL_BACKEND_ID)
}

fn non_empty_string(v: Option<&Value>) -> Option<&str> {
    match v {
        Some(Value::String(s)) if !s.is_empty() => Some(s),
        _ => None,
    }
}

fn js_template(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".to_owned(), tatsu_js::to_js_string)
}

fn token_key(id: Option<&Value>) -> String {
    format!("backend-token:{}", js_template(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(value: Value) -> ConfigDoc {
        match value {
            Value::Object(map) => ConfigDoc::from_map(map),
            _ => unreachable!(),
        }
    }

    #[test]
    fn set_active_without_an_id_drops_the_key_and_a_later_set_appends_it() {
        let mut doc = doc(json!({
            "connections": [{"label": "Anon"}],
            "activeBackendId": "local",
            "hooksConsent": "pending",
        }));
        assert!(set_active_in(&mut doc, None).is_ok());
        assert_eq!(doc.get(ACTIVE_KEY), None);
        assert!(set_active_in(&mut doc, None).is_ok());
        doc.set(CONNECTIONS_KEY, json!([{"id": "r1"}]));
        assert!(set_active_in(&mut doc, Some(&json!("r1"))).is_ok());
        let keys: Vec<&str> = doc.keys().collect();
        assert_eq!(keys, ["connections", "hooksConsent", "activeBackendId"]);
    }

    #[test]
    fn spreading_a_string_splits_astral_characters_into_replacement_halves() {
        let spread = spread(&json!("a\u{1F600}"));
        assert_eq!(
            Value::Object(spread),
            json!({"0": "a", "1": "\u{FFFD}", "2": "\u{FFFD}"})
        );
    }
}

use serde_json::{Map, Value};
use tatsu_state::StateEvent;

use crate::router::RouterReply;

#[derive(Debug, PartialEq)]
pub(super) enum Inbound {
    Snapreq {
        id: Option<Value>,
    },
    Req {
        id: Option<Value>,
        name: String,
        args: Vec<Value>,
    },
    Send {
        name: String,
        args: Vec<Value>,
    },
    Ignored,
}

pub(super) fn decode(frame: Value) -> Inbound {
    let Value::Object(mut obj) = frame else {
        return Inbound::Ignored;
    };
    let Some(Value::String(t)) = obj.get("t") else {
        return Inbound::Ignored;
    };
    match t.as_str() {
        "snapreq" => Inbound::Snapreq {
            id: obj.remove("id"),
        },
        "req" => Inbound::Req {
            id: obj.remove("id"),
            name: name(&obj),
            args: args(&mut obj),
        },
        "send" => Inbound::Send {
            name: name(&obj),
            args: args(&mut obj),
        },
        _ => Inbound::Ignored,
    }
}

fn name(obj: &Map<String, Value>) -> String {
    match obj.get("name") {
        None => "undefined".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => tatsu_js::to_js_string(other),
    }
}

fn args(obj: &mut Map<String, Value>) -> Vec<Value> {
    match obj.remove("args") {
        Some(Value::Array(args)) => args,
        _ => Vec::new(),
    }
}

fn object(fields: Vec<(&str, Option<Value>)>) -> Value {
    Value::Object(
        fields
            .into_iter()
            .filter_map(|(k, v)| v.map(|v| (k.to_string(), v)))
            .collect(),
    )
}

pub(super) fn state(event: &StateEvent, seq: u64) -> String {
    let event = serde_json::to_value(event).expect("StateEvent serializes to JSON");
    tatsu_js::stringify(&object(vec![
        ("t", Some("state".into())),
        ("event", Some(event)),
        ("seq", Some(seq.into())),
    ]))
}

pub(super) fn snapres(id: Option<&Value>, snapshot_json: &str) -> String {
    let head = tatsu_js::stringify(&object(vec![
        ("t", Some("snapres".into())),
        ("id", id.cloned()),
        ("ok", Some(true.into())),
    ]));
    let open = head.strip_suffix('}').expect("stringify writes an object");
    format!("{open},\"snapshot\":{snapshot_json}}}")
}

pub(super) fn res(id: Option<Value>, reply: RouterReply) -> String {
    let (ok, value, error) = match reply {
        RouterReply::Value(value) => (true, Some(value), None),
        RouterReply::NoValue => (true, None, None),
        RouterReply::Error(error) => (false, None, Some(Value::String(error))),
    };
    tatsu_js::stringify(&object(vec![
        ("t", Some("res".into())),
        ("id", id),
        ("ok", Some(ok.into())),
        ("value", value),
        ("error", error),
    ]))
}

pub(super) fn sig(name: &str, args: Vec<Value>) -> String {
    tatsu_js::stringify(&object(vec![
        ("t", Some("sig".into())),
        ("name", Some(name.into())),
        ("args", Some(Value::Array(args))),
    ]))
}

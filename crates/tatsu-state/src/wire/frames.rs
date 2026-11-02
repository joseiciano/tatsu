use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

use super::{False, True};
use crate::StateEvent;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum SnapshotResult {
    Ok {
        id: String,
        ok: True,
        snapshot: Value,
    },
    Err {
        id: String,
        ok: False,
        error: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum RequestResult {
    Ok {
        id: String,
        ok: True,
        value: Value,
    },
    Err {
        id: String,
        ok: False,
        error: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum ServerFrame {
    State { event: StateEvent, seq: u64 },
    Snapres(SnapshotResult),
    Res(RequestResult),
    Sig { name: String, args: Vec<Value> },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum ClientFrame {
    Snapreq {
        id: String,
    },
    Req {
        id: String,
        name: String,
        args: Vec<Value>,
    },
    Send {
        name: String,
        args: Vec<Value>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn round_trips<T: Serialize + for<'de> Deserialize<'de>>(frame: Value) {
        let parsed: T = serde_json::from_value(frame.clone()).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), frame);
    }

    #[test]
    fn every_server_frame_variant_round_trips() {
        for frame in [
            json!({ "t": "state", "event": { "type": "snooze/clear", "payload": "/a" }, "seq": 3 }),
            json!({ "t": "snapres", "id": "1", "ok": true, "snapshot": { "seq": 1, "state": {} } }),
            json!({ "t": "snapres", "id": "1", "ok": false, "error": "nope" }),
            json!({ "t": "res", "id": "2", "ok": true, "value": null }),
            json!({ "t": "res", "id": "2", "ok": false, "error": "nope" }),
            json!({ "t": "sig", "name": "terminal:data", "args": ["x", 1, { "a": [] }] }),
        ] {
            round_trips::<ServerFrame>(frame);
        }
    }

    #[test]
    fn every_client_frame_variant_round_trips() {
        for frame in [
            json!({ "t": "snapreq", "id": "1" }),
            json!({ "t": "req", "id": "2", "name": "settings:setTheme", "args": ["dark"] }),
            json!({ "t": "send", "name": "pty:write", "args": ["t1", "ls\n"] }),
        ] {
            round_trips::<ClientFrame>(frame);
        }
    }

    #[test]
    fn an_ok_result_with_an_error_field_is_rejected() {
        let parsed = serde_json::from_value::<ServerFrame>(
            json!({ "t": "res", "id": "2", "ok": true, "error": "nope" }),
        );
        assert!(parsed.is_err());
    }
}

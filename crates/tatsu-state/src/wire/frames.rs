use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

use super::{False, True};
use crate::{StateEvent, StateSnapshot};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum SnapshotResult {
    Ok {
        id: String,
        ok: True,
        snapshot: Box<StateSnapshot>,
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

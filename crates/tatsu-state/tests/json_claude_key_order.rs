use std::{fs, path::PathBuf};

use serde_json::{Map, Value};
use tatsu_state::{AppState, StateEvent, root_reduce};

const SESSION_RECORDS: [&str; 2] = ["autoApprovedDecisions", "sessionAllowedDecisions"];

fn json_claude_cases() -> Vec<Map<String, Value>> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/wire/jsonClaude.json");
    let text = fs::read_to_string(&path).unwrap_or_else(|err| panic!("{}: {err}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("{}: {err}", path.display()))
}

fn rust_after(case: &Map<String, Value>) -> Value {
    let start: Map<String, Value> = case
        .get("before")
        .map(|before| ("jsonClaude".to_string(), before.clone()))
        .into_iter()
        .collect();
    let mut state: AppState = serde_json::from_value(Value::Object(start)).unwrap();
    let event: StateEvent = serde_json::from_value(case["event"].clone()).unwrap();
    root_reduce(&mut state, event, case["now"].as_i64().unwrap());
    let text = serde_json::to_string(&state).unwrap();
    let mut state: Value = serde_json::from_str(&text).unwrap();
    state["jsonClaude"].take()
}

fn record_keys(slice: &Value) -> Vec<(String, Vec<String>)> {
    let keys = |value: &Value| -> Vec<String> {
        value
            .as_object()
            .map(|map| map.keys().cloned().collect())
            .unwrap_or_default()
    };
    let mut records = vec![
        ("sessions".to_string(), keys(&slice["sessions"])),
        (
            "pendingApprovals".to_string(),
            keys(&slice["pendingApprovals"]),
        ),
    ];
    for (id, session) in slice["sessions"].as_object().into_iter().flatten() {
        for field in SESSION_RECORDS {
            records.push((format!("sessions.{id}.{field}"), keys(&session[field])));
        }
    }
    records
}

#[test]
fn record_keys_keep_the_ts_insertion_order_for_every_json_claude_fixture() {
    let mut multi_key_records = 0;
    let mut failures = Vec::new();

    for case in json_claude_cases() {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let want = record_keys(&case["after"]);
        multi_key_records += want.iter().filter(|(_, keys)| keys.len() >= 2).count();
        let got = record_keys(&rust_after(&case));
        if want != got {
            failures.push(format!("{name}: TS {want:?}, Rust {got:?}"));
        }
    }

    assert!(
        multi_key_records >= 5,
        "only {multi_key_records} record(s) with 2+ keys across the jsonClaude fixtures"
    );
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

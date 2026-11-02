use std::{fs, path::PathBuf};

use serde_json::{Map, Value};
use tatsu_state::{AppState, StateEvent, root_reduce};

const RECORD_FIELDS: [&str; 7] = [
    "statuses",
    "pendingTools",
    "shellActivity",
    "progress",
    "panes",
    "lastActive",
    "sessions",
];

fn terminals_cases() -> Vec<Map<String, Value>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/wire/terminals.json");
    let text = fs::read_to_string(&path).unwrap_or_else(|err| panic!("{}: {err}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("{}: {err}", path.display()))
}

fn rust_after(case: &Map<String, Value>) -> Value {
    let start: Map<String, Value> = case
        .get("before")
        .map(|before| ("terminals".to_string(), before.clone()))
        .into_iter()
        .collect();
    let mut state: AppState = serde_json::from_value(Value::Object(start)).unwrap();
    let event: StateEvent = serde_json::from_value(case["event"].clone()).unwrap();
    root_reduce(&mut state, event, case["now"].as_i64().unwrap());
    let text = serde_json::to_string(&state).unwrap();
    let mut state: Value = serde_json::from_str(&text).unwrap();
    state["terminals"].take()
}

fn keys(slice: &Value, field: &str) -> Vec<String> {
    slice[field]
        .as_object()
        .unwrap_or_else(|| panic!("`{field}` is not an object"))
        .keys()
        .cloned()
        .collect()
}

#[test]
fn record_keys_keep_the_ts_insertion_order_for_every_terminals_fixture() {
    let cases = terminals_cases();
    let mut multi_key_panes = 0;
    let mut failures = Vec::new();

    for case in &cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let expected = &case["after"];
        let actual = rust_after(case);
        for field in RECORD_FIELDS {
            let (want, got) = (keys(expected, field), keys(&actual, field));
            if field == "panes" && want.len() >= 3 {
                multi_key_panes += 1;
            }
            if want != got {
                failures.push(format!("{name} > {field}: TS {want:?}, Rust {got:?}"));
            }
        }
    }

    assert!(
        multi_key_panes >= 5,
        "only {multi_key_panes} fixture case(s) record 3+ panes keys"
    );
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn removing_a_middle_worktree_keeps_the_remaining_panes_in_order() {
    let case = terminals_cases()
        .into_iter()
        .find(|case| {
            case["name"]
                == "panesForWorktreeCleared removes a middle key and keeps the order of the rest"
        })
        .expect("middle-key removal fixture");

    assert_eq!(
        keys(&case["before"], "panes"),
        ["/w/d", "/w/b", "/w/a", "/w/c"]
    );
    assert_eq!(keys(&case["after"], "panes"), ["/w/d", "/w/a", "/w/c"]);
    assert_eq!(keys(&rust_after(&case), "panes"), ["/w/d", "/w/a", "/w/c"]);
}

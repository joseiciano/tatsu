use std::{fs, path::PathBuf};

use serde_json::{Map, Value};
use tatsu_state::{AppState, StateSnapshot, initial_snapshot_json, strip_snapshot_for_wire};

const SLICE_ORDER: [&str; 16] = [
    "settings",
    "prs",
    "onboarding",
    "hooks",
    "worktrees",
    "terminals",
    "updater",
    "repoConfigs",
    "costs",
    "browser",
    "jsonClaude",
    "snooze",
    "runtimes",
    "announcements",
    "scratchpad",
    "harnessConfig",
];

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/wire")
}

fn root_case_actual(case: &Map<String, Value>) -> Result<Value, String> {
    let before = case.get("before").cloned().ok_or("missing `before`")?;
    let kind = case.get("kind").and_then(Value::as_str);
    let actual = match kind {
        Some("strip") => {
            let snapshot: StateSnapshot =
                serde_json::from_value(before).map_err(|e| e.to_string())?;
            serde_json::to_value(strip_snapshot_for_wire(snapshot))
        }
        Some("deserialize") => {
            let state: AppState = serde_json::from_value(before).map_err(|e| e.to_string())?;
            serde_json::to_value(state)
        }
        _ => return Err(format!("unknown `kind` {kind:?}")),
    };
    actual.map_err(|e| e.to_string())
}

#[test]
fn every_root_fixture_case_matches_the_recorded_ts_after() {
    let path = fixtures_dir().join("root.json");
    let text = fs::read_to_string(&path).expect("read root.json");
    let cases: Vec<Map<String, Value>> = serde_json::from_str(&text).expect("parse root.json");
    let mut kinds = Vec::new();
    let mut failures = Vec::new();
    for case in &cases {
        kinds.push(case["kind"].as_str().unwrap_or_default().to_string());
        let expected = case.get("after").cloned().unwrap_or(Value::Null);
        let actual = root_case_actual(case).unwrap_or_else(Value::String);
        if actual != expected {
            failures.push(format!(
                "{}\nexpected: {expected:#}\nactual: {actual:#}",
                case["name"]
            ));
        }
    }
    assert!(kinds.iter().any(|kind| kind == "strip"));
    assert!(kinds.iter().any(|kind| kind == "deserialize"));
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[test]
fn committed_initial_snapshot_is_fresh() {
    let committed = fs::read_to_string(fixtures_dir().join("rust-initial-snapshot.json"))
        .expect("read rust-initial-snapshot.json; run pnpm gen:wire-types");
    assert_eq!(
        committed,
        initial_snapshot_json(),
        "fixtures/wire/rust-initial-snapshot.json is stale; run pnpm gen:wire-types"
    );
}

#[test]
fn initial_snapshot_lists_the_slices_in_ts_order() {
    let snapshot: Value = serde_json::from_str(&initial_snapshot_json()).unwrap();
    let keys: Vec<&str> = snapshot["state"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(keys, SLICE_ORDER);
    assert_eq!(snapshot["seq"], 0);
}

#[test]
fn initial_snapshot_sends_harness_config_roots_and_all_template_fields() {
    let snapshot: Value = serde_json::from_str(&initial_snapshot_json()).unwrap();
    let state = &snapshot["state"];
    assert!(state["settings"]["harnessConfigRoots"].is_object());
    let templates = state["harnessConfig"]["templates"].as_object().unwrap();
    for key in ["templates", "fragments", "errors", "loadedAt"] {
        assert!(templates.contains_key(key), "templates.{key} missing");
    }
}

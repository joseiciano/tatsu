use std::{fs, path::PathBuf};

use serde_json::{Map, Value};
use tatsu_state::{AppState, StateEvent, root_reduce};

const SLICE_KEYS: [&str; 16] = [
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

fn slice_files() -> Vec<(String, PathBuf)> {
    let mut files: Vec<(String, PathBuf)> = fs::read_dir(fixtures_dir())
        .expect("read fixtures/wire")
        .map(|entry| entry.expect("read fixtures/wire entry").path())
        .filter_map(|path| {
            let key = path.file_name()?.to_str()?.strip_suffix(".json")?;
            SLICE_KEYS
                .contains(&key)
                .then(|| (key.to_string(), path.clone()))
        })
        .collect();
    files.sort();
    files
}

fn reduce_case(key: &str, case: &Map<String, Value>) -> Result<Value, String> {
    let now = case["now"].as_i64().ok_or("`now` is not an integer")?;
    let state = Value::Object(Map::from_iter([(key.to_string(), case["before"].clone())]));
    let mut state: AppState =
        serde_json::from_value(state).map_err(|err| format!("before: {err}"))?;
    let event: StateEvent =
        serde_json::from_value(case["event"].clone()).map_err(|err| format!("event: {err}"))?;
    root_reduce(&mut state, event, now);
    let mut state = serde_json::to_value(&state).map_err(|err| format!("serialize: {err}"))?;
    Ok(state[key].take())
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap()
}

#[test]
fn every_slice_fixture_case_matches_the_recorded_ts_after() {
    let mut cases = 0;
    let mut failures = Vec::new();

    for (key, path) in slice_files() {
        let text = fs::read_to_string(&path).expect("read fixture file");
        let file: Vec<Map<String, Value>> =
            serde_json::from_str(&text).unwrap_or_else(|err| panic!("{}: {err}", path.display()));
        for case in &file {
            cases += 1;
            let name = case["name"].as_str().unwrap_or("<unnamed>");
            let input = Value::Object(
                ["now", "before", "event"]
                    .into_iter()
                    .map(|field| (field.to_string(), case[field].clone()))
                    .collect(),
            );
            let expected = case.get("after").cloned().unwrap_or(Value::Null);
            let actual = reduce_case(&key, case).unwrap_or_else(Value::String);
            if actual != expected {
                failures.push(format!(
                    "{key} > {name}\ninput: {}\nexpected: {}\nactual: {}",
                    pretty(&input),
                    pretty(&expected),
                    pretty(&actual)
                ));
            }
        }
    }

    assert!(
        cases > 0,
        "no slice fixture cases found in {}",
        fixtures_dir().display()
    );
    assert!(
        failures.is_empty(),
        "{} of {cases} fixture case(s) failed:\n\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

use std::{fs, path::PathBuf};

use serde_json::{Map, Value};
use tatsu_state::{AppState, StateEvent, root_reduce};

fn harness_config_cases() -> Vec<Map<String, Value>> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/wire/harnessConfig.json");
    let text = fs::read_to_string(&path).unwrap_or_else(|err| panic!("{}: {err}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("{}: {err}", path.display()))
}

fn rust_after(case: &Map<String, Value>) -> Value {
    let start: Map<String, Value> = case
        .get("before")
        .map(|before| ("harnessConfig".to_string(), before.clone()))
        .into_iter()
        .collect();
    let mut state: AppState = serde_json::from_value(Value::Object(start)).unwrap();
    let event: StateEvent = serde_json::from_value(case["event"].clone()).unwrap();
    root_reduce(&mut state, event, case["now"].as_i64().unwrap());
    let text = serde_json::to_string(&state).unwrap();
    let mut state: Value = serde_json::from_str(&text).unwrap();
    state["harnessConfig"].take()
}

fn keys(value: &Value) -> Vec<String> {
    value
        .as_object()
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default()
}

fn collect_object_keys(path: String, value: &Value, out: &mut Vec<(String, Vec<String>)>) {
    match value {
        Value::Object(map) => {
            out.push((path.clone(), map.keys().cloned().collect()));
            for (key, child) in map {
                collect_object_keys(format!("{path}.{key}"), child, out);
            }
        }
        Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                collect_object_keys(format!("{path}[{index}]"), child, out);
            }
        }
        _ => {}
    }
}

fn record_keys(slice: &Value) -> Vec<(String, Vec<String>)> {
    let mut records = vec![
        ("comparisons".to_string(), keys(&slice["comparisons"])),
        (
            "templateSyncNotice".to_string(),
            slice["templateSyncNotice"]["scopes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|scope| scope.as_str().map(str::to_string))
                .collect(),
        ),
    ];
    for (index, template) in slice["templates"]["templates"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let harnesses = &template["harnesses"];
        records.push((format!("templates[{index}].harnesses"), keys(harnesses)));
        for (kind, block) in harnesses.as_object().into_iter().flatten() {
            collect_object_keys(
                format!("templates[{index}].harnesses.{kind}.frontmatter"),
                &block["frontmatter"],
                &mut records,
            );
        }
    }
    records
}

#[test]
fn frontmatter_and_record_keys_keep_the_ts_order_for_every_harness_config_fixture() {
    let mut unsorted_frontmatter = 0;
    let mut multi_key_comparisons = 0;
    let mut failures = Vec::new();

    for case in harness_config_cases() {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let want = record_keys(&case["after"]);
        unsorted_frontmatter += want
            .iter()
            .filter(|(path, keys)| path.contains(".frontmatter") && !keys.is_sorted())
            .count();
        multi_key_comparisons += want
            .iter()
            .filter(|(path, keys)| path == "comparisons" && keys.len() >= 2)
            .count();
        let got = record_keys(&rust_after(&case));
        if want != got {
            failures.push(format!("{name}: TS {want:?}, Rust {got:?}"));
        }
    }

    assert!(
        unsorted_frontmatter >= 2,
        "only {unsorted_frontmatter} frontmatter object(s) with non-alphabetical keys"
    );
    assert!(
        multi_key_comparisons >= 2,
        "only {multi_key_comparisons} comparisons record(s) with 2+ keys"
    );
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

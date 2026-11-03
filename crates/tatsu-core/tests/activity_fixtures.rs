use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use serde_json::Value;
use tatsu_core::activity::{ACTIVITY_FILENAME, ActivityLog, ActivityState, FinalizeInfo};

fn cases() -> Vec<Value> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/core/activity/cases.json");
    let Value::Array(cases) =
        tatsu_js::parse_lenient(&std::fs::read_to_string(path).unwrap()).unwrap()
    else {
        panic!("cases.json is not an array");
    };
    cases
}

fn apply(log: &ActivityLog, call: &Value) {
    let args = call["args"].as_array().unwrap();
    let path = || args[0].as_str().unwrap();
    let meta = |key: &str| args[1].get(key).and_then(Value::as_str);
    match call["op"].as_str().unwrap() {
        "record" => log.record(
            path(),
            serde_json::from_value::<ActivityState>(args[1].clone()).unwrap(),
        ),
        "touchMeta" => log.touch_meta(path(), meta("branch"), meta("repoRoot")),
        "finalize" => log.finalize(
            path(),
            &serde_json::from_value::<FinalizeInfo>(args[1].clone()).unwrap(),
        ),
        "clear" => log.clear(path()),
        "clearAll" => log.clear_all(),
        "sealAll" => log.seal_all(),
        op => panic!("unknown op {op}"),
    }
}

async fn run(case: &Value) -> Option<String> {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join(ACTIVITY_FILENAME);
    if let Value::String(bytes) = &case["fileBefore"] {
        std::fs::write(&file, bytes).unwrap();
    }
    let now = Arc::new(AtomicI64::new(0));
    let clock_now = Arc::clone(&now);
    let log = ActivityLog::new(
        &file,
        tokio::runtime::Handle::current(),
        Arc::new(move || clock_now.load(Ordering::SeqCst)),
    );
    for call in case["calls"].as_array().unwrap() {
        now.store(call["now"].as_i64().unwrap(), Ordering::SeqCst);
        apply(&log, call);
    }
    log.settled().await;
    std::fs::read_to_string(&file).ok()
}

#[tokio::test(start_paused = true)]
async fn every_case_gives_the_recorded_activity_json_bytes() {
    let cases = cases();
    assert!(cases.len() >= 30, "only {} activity cases", cases.len());
    let mut failures = Vec::new();
    for case in &cases {
        let actual = run(case).await;
        let expected = case["expected"].as_str();
        if actual.as_deref() != expected {
            failures.push(format!(
                "{}:\n- {expected:?}\n+ {actual:?}",
                case["name"].as_str().unwrap()
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

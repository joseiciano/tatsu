use std::path::PathBuf;

use serde_json::{Value, json};
use tatsu_core::repo_config::{RepoConfigStore, config_path, sanitize};

fn save_cases() -> Vec<Value> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/core/repo-config/save.json");
    let Value::Array(cases) =
        tatsu_js::parse_lenient(&std::fs::read_to_string(path).unwrap()).unwrap()
    else {
        panic!("save.json is not an array");
    };
    cases
}

fn run_save(case: &Value) -> Value {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().into_owned();
    let path = config_path(&root);
    if let Value::String(bytes) = &case["fileBefore"] {
        std::fs::write(&path, bytes).unwrap();
    }
    let (next, dropped) = sanitize(&case["next"]);
    assert!(
        dropped.is_empty(),
        "{}: `next` must hold only values the Rust type can carry, dropped {dropped:?}",
        case["name"]
    );

    let reply = RepoConfigStore::new().save(&root, &next);

    json!({
        "fileAfter": std::fs::read_to_string(&path).ok(),
        "reply": serde_json::to_value(&reply).unwrap(),
    })
}

#[test]
fn save_gives_the_recorded_file_bytes_and_reply() {
    let cases = save_cases();
    assert!(cases.len() >= 10, "only {} save cases", cases.len());
    let mut failures = Vec::new();
    for case in &cases {
        let actual = run_save(case);
        if tatsu_js::stringify(&actual) != tatsu_js::stringify(&case["expected"]) {
            failures.push(format!(
                "{}:\n- {}\n+ {}",
                case["name"],
                tatsu_js::stringify(&case["expected"]),
                tatsu_js::stringify(&actual)
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

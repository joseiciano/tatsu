use std::path::PathBuf;

use serde::Deserialize;
use serde_json::Value;
use tatsu_core::config::{self, CONFIG_FILE, SCHEMA_VERSION};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Case {
    name: String,
    now: i64,
    input: Option<String>,
    expected: Option<String>,
    schema_version: Option<u64>,
}

fn cases() -> Vec<Case> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/core/config/load-save.json");
    let text = std::fs::read_to_string(&path).unwrap();
    serde_json::from_str(&text).unwrap()
}

fn byte_diff(expected: &str, actual: &str) -> String {
    let at = expected
        .bytes()
        .zip(actual.bytes())
        .position(|(a, b)| a != b)
        .unwrap_or(expected.len().min(actual.len()));
    let line = expected[..at].matches('\n').count() + 1;
    let mut out = format!("first difference at byte {at} (line {line})\n");
    for (i, (e, a)) in expected.lines().zip(actual.lines()).enumerate() {
        if e != a {
            out.push_str(&format!("line {}:\n- {e}\n+ {a}\n", i + 1));
        }
    }
    let (e, a) = (expected.lines().count(), actual.lines().count());
    if e != a {
        out.push_str(&format!("expected {e} lines, got {a}\n"));
    }
    out
}

#[test]
fn rust_load_and_save_give_the_recorded_ts_bytes() {
    let cases = cases();
    assert!(!cases.is_empty());
    let mut failures = Vec::new();
    for case in &cases {
        let expected = case.expected.as_deref().unwrap_or_else(|| {
            panic!("{}: not recorded; run pnpm fixtures:record-core", case.name)
        });
        assert_eq!(
            case.schema_version,
            Some(SCHEMA_VERSION),
            "{}: recorded with a different schema version",
            case.name
        );

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONFIG_FILE);
        if let Some(input) = &case.input {
            std::fs::write(&path, input).unwrap();
        }
        let doc = config::load(&path, case.now);
        config::save_sync(&path, &doc).unwrap();
        let actual = std::fs::read_to_string(&path).unwrap();
        if actual != expected {
            failures.push(format!("{}\n{}", case.name, byte_diff(expected, &actual)));
        }

        let backup = dir.path().join(format!("{CONFIG_FILE}.bad-{}", case.now));
        let parses_to_object = case
            .input
            .as_deref()
            .is_none_or(|input| matches!(tatsu_js::parse_lenient(input), Ok(Value::Object(_))));
        assert_eq!(backup.exists(), !parses_to_object, "{}: backup", case.name);
        if backup.exists() {
            assert_eq!(
                std::fs::read_to_string(&backup).ok().as_deref(),
                case.input.as_deref(),
                "{}: backup keeps the original bytes",
                case.name
            );
        }
        if case.input.is_none() {
            assert!(doc.get("harnessConfig").is_none(), "{}", case.name);
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn the_bad_json_case_is_backed_up_and_saves_the_recorded_defaults() {
    let cases = cases();
    let bad = cases
        .iter()
        .find(|c| c.name == "bad JSON loads defaults")
        .unwrap();
    let missing = cases.iter().find(|c| c.input.is_none()).unwrap();
    let input = bad.input.as_deref().unwrap();
    assert!(tatsu_js::parse_lenient(input).is_err());

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(CONFIG_FILE);
    std::fs::write(&path, input).unwrap();
    config::save_sync(&path, &config::load(&path, bad.now)).unwrap();

    let backup = dir.path().join(format!("{CONFIG_FILE}.bad-{}", bad.now));
    assert_eq!(std::fs::read_to_string(backup).unwrap(), input);
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        bad.expected.as_deref().unwrap()
    );
    assert_eq!(bad.now, missing.now);
    assert_eq!(bad.expected, missing.expected);
}

use std::collections::VecDeque;
use std::path::PathBuf;

use serde::Deserialize;
use serde_json::{Map, Value, json};
use tatsu_core::config::{self, CONFIG_FILE, MigrationCtx, SCHEMA_VERSION};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Case {
    name: String,
    now: i64,
    input: Option<String>,
    expected: Option<String>,
    schema_version: Option<u64>,
    random_suffixes: Option<Vec<String>>,
}

fn read_cases(file: &str) -> Vec<Case> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/core/config")
        .join(file);
    let text = std::fs::read_to_string(&path).unwrap();
    serde_json::from_str(&text).unwrap()
}

fn cases() -> Vec<Case> {
    read_cases("load-save.json")
}

fn migration_cases() -> Vec<Case> {
    read_cases("migrations.json")
}

fn suffix_ctx<'a>(now: i64, suffixes: &'a mut VecDeque<String>, name: &'a str) -> MigrationCtx<'a> {
    MigrationCtx::with_random_suffix(now, move || {
        suffixes
            .pop_front()
            .unwrap_or_else(|| panic!("{name}: ran out of recorded random suffixes"))
    })
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
    check_load_and_save(cases());
}

#[test]
fn migrations_give_the_recorded_ts_bytes() {
    check_load_and_save(migration_cases());
}

fn check_load_and_save(cases: Vec<Case>) {
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
        let mut suffixes: VecDeque<String> =
            case.random_suffixes.clone().unwrap_or_default().into();
        let doc = config::load_with(&path, &mut suffix_ctx(case.now, &mut suffixes, &case.name));
        assert!(
            suffixes.is_empty(),
            "{}: unused random suffixes {suffixes:?}",
            case.name
        );
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

fn parsed_object(input: &str) -> Option<Map<String, Value>> {
    match tatsu_js::parse_lenient(input) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

#[test]
fn running_the_migrations_again_changes_nothing() {
    let mut checked = 0;
    for case in migration_cases() {
        let Some(mut config) = case.input.as_deref().and_then(parsed_object) else {
            continue;
        };
        let from = config.get("schemaVersion").cloned();
        let mut suffixes: VecDeque<String> =
            case.random_suffixes.clone().unwrap_or_default().into();
        let mut ctx = suffix_ctx(case.now, &mut suffixes, &case.name);
        if config::run_migrations(&mut config, &mut ctx).is_err() {
            continue;
        }
        let once = tatsu_js::stringify(&Value::Object(config.clone()));
        config.insert("schemaVersion".into(), from.unwrap_or(json!(0)));
        let mut no_random = MigrationCtx::with_random_suffix(case.now, || {
            panic!("second run asked for a random suffix")
        });
        config::run_migrations(&mut config, &mut no_random).unwrap();
        let twice = tatsu_js::stringify(&Value::Object(config));
        assert_eq!(once, twice, "{}: second run changed the config", case.name);
        checked += 1;
    }
    assert!(checked > 10, "only {checked} cases checked");
}

#[test]
fn backfilled_agent_kind_is_the_last_key_of_each_changed_tab() {
    let case = migration_cases()
        .into_iter()
        .find(|c| c.name.starts_with("v8 legacy harnessConfig"))
        .unwrap();
    let expected = parsed_object(case.expected.as_deref().unwrap()).unwrap();
    let mut tabs = Vec::new();
    collect_tabs(&expected["panes"], &mut tabs);
    let backfilled: Vec<&str> = tabs
        .iter()
        .filter(|tab| tab.keys().next_back().map(String::as_str) == Some("agentKind"))
        .filter(|tab| tab["agentKind"] == "claude")
        .map(|tab| tab["id"].as_str().unwrap())
        .collect();
    assert_eq!(backfilled, ["j1", "j2", "j4"]);
    let untouched: Vec<(&str, Option<&Value>)> = tabs
        .iter()
        .filter(|tab| ["j3", "a1", "j5", "j6"].contains(&tab["id"].as_str().unwrap()))
        .map(|tab| (tab["id"].as_str().unwrap(), tab.get("agentKind")))
        .collect();
    assert_eq!(
        untouched,
        [
            ("j3", Some(&json!("codex"))),
            ("a1", None),
            ("j5", None),
            ("j6", None)
        ]
    );
}

fn collect_tabs<'a>(value: &'a Value, out: &mut Vec<&'a Map<String, Value>>) {
    match value {
        Value::Object(map)
            if map.get("type").and_then(Value::as_str).is_some() && map.contains_key("label") =>
        {
            out.push(map)
        }
        Value::Object(map) => map.values().for_each(|v| collect_tabs(v, out)),
        Value::Array(items) => items.iter().for_each(|v| collect_tabs(v, out)),
        _ => {}
    }
}

use std::path::{Path, PathBuf};

use serde_json::Value;
use tatsu_core::{DataDir, logs, themes};

const PARSE_ERROR: &str = ": parse error — ";

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/core/themes")
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

fn mask(line: &str) -> String {
    let stamped = line.len() > 14
        && line.as_bytes()[0] == b'['
        && line.as_bytes()[13] == b']'
        && line[1..13].bytes().enumerate().all(|(i, b)| match i {
            2 | 5 => b == b':',
            8 => b == b'.',
            _ => b.is_ascii_digit(),
        });
    let line = if stamped {
        format!("[<ts>]{}", &line[14..])
    } else {
        line.to_owned()
    };
    match line.find(PARSE_ERROR) {
        Some(at) => format!("{}<message>", &line[..at + PARSE_ERROR.len()]),
        None => line,
    }
}

fn new_theme_lines(debug_log: &Path, from: usize) -> Vec<String> {
    let text = std::fs::read(debug_log).unwrap_or_default();
    String::from_utf8_lossy(&text[from.min(text.len())..])
        .lines()
        .filter(|line| line.contains("] [themes] "))
        .map(mask)
        .collect()
}

fn order_sensitive(value: &Value) -> String {
    serde_json::to_string(value).unwrap()
}

#[test]
fn rust_loader_matches_every_recorded_ts_theme_case() {
    let logs_dir = tempfile::TempDir::new().unwrap();
    logs::init(&DataDir::from_path(logs_dir.path()).unwrap());
    let debug_log = logs_dir.path().join("debug.log");

    let text = std::fs::read_to_string(fixtures_dir().join("expected.json")).unwrap();
    let Value::Array(cases) = tatsu_js::parse_lenient(&text).unwrap() else {
        panic!("expected.json is not an array");
    };
    assert!(!cases.is_empty());

    let mut failures = Vec::new();
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let data = tempfile::TempDir::new().unwrap();
        let source = fixtures_dir().join(name);
        if source.exists() {
            copy_dir(&source, &data.path().join("themes"));
        }
        let from = std::fs::metadata(&debug_log).map_or(0, |m| m.len() as usize);

        let loaded = themes::load(&DataDir::from_path(data.path()).unwrap()).unwrap();
        logs::flush();

        let actual_themes = order_sensitive(&serde_json::to_value(&loaded).unwrap());
        let expected_themes = order_sensitive(&case["customThemes"]);
        if actual_themes != expected_themes {
            failures.push(format!(
                "{name}: customThemes\n  rust: {actual_themes}\n  ts:   {expected_themes}"
            ));
        }
        let actual_lines = new_theme_lines(&debug_log, from);
        let expected_lines: Vec<String> = serde_json::from_value(case["logLines"].clone()).unwrap();
        if actual_lines != expected_lines {
            failures.push(format!(
                "{name}: logLines\n  rust: {actual_lines:#?}\n  ts:   {expected_lines:#?}"
            ));
        }
        assert!(data.path().join("themes").is_dir(), "{name}: themes dir");
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n\n"));
}

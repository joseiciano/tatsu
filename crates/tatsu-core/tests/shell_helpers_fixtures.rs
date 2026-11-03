use std::path::Path;

use serde_json::Value;
use tatsu_core::DataDir;
use tatsu_core::shell_quote::shell_quote;
use tatsu_core::terminal_history;

fn cases(fn_name: &str) -> Vec<(String, String, String)> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/core/helpers/shell.json");
    let all: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let picked: Vec<_> = all
        .into_iter()
        .filter(|c| c["fn"] == fn_name)
        .map(|c| {
            (
                c["name"].as_str().unwrap().to_owned(),
                c["input"].as_str().unwrap().to_owned(),
                c["expected"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert!(!picked.is_empty(), "no {fn_name} cases");
    picked
}

#[test]
fn shell_quote_matches_ts_fixtures() {
    for (name, input, expected) in cases("shellQuote") {
        assert_eq!(shell_quote(&input), expected, "case {name:?}");
    }
}

#[test]
fn terminal_history_ids_match_ts_fixtures() {
    let ids = cases("sanitizeId");
    assert!(
        ids.iter()
            .any(|(_, input, _)| input.chars().any(|c| c as u32 > 0xFFFF))
    );
    for (name, input, expected) in ids {
        assert_eq!(
            terminal_history::sanitize_id(&input),
            expected,
            "case {name:?}"
        );
        let tmp = tempfile::tempdir().unwrap();
        let dir = DataDir::from_path(tmp.path()).unwrap();
        terminal_history::save(&dir, &input, "x");
        let files: Vec<String> = std::fs::read_dir(tmp.path().join("terminal-history"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(files, [format!("{expected}.txt")], "case {name:?}");
    }
}

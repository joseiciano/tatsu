use serde_json::json;
use tatsu_core::repo_config::{RepoConfigStore, config_path};
use tatsu_core::{DataDir, logs};

#[test]
fn bad_fields_are_dropped_with_a_debug_line_and_the_sanitized_value_is_cached() {
    let data = tempfile::TempDir::new().unwrap();
    logs::init(&DataDir::from_path(data.path()).unwrap());
    let repo = tempfile::TempDir::new().unwrap();
    let root = repo.path().to_string_lossy().into_owned();
    let path = config_path(&root);
    std::fs::write(
        &path,
        r#"{"version": "1", "setupCommand": "pnpm i", "hiddenRightPanels": {"sidebar": true, "pr": true}}"#,
    )
    .unwrap();
    let store = RepoConfigStore::new();

    let first = store.load(&root);
    std::fs::write(&path, "{}").unwrap();
    let second = store.load(&root);
    logs::flush();

    assert_eq!(
        serde_json::to_value(&first).unwrap(),
        json!({"setupCommand": "pnpm i", "hiddenRightPanels": {"pr": true}})
    );
    assert_eq!(second, first);
    let log = std::fs::read_to_string(data.path().join("debug.log")).unwrap();
    let lines: Vec<&str> = log
        .lines()
        .filter(|line| line.contains("[repo-config]"))
        .map(|line| line.split_once("] ").unwrap().1)
        .collect();
    assert_eq!(
        lines,
        [
            format!(
                "[repo-config] ignored invalid version in {}",
                path.display()
            ),
            format!(
                "[repo-config] ignored invalid hiddenRightPanels.sidebar in {}",
                path.display()
            ),
        ]
    );
}

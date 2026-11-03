use serde_json::{Value, json};
use tatsu_state::slices::repo_configs::{MergeStrategy, RepoConfig, RightPanelKey};

use super::{RepoConfigStore, config_path, sanitize};

fn wire(config: &RepoConfig) -> Value {
    serde_json::to_value(config).unwrap()
}

fn repo_with(text: &str) -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().into_owned();
    std::fs::write(config_path(&root), text).unwrap();
    (dir, root)
}

#[test]
fn sanitize_keeps_every_well_typed_field_in_file_order() {
    let value = json!({
        "version": 1,
        "setupCommand": "pnpm i",
        "teardownCommand": "make clean",
        "mergeStrategy": "fast-forward",
        "hideMergePanel": true,
        "hidePrPanel": false,
        "hiddenRightPanels": {"pr": true, "scratchpad": false},
        "rightPanelOrder": ["commits", "merge"]
    });

    let (config, dropped) = sanitize(&value);

    assert!(dropped.is_empty(), "{dropped:?}");
    assert_eq!(wire(&config), value);
}

#[test]
fn sanitize_drops_only_the_values_that_do_not_fit() {
    let (config, dropped) = sanitize(&json!({
        "version": "1",
        "setupCommand": "make",
        "teardownCommand": 5,
        "mergeStrategy": "bogus",
        "hidePrPanel": "yes",
        "hiddenRightPanels": {"nope": true, "pr": true, "merge": "x"},
        "rightPanelOrder": ["todos", "sidebar", 3, "cost"],
        "baseBranch": "main"
    }));

    assert_eq!(
        wire(&config),
        json!({
            "setupCommand": "make",
            "hidePrPanel": true,
            "hiddenRightPanels": {"pr": true},
            "rightPanelOrder": ["todos", "cost"]
        })
    );
    assert_eq!(
        dropped,
        [
            "version",
            "teardownCommand",
            "mergeStrategy",
            "rightPanelOrder[1]",
            "rightPanelOrder[2]",
            "hiddenRightPanels.nope",
            "hiddenRightPanels.merge",
        ]
    );
}

#[test]
fn sanitize_drops_containers_of_the_wrong_shape() {
    let (config, dropped) = sanitize(&json!({
        "hiddenRightPanels": ["pr"],
        "rightPanelOrder": "x",
        "version": 1.5
    }));

    assert_eq!(config, RepoConfig::default());
    assert_eq!(dropped, ["version", "rightPanelOrder", "hiddenRightPanels"]);
}

#[test]
fn sanitize_accepts_an_integral_float_version() {
    let (config, dropped) = sanitize(&tatsu_js::parse_lenient(r#"{"version": 1.0}"#).unwrap());

    assert_eq!(config.version, Some(1));
    assert!(dropped.is_empty());
}

#[test]
fn a_top_level_that_is_not_an_object_reads_as_empty() {
    for text in ["[1, 2]", "null", "\"x\"", "3"] {
        let (config, dropped) = sanitize(&tatsu_js::parse_lenient(text).unwrap());
        assert_eq!(config, RepoConfig::default(), "{text}");
        assert!(dropped.is_empty());
    }
}

#[test]
fn load_returns_the_sanitized_value_and_caches_it() {
    let (_dir, root) = repo_with(
        r#"{"version": "1", "setupCommand": "make", "hiddenRightPanels": {"nope": true}}"#,
    );
    let store = RepoConfigStore::new();

    let first = store.load(&root);
    std::fs::write(config_path(&root), r#"{"setupCommand": "changed"}"#).unwrap();
    let second = store.load(&root);

    assert_eq!(
        wire(&first),
        json!({"setupCommand": "make", "hiddenRightPanels": {}})
    );
    assert_eq!(second, first);
}

#[test]
fn invalidate_rereads_the_file() {
    let (_dir, root) = repo_with(r#"{"setupCommand": "a"}"#);
    let store = RepoConfigStore::new();
    store.load(&root);
    std::fs::write(config_path(&root), r#"{"setupCommand": "b"}"#).unwrap();

    store.invalidate(Some(&root));
    let one = store.load(&root);
    std::fs::write(config_path(&root), r#"{"setupCommand": "c"}"#).unwrap();
    store.invalidate(None);
    let all = store.load(&root);

    assert_eq!(one.setup_command.as_deref(), Some("b"));
    assert_eq!(all.setup_command.as_deref(), Some("c"));
}

#[test]
fn a_missing_file_reads_as_empty_and_is_cached() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().into_owned();
    let store = RepoConfigStore::new();

    assert_eq!(store.load(&root), RepoConfig::default());
    std::fs::write(config_path(&root), r#"{"setupCommand": "late"}"#).unwrap();
    assert_eq!(store.load(&root), RepoConfig::default());
}

#[test]
fn a_file_that_does_not_parse_reads_as_empty() {
    let (_dir, root) = repo_with(r#"{"setupCommand": "#);

    assert_eq!(RepoConfigStore::new().load(&root), RepoConfig::default());
}

#[test]
fn an_empty_root_reads_and_saves_nothing() {
    let store = RepoConfigStore::new();
    let next = RepoConfig {
        setup_command: Some("make".into()),
        ..RepoConfig::default()
    };

    assert_eq!(store.load(""), RepoConfig::default());
    assert_eq!(store.save("", &next), RepoConfig::default());
    assert!(!std::path::Path::new(super::REPO_CONFIG_FILENAME).exists());
}

#[test]
fn save_uses_js_trim_for_commands() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().into_owned();
    let next = RepoConfig {
        setup_command: Some("\u{feff}\u{a0} make \u{2028}".into()),
        teardown_command: Some("\u{feff} ".into()),
        ..RepoConfig::default()
    };

    let saved = RepoConfigStore::new().save(&root, &next);

    assert_eq!(wire(&saved), json!({"version": 1, "setupCommand": "make"}));
}

#[test]
fn a_failed_write_returns_the_cached_value() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().into_owned();
    std::fs::write(config_path(&root), r#"{"mergeStrategy": "squash"}"#).unwrap();
    let store = RepoConfigStore::new();
    let cached = store.load(&root);
    std::fs::remove_file(config_path(&root)).unwrap();
    std::fs::create_dir(config_path(&root)).unwrap();

    let saved = store.save(
        &root,
        &RepoConfig {
            setup_command: Some("make".into()),
            ..RepoConfig::default()
        },
    );

    assert_eq!(cached.merge_strategy, Some(MergeStrategy::Squash));
    assert_eq!(saved, cached);
}

#[test]
fn a_failed_write_with_nothing_cached_returns_empty() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("missing").to_string_lossy().into_owned();

    let saved = RepoConfigStore::new().save(
        &root,
        &RepoConfig {
            setup_command: Some("make".into()),
            ..RepoConfig::default()
        },
    );

    assert_eq!(saved, RepoConfig::default());
}

#[test]
fn update_merges_against_the_cached_value() {
    let (_dir, root) = repo_with(r#"{"setupCommand": "make"}"#);
    let store = RepoConfigStore::new();

    let saved = store.update(&root, |mut current| {
        current.right_panel_order = Some(vec![RightPanelKey::Cost]);
        current
    });

    assert_eq!(
        wire(&saved),
        json!({"version": 1, "setupCommand": "make", "rightPanelOrder": ["cost"]})
    );
    assert_eq!(store.load(&root), saved);
}

#[test]
fn hide_flags_follow_js_truthiness_like_the_ts_save() {
    let (config, dropped) = sanitize(&json!({"hideMergePanel": "yes", "hidePrPanel": 0}));

    assert_eq!(config.hide_merge_panel, Some(true));
    assert_eq!(config.hide_pr_panel, Some(false));
    assert!(dropped.is_empty());
}

// Accepted difference: TS keeps a panel key it does not know (for example one added by a newer build) and writes it back; Rust drops it on read, so the next save removes it.
#[test]
fn a_well_formed_unknown_panel_is_dropped_on_read_and_not_written_back() {
    let (_dir, root) = repo_with(
        r#"{"setupCommand": "make", "hiddenRightPanels": {"futurePanel": true, "pr": true}, "rightPanelOrder": ["futurePanel", "commits"]}"#,
    );
    let store = RepoConfigStore::new();

    let loaded = store.load(&root);
    store.save(&root, &loaded);

    assert_eq!(
        std::fs::read_to_string(config_path(&root)).unwrap(),
        "{\n  \"version\": 1,\n  \"setupCommand\": \"make\",\n  \"hiddenRightPanels\": {\n    \"pr\": true\n  },\n  \"rightPanelOrder\": [\n    \"commits\"\n  ]\n}\n"
    );
}

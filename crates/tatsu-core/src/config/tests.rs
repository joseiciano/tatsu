use serde_json::{Value, json};

use super::*;

const NOW: i64 = 1_700_000_000_123;

fn doc_from(text: &str) -> ConfigDoc {
    match tatsu_js::parse_lenient(text).unwrap() {
        Value::Object(map) => ConfigDoc::from_map(map),
        _ => panic!("not an object"),
    }
}

fn keys(doc: &ConfigDoc) -> Vec<&str> {
    doc.keys().collect()
}

fn load_text(text: &str) -> (tempfile::TempDir, ConfigDoc) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(CONFIG_FILE);
    std::fs::write(&path, text).unwrap();
    let doc = load(&path, NOW);
    (dir, doc)
}

#[test]
fn setting_an_existing_key_keeps_its_position() {
    let mut doc = doc_from(r#"{"a":1,"b":2,"c":3}"#);
    doc.set("b", json!("x"));
    assert_eq!(keys(&doc), ["a", "b", "c"]);
    assert_eq!(doc.get("b"), Some(&json!("x")));
}

#[test]
fn a_new_key_goes_last() {
    let mut doc = doc_from(r#"{"a":1,"b":2}"#);
    doc.set("z", json!(true));
    assert_eq!(keys(&doc), ["a", "b", "z"]);
}

#[test]
fn removing_a_middle_key_shifts_later_keys_without_swapping() {
    let mut doc = doc_from(r#"{"a":1,"b":2,"c":3,"d":4}"#);
    assert_eq!(doc.remove("b"), Some(json!(2)));
    assert_eq!(keys(&doc), ["a", "c", "d"]);
    assert_eq!(doc.to_json(), "{\n  \"a\": 1,\n  \"c\": 3,\n  \"d\": 4\n}");
}

#[test]
fn missing_file_gives_defaults_with_local_connection_and_no_harness_config() {
    let dir = tempfile::tempdir().unwrap();
    let doc = load(&dir.path().join(CONFIG_FILE), NOW);
    assert_eq!(
        keys(&doc),
        [
            "schemaVersion",
            "windowBounds",
            "repoRoots",
            "connections",
            "activeBackendId"
        ]
    );
    assert_eq!(doc.get("schemaVersion"), Some(&json!(9)));
    assert_eq!(doc.get("connections").unwrap()[0]["addedAt"], json!(NOW));
    assert!(doc.get("harnessConfig").is_none());
}

#[test]
fn parsed_keys_overwrite_defaults_in_place_and_unknown_keys_follow() {
    let (_dir, doc) = load_text(
        r#"{"zeta":1,"repoRoots":["/r"],"schemaVersion":9,"connections":[{"id":"x"}],"activeBackendId":"x"}"#,
    );
    assert_eq!(
        keys(&doc),
        [
            "schemaVersion",
            "windowBounds",
            "repoRoots",
            "zeta",
            "connections",
            "activeBackendId"
        ]
    );
    assert_eq!(doc.get("repoRoots"), Some(&json!(["/r"])));
}

#[test]
fn a_higher_schema_version_is_written_down_to_the_current_one() {
    let (_dir, doc) = load_text(r#"{"schemaVersion":42}"#);
    assert_eq!(doc.get("schemaVersion"), Some(&json!(SCHEMA_VERSION)));
}

#[test]
fn connection_defaults_follow_the_js_falsy_and_length_rules() {
    let replaced = ["null", "false", "0", "\"\"", "[]", "{\"length\":0}"];
    for value in replaced {
        let (_dir, doc) = load_text(&format!(
            r#"{{"schemaVersion":9,"connections":{value},"activeBackendId":"r"}}"#
        ));
        assert_eq!(
            doc.get("connections").unwrap()[0]["id"],
            json!("local"),
            "connections: {value}"
        );
        assert_eq!(keys(&doc)[3], "connections", "kept in place for {value}");
    }
    for value in ["\"x\"", "1", "{}", "[{\"id\":\"r\"}]"] {
        let (_dir, doc) = load_text(&format!(
            r#"{{"schemaVersion":9,"connections":{value},"activeBackendId":"r"}}"#
        ));
        assert_eq!(
            doc.get("connections").unwrap(),
            &tatsu_js::parse_lenient(value).unwrap(),
            "connections: {value}"
        );
    }
}

#[test]
fn a_falsy_active_backend_becomes_local_and_a_set_one_stays() {
    for (value, expected) in [
        ("\"\"", "local"),
        ("null", "local"),
        ("\"remote\"", "remote"),
    ] {
        let (_dir, doc) = load_text(&format!(
            r#"{{"schemaVersion":9,"activeBackendId":{value},"connections":[1]}}"#
        ));
        assert_eq!(doc.get("activeBackendId"), Some(&json!(expected)));
    }
}

#[test]
fn a_bad_file_is_renamed_to_a_timestamped_backup_and_defaults_load() {
    let original = "{\"schemaVersion\": 9, \"repoRoots\": [";
    let (dir, doc) = load_text(original);
    let backup = dir.path().join(format!("{CONFIG_FILE}.bad-{NOW}"));
    assert_eq!(std::fs::read_to_string(backup).unwrap(), original);
    assert!(!dir.path().join(CONFIG_FILE).exists());
    assert_eq!(doc, load(&dir.path().join(CONFIG_FILE), NOW));
}

#[test]
fn a_non_object_top_level_value_is_backed_up_like_a_bad_file() {
    for text in ["null", "[1]", "42", "\"x\""] {
        let (dir, doc) = load_text(text);
        assert!(dir.path().join(format!("{CONFIG_FILE}.bad-{NOW}")).exists());
        assert_eq!(doc.get("repoRoots"), Some(&json!([])), "{text}");
    }
}

#[test]
fn invalid_utf8_is_replaced_like_node_instead_of_rejecting_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(CONFIG_FILE);
    std::fs::write(&path, b"{\"schemaVersion\":9,\"name\":\"a\xffb\"}").unwrap();
    let doc = load(&path, NOW);
    assert_eq!(doc.get("name"), Some(&json!("a\u{fffd}b")));
}

#[test]
fn save_writes_pretty_json_without_a_trailing_newline_and_keeps_the_file_mode() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(CONFIG_FILE);
    std::fs::write(&path, "{}").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    save_sync(&path, &doc_from(r#"{"a":[1.5,2],"b":{}}"#)).unwrap();
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "{\n  \"a\": [\n    1.5,\n    2\n  ],\n  \"b\": {}\n}"
    );
    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}

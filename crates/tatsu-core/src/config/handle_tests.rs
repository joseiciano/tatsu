use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::runtime::Handle;

use super::save::write_atomic;
use super::*;

fn doc_from(text: &str) -> ConfigDoc {
    match tatsu_js::parse_lenient(text).unwrap() {
        Value::Object(map) => ConfigDoc::from_map(map),
        _ => panic!("not an object"),
    }
}

fn handle_in(dir: &Path, text: &str) -> ConfigHandle {
    ConfigHandle::new(dir.join(CONFIG_FILE), doc_from(text), Handle::current())
}

fn read(dir: &Path) -> Option<String> {
    std::fs::read_to_string(dir.join(CONFIG_FILE)).ok()
}

fn dir_entries(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

async fn advance(ms: u64) {
    tokio::time::advance(Duration::from_millis(ms)).await;
    for _ in 0..4 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn reads_are_typed_and_missing_or_mistyped_keys_give_none() {
    let dir = tempfile::tempdir().unwrap();
    let config = handle_in(dir.path(), r#"{"uiScale":"large","autoSleepMinutes":15}"#);
    assert_eq!(config.get::<String>("uiScale").as_deref(), Some("large"));
    assert_eq!(config.get::<u32>("autoSleepMinutes"), Some(15));
    assert_eq!(config.get::<String>("autoSleepMinutes"), None);
    assert_eq!(config.get::<String>("missing"), None);
    assert_eq!(config.get_raw("autoSleepMinutes"), Some(json!(15)));
}

#[tokio::test]
async fn set_remove_and_update_change_the_document_and_view_is_a_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let config = handle_in(dir.path(), r#"{"a":1,"b":2}"#);
    let before = config.view();
    config.set("a", json!("x"));
    assert_eq!(config.remove("b"), Some(json!(2)));
    let len = config.update(|doc| {
        doc.set("c", json!(true));
        doc.set("d", json!([]));
        doc.keys().count()
    });
    assert_eq!(len, 3);
    let after = config.view();
    assert_eq!(
        after.doc().to_json(),
        doc_from(r#"{"a":"x","c":true,"d":[]}"#).to_json()
    );
    assert_eq!(after.get::<bool>("c"), Some(true));
    assert_eq!(before.get_raw("b"), Some(&json!(2)));
    assert_eq!(before.get::<i64>("a"), Some(1));
}

#[tokio::test(start_paused = true)]
async fn changes_within_the_debounce_write_once_500ms_after_the_last_change() {
    let dir = tempfile::tempdir().unwrap();
    let config = handle_in(dir.path(), r#"{"schemaVersion":9}"#);
    config.set("a", json!(1));
    advance(200).await;
    config.set("b", json!(2.5));
    advance(200).await;
    config.set("a", json!("z"));
    advance(499).await;
    assert_eq!(read(dir.path()), None);
    advance(1).await;
    assert_eq!(read(dir.path()), Some(config.view().doc().to_json()));
    assert_eq!(
        read(dir.path()).unwrap(),
        "{\n  \"schemaVersion\": 9,\n  \"a\": \"z\",\n  \"b\": 2.5\n}"
    );
    std::fs::remove_file(dir.path().join(CONFIG_FILE)).unwrap();
    advance(5_000).await;
    assert_eq!(dir_entries(dir.path()), Vec::<String>::new());
}

#[tokio::test(start_paused = true)]
async fn debounced_save_keeps_an_existing_file_mode_and_leaves_no_temp_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(CONFIG_FILE);
    std::fs::write(&path, "{}").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let config = handle_in(dir.path(), "{}");
    config.set("k", json!("v"));
    advance(500).await;
    assert_eq!(read(dir.path()).unwrap(), "{\n  \"k\": \"v\"\n}");
    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    assert_eq!(dir_entries(dir.path()), [CONFIG_FILE]);
}

#[tokio::test(start_paused = true)]
async fn flush_sync_writes_a_pending_change_at_once_and_cancels_the_timer() {
    let dir = tempfile::tempdir().unwrap();
    let config = handle_in(dir.path(), "{}");
    config.set("k", json!(1));
    config.flush_sync();
    assert_eq!(read(dir.path()).unwrap(), "{\n  \"k\": 1\n}");
    std::fs::remove_file(dir.path().join(CONFIG_FILE)).unwrap();
    advance(1_000).await;
    assert_eq!(read(dir.path()), None);
}

#[tokio::test(start_paused = true)]
async fn flush_sync_does_nothing_when_no_save_is_pending() {
    let dir = tempfile::tempdir().unwrap();
    let config = handle_in(dir.path(), r#"{"k":1}"#);
    config.flush_sync();
    assert_eq!(read(dir.path()), None);
    config.set("k", json!(2));
    advance(500).await;
    std::fs::remove_file(dir.path().join(CONFIG_FILE)).unwrap();
    config.flush_sync();
    assert_eq!(read(dir.path()), None);
}

#[test]
fn a_failed_rename_leaves_the_old_file_intact_and_removes_the_temp_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(CONFIG_FILE);
    std::fs::write(&path, "{\"old\": true}").unwrap();
    let result = write_atomic(&path, "{\"new\": true}", |_, _| {
        Err(std::io::Error::other("simulated crash before rename"))
    });
    assert!(result.is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"old\": true}");
    assert_eq!(dir_entries(dir.path()), [CONFIG_FILE]);
}

#[tokio::test(start_paused = true)]
async fn a_failed_debounced_write_stays_pending_for_the_shutdown_flush() {
    let dir = tempfile::tempdir().unwrap();
    let blocked = dir.path().join("missing-dir");
    let config = handle_in(&blocked, "{}");
    config.set("k", json!(1));
    advance(500).await;
    std::fs::create_dir(&blocked).unwrap();
    config.flush_sync();
    assert_eq!(read(&blocked).unwrap(), "{\n  \"k\": 1\n}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_updates_and_flushes_end_with_the_final_document_on_disk() {
    let dir = tempfile::tempdir().unwrap();
    let config = handle_in(dir.path(), "{}");
    let threads: Vec<_> = (0..8)
        .map(|t| {
            let config = config.clone();
            std::thread::spawn(move || {
                for i in 0..50 {
                    config.update(|doc| doc.set(format!("t{t}"), json!(i)));
                    if i % 10 == 0 {
                        config.flush_sync();
                    }
                }
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    config.flush_sync();
    assert_eq!(read(dir.path()), Some(config.view().doc().to_json()));
    assert_eq!(dir_entries(dir.path()), [CONFIG_FILE]);
    for t in 0..8 {
        assert_eq!(config.get::<i64>(&format!("t{t}")), Some(49));
    }
}

#[tokio::test(start_paused = true)]
async fn pending_save_is_the_unwritten_document_until_the_debounced_write_lands() {
    let dir = tempfile::tempdir().unwrap();
    let config = handle_in(dir.path(), r#"{"a":1}"#);
    assert_eq!(config.pending_save(), None);
    config.remove("missing");
    assert_eq!(config.pending_save().as_deref(), Some("{\n  \"a\": 1\n}"));
    advance(SAVE_DEBOUNCE.as_millis() as u64).await;
    assert_eq!(config.pending_save(), None);
    assert_eq!(read(dir.path()).as_deref(), Some("{\n  \"a\": 1\n}"));
}
